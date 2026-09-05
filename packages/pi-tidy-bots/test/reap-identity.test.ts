import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
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

// Issue 148 (verified rejection): the stale child ledger once matched
// foreign processes with a broad command regex (/pi|stub|node/) and sent
// them SIGTERM. The reaper must PROVE ownership: the ledger records the
// child's process identity (pid + start time + exact command) and a signal
// is sent only when ALL THREE still match exactly. Every mismatch and every
// legacy bare-pid ledger is fail-closed.
//
// Hermetic: all signaled/not-signaled targets are processes THIS test owns.

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

const psStart = (pid: number): number => {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).stdout.trim();
  return Date.parse(out);
};
const psCommand = (pid: number): string =>
  spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout.trim();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A test-owned long-lived node process (never a real foreign target). */
function ownSentinel(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
  return {
    pid: child.pid!,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    },
  };
}

test(
  "reaper identity: recycled-pid and command-mismatch ledgers never signal; verified orphans reap; legacy ledgers are fail-closed",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-reap-"));
    const logs: string[] = [];
    const sentinels: Array<() => void> = [];
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
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
        log: (line: string) => logs.push(String(line)),
      });
      const base = `http://127.0.0.1:${handle.port}`;
      const online = async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online);
      await waitFor(online);
      // After every model PUT the bot respawns and OVERWRITES the ledger at
      // spawn-settle; scenario writes must wait for that settle or they race
      // the respawn's own ledger write.
      const putModel = async (model: string) => {
        await fetch(`${base}/api/bots/aa/model`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
        });
        await waitFor(online, 15000);
        await waitFor(() => existsSync(ledgerPath), 15000);
      };

      // 1. The live ledger carries full process identity.
      const ledgerPath = join(fleetDir, ".fleet", "children", "aa.pid");
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
        pid: number | null;
        lstart: number | null;
        command: string | null;
      };
      assert.ok(Number.isFinite(ledger.pid) && ledger.pid! > 0, "pid recorded");
      assert.ok(typeof ledger.lstart === "number", "start time recorded");
      assert.ok(
        typeof ledger.command === "string" && ledger.command.length > 0,
        "command recorded"
      );

      // Stop the fleet WITHOUT letting its children die first: simulate an
      // unclean previous daemon by leaving the child alive with its ledger.
      // (stop() would SIGTERM children; instead SIGKILL nothing — just take
      // the ledger content and keep the fleet running for the scenario.)
      const childPid = ledger.pid!;
      const childStart = ledger.lstart!;
      const childCommand = ledger.command!;
      assert.equal(alive(childPid), true, "child alive for scenario");

      // 2. RECYCLED-PID ledger: same pid, WRONG start time -> no signal.
      const sentinelA = ownSentinel();
      sentinels.push(sentinelA.stop);
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          pid: sentinelA.pid,
          lstart: 12345,
          command: psCommand(sentinelA.pid),
        })
      );
      await putModel("stub/other");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        alive(sentinelA.pid),
        true,
        "recycled-pid target NOT signaled"
      );
      assert.ok(
        logs.some(
          (l) => l.includes("was recycled") || l.includes("start time changed")
        ),
        "recycle logged loudly"
      );

      // 3. COMMAND-MISMATCH ledger: right pid + right start, different
      //    command than recorded -> no signal.
      const sentinelB = ownSentinel();
      sentinels.push(sentinelB.stop);
      const startB = psStart(sentinelB.pid);
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          pid: sentinelB.pid,
          lstart: startB,
          command: "some-other-command --not-ours",
        })
      );
      await putModel("stub/another");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        alive(sentinelB.pid),
        true,
        "command-mismatch target NOT signaled"
      );

      // 4. LEGACY bare-pid ledger -> unverifiable -> no signal.
      const sentinelC = ownSentinel();
      sentinels.push(sentinelC.stop);
      writeFileSync(ledgerPath, String(sentinelC.pid));
      await putModel("stub/third");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        alive(sentinelC.pid),
        true,
        "legacy-ledger target NOT signaled"
      );
      assert.ok(
        logs.some((l) => l.includes("unverifiable")),
        `legacy ledger logged as unverifiable; logs tail: ${logs.slice(-8).join(" | ")}`
      );

      // 5. VERIFIED ORPHAN: a test-owned child spawned EXACTLY like a fleet
      //    child (same wrapper) — LIVE at reap time, the true orphan shape.
      const orphan = spawn(wrapper, [], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      sentinels.push(() => {
        try {
          orphan.kill("SIGKILL");
        } catch {}
      });
      await waitFor(() => psCommand(orphan.pid!).length > 0, 10000);
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          pid: orphan.pid,
          lstart: psStart(orphan.pid!),
          command: psCommand(orphan.pid!),
        })
      );
      await putModel("stub/fourth");
      await waitFor(() => !alive(orphan.pid!), 15000);
      assert.ok(
        logs.some((l) => l.includes("identity verified")),
        "verified orphan reaped with identity proof"
      );

      await handle.stop();
    } finally {
      for (const stop of sentinels) stop();
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
