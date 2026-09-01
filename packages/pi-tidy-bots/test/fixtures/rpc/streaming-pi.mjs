// Streaming child runner (issue 74): a stand-in for `pi --mode rpc` that
// answers the daemon's probes and, on each prompt, emits a realistic turn —
// turn_start → agent_start → tool run → assistant message → turn_end →
// agent_end — and only THEN resolves the prompt request, exactly like the
// real harness (prompt() resolves when the turn finishes, not when it is
// accepted). The daemon must therefore learn "accepted" from agent_start.
//
// Events fire on timers so tests can observe the mid-turn window where the
// operator bubble must already read as delivering=false.
import readline from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendFileSync } from "node:fs";

// Issue 58 test seam: record every inbound request so tests can prove a
// session was (or was NOT) prompted. Opt-in via PTB_STUB_TRACE.
const trace = (kind, text, images = 0) => {
  if (process.env.PTB_STUB_TRACE)
    appendFileSync(
      process.env.PTB_STUB_TRACE,
      JSON.stringify({
        name: process.env.PI_TIDY_BOTS_NAME,
        kind,
        text,
        images,
      }) + "\n"
    );
};

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const respond = (id, extra = {}) =>
  send({ type: "response", id, success: true, ...extra });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.type === "get_state") {
    respond(request.id, {
      result: { contextWindow: 128000, streaming: false },
    });
    return;
  }
  if (request.type === "get_messages") {
    respond(request.id, { result: { messages: [] } });
    return;
  }
  if (request.type === "prompt" || request.type === "follow_up") {
    trace(
      request.type,
      String(request.message ?? ""),
      Array.isArray(request.images) ? request.images.length : 0
    );
    // Real pi acks follow_up immediately (it queues inside the child); the
    // turn streams afterwards. Only prompt resolves when its turn finishes.
    // A prompt carrying streamingBehavior is a daemon-side queued handoff —
    // it also streams LATER, behind the running turn.
    const queued =
      request.type === "follow_up" || request.streamingBehavior === "followUp";
    // Queued deliveries (follow_up request, or a prompt carrying
    // streamingBehavior) ack on ACCEPTANCE — the turn streams later. Plain
    // prompts resolve when their turn finishes.
    if (request.type === "follow_up" || request.streamingBehavior !== undefined)
      respond(request.id);
    // Deterministic queue tests: when PTB_STUB_HOLD_DIR is set, queued
    // turns WAIT for <dir>/release before streaming — the daemon-side
    // journal can be observed at leisure, then released to drain.
    const hold = () =>
      existsSync(join(process.env.PTB_STUB_HOLD_DIR ?? ".", "release"));
    const run = () => {
      send({ type: "turn_start" });
      send({ type: "agent_start" });
      send({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "sleep 5" },
      });
      // Issue 66: partial output mid-run, then a settle frame carrying the
      // result text, isError flag, and measured duration — exactly the real
      // harness contract the daemon must map.
      setTimeout(() => {
        send({
          type: "tool_execution_update",
          toolCallId: "t1",
          partialResult: "still sleeping...\n",
        });
      }, 350);
      setTimeout(() => {
        send({
          type: "tool_execution_end",
          toolCallId: "t1",
          result: "slept fine",
          isError: false,
          piTidyElapsedMs: 650,
        });
        send({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        });
        send({ type: "turn_end", message: { usage: { input: 10 } } });
        send({ type: "agent_end" });
        send({ type: "agent_settled" });
        if (request.type === "prompt" && !request.streamingBehavior)
          respond(request.id);
      }, 700);
    };
    if (queued && process.env.PTB_STUB_HOLD_DIR) {
      const wait = setInterval(() => {
        if (hold()) {
          clearInterval(wait);
          run();
        }
      }, 50);
      return;
    }
    setTimeout(run, queued ? 1200 : 100);
    return;
  }
  if (request.id !== undefined) respond(request.id);
});
