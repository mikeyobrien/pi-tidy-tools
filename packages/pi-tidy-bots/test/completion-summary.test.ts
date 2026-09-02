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
import { createTranscriptStore } from "../src/transcripts.ts";

// Issue 122: the receiving agent attaches a one-line summary to its latest
// peer-completion entry (kind=completion). Daemon stores + serves; it never
// writes the text. Survives restart; legacy entries unchanged.

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

test("transcript store save(): mutate entries, no duplicates vs rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-tsave-"));
  try {
    const store = createTranscriptStore(dir, 400);
    for (let i = 0; i < 6; i++)
      store.append("aa", { id: `e${i}`, text: "x".repeat(30) });
    // Force rotation past the cap, then mutate + save the merged view.
    const merged = store.load("aa") as { id: string }[];
    const withSummary = merged.map((entry, index) =>
      index === merged.length - 1 ? { ...entry, summary: "done" } : entry
    );
    store.save("aa", withSummary);
    const reloaded = store.load("aa") as { id: string; summary?: string }[];
    const ids = reloaded.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicates after save");
    assert.equal(reloaded.at(-1)?.summary, "done", "mutation persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "completion summary: attach via API, restart survival, legacy-safe (issue 122)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-csum-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n[[bot]]\nname = "bb"\ndir = "bots/bb"\n`
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
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      // Peer handoff aa→bb; bb settles → completion lands on aa.
      const bus = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({ from: "aa", target: "bb", message: "do it" }),
      });
      assert.equal(((await bus.json()) as { delivered?: boolean }).delivered, true);

      const transcript = async () =>
        (
          (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
            transcript: {
              kind?: string;
              text: string;
              summary?: string;
            }[];
          }
        ).transcript;
      await waitFor(async () =>
        (await transcript()).some((e) => e.kind === "completion")
      );

      // The receiving agent (aa) attaches its one-line summary mid-turn —
      // via the same authorized surface the bridge tool uses.
      const attach = await fetch(`${base}/api/bots/aa/completion-summary`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({ summary: "bb landed the fix — re-verified green" }),
      });
      assert.equal(attach.status, 200);
      assert.deepEqual(await attach.json(), { attached: true });
      const withSummary = (await transcript()).find(
        (e) => e.kind === "completion"
      );
      assert.equal(
        withSummary?.summary,
        "bb landed the fix — re-verified green"
      );
      // Legacy-safe: other entries carry no summary field.
      assert.ok(
        (await transcript())
          .filter((e) => e.kind !== "completion")
          .every((e) => e.summary === undefined)
      );

      // Invalid payloads.
      const empty = await fetch(`${base}/api/bots/aa/completion-summary`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "  " }),
      });
      assert.equal(empty.status, 400);
      const ghost = await fetch(`${base}/api/bots/zz/completion-summary`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "x" }),
      });
      assert.equal(ghost.status, 404);

      // Restart survival: the journal carries the summary into the next boot.
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
      await waitFor(async () => {
        const after = (
          (await (await fetch(`${base2}/api/bots/aa/transcript`)).json()) as {
            transcript: { kind?: string }[];
          }
        ).transcript;
        return after.some((e) => e.kind === "completion");
      });
      const after = (
        (await (await fetch(`${base2}/api/bots/aa/transcript`)).json()) as {
          transcript: { kind?: string; summary?: string }[];
        }
      ).transcript;
      assert.equal(
        after.find((e) => e.kind === "completion")?.summary,
        "bb landed the fix — re-verified green",
        "summary survives restart"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
