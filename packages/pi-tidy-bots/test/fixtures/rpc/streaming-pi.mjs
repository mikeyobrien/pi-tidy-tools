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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendFileSync } from "node:fs";

// Issue 58 test seam: record every inbound request so tests can prove a
// session was (or was NOT) prompted. Opt-in via PTB_STUB_TRACE.
const trace = (kind, text, images = 0) => {
  if (!process.env.PTB_STUB_TRACE) return;
  try {
    appendFileSync(
      process.env.PTB_STUB_TRACE,
      JSON.stringify({
        name: process.env.PI_TIDY_BOTS_NAME,
        kind,
        text,
        images,
      }) + "\n"
    );
  } catch {
    // Stale trace path (test fleet torn down) — never kill the stub.
  }
};

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const freshSession = () =>
  existsSync(
    join(dirname(process.env.PTB_STUB_TRACE ?? "."), "fresh-session")
  );

// Issue 43 amendment test knobs: window from a FILE (so a test can change it
// between spawns) else env, else 128000 default.
const stubWindow = () => {
  if (process.env.PTB_STUB_WINDOW_FILE) {
    try {
      const value = Number(readFileSync(process.env.PTB_STUB_WINDOW_FILE, "utf8"));
      if (Number.isFinite(value) && value > 0) return value;
    } catch {}
  }
  if (process.env.PTB_STUB_WINDOW !== undefined) {
    const value = Number(process.env.PTB_STUB_WINDOW);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 128000;
};
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
    trace("get_state", "");
    send({
      type: "response",
      id: request.id,
      success: true,
      data: {
        model: { contextWindow: stubWindow() },
        streaming: false,
        // Issue 79 layer 2: the child's OWN usage numbers — ground truth
        // the daemon must prefer over its fill estimates.
        ...(process.env.PTB_STUB_STATE_USAGE_FILE !== undefined
          ? (() => {
              // Issue 79: file-backed so a test can flip the child's
              // reported usage across the session-reset respawn.
              try {
                const n = Number(
                  readFileSync(process.env.PTB_STUB_STATE_USAGE_FILE, "utf8").trim()
                );
                if (Number.isFinite(n)) return { usage: { input: n } };
              } catch {}
              return {};
            })()
          : process.env.PTB_STUB_STATE_USAGE !== undefined
            ? { usage: { input: Number(process.env.PTB_STUB_STATE_USAGE) } }
            : {}),
      },
    });
    return;
  }
  if (request.type === "get_messages") {
    respond(request.id, { result: { messages: [] } });
    return;
  }
  if (request.type === "set_model") {
    trace("set_model", `${request.provider}/${request.modelId}`);
    // pi returns the full Model object under data.model — the REAL window
    // for the switched-to model (no fixture fiction: a fabricated window
    // poisons the daemon's live telemetry on the restore path, issue 149).
    send({
      type: "response",
      id: request.id,
      success: true,
      data: { model: { contextWindow: stubWindow(), id: request.modelId } },
    });
    return;
  }
  if (request.type === "compact") {
    trace(
      "compact",
      process.env.PTB_STUB_COMPACT_FAIL === "1"
        ? "FAIL"
        : process.env.PTB_STUB_COMPACT_REFUSAL
          ? `REFUSE(${process.env.PTB_STUB_COMPACT_REFUSAL})`
          : "ok"
    );
    if (process.env.PTB_STUB_COMPACT_REFUSAL === "already") {
      // Issue 79: pi's compaction state says done — the terminal no-op
      // refusal the daemon used to classify as delivery_failed.
      send({
        type: "response",
        id: request.id,
        success: false,
        error: "Already compacted",
      });
      return;
    }
    if (process.env.PTB_STUB_COMPACT_FAIL === "1") {
      // A failed compact models a hard reset in these tests: subsequent
      // turns (including in RESPAWNED stub processes) report a SMALL
      // fresh-session usage, not the oversized knob. File-based so the
      // marker survives the session-reset respawn.
      try {
        writeFileSync(
          join(dirname(process.env.PTB_STUB_TRACE ?? "."), "fresh-session"),
          "1"
        );
      } catch {}
      send({
        type: "response",
        id: request.id,
        success: false,
        error: "provider_error: summarization refused",
      });
      return;
    }
    send({
      type: "response",
      id: request.id,
      success: true,
      data: { summary: "stub summary", tokensBefore: 1, estimatedTokensAfter: 1 },
    });
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
    // Issue 149 (repro-verified against real pi): ALL prompt-class requests
    // ack on ACCEPTANCE — real children resolve the RPC when the turn is
    // accepted (<10ms), never at turn end. Events stream afterwards.
    if (request.type === "prompt" || request.type === "follow_up")
      respond(request.id);
    // Deterministic queue tests: when PTB_STUB_HOLD_DIR is set, queued
    // turns WAIT for <dir>/release before streaming — the daemon-side
    // journal can be observed at leisure, then released to drain.
    const hold = () =>
      existsSync(join(process.env.PTB_STUB_HOLD_DIR ?? ".", "release"));
    const run = () => {
      send({ type: "turn_start" });
      send({ type: "agent_start" });
      // Issue 124 fixture mode: a turn with narration A → tool → narration B
      // (three assistant messages; the tool-call-only middle one carries no
      // text). PTB_STUB_MULTI=whole sends complete messages (no deltas);
      // =delta streams each message's text first. Both must interleave.
      // Issue 128 fixture: the turn dispatches via message_agent (tool part
      // carries the receipt chip); the embedded brief is long so the
      // bounded-reason rule is observable.
      if (process.env.PTB_STUB_DISPATCH) {
        send({
          type: "tool_execution_start",
          toolCallId: "t9",
          toolName: "message_agent",
          args: {
            target: "bb",
            message:
              "Full dispatch brief that goes on for a while: rebuild the widget, verify gates, report hashes back. ".repeat(
                3
              ),
          },
        });
        send({
          type: "tool_execution_end",
          toolCallId: "t9",
          result: "Delivered to bb.",
          isError: false,
          piTidyElapsedMs: 12,
        });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "dispatched" }] } });
        send({ type: "turn_end", message: { usage: { input: 10 } } });
        send({ type: "agent_end" });
        send({ type: "agent_settled" });
        return;
      }
      if (process.env.PTB_STUB_MULTI) {
        const streamed = process.env.PTB_STUB_MULTI === "delta";
        const message = (text) => ({
          role: "assistant",
          content: [{ type: "text", text }],
        });
        const emitMessage = (text) => {
          send({ type: "message_start", message: message("") });
          if (streamed) {
            for (const chunk of text.match(/.{1,4}/g) ?? [])
              send({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: chunk },
              });
          }
          send({ type: "message_end", message: message(text) });
        };
        emitMessage("Narration A");
        send({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "true" },
        });
        send({
          type: "tool_execution_end",
          toolCallId: "t1",
          result: "ok",
          isError: false,
          piTidyElapsedMs: 5,
        });
        send({ type: "message_start", message: message("") });
        send({ type: "message_end", message: message("") }); // tool-only msg
        emitMessage("Narration B");
        setTimeout(() => {
          send({ type: "turn_end", message: { usage: { input: 10 } } });
          send({ type: "agent_end" });
          send({ type: "agent_settled" });
        }, 300);
        return;
      }
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
        send({
          type: "turn_end",
          message: {
            usage: {
              input: freshSession()
                ? 10
                : process.env.PTB_STUB_USAGE !== undefined
                  ? Number(process.env.PTB_STUB_USAGE)
                  : 10,
            },
          },
        });
        send({ type: "agent_end" });
        send({ type: "agent_settled" });
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
