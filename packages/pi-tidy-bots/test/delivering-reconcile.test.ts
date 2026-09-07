import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STALE_DELIVERING_MS,
  reconcileDelivering,
  isStaleDelivering,
} from "../src/delivering.ts";
import { createRpcEventHandler } from "../src/events.ts";
import type { BotRuntime, TranscriptEntry } from "../src/daemon.ts";

const now = Date.parse("2026-09-07T20:00:00.000Z");

const entry = (id: string, ts: string, delivering = true): TranscriptEntry => ({
  id,
  role: "user",
  origin: "operator",
  text: id,
  ts,
  delivering,
});

test("stale delivering is older than the prompt-class window", () => {
  const fresh = entry("a", new Date(now - 60_000).toISOString());
  const stale = entry(
    "b",
    new Date(now - DEFAULT_STALE_DELIVERING_MS).toISOString()
  );
  assert.equal(isStaleDelivering(fresh, now), false);
  assert.equal(isStaleDelivering(stale, now), true);
});

test("settle clears leftover delivering; pending follow-up stays", () => {
  const stuck = entry("timeout-unknown", "2026-09-06T03:00:00.000Z");
  const queued = entry("follow-up", "2026-09-07T19:59:00.000Z");
  const cleared = reconcileDelivering([stuck, queued], {
    now,
    pendingIds: ["follow-up"],
    settled: true,
    streaming: false,
  });
  assert.equal(stuck.delivering, false);
  assert.equal(queued.delivering, true);
  assert.deepEqual(
    cleared.map((e) => e.id),
    ["timeout-unknown"]
  );
});

test("idle + empty pending clears; accept-window id is kept until stale", () => {
  const accepting = entry("active", new Date(now - 30_000).toISOString());
  const orphan = entry("orphan", new Date(now - 45_000).toISOString());
  reconcileDelivering([accepting, orphan], {
    now,
    activeDeliveryId: "active",
    streaming: false,
    pendingIds: [],
  });
  assert.equal(accepting.delivering, true, "issue 149 unknown window kept");
  assert.equal(orphan.delivering, false, "no pending and not active → clear");
});

test("stale expires even the accept-window and queued flags", () => {
  const aged = entry(
    "active",
    new Date(now - DEFAULT_STALE_DELIVERING_MS - 1).toISOString()
  );
  reconcileDelivering([aged], {
    now,
    activeDeliveryId: "active",
    pendingIds: ["active"],
    streaming: true,
  });
  assert.equal(aged.delivering, false, "never forever-true");
});

test("protocol: agent_settled clears timeout leftover not in pending", () => {
  const leftover = entry("op-1", "2026-09-06T02:12:00.000Z");
  const runtime = {
    config: { name: "atlas" },
    transcript: [leftover],
    activeDeliveryId: null,
    session: { streaming: false },
    pendingFrom: [],
    turnId: "turn-1",
    turnParts: { concatText: () => "", snapshot: () => [] },
    steps: [],
    forceCompactNext: false,
    emptyTurnStreak: 0,
  } as unknown as BotRuntime;
  const emitted: unknown[] = [];
  const handler = createRpcEventHandler({
    runtimes: new Map(),
    fleetBots: () => [],
    pendingStore: { load: () => [], remove: () => {} },
    activeToolOutput: () => "off",
    viewSteps: (steps) => steps,
    computeFill: () => undefined,
    log: () => {},
    emit: (event) => emitted.push(event),
    emitRoster: () => {},
    touch: () => {},
    appendTranscript: () => {},
    resolveUi: () => {},
    maybeCompact: async () => {},
  });
  handler(runtime, { kind: "agent_settled" });
  assert.equal(leftover.delivering, false);
  assert.ok(
    emitted.some(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "append" &&
        (event as { entry?: { id?: string } }).entry?.id === "op-1"
    ),
    "cleared entry is appended so clients drop the spinner"
  );
});

test(
  "boot rewrite: journaled delivering:true not in pending is cleared and persisted",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-sticky-deliv-"));
    const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
      .pathname;
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      mkdirSync(join(fleetDir, ".fleet", "transcripts"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      writeFileSync(
        join(fleetDir, ".fleet", "transcripts", "aa.jsonl"),
        `${JSON.stringify({
          id: "stuck-1",
          role: "user",
          origin: "operator",
          text: "yesterday",
          ts: "2026-09-06T02:12:00.000Z",
          delivering: true,
        })}\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
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
      const deadline = Date.now() + 20000;
      let delivering: boolean | undefined = true;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/bots/aa/transcript`);
        if (res.ok) {
          const body = (await res.json()) as {
            transcript: { id: string; delivering?: boolean }[];
          };
          const stuck = body.transcript.find((e) => e.id === "stuck-1");
          if (stuck) {
            delivering = stuck.delivering;
            if (delivering !== true) break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.notEqual(
        delivering,
        true,
        "boot sweep persists a clear for journaled leftovers"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
