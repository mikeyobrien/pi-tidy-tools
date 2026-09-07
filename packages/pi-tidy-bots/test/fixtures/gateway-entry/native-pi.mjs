// Deterministic stdin/stdout Pi RPC child. It never loads Pi, a provider, user
// extensions, credentials, or a real model. Native input/output is recorded so
// assertions can relate public HTTP/WS events to the actual child boundary.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const dir = process.env.GATEWAY_ENTRY_CONTROL;
const name = process.env.PI_TIDY_BOTS_NAME;
const trace = (direction, frame) =>
  appendFileSync(
    join(dir, "native.jsonl"),
    JSON.stringify({ name, direction, frame }) + "\n"
  );
const send = (frame) => {
  trace("out", frame);
  process.stdout.write(JSON.stringify(frame) + "\n");
};
const respond = (request, data = {}) =>
  send({ type: "response", id: request.id, success: true, data });
const control = (file) => existsSync(join(dir, file));
const textMessage = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const finish = (text = "Finished") => {
  send({ type: "message_start", message: textMessage("") });
  send({ type: "message_end", message: textMessage(text) });
  send({ type: "turn_end", message: { usage: { input: 10 } } });
  send({ type: "agent_end" });
  send({ type: "agent_settled" });
};
let waiting;
const run = (request) => {
  send({ type: "turn_start" });
  send({ type: "agent_start" });
  const text = String(request.message ?? "");
  if (text === "question" || text === "question-crash") {
    waiting = text;
    send({
      type: "extension_ui_request",
      id: text,
      method: "select",
      title: "Choose a release window",
      options: ["Morning", "Evening"],
    });
    return;
  }
  if (text === "stream") {
    send({ type: "message_start", message: textMessage("") });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Narration A" },
    });
    send({ type: "message_end", message: textMessage("Narration A") });
    send({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "sample.txt" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      result: "sample contents",
      isError: false,
      piTidyElapsedMs: 5,
    });
    send({ type: "message_start", message: textMessage("") });
    send({ type: "message_end", message: textMessage("") });
    send({ type: "message_start", message: textMessage("") });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Narration B" },
    });
    send({ type: "message_end", message: textMessage("Narration B") });
    waiting = "stream";
    return;
  }
  if (text === "handoff") {
    void fetch(`${process.env.PI_TIDY_BOTS_DAEMON_URL}/bus/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fleet-child": process.env.PI_TIDY_BOTS_CHILD_SECRET,
      },
      body: JSON.stringify({
        from: name,
        target: "bb",
        message: "fixture brief",
      }),
    }).then(async (response) => {
      trace("bus", { status: response.status, body: await response.json() });
      finish("Dispatched");
    });
    return;
  }
  finish(text.includes("fixture brief") ? "Worker result" : `Reply: ${text}`);
};

// Offline at boot lets the real HTTP handler admit a queued item. Wake/restart
// is still the daemon's code, and is unblocked only by an explicit test file.
if (control("offline")) process.exit(0);
const timer = setInterval(() => {
  if (control("crash")) process.exit(17);
  if (waiting === "stream" && control("finish-stream")) {
    waiting = undefined;
    send({ type: "turn_end", message: { usage: { input: 10 } } });
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
  }
}, 20);
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  clearInterval(timer);
  process.exit(0); // Parent EOF owns this child; no detached process survives.
});
input.on("line", (line) => {
  const request = JSON.parse(line);
  trace("in", request);
  if (request.type === "get_state") {
    respond(request, {
      model: { id: "fake-model", contextWindow: 128000 },
      streaming: false,
      usage: { input: 10 },
    });
  } else if (request.type === "get_messages") {
    respond(request, { messages: [] });
  } else if (request.type === "compact") {
    send({
      type: "response",
      id: request.id,
      success: false,
      error: "Already compacted",
    });
  } else if (request.type === "extension_ui_response") {
    if (request.id === waiting) {
      waiting = undefined;
      finish(`Selected ${request.value}`);
    }
  } else if (request.type === "prompt" || request.type === "follow_up") {
    if (String(request.message) === "unknown") return; // No accept or reject.
    respond(request);
    // Follow-ups remain parked until the test releases them. This observes
    // real daemon queue semantics without depending on a millisecond race.
    if (
      request.type === "follow_up" ||
      request.streamingBehavior === "followUp"
    ) {
      const gate = setInterval(() => {
        if (control("release-queue")) {
          clearInterval(gate);
          run(request);
        }
      }, 20);
    } else {
      setTimeout(() => run(request), 20);
    }
  } else if (request.id !== undefined) {
    respond(request);
  }
});
