import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("routine added to an existing bot registers live (issue 157)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-r157-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    const manifest = join(fleetDir, "bots.toml");
    writeFileSync(manifest, `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`);
    const wrapper = join(fleetDir, "pi.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
    spawnSync("chmod", ["+x", wrapper]);
    delete process.env.PTB_STUB_TRACE;

    const { startFleet } = await import(
      "../src/daemon.ts"
    );
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
    const routines = async () =>
      (
        (await (await fetch(`${base}/api/routines`)).json()) as {
          routines: { bot: string; name: string }[];
        }
      ).routines;
    assert.equal((await routines()).length, 0, "no routines initially");

    // Edit the manifest: add a routine to the EXISTING bot.
    writeFileSync(
      manifest,
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\nroutines = [{name = "health", schedule = "5 * * * *", prompt = "ping"}]\n`
    );
    await waitFor(async () =>
      (await routines()).some((r) => r.bot === "aa" && r.name === "health")
    );
    // The toggle no longer 404s.
    const toggle = await fetch(
      `${base}/api/bots/aa/routines/health/toggle`,
      { method: "POST" }
    );
    assert.equal(toggle.status, 200, "toggle works after live add");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
