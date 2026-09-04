import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Issue 184: initial-sync replay must not re-animate history. since=0
// replays the whole event buffer — retired turns' bubble working/delta/
// final frames recreated historical bubbles and per-character revealed
// persisted text on every fresh load. Root fix: replay carries append
// events + CURRENTLY-live turns' bubble frames only.

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

interface Harness {
  base: string;
  wsUrl: (since: number) => string;
  stop(): Promise<void>;
}

const boot = async (fleetDir: string): Promise<Harness> => {
  const wrapper = join(fleetDir, "pi.sh");
  writeFileSync(wrapper, "#!/bin/sh\nexec node " + runner + "\n");
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
  return {
    base,
    wsUrl: (since: number) =>
      `ws://127.0.0.1:${handle.port}/api/ws?since=${since}`,
    stop: () => handle.stop(),
  };
};

/** Collect replay frames between hello and roster for a given cursor. */
const replay = (url: string) =>
  new Promise<{ type: string; turnId?: string; bot?: string }[]>(
    (resolve, reject) => {
      const ws = new WebSocket(url);
      const frames: { type: string; turnId?: string; bot?: string }[] = [];
      let seenHello = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("replay: roster never arrived"));
      }, 10000);
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as {
          type: string;
          turnId?: string;
        };
        if (frame.type === "hello") {
          seenHello = true;
          return;
        }
        if (frame.type === "roster") {
          clearTimeout(timer);
          ws.close();
          resolve(frames);
          return;
        }
        if (seenHello) frames.push(frame);
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }
  );

test("fresh-load replay: zero retired bubbles, appends intact (184)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-184-"));
  const stops: Array<() => Promise<void>> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    const h = await boot(fleetDir);
    stops.push(() => h.stop());

    await waitFor(async () =>
      (
        (await (await fetch(`${h.base}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );

    // Drive TWO full turns — bubble working/parts/delta/final frames get
    // published for both, then both turns retire (turnId back to null).
    // 183 family: wait per-turn by COUNTING settled entries — a some(done)
    // probe matches turn one's entry and returns while turn two is still
    // mid-flight, and under load its settle can outrun the margin below.
    let settled = 0;
    for (const text of ["turn one", "turn two"]) {
      settled += 1;
      await fetch(`${h.base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const target = settled;
      await waitFor(
        async () =>
          (
            (await (
              await fetch(`${h.base}/api/bots/aa/transcript`)
            ).json()) as {
              transcript: { text: string }[];
            }
          ).transcript.filter((e) => e.text.includes("done")).length >= target
      );
    }
    // Settle margin: the final bubble frame lands at agent_settled.
    await new Promise((r) => setTimeout(r, 800));

    const frames = await replay(h.wsUrl(0));
    const bubbles = frames.filter((f) => f.type === "bubble");
    const appends = frames.filter((f) => f.type === "append");
    assert.equal(
      bubbles.length,
      0,
      `no retired-turn bubble frames in fresh-load replay (got ${bubbles.length})`
    );
    assert.ok(
      appends.length >= 2,
      `append events carry the settled history (got ${appends.length})`
    );
  } finally {
    await Promise.all(stops.map((s) => s().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});

test("live turn: its bubble frames DO replay for reconnecting clients (184)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-184live-"));
  const stops: Array<() => Promise<void>> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    // Hold the stub mid-turn so the turn is STILL live at replay time.
    const holdDir = join(fleetDir, "hold");
    mkdirSync(holdDir, { recursive: true });
    process.env.PTB_STUB_HOLD_DIR = holdDir;
    const h = await boot(fleetDir);
    stops.push(() => h.stop());

    await waitFor(async () =>
      (
        (await (await fetch(`${h.base}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );
    await fetch(`${h.base}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "held turn" }),
    });
    // Wait until the turn is visibly live (a working bubble exists).
    await waitFor(async () => {
      const frames = await replay(h.wsUrl(0));
      return frames.some((f) => f.type === "bubble" && f.turnId);
    });
    const frames = await replay(h.wsUrl(0));
    const liveBubbles = frames.filter((f) => f.type === "bubble" && f.turnId);
    assert.ok(
      liveBubbles.length > 0,
      "the CURRENTLY-live turn's frames replay (reconnect-during-turn)"
    );
    // Release the hold so the turn settles before teardown.
    writeFileSync(join(holdDir, "release"), "1");
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    delete process.env.PTB_STUB_HOLD_DIR;
    await Promise.all(stops.map((s) => s().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
