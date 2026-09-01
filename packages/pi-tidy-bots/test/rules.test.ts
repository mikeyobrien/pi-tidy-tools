import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcSpawnArgs } from "../src/rpc.ts";

// Issue 82: fleet-wide rules — persisted at {fleet}/.fleet/rules.md, edited
// via GET/PUT /api/rules ({text}, empty file is "" not 404), injected into
// every bot on its NEXT spawn via --append-system-prompt. AGENTS.md is never
// rewritten and in-flight turns are never steered.

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

test("rpcSpawnArgs carries rules only when present", () => {
  const base = {
    name: "aa",
    cwd: "/tmp",
    sessionDir: "/tmp/s",
    resume: false,
    approve: false,
    bridgePath: "/b.ts",
    daemonUrl: "http://x",
    childSecret: "s",
  };
  const bare = rpcSpawnArgs(base);
  assert.ok(!bare.includes("--append-system-prompt"), "no rules, no flag");
  const withRules = rpcSpawnArgs({
    ...base,
    appendSystemPrompt: "Be terse. Sign nothing.",
  });
  const index = withRules.indexOf("--append-system-prompt");
  assert.equal(withRules[index + 1], "Be terse. Sign nothing.");
});

test("rules API round-trip: empty by default, PUT persists (issue 82)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-rules-"));
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
    await waitFor(async () => (await fetch(`${base}/api/fleet`)).ok);

    // Missing rules file: empty text, 200 — never 404.
    const empty = await fetch(`${base}/api/rules`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { text: "" });

    // PUT persists; GET reads back; the file lands at .fleet/rules.md.
    const put = await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "# Fleet rules\n\nReply tersely." }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      (await (await fetch(`${base}/api/rules`)).json()).text,
      "# Fleet rules\n\nReply tersely."
    );
    assert.equal(
      existsSync(join(fleetDir, ".fleet", "rules.md")),
      true,
      "persisted on disk"
    );

    // Clearing via empty string is valid too.
    await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.deepEqual(await (await fetch(`${base}/api/rules`)).json(), {
      text: "",
    });

    // Non-string body: 400.
    const bad = await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 42 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
