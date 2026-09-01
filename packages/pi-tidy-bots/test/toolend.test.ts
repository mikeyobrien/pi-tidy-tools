import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 66: tool_execution_end is THE settle event (result text, isError,
// measured duration) and tool_execution_update carries partial output.
// Before the mapping, every tool stayed "running" and the settle fallback
// rendered ALL of them failed with no duration — 282/282 error parts in
// production transcripts.

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

interface ToolPart {
  type: string;
  status?: string;
  duration?: number;
  output?: string;
  toolCallId?: string;
}

test("tool_execution_end settles tools: ok status, duration, output (issue 66)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-toolend-"));
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
    await waitFor(async () => await (await fetch(`${base}/api/fleet`)).ok);

    const first = fetch(`${base}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "run the tool" }),
    });
    await first;

    const transcript = async () =>
      (
        (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
          transcript: {
            parts?: ToolPart[];
            steps?: { output?: string; error?: boolean; duration?: number }[];
          }[];
        }
      ).transcript;
    await waitFor(async () => {
      const entries = await transcript();
      const settled = entries
        .at(-1)
        ?.parts?.find(
          (part) => part.type === "tool" && part.status !== "running"
        );
      return settled !== undefined;
    });

    const entries = await transcript();
    const tool = entries.at(-1)?.parts?.find((part) => part.type === "tool");
    assert.ok(tool, "tool part exists");
    assert.equal(tool?.status, "ok", "successful call settles ok, not error");
    assert.equal(tool?.duration, 650, "measured duration from the wire");
    assert.equal(tool?.output, "slept fine", "result text rides the part");
    // Steps view is mode-gated (output only in full mode); duration is the
    // mode-independent settle fact.
    const withSteps = entries.filter((e) => (e.steps ?? []).length > 0).at(-1);
    const step = withSteps?.steps?.[0];
    assert.equal(step?.duration, 650, "step duration settled");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
