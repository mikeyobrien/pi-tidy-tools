import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { TurnPartsAccumulator } from "../src/turnparts.ts";

// Issue 124: turnText overwrite. A narration A → tool → narration B turn
// must settle with BOTH narrations in entry.text (from the parts model),
// live delta frames must never wipe to "" at the tool-call-only message
// boundary, and narration blocks stay DISTINCT text parts (123's styling
// signal). Whole-message (no deltas) and streamed paths both covered.

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

test("accumulator: splitText keeps narration blocks distinct", () => {
  const acc = new TurnPartsAccumulator();
  acc.appendText("Narration A");
  acc.splitText();
  acc.appendText("Narration B");
  const texts = acc
    .snapshot()
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text);
  assert.deepEqual(texts, ["Narration A", "Narration B"], "two parts");
  assert.equal(acc.concatText(), "Narration ANarration B", "concat intact");
  // A split with no following text is a no-op.
  acc.splitText();
  assert.equal(acc.snapshot().length, 2);
});

async function runTurnCase(mode: "whole" | "delta") {
  const fleetDir = mkdtempSync(join(tmpdir(), `ptb-midturn-${mode}-`));
  const handles: Array<{ stop(): Promise<void> }> = [];
  process.env.PTB_STUB_MULTI = mode;
  delete process.env.PTB_STUB_WINDOW;
  delete process.env.PTB_STUB_USAGE;
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    const wrapper = join(fleetDir, "pi.sh");
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

    // Live delta frames: collect while the turn runs.
    const deltaFrames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`);
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "bubble" && frame.phase === "delta")
        deltaFrames.push(String(frame.text ?? ""));
    });
    await new Promise((resolve) => ws.once("open", resolve));

    const sent = fetch(`${base}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go" }),
    });

    const transcript = async () =>
      (
        (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
          transcript: {
            role: string;
            text: string;
            parts?: { type: string; text?: string; status?: string }[];
          }[];
        }
      ).transcript;
    await waitFor(async () =>
      (await transcript()).some(
        (e) => e.role === "assistant" && e.text.includes("Narration B")
      )
    );
    await sent;
    await new Promise((r) => setTimeout(r, 400));
    ws.close();

    const entry = (await transcript()).find(
      (e) => e.role === "assistant" && e.text.includes("Narration B")
    );
    // Acceptance 1: BOTH narrations in the canonical text.
    assert.ok(
      entry && entry.text.includes("Narration A") && entry.text.includes("Narration B"),
      `${mode}: entry.text carries both narrations — got "${entry?.text}"`
    );
    // Acceptance 3: distinct text parts per message boundary, tool between.
    const parts = entry?.parts ?? [];
    const shape = parts.map((part) =>
      part.type === "text" ? `text:${part.text}` : `tool:${part.status}`
    );
    assert.deepEqual(shape, [
      "text:Narration A",
      "tool:ok",
      "text:Narration B",
    ], `${mode}: ordered, distinct parts`);
    // Acceptance 2: no live wipe — the A→""→B overwrite is gone.
    assert.ok(
      deltaFrames.length > 0,
      `${mode}: delta frames observed`
    );
    assert.ok(
      !deltaFrames.includes(""),
      `${mode}: no empty delta frame at the tool-only boundary`
    );
    assert.ok(
      deltaFrames.some((frame) => frame.includes("Narration A")),
      `${mode}: narration A visible live`
    );
    const lastWithB = deltaFrames.find((frame) => frame.includes("Narration B"));
    assert.ok(
      lastWithB !== undefined && lastWithB.includes("Narration A"),
      `${mode}: delta frames are cumulative — A survives into the B frames`
    );
  } finally {
    delete process.env.PTB_STUB_MULTI;
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
}

test("mid-turn interleaving, whole-message path (issue 124)", () => runTurnCase("whole"));
test("mid-turn interleaving, streamed-delta path (issue 124)", () => runTurnCase("delta"));
