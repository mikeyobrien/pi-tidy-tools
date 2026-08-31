import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Extension-tolerance conformance suite (issue 46). The daemon must survive
// whatever users load into fleet bot sessions: loads that throw, unknown
// event kinds, stdout floods, garbage UI methods, and hung children.
//
// Hermetic: every bot child is the pathological runner
// (fixtures/extensions/pathological-pi.mjs) driven per-bot via
// EXT_MODE_DIR/<name>.mode files. The fixture .mjs extensions in
// fixtures/extensions/ document the real extension shapes these behaviors
// model.

const runner = new URL(
  "./fixtures/extensions/pathological-pi.mjs",
  import.meta.url
).pathname;

let suiteBase = "";
const BOTS = ["crasher", "unknown", "flood", "garbage", "hang"];
// Runner modes keyed by bot (see pathological-pi.mjs).
const MODES: Record<string, string> = {
  crasher: "crash-then-recover",
  unknown: "unknown-events",
  flood: "flood",
  garbage: "garbage-ui",
  hang: "hang",
};

test(
  "daemon tolerates hostile extensions and keeps siblings healthy",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-ext-"));
    const modeDir = join(fleetDir, "ext-modes");
    mkdirSync(modeDir, { recursive: true });
    // The runner picks its pathology per bot: EXT_MODE_DIR/<name>.mode.
    process.env.PI_TIDY_BOTS_EXT_MODE_DIR = modeDir;
    for (const bot of BOTS) {
      mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
      writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      writeFileSync(join(modeDir, `${bot}.mode`), MODES[bot]);
    }
    const manifest = BOTS.map(
      (bot) => `[[bot]]\nname = "${bot}"\ndir = "bots/${bot}"\n`
    ).join("\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[fleet]\nport = 0\n${manifest}`
    );

    // Wrapper the daemon spawns instead of `pi`: hands off to the runner.
    const wrapper = join(fleetDir, "stub-pi.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
    spawnSync("chmod", ["+x", wrapper]);

    const { startFleet } = await import("../src/daemon.ts");
    // handle.port carries the OS-assigned port (manifest declares port 0).
    const handle = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      piBin: wrapper,
      log: (line) => console.error(line),
    });
    suiteBase = `http://127.0.0.1:${handle.port}`;

    const fleet = () => fetch(`${suiteBase}/api/fleet`);
    const alive = async () => (await fleet()).ok;

    try {
      // Phase A — boot with all five pathologies live: daemon survives.
      await waitFor("fleet responds", alive);
      const roster = (await (await fleet()).json()) as {
        bots: { name: string }[];
      };
      assert.deepEqual(
        roster.bots.map((b) => b.name).sort(),
        [...BOTS].sort(),
        "all bots registered despite the pathology zoo"
      );

      // Phase B — crash-then-recover: exits are covered by the restart budget.
      await waitFor(
        "crasher recovers within the restart budget",
        () => existsSync(join(modeDir, "crasher.recovered")),
        15000
      );
      assert.ok(await alive(), "daemon alive after crash loop");

      // Phase C — unknown events + stdout flood: no crash, no state
      // corruption, siblings unaffected.
      await new Promise((r) => setTimeout(r, 4000));
      assert.ok(await alive(), "daemon alive through unknown events + flood");
      const floodTranscript = await (
        await fetch(`${suiteBase}/api/bots/flood/transcript`)
      ).json();
      assert.ok(Array.isArray(floodTranscript.transcript), "transcript sane");

      // Phase D — garbage UI methods: defused, never wedge a turn.
      await new Promise((r) => setTimeout(r, 2500));
      assert.ok(await alive(), "daemon alive through garbage UI requests");

      // Phase E — hung child: prints nothing, never exits. The boot probe
      // degrades to its RPC timeout; the runtime must neither crash nor block
      // the rest of the fleet.
      assert.ok(await alive(), "daemon alive with a hung child");
      const others = (await (await fleet()).json()).bots.filter(
        (b: { name: string }) => b.name !== "hang"
      );
      assert.equal(others.length, BOTS.length - 1, "siblings unaffected");

      // Transcript consistency: every bot's transcript endpoint returns valid
      // JSON arrays even after the pathology zoo ran.
      for (const bot of BOTS) {
        const data = await (
          await fetch(`${suiteBase}/api/bots/${bot}/transcript`)
        ).json();
        assert.ok(
          Array.isArray(data.transcript),
          `${bot} transcript is a list`
        );
      }
    } finally {
      await handle.stop();
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

async function waitFor(
  label: string,
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 10000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
