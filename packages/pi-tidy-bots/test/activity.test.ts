import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 99-FAIL regression: blanket touch() stamped BOOT NOISE (session
// primers, extension status pings, replay deltas) as activity — idle bots
// showed the boot second and the poison persisted via state.json. Touch now
// fires only on activity-bearing kinds; status pings (fire-and-forget UI)
// and raw `event` frames never stamp.

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

test("boot noise never stamps lastActive; real activity does (99-FAIL)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-99f-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    // A quiet stub: answers probes, emits ONLY boot-noise frames (status
    // pings + raw events), never a turn — the 99-FAIL bot shape.
    const quiet = join(fleetDir, "quiet-pi.mjs");
    writeFileSync(
      quiet,
      `import { createInterface } from "node:readline";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === "get_state") {
    send({ type: "response", id: request.id, success: true, data: { model: { contextWindow: 128000 } } });
    // Boot noise after the probe: status ping + unknown raw frame.
    send({ type: "extension_ui_request", id: "ping-1", method: "setStatus", statusKey: "mcp", statusText: "1 server" });
    send({ type: "warp_core_breach", deck: 12 });
    return;
  }
  if (request.type === "get_messages") {
    send({ type: "response", id: request.id, success: true, data: { messages: [] } });
    return;
  }
  if (request.id !== undefined) send({ type: "response", id: request.id, success: true });
});
setInterval(() => {
  // Steady drip of the same noise.
  send({ type: "extension_ui_request", id: "ping-" + Date.now(), method: "setStatus", statusKey: "mcp", statusText: "still here" });
}, 400);
`
    );
    const wrapper = join(fleetDir, "pi.sh");
    writeFileSync(wrapper, `#!/bin/sh\\nexec node ${quiet}\\n`.replace("\\\\n", "\\n"));
    writeFileSync(wrapper, "#!/bin/sh\nexec node " + quiet + "\n");
    spawnSync("chmod", ["+x", wrapper]);
    delete process.env.PTB_STUB_TRACE;

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
    // Let the noise drip for 2s.
    await new Promise((r) => setTimeout(r, 2000));

    const context = (await (
      await fetch(`${base}/api/bots/aa/context`)
    ).json()) as { lastActive: string | null };
    // Never-active bots seed from the epoch (99), never the boot second.
    const stamped =
      context.lastActive !== null &&
      Date.now() - Date.parse(context.lastActive) < 3_600_000;
    assert.equal(
      stamped,
      false,
      `boot noise + status pings never stamp lastActive (got ${context.lastActive})`
    );

    // The poison path is closed too: nothing in state.json's lastActive map.
    await handle.stop();
    // No poison persisted: either state.json is absent (nothing ever
    // touched — strongest form) or its lastActive map lacks aa.
    const statePath = join(fleetDir, ".fleet", "state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        lastActive?: Record<string, string>;
      };
      assert.equal(
        state.lastActive?.aa,
        undefined,
        "no poison persisted for the quiet bot"
      );
    }

    // Positive control on the SAME fleet: the normal streaming stub's
    // turn events DO stamp (activity kinds intact).
    const wrapper2 = join(fleetDir, "pi2.sh");
    writeFileSync(wrapper2, "#!/bin/sh\nexec node " + runner + "\n");
    spawnSync("chmod", ["+x", wrapper2]);
    const second = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      piBin: wrapper2,
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
    await fetch(`${base2}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "real work" }),
    });
    await waitFor(async () => {
      const context = (await (
        await fetch(`${base2}/api/bots/aa/context`)
      ).json()) as { lastActive: string | null };
      return context.lastActive !== null;
    });
    assert.ok(true, "turn events stamp lastActive (positive control)");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
