import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 80: GET /api/settings must read back the LIVE tool-output mode —
// POST persists + broadcasts, and a reload (GET) must not silently revert
// to the boot-frozen value.

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

test("settings round-trip: POST full → GET full without restart (issue 80)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-settings-"));
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
    const settings = async () =>
      (await (await fetch(`${base}/api/settings`)).json()) as {
        toolOutput?: string;
      };
    await waitFor(async () => (await settings()).toolOutput !== undefined);

    // Boot default.
    assert.equal((await settings()).toolOutput, "reasons");

    // Change mode; the GET must reflect it immediately (no restart).
    const post = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolOutput: "full" }),
    });
    assert.equal(post.status, 200);
    assert.equal((await settings()).toolOutput, "full", "live read-back");

    // A second change — off — also sticks; invalid stays 400.
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolOutput: "off" }),
    });
    assert.equal((await settings()).toolOutput, "off");
    const bad = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolOutput: "loud" }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await settings()).toolOutput, "off", "unchanged on reject");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
