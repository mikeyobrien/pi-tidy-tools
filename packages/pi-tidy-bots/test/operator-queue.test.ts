import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorQueueStore } from "../src/operator-queue.ts";

// Issue 159: the operator attention queue — one-at-a-time, server-enforced,
// restart-safe journal. GET {pinged, queued, counts}; enqueue promotes when
// idle; clear promotes exactly one; the invariant holds on every write.

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

function queueFixture(dir: string) {
  mkdirSync(join(dir, "bots", "aa"), { recursive: true });
  writeFileSync(join(dir, "bots", "aa", "AGENTS.md"), "# aa\n");
  writeFileSync(join(dir, "bots.toml"), `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`);
}

test("store: one-at-a-time invariant across enqueue/clear/replay (issue 159)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-oq-unit-"));
  try {
    const store = createOperatorQueueStore(dir);
    // Enqueue 3 → first auto-promoted (idle queue).
    const a = store.enqueue({ title: "A", source: "atlas" });
    const b = store.enqueue({ title: "B", source: "atlas" });
    const c = store.enqueue({ title: "C", source: "atlas" });
    assert.equal(a.status, "pinged", "first item pinged immediately");
    assert.equal(b.status, "queued");
    let view = store.view();
    assert.equal(view.pinged?.id, a.id);
    assert.equal(view.queued.length, 2);
    assert.deepEqual(view.counts, { pinged: 1, queued: 2, cleared: 0 });

    // Clear A → exactly one promotion (B).
    const cleared = store.clear(a.id);
    assert.equal(cleared?.cleared.id, a.id);
    assert.equal(cleared?.promoted?.id, b.id, "oldest queued promoted");
    view = store.view();
    assert.equal(view.pinged?.id, b.id);
    assert.equal(view.queued.length, 1);
    assert.equal(view.counts.cleared, 1);

    // Clear a QUEUED item (not pinged): no promotion of another beyond the
    // standing pinged — invariant stays zero-or-one.
    const clearedQueued = store.clear(c.id);
    assert.equal(clearedQueued?.cleared.id, c.id);
    assert.equal(clearedQueued?.promoted, undefined, "no double promotion");
    view = store.view();
    assert.equal(view.pinged?.id, b.id);

    // Restart (fresh store over the same journal): state preserved.
    const replayed = createOperatorQueueStore(dir);
    const rview = replayed.view();
    assert.equal(rview.pinged?.id, b.id, "pinged survives restart");
    assert.equal(rview.counts.cleared, 2);

    // Corrupted state (two pinged rows) self-heals to one on load.
    const file = join(dir, ".fleet", "operator-queue.jsonl");
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as { status?: string });
    rows[0].status = "pinged";
    writeFileSync(
      file,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const healed = createOperatorQueueStore(dir).view();
    assert.equal(healed.counts.pinged, 1, "multiple pinged repaired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "API: enqueue/view/clear over HTTP; auth; restart replay (issue 159)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-oq-api-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      queueFixture(fleetDir);
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        token: "sekrit",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      await waitFor(async () => (await (await fetch(`${base}/api/fleet?token=sekrit`)).ok));

      const enqueue = (title: string) =>
        fetch(`${base}/api/operator/queue?token=sekrit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title,
            receipts: [{ ref: "159", detail: "the wire spec" }],
            source: "atlas",
          }),
        });
      const view = async () =>
        (await (await fetch(`${base}/api/operator/queue?token=sekrit`)).json()) as {
          pinged: { id: string; title: string } | null;
          queued: { id: string; title: string }[];
          counts: { pinged: number; queued: number; cleared: number };
        };

      // Acceptance 1: enqueue 3 → 1 pinged + 2 queued.
      for (const title of ["one", "two", "three"]) await enqueue(title);
      let current = await view();
      assert.equal(current.pinged?.title, "one");
      assert.equal(current.queued.length, 2);
      assert.deepEqual(current.counts, { pinged: 1, queued: 2, cleared: 0 });

      // Clear → next promoted.
      const cleared = await fetch(
        `${base}/api/operator/queue/${current.pinged?.id}/clear?token=sekrit`,
        { method: "POST" }
      );
      assert.equal(cleared.status, 200);
      current = await view();
      assert.equal(current.pinged?.title, "two", "next promoted after clear");
      assert.equal(current.counts.cleared, 1);

      // Acceptance 2: no token → 401.
      const bare = await fetch(`${base}/api/operator/queue`);
      assert.equal(bare.status, 401);

      // Restart preserves.
      await handle.stop();
      const second = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        token: "sekrit",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(second);
      const base2 = `http://127.0.0.1:${second.port}`;
      await waitFor(async () => (await (await fetch(`${base2}/api/fleet?token=sekrit`)).ok));
      const replayed = (await (
        await fetch(`${base2}/api/operator/queue?token=sekrit`)
      ).json()) as { pinged: { title: string } | null; counts: { cleared: number } };
      assert.equal(replayed.pinged?.title, "two", "queue survives restart");
      assert.equal(replayed.counts.cleared, 1);

      // Unknown id clear → 404.
      const miss = await fetch(`${base2}/api/operator/queue/nope/clear?token=sekrit`, {
        method: "POST",
      });
      assert.equal(miss.status, 404);
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
