import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
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
import WebSocket from "ws";

// Issue 76: the follow-up queue is data, not a count. Roster/presence and
// GET /api/bots/:name/queue expose {id, text, hasImage, filename?} (no
// base64); DELETE drops a journaled row so it never replays; queued always
// equals queue.length; roster WS events fire when the list changes.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor: condition not met in time");
}

interface QueueItem {
  id: string;
  text: string;
  hasImage: boolean;
  filename?: string;
}

test(
  "queue as data: items on roster + endpoint, dismiss by id, count invariant",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-queue-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n[[bot]]\nname = "bb"\ndir = "bots/bb"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      // Deterministic drain: queued turns hold until <dir>/release exists.
      const holdDir = join(fleetDir, "hold");
      mkdirSync(holdDir, { recursive: true });
      process.env.PTB_STUB_HOLD_DIR = holdDir;
      // Widen the live-turn window: the parked-items assertions must land
      // while turn 1 is still running. 700ms raced under load (the
      // pre-existing flake documented since 157); 5s makes the park
      // deterministic.
      process.env.PTB_STUB_TURN_MS = "5000";

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
          bots: {
            name: string;
            online: boolean;
            queued: number;
            queue?: QueueItem[];
          }[];
        };
      await waitFor(async () => (await fleet()).bots.every((b) => b.online));

      const queue = async (): Promise<QueueItem[]> => {
        const items = (
          (await (await fetch(`${base}/api/bots/bb/queue`)).json()) as {
            queue: QueueItem[];
          }
        ).queue;
        return items;
      };
      const send = async (text: string) => {
        const res = await fetch(`${base}/api/bots/bb/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        return res;
      };

      // WS: collect roster frames to prove the queue change broadcasts, and
      // bubble frames — agent_start's "working" bubble is the deterministic
      // gate that bb is STREAMING (183 family: the transcript's delivering
      //:false clears at prompt ACCEPTANCE, before turn_start — sending the
      // image handoff in that window takes the idle path and never parks).
      const rosterFrames: Array<{
        bots: { name: string; queue?: QueueItem[] }[];
      }> = [];
      let bbWorking = false;
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`);
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "roster") rosterFrames.push(frame);
        if (
          frame.type === "bubble" &&
          frame.bot === "bb" &&
          frame.phase === "working"
        )
          bbWorking = true;
      });
      await new Promise((resolve) => ws.once("open", resolve));

      // Turn 1 runs (~800ms); two text follow-ups + one image handoff park.
      // Fire WITHOUT awaiting the response — the daemon answers only at
      // turn end, but the entry journals/streams immediately.
      const first = send("first");
      // Wait until bb's turn is STREAMING (agent_start fired) — only then do
      // the follow-ups and the image handoff take the parking path.
      await waitFor(() => bbWorking);
      await send("follow-up one");
      await send("follow-up two");
      const bus = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "aa",
          target: "bb",
          message: "match these pixels",
          images: [{ mediaType: "image/png", data: "aGk=" }],
        }),
      });
      assert.equal(
        ((await bus.json()) as { delivered?: boolean }).delivered,
        true,
        "image handoff queued behind the running turn"
      );

      // Three parked items: two text + one image (no base64 on the wire).
      await waitFor(async () => (await queue()).length === 3);
      const items = await queue();
      assert.deepEqual(
        items.map((item) => [item.text, item.hasImage]),
        [
          ["follow-up one", false],
          ["follow-up two", false],
          ["match these pixels", true],
        ],
        "ordered items, image collapsed to hasImage"
      );
      assert.ok(
        !JSON.stringify(items).includes("aGk="),
        "no base64 on the queue"
      );

      // Count invariant on the roster.
      const fleetNow = await fleet();
      const bb = fleetNow.bots.find((b) => b.name === "bb");
      assert.equal(bb?.queued, bb?.queue?.length, "queued === queue.length");

      // WS roster frames carried the queue list while it grew.
      assert.ok(
        rosterFrames.some(
          (frame) =>
            frame.bots.find((b) => b.name === "bb")?.queue?.length === 3
        ),
        "roster broadcast includes queue items"
      );

      // Dismiss the image item: journal row gone, count follows, 404 on miss.
      const dismiss = await fetch(`${base}/api/bots/bb/queue/${items[2]?.id}`, {
        method: "DELETE",
      });
      assert.equal(dismiss.status, 200);
      assert.deepEqual(await dismiss.json(), { removed: true });
      const afterDelete = await queue();
      assert.equal(afterDelete.length, 2);
      assert.ok(afterDelete.every((item) => !item.hasImage));
      const bbAfter = (await fleet()).bots.find((b) => b.name === "bb");
      assert.equal(bbAfter?.queued, 2);
      const miss = await fetch(`${base}/api/bots/bb/queue/nope`, {
        method: "DELETE",
      });
      assert.equal(miss.status, 404);

      // Release the held queued turns; they drain into the transcript and
      // the queue empties. The dismissed row never replays.
      writeFileSync(join(holdDir, "release"), "1");
      delete process.env.PTB_STUB_TURN_MS;
      await waitFor(async () => (await queue()).length === 0, 20000);
      ws.close();
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
