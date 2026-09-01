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

// Issue 88: per-bot model API. GET/PUT /api/bots/:name/model {model} —
// persisted in the fleet state store (restart-surviving), applied by
// respawning ONLY that bot. Empty string clears to the manifest default.
// Wire surface never names the manifest.

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

test("model API: persist, single-bot respawn, restart survival (issue 88)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-model-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  const tracePath = join(fleetDir, "stub-trace.jsonl");
  try {
    for (const bot of ["aa", "bb"]) {
      mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
      writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
    }
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n` +
        `[[bot]]\nname = "bb"\ndir = "bots/bb"\n`
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

    const traced = () =>
      existsSync(tracePath)
        ? readFileSync(tracePath, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as { name?: string; kind?: string })
        : [];
    const bootProbes = (name: string) =>
      traced().filter((r) => r.name === name && r.kind === "get_state").length;

    // 1. Default: no model in the manifest → empty string.
    const before = await fetch(`${base}/api/bots/aa/model`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { model: "" });
    const aaBoots = bootProbes("aa");
    const bbBoots = bootProbes("bb");

    // 2. PUT persists + respawns ONLY aa (its boot-probe count grows; bb's
    //    does not).
    const put = await fetch(`${base}/api/bots/aa/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/custom-flash" }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { model: "stub/custom-flash" });
    await waitFor(() => bootProbes("aa") > aaBoots);
    assert.equal(bootProbes("bb"), bbBoots, "siblings untouched");
    assert.equal(
      (await (await fetch(`${base}/api/bots/aa/model`)).json()).model,
      "stub/custom-flash"
    );
    // Persisted in the state store, not by rewriting the manifest.
    const state = JSON.parse(
      readFileSync(join(fleetDir, ".fleet", "state.json"), "utf8")
    );
    assert.equal(state.models?.aa, "stub/custom-flash");

    // 3. Restart survival: stop + start → GET still reports the override.
    await handle.stop();
    const second = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      piBin: wrapper,
      log: () => {},
    });
    handles.push(second);
    const base2 = `http://127.0.0.1:${second.port}`;
    await waitFor(async () =>
      (
        (await (await fetch(`${base2}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );
    assert.equal(
      (await (await fetch(`${base2}/api/bots/aa/model`)).json()).model,
      "stub/custom-flash",
      "override survives restart"
    );

    // 4. Clear back to default; opaque errors; unknown bot 404.
    await fetch(`${base2}/api/bots/aa/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    assert.deepEqual(await (await fetch(`${base2}/api/bots/aa/model`)).json(), {
      model: "",
    });
    const ghostRaw = await (
      await fetch(`${base2}/api/bots/ghost/model`)
    ).text();
    assert.equal(JSON.parse(ghostRaw).error, "unknown bot");
    const badRaw = await (
      await fetch(`${base2}/api/bots/aa/model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: 7 }),
      })
    ).text();
    assert.equal(JSON.parse(badRaw).error, "model (string) required");
    for (const raw of [ghostRaw, badRaw]) {
      assert.ok(!raw.includes("bots.toml"), "manifest never named on the wire");
    }
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
