import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 74: delivering means "not yet accepted by the child". The active
// prompt must lose its delivering flag at agent_start (streaming), not when
// the turn ends; a message queued behind an in-flight turn keeps delivering
// until ITS turn_start.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

interface Bot {
  name: string;
  role: string;
  delivering?: boolean;
  text: string;
}

test(
  "delivering clears at agent_start; queued follow-up keeps it until turn_start",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-delivering-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
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
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      const fleet = async () =>
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { name: string; online: boolean }[];
        };
      await waitFor(async () =>
        (await fleet()).bots.some((b) => b.name === "aa" && b.online)
      );

      const transcript = async () =>
        (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
          transcript: Bot[];
        };
      const userEntries = async () =>
        (await transcript()).transcript.filter((e) => e.role !== "system");

      // 1. Direct message to an idle bot: while the turn streams (tool runs
      //    for ~400ms after agent_start), the entry must NOT be delivering.
      const send = async (text: string) => {
        const res = await fetch(`${base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const body = await res.text();
        console.error(`SEND ${text} -> ${res.status} ${body}`);
        return res;
      };
      // 1. Fire the first message WITHOUT awaiting its response: the daemon
      //    answers only when the turn ends, but the transcript entry appears
      //    immediately and delivering must clear at agent_start — while the
      //    turn is still streaming (the stub runs a ~700ms tool after).
      const first = send("first message");
      await waitFor(async () => {
        const entries = await userEntries();
        return entries.some(
          (e) => e.text === "first message" && e.delivering === false
        );
      }, 5000);
      const midTurn = await userEntries();
      assert.equal(
        midTurn.find((e) => e.text === "first message")?.delivering,
        false,
        "active prompt stops delivering once the child accepted it"
      );

      // 2. Second message DURING the still-streaming turn: queues (follow_up)
      //    and must show delivering=true while queued, clearing when ITS
      //    turn_start pops the journal (~400ms in the stub).
      const second = send("second message");
      let sawQueued = false;
      const queueDeadline = Date.now() + 2000;
      while (Date.now() < queueDeadline) {
        const entries = await userEntries();
        const queued = entries.find(
          (e) => e.text === "second message" && e.delivering === true
        );
        if (queued) {
          sawQueued = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(sawQueued, "queued follow-up reads as delivering while queued");

      await first;
      await second;
      // End state: both user entries settled — no stuck delivering flags.
      await waitFor(async () => {
        const entries = await userEntries();
        const users = entries.filter((e) => e.role === "user");
        return users.length === 2 && users.every((e) => e.delivering !== true);
      }, 10000);
      const settled = (await userEntries()).filter((e) => e.role === "user");
      assert.equal(settled.length, 2);
      assert.ok(
        settled.every((e) => e.delivering !== true),
        "no stuck delivering flags after both turns"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
