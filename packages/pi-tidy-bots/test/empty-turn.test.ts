import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 80 (P0, operator-filed): model-quota exhaustion produced turns with
// EMPTY assistant output that completed "successfully" — sessions looked
// fresh/healthy while producing nothing. The daemon must classify
// empty-success turns as anomalies, journal them, and surface the streak on
// the roster so health probes and wedge detection can see them.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 20000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

interface RosterBot {
  name: string;
  online: boolean;
  emptyTurns?: { streak: number; degraded: boolean; lastAt?: string };
}

test(
  "empty-success turns are detected, journaled, and surfaced; productive turns reset the streak",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-empty-"));
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[fleet]\nempty_turn_alert_after = 2\n[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      process.env.PTB_STUB_EMPTY_TURN = "1";
      process.env.PTB_STUB_TURN_MS = "150";

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      const base = `http://127.0.0.1:${handle.port}`;
      const roster = async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: RosterBot[];
          }
        ).bots;
      const transcript = async () =>
        (
          (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
            transcript: { role: string; text: string }[];
          }
        ).transcript;
      await waitFor(async () => (await roster()).every((b) => b.online));

      // Turn 1: empty "success" — anomaly recorded, streak 1, not yet degraded.
      await fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "quota-exhausted attempt 1" }),
      });
      await waitFor(async () => (await roster())[0].emptyTurns?.streak === 1);
      assert.equal((await roster())[0].emptyTurns?.degraded, false);
      assert.ok(
        (await transcript()).some(
          (e) =>
            e.role === "system" &&
            e.text.includes("no output") &&
            e.text.includes("anomaly")
        ),
        "first empty turn carries a visible system entry"
      );

      // Turn 2: still empty — crosses the configured threshold: degraded.
      await fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "quota-exhausted attempt 2" }),
      });
      await waitFor(
        async () => (await roster())[0].emptyTurns?.degraded === true
      );
      assert.equal((await roster())[0].emptyTurns?.streak, 2);
      assert.ok(
        (await transcript()).some(
          (e) =>
            e.role === "system" &&
            e.text.includes("degraded") &&
            e.text.includes("quota")
        ),
        "threshold crossing carries a degraded system entry"
      );

      // Event log: every empty turn journaled with its streak.
      const journalLines = readFileSync(
        join(fleetDir, ".fleet", "routines.jsonl"),
        "utf8"
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const emptyEvents = journalLines.filter(
        (row) => row.key === "aa:empty-turn"
      );
      assert.equal(emptyEvents.length, 2, "both empty turns journaled");
      assert.equal(emptyEvents[0].status, "empty-success");
      assert.equal(emptyEvents[1].status, "empty-success-degraded");

      // Recovery: a productive turn clears the streak and the roster field.
      delete process.env.PTB_STUB_EMPTY_TURN;
      // The stub reads the env at spawn — the bot must respawn to pick the
      // change up (model change is the sanctioned single-bot respawn).
      await fetch(`${base}/api/bots/aa/model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "stub/flash" }),
      });
      await waitFor(async () => {
        const r = await roster();
        return r[0].online;
      });
      await fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "quota reset — real turn" }),
      });
      await waitFor(async () => (await roster())[0].emptyTurns === undefined);
      await handle.stop();
    } finally {
      delete process.env.PTB_STUB_EMPTY_TURN;
      delete process.env.PTB_STUB_TURN_MS;
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "default threshold is 2 without manifest configuration; invalid values fail fast",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-empty-cfg-"));
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      process.env.PTB_STUB_EMPTY_TURN = "1";
      process.env.PTB_STUB_TURN_MS = "150";

      // No [fleet] block at all: default threshold 2.
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      const base = `http://127.0.0.1:${handle.port}`;
      const roster = async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: RosterBot[];
          }
        ).bots;
      await waitFor(async () => (await roster()).every((b) => b.online));
      // One empty turn per agent cycle: settle between sends, or both
      // queue into a single cycle and only one settle fires.
      for (const text of ["one", "two"]) {
        await fetch(`${base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        await waitFor(async () => (await roster())[0].online, 15000);
        await waitFor(
          async () => (await roster())[0].emptyTurns !== undefined,
          15000
        );
      }
      await waitFor(
        async () => (await roster())[0].emptyTurns?.degraded === true
      );
      await handle.stop();

      // Invalid thresholds fail fast at config load.
      const { loadFleetConfig } = await import("../src/config.ts");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[fleet]\nempty_turn_alert_after = 0\n[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      assert.throws(
        () => loadFleetConfig(fleetDir),
        /empty_turn_alert_after must be an integer >= 1/
      );
    } finally {
      delete process.env.PTB_STUB_EMPTY_TURN;
      delete process.env.PTB_STUB_TURN_MS;
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
