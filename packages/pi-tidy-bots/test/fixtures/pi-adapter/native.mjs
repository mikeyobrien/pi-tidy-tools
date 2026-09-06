#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
const handlers = new Map(),
  tools = new Map();
const extensionPath = process.argv[process.argv.indexOf("-e") + 1];
const ctx = { sessionManager: { getSessionId: () => "fixture-session" } };
if (extensionPath?.endsWith("fleet-extension.mjs")) {
  const extension = await import(pathToFileURL(extensionPath).href);
  extension.default({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
  });
  await handlers.get("session_start")({}, ctx);
}
const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
const logPath = join(dirname(sessionDir), "native-effects.jsonl");
const log = (record) => appendFileSync(logPath, JSON.stringify(record) + "\n");
log({
  launch: process.pid,
  argv: process.argv.slice(2),
  environmentKeys: Object.keys(process.env).sort(),
  profile: process.env.PI_CODING_AGENT_DIR,
});
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const response = (request, data, success = true) =>
  send({
    type: "response",
    id: request.id,
    command: request.type,
    success,
    data,
  });
const message = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "PRIVATE_REASONING_CANARY" },
    { type: "text", text },
  ],
  stopReason,
});
const final = (text, stopReason) =>
  send({ type: "message_end", message: message(text, stopReason) });
const start = () =>
  send({ type: "message_start", message: { role: "assistant", content: [] } });
const delta = (text) =>
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  });
const settle = () => {
  handlers.get("agent_end")?.({}, ctx);
  send({ type: "agent_end" });
  send({ type: "agent_settled" });
};
let held = false;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log({
    command: request.type,
    id: request.id,
    text: request.message,
    ...(request.images ? { images: request.images } : {}),
  });
  if (request.type === "get_state") {
    response(request, {
      sessionId: "fixture-session",
      sessionFile: join(sessionDir, "history.jsonl"),
      isStreaming: false,
      messageCount: 0,
      pendingMessageCount: 0,
    });
  } else if (request.type === "prompt") {
    if (request.message === "[reject]") {
      response(request, undefined, false);
      continue;
    }
    if (request.message === "[unknown]") continue;
    response(request);
    send({ type: "agent_start" });
    await handlers.get("agent_start")?.({}, ctx);
    if (
      ["[fleet-send]", "[fleet-no-events]", "[fleet-send:hermes]"].includes(
        request.message
      )
    ) {
      const args = {
        target: request.message === "[fleet-send:hermes]" ? "hermes" : "peer",
        text: "fixture task",
      };
      if (request.message !== "[fleet-no-events]")
        send({
          type: "tool_execution_start",
          toolCallId: "fleet-native-one",
          toolName: "fleet_send",
          args,
        });
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await tools
          .get("fleet_send")
          .execute("fleet-native-one", args, undefined, undefined, ctx);
        log({ fleetResult: result });
      }
      if (request.message !== "[fleet-no-events]")
        send({
          type: "tool_execution_end",
          toolCallId: "fleet-native-one",
          result,
          isError: false,
        });
    }
    if (request.message === "[fleet-unsettled]")
      send({
        type: "tool_execution_start",
        toolCallId: "unsettled",
        toolName: "fleet_send",
        args: {},
      });
    if (request.message === "[malformed]") {
      process.stdout.write("{bad native json}\n");
      continue;
    }
    if (request.message === "[oversize]") {
      process.stdout.write(" ".repeat(2 * 1024 * 1024));
      continue;
    }
    if (request.message === "[invalid-utf8]") {
      process.stdout.write(Buffer.from([0xff, 10]));
      continue;
    }
    if (request.message === "[tool]") {
      send({
        type: "tool_execution_start",
        toolCallId: "unexpected",
        toolName: "bash",
        args: {},
      });
      continue;
    }
    start();
    if (request.message === "[hold]") {
      held = true;
      delta("working");
      continue;
    }
    if (request.message === "[multi]") {
      delta("first draft");
      final("First corrected");
      start();
      delta("second");
      final("second");
    } else {
      const text = "Hello 🦋\u2028world";
      const frame = Buffer.from(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text },
        }) + "\n"
      );
      for (const byte of frame) {
        process.stdout.write(Buffer.from([byte]));
        await new Promise((resolve) => setImmediate(resolve));
      }
      final(text, request.message === "[error]" ? "error" : "stop");
    }
    settle();
  } else if (request.type === "abort") {
    if (held) {
      final("stopped", "aborted");
      held = false;
      settle();
    }
    response(request);
  }
}
handlers.get("session_shutdown")?.({}, ctx);
