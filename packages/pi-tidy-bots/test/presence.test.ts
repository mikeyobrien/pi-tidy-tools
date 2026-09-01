import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Issue 72 + 69: roster truth after boot and across transports.
// - 72: lastActive persists across daemon restarts (state file), so a reboot
//   never shows a bogus "now" for a long-idle bot, and `active` follows.
// - 69: WS presence() carries `latest` so a roster broadcast matches the
//   REST /api/fleet shape instead of erasing client-side previews.

const fleetDir = mkdtempSync(join(tmpdir(), "ptb-presence-"));
const OLD_ACTIVE = "2026-08-30T10:00:00.000Z"; // ~2 days before "now"

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 10000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

test(
  "presence: lastActive restores from state file; WS roster carries latest",
  { timeout: 45000 },
  async () => {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    mkdirSync(join(fleetDir, "bots", "bb"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(join(fleetDir, "bots", "bb", "AGENTS.md"), "# bb\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n[[bot]]\nname = "bb"\ndir = "bots/bb"\n`
    );
    // Pre-seed persisted activity: aa was active 2 days ago; bb never seen.
    mkdirSync(join(fleetDir, ".fleet"), { recursive: true });
    writeFileSync(
      join(fleetDir, ".fleet", "state.json"),
      JSON.stringify({ lastActive: { aa: OLD_ACTIVE } })
    );

    // Sleeping stub pi: bots go offline, but the roster still serves.
    const stub = join(fleetDir, "stub-pi.sh");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", stub]);

    const { startFleet } = await import("../src/daemon.ts");
    const handles: Array<{ stop(): Promise<void> }> = [];
    const handle = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      piBin: stub,
      log: () => {},
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;

    try {
      await waitFor(async () => (await fetch(`${base}/api/fleet`)).ok);
      const rest = (await (await fetch(`${base}/api/fleet`)).json()) as {
        bots: {
          name: string;
          lastActive: string;
          active: boolean;
          latest: string;
        }[];
      };
      const aa = rest.bots.find((b) => b.name === "aa");
      const bb = rest.bots.find((b) => b.name === "bb");
      assert.ok(aa && bb, "both bots listed");
      // Issue 72: restored, not boot time.
      assert.equal(aa.lastActive, OLD_ACTIVE, "aa restores persisted value");
      assert.equal(aa.active, false, "aa is idle, not bogusly active");
      assert.equal(
        typeof bb.lastActive === "string" && bb.lastActive.length > 0,
        true,
        "unseen bot defaults to boot time"
      );
      assert.equal(bb.active, true, "fresh boot window counts as active");
      assert.equal(typeof aa.latest, "string", "REST carries latest");

      // Issue 69: the WS roster snapshot must match the REST shape.
      const roster = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`);
        const fail = setTimeout(
          () => reject(new Error("no roster frame")),
          10000
        );
        ws.on("message", (raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "roster") return;
          clearTimeout(fail);
          ws.close();
          resolve(frame);
        });
        ws.on("error", reject);
      });
      const wsAa = roster.bots.find((b: { name: string }) => b.name === "aa");
      assert.ok(wsAa, "aa on WS roster");
      assert.equal(
        typeof wsAa.latest,
        "string",
        "WS presence carries latest (issue 69)"
      );
      assert.equal(
        wsAa.latest,
        aa.latest,
        "WS and REST latest agree for the same bot"
      );
      assert.equal(
        wsAa.lastActive,
        OLD_ACTIVE,
        "WS presence serves the restored lastActive too"
      );

      // Boot again (stop + start): unflushed boot-time defaults for bb are
      // fine, but aa's persisted value must survive a full cycle.
      await handle.stop();
      const second = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: stub,
        log: () => {},
      });
      handles.push(second);
      try {
        await waitFor(
          async () =>
            (await fetch(`http://127.0.0.1:${second.port}/api/fleet`)).ok
        );
        const again = (await (
          await fetch(`http://127.0.0.1:${second.port}/api/fleet`)
        ).json()) as { bots: { name: string; lastActive: string }[] };
        const aa2 = again.bots.find((b) => b.name === "aa");
        assert.equal(
          aa2?.lastActive,
          OLD_ACTIVE,
          "persisted lastActive survives a stop/start cycle"
        );
        // The state file itself carries the map (restoration is file-backed).
        const state = JSON.parse(
          readFileSync(join(fleetDir, ".fleet", "state.json"), "utf8")
        );
        assert.equal(state.lastActive?.aa, OLD_ACTIVE);
      } finally {
        await second.stop();
      }
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test("state file untouched when no activity ever happens", async () => {
  // Sanity: a fleet that never touches must not gain lastActive keys.
  const dir = mkdtempSync(join(tmpdir(), "ptb-presence-quiet-"));
  try {
    mkdirSync(join(dir, "bots", "quiet"), { recursive: true });
    writeFileSync(join(dir, "bots", "quiet", "AGENTS.md"), "# quiet\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "quiet"\ndir = "bots/quiet"\n`
    );
    const stub = join(dir, "stub-pi.sh");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", stub]);
    const { startFleet } = await import("../src/daemon.ts");
    const handle = await startFleet({
      dir,
      port: 0,
      host: "127.0.0.1",
      piBin: stub,
      log: () => {},
    });
    await handle.stop();
    const statePath = join(dir, ".fleet", "state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(
        state.lastActive,
        undefined,
        "no activity → no lastActive map written"
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
