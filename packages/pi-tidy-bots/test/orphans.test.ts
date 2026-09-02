import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 148: unclean daemon death (1) orphans pi --mode rpc children — the
// child-pid ledger (.fleet/children/<bot>.pid) is written at spawn and
// reaped at the next boot; (2) replayed journal entries' delivering flags
// spin forever — agent_start clears them by id.

const runner = new URL(
  "./fixtures/rpc/streaming-pi.mjs",
  import.meta.url
).pathname;

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

test(
  "child-pid ledger written at spawn; orphan reaped at next boot (issue 148)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-orphan-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    // An orphan candidate: a long-lived process matching the child shape.
    const orphanScript = join(fleetDir, "orphan-pi.mjs");
    writeFileSync(
      orphanScript,
      `process.title = "stub-pi-orphan";\nsetInterval(() => {}, 1 << 30);\n`
    );
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const first = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(first);
      const base = `http://127.0.0.1:${first.port}`;
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      // Ledger exists with the spawned child's pid.
      const ledger = join(fleetDir, ".fleet", "children", "aa.pid");
      assert.ok(existsSync(ledger), "ledger written at spawn");
      const childPid = Number(readFileSync(ledger, "utf8").trim());
      assert.ok(Number.isFinite(childPid) && childPid > 0, "real pid");

      // Simulate the orphan: a same-shape process recorded in the ledger
      // (the daemon itself stops its own children; the orphan case is a
      // DIFFERENT process the old daemon never reaped).
      // spawn (not spawnSync — the orphan must outlive the call).
      const orphan = spawn(process.execPath, [orphanScript], {
        detached: true,
        stdio: "ignore",
      });
      orphan.unref();
      const orphanPid = (() => {
        const ps = spawnSync("ps", ["ax", "-o", "pid,command"], {
          encoding: "utf8",
        });
        const row = ps.stdout
          .split("\n")
          .find((line) => line.includes("stub-pi-orphan"));
        return row ? Number(row.trim().split(/\s+/)[0]) : undefined;
      })();
      assert.ok(orphanPid, "orphan spawned");
      // Hand-forge the ledger the way the dead daemon left it.
      writeFileSync(ledger, String(orphanPid));

      // Next boot reaps it (kill-or-adopt): a same-shape process named in
      // the ledger is SIGTERMed before the fresh child spawns.
      await first.stop();
      const second = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(second);
      await waitFor(() => {
        try {
          process.kill(orphanPid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 10000);
      assert.ok(true, "orphan reaped by the next boot");
      // The ledger now names the NEW child (rewritten at spawn).
      const newPid = Number(readFileSync(ledger, "utf8").trim());
      assert.notEqual(newPid, orphanPid, "ledger refreshed");
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
