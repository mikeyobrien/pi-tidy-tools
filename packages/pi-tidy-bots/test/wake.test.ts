import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 140: the wake path. Offline sends used to journal pending "for
// delivery on next spawn" while nothing ever triggered that spawn; in-flight
// handoff state (pendingFrom/turnId) was memory-only, so a daemon restart
// lost target completions and parked source bots forever; restart-budget
// exhaustion left a bot offline until a human respawned it.
//
// - turn markers: written at agent_start (.fleet/inflight/<bot>.json), cleared
//   at settle — a marker that survives to the next boot means the turn died
//   with the daemon: boot re-drives it and notifies waiting handoff sources.
// - wake-on-queue: a message journaled for a dead runtime kicks a respawn
//   (operator intent re-arms the restart budget — a remote kick, not a
//   silent queue).

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

interface Entry {
  role: string;
  kind?: string;
  originFrom?: string;
  text: string;
}

const bootFleet = async (fleetDir: string) => {
  for (const bot of ["src", "tgt"]) {
    mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
    writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
  }
  writeFileSync(
    join(fleetDir, "bots.toml"),
    `[[bot]]\nname = "src"\ndir = "bots/src"\n[[bot]]\nname = "tgt"\ndir = "bots/tgt"\n`
  );
  const wrapper = join(fleetDir, "streaming-pi.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
  spawnSync("chmod", ["+x", wrapper]);
  const { startFleet } = await import("../src/daemon.ts");
  const handle = await startFleet({
    dir: fleetDir,
    port: 0,
    host: "127.0.0.1",
    piBin: wrapper,
    log: () => {},
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const fleet = async () =>
    (await (await fetch(`${base}/api/fleet`)).json()) as {
      bots: { name: string; online: boolean }[];
    };
  const online = async (name: string) =>
    (await fleet()).bots.find((b) => b.name === name)?.online === true;
  const transcript = async (name: string) =>
    (
      (await (await fetch(`${base}/api/bots/${name}/transcript`)).json()) as {
        transcript: Entry[];
      }
    ).transcript;
  await waitFor(async () => (await online("src")) && (await online("tgt")));
  return { handle, base, online, transcript };
};

test(
  "in-flight marker: written with pendingFrom at turn start, cleared at settle",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-wake-1-"));
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    const markerPath = join(fleetDir, ".fleet", "inflight", "tgt.json");
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      process.env.PTB_STUB_TRACE = tracePath;
      process.env.PTB_STUB_TURN_MS = "3000";
      const { handle, base, transcript } = await bootFleet(fleetDir);
      handles.push(handle);

      // s dispatches to t — t's turn runs for the full stub window.
      const bus = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "src",
          target: "tgt",
          message: "work on 140",
        }),
      });
      assert.equal(
        ((await bus.json()) as { delivered?: boolean }).delivered,
        true
      );

      // Mid-turn: the marker exists and carries the waiting source.
      await waitFor(() => existsSync(markerPath));
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        turnId: string;
        pendingFrom: string[];
      };
      assert.ok(marker.turnId.length > 0, "marker carries the live turnId");
      assert.deepEqual(marker.pendingFrom, ["src"]);

      // Settle: marker gone, completion delivered to the source.
      await waitFor(() => !existsSync(markerPath));
      await waitFor(async () => {
        const entries = await transcript("src");
        return entries.some(
          (e) => e.role === "assistant" && e.originFrom === "tgt"
        );
      });
    } finally {
      delete process.env.PTB_STUB_TRACE;
      delete process.env.PTB_STUB_TURN_MS;
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "wake-on-queue: a message kicks a budget-exhausted bot back online; boot marker re-drives and notifies sources",
  { timeout: 90000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-wake-2-"));
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    const ledger = join(fleetDir, ".fleet", "children", "tgt.pid");
    const markerPath = join(fleetDir, ".fleet", "inflight", "tgt.json");
    const pendingPath = join(fleetDir, ".fleet", "pending", "tgt.jsonl");
    const killChild = () => {
      // The ledger carries {pid, lstart, command} identity JSON.
      const raw = readFileSync(ledger, "utf8").trim();
      const pid = Number(
        raw.startsWith("{") ? (JSON.parse(raw) as { pid: number }).pid : raw
      );
      process.kill(pid, "SIGKILL");
    };
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      process.env.PTB_STUB_TRACE = tracePath;
      const { handle, base, online, transcript } = await bootFleet(fleetDir);
      handles.push(handle);

      // Exhaust the restart budget: 4 kills inside the 60s window (max 3).
      // The ledger carries {pid, lstart, command} identity JSON.
      const ledgerPid = () => {
        const raw = readFileSync(ledger, "utf8").trim();
        return Number(
          raw.startsWith("{") ? (JSON.parse(raw) as { pid: number }).pid : raw
        );
      };
      for (let i = 0; i < 4; i++) {
        const pid = ledgerPid();
        process.kill(pid, "SIGKILL");
        if (i < 3) {
          await waitFor(async () => !(await online("tgt")), 10000);
          await waitFor(() => online("tgt"), 15000);
          await waitFor(() => ledgerPid() !== pid, 10000);
        }
      }
      await waitFor(async () => !(await online("tgt")), 15000);

      // Seed a marker as a daemon death would have left behind: t's turn
      // died mid-flight with s waiting on its completion.
      mkdirSync(join(fleetDir, ".fleet", "inflight"), { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({
          turnId: "died-with-the-daemon",
          pendingFrom: ["src"],
          ts: new Date().toISOString(),
        })
      );

      // The operator message queues AND wakes the dead runtime.
      const sent = await fetch(`${base}/api/bots/tgt/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "wake up 140" }),
      });
      assert.equal(sent.status, 202);
      assert.equal(
        ((await sent.json()) as { queued?: boolean }).queued,
        true,
        "offline send queues, never drops"
      );

      // The wake respawn brings t back online.
      await waitFor(() => online("tgt"), 20000);

      // Boot recovery: target re-drives, source is told — loudly.
      await waitFor(async () =>
        (await transcript("tgt")).some(
          (e) =>
            e.role === "system" &&
            e.text.includes("interrupted by a daemon restart")
        )
      );
      await waitFor(() => {
        if (!existsSync(tracePath)) return false;
        return readFileSync(tracePath, "utf8").includes(
          "interrupted by a daemon restart"
        );
      }, 20000);

      // The queued message replayed and drained the journal.
      await waitFor(() => {
        if (existsSync(pendingPath))
          return readFileSync(pendingPath, "utf8").trim().length === 0;
        return true;
      });
      await waitFor(async () => {
        const entries = await transcript("tgt");
        return (
          entries.some((e) => e.role === "user" && e.text === "wake up 140") &&
          entries.some((e) => e.role === "assistant" && e.text.includes("done"))
        );
      });

      // The seeded marker was one-shot.
      assert.equal(existsSync(markerPath), false);
    } finally {
      delete process.env.PTB_STUB_TRACE;
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
