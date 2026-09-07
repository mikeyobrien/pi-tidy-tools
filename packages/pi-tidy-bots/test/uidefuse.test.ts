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

// Issue 136: child death defuses pending question cards through the
// standard resolution path — cards settle read-only everywhere (system
// entry + uiResolved + WS append) instead of freezing open with answers
// 404ing forever.

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

test(
  "child death defuses pending question cards (issue 136)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-uidefuse-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    // A stub that hangs with a live interactive question pending: prints a
    // confirm request then never responds — the daemon cards it. Killing
    // the child (crash simulation) must defuse the card, not freeze it.
    const questionStub = join(fleetDir, "question-pi.mjs");
    writeFileSync(
      questionStub,
      `import { createInterface } from "node:readline";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === "get_state") {
    send({ type: "response", id: request.id, success: true, data: { model: { contextWindow: 128000 } } });
    return;
  }
  if (request.type === "get_messages") {
    send({ type: "response", id: request.id, success: true, data: { messages: [] } });
    return;
  }
  if (request.type === "prompt") {
    send({ type: "turn_start" });
    send({ type: "agent_start" });
    send({
      type: "extension_ui_request",
      id: "q1",
      method: "confirm",
      title: "Deploy to prod?",
      message: "The migration is staged.",
    });
    // Never resolves the prompt — stays alive holding the open question.
  }
  if (request.id !== undefined && request.type) {
    send({ type: "response", id: request.id, success: true });
  }
});
setInterval(() => {}, 1 << 30);
`
    );
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${questionStub}\n`);
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

      // Turn 1: the bot asks; the card pends.
      void fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "deploy when ready" }),
      });
      const transcript = async () =>
        (
          (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
            transcript: {
              role: string;
              text: string;
              ui?: { id: string };
              uiResolved?: unknown;
            }[];
          }
        ).transcript;
      await waitFor(async () =>
        (await transcript()).some((e) => e.ui?.id === "q1")
      );

      // Crash the child mid-question (issue 136's trigger). Find its pid via
      // the runtime's process: the stub writes nothing else, so kill by
      // matching the wrapper script path in the process list.
      const ps = spawnSync("ps", ["ax", "-o", "pid,command"], {
        encoding: "utf8",
      });
      const victim = ps.stdout
        .split("\n")
        .find((line) => line.includes("question-pi.mjs"));
      assert.ok(victim, "stub child found");
      const victimPid = Number(victim.trim().split(/\s+/)[0]);
      process.kill(victimPid, "SIGKILL");

      // The card defuses: uiResolved lands on the entry (cancelled, auto),
      // a system entry records it, and a re-answer no longer 404s a live
      // card (the pending map is empty; the old behavior kept the card).
      // The resolution lands as its own system entry carrying uiResolved
      // (standard resolveUi shape — same lane an operator answer uses).
      await waitFor(async () => {
        const entries = await transcript();
        return entries.some(
          (e) => (e as { uiResolved?: { id?: string } }).uiResolved?.id === "q1"
        );
      });
      const entries = await transcript();
      const resolution = entries.find(
        (e) => (e as { uiResolved?: { id?: string } }).uiResolved?.id === "q1"
      );
      assert.ok(resolution?.text.includes("cancelled"), "resolution is cancel");
      assert.ok(
        resolution?.text.includes("(auto)"),
        "marked auto — child-death defusal"
      );
      const answer = await fetch(`${base}/api/bots/aa/ui/q1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: false }),
      });
      assert.equal(
        answer.status,
        404,
        "no live card remains after defusal (was the frozen affordance)"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
