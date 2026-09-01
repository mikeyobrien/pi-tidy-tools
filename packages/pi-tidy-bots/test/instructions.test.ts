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

// Issue 83: per-bot instructions API — GET/PUT /api/bots/:name/instructions
// {text}. Backed by the persona document; the wire surface NEVER names the
// file or its path (missing document = empty text, not an error). Applies on
// the next turn via the existing watcher — observable here as a reload
// prompt reaching the child after a PUT.

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

test("instructions API: round-trip, opaque errors, watcher pickup (issue 83)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-instructions-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  const tracePath = join(fleetDir, "stub-trace.jsonl");
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
    process.env.PTB_STUB_TRACE = tracePath;

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
    await waitFor(async () =>
      (
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );

    // 1. GET returns the current instructions verbatim.
    const before = await fetch(`${base}/api/bots/aa/instructions`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { text: "# aa\n" });

    // 2. PUT round-trips and lands on disk; the watcher fires a reload
    //    prompt at the child (next-turn application, no respawn).
    const put = await fetch(`${base}/api/bots/aa/instructions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "# aa\n\nAlways reply in haiku." }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      (await (await fetch(`${base}/api/bots/aa/instructions`)).json()).text,
      "# aa\n\nAlways reply in haiku."
    );
    assert.equal(
      readFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "utf8"),
      "# aa\n\nAlways reply in haiku."
    );
    await waitFor(() => {
      if (!existsSync(tracePath)) return false;
      return readFileSync(tracePath, "utf8").includes("/bots-reload");
    }, 10000);

    // 3. Opaque surface: errors never name the file or paths; unknown bot 404.
    const ghost = await fetch(`${base}/api/bots/ghost/instructions`);
    assert.equal(ghost.status, 404);
    const ghostRaw = await ghost.text();
    assert.equal(JSON.parse(ghostRaw).error, "unknown bot");
    const bad = await fetch(`${base}/api/bots/aa/instructions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: null }),
    });
    assert.equal(bad.status, 400);
    const badRaw = await bad.text();
    assert.deepEqual(JSON.parse(badRaw), { error: "text (string) required" });
    for (const raw of [ghostRaw, badRaw]) {
      assert.ok(!raw.includes("AGENTS"), "no file naming on the wire");
      assert.ok(!raw.includes(fleetDir), "no paths on the wire");
    }

    // 4. Missing document: empty text, never 404 (delete at runtime).
    rmSync(join(fleetDir, "bots", "aa", "AGENTS.md"));
    const empty = await fetch(`${base}/api/bots/aa/instructions`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { text: "" });
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
