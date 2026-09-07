#!/usr/bin/env node
import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
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
const sessionDir = realpathSync(
  process.argv[process.argv.indexOf("--session-dir") + 1]
);
const sessionFile = process.argv.includes("--session")
  ? process.argv[process.argv.indexOf("--session") + 1]
  : join(sessionDir, "history.jsonl");
const retained = process.argv.includes("--session")
  ? readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  : [];
let messageCount = retained.filter((entry) => entry.type === "message").length;
let settings = {
  model: { provider: "fixture", id: "saved-model" },
  thinkingLevel: "medium",
};
for (const entry of retained) {
  if (entry.type === "model_change")
    settings.model = { provider: entry.provider, id: entry.modelId };
  if (entry.type === "thinking_level_change")
    settings.thinkingLevel = entry.thinkingLevel;
}
const persistSetting = (entry) =>
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
if (!process.argv.includes("--session"))
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "fixture-session",
      cwd: process.cwd(),
    }) + "\n"
  );
const logPath = join(dirname(sessionDir), "native-effects.jsonl");
const log = (record) => appendFileSync(logPath, JSON.stringify(record) + "\n");
log({
  launch: process.pid,
  argv: process.argv.slice(2),
  environmentKeys: Object.keys(process.env).sort(),
  profile: process.env.PI_CODING_AGENT_DIR,
});
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const uiPending = new Map();
let uiCounter = 0;
const askUi = (method, title, args = {}) => {
  const id = `ui-fixture-${++uiCounter}`;
  send({ type: "extension_ui_request", id, method, title, ...args });
  return new Promise((resolve) => uiPending.set(id, resolve));
};
ctx.ui = {
  select: (title, options) => askUi("select", title, { options }),
  confirm: (title, message) => askUi("confirm", title, { message }),
  input: (title, placeholder) => askUi("input", title, { placeholder }),
  editor: (title, prefill) => askUi("editor", title, { prefill }),
};
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
  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: `message-${messageCount++}`,
      message: { role: "assistant", content: [] },
    }) + "\n"
  );
  handlers.get("agent_end")?.({}, ctx);
  send({ type: "agent_end" });
  send({ type: "agent_settled" });
};
let held = false;
let pendingUi;
let compacting = false;
let heldCompaction;
let compactMode = "success";
const compactResult = (
  summary = "fixture compacted",
  firstKeptEntryId = "message-0",
  tokensBefore = 42
) => ({ summary, firstKeptEntryId, tokensBefore });
const compactionEnd = (result, aborted = false) =>
  send({
    type: "compaction_end",
    reason: "manual",
    aborted,
    willRetry: false,
    ...(result ? { result } : {}),
  });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log({
    command: request.type,
    id: request.id,
    text: request.message,
    provider: request.provider,
    modelId: request.modelId,
    level: request.level,
    ...(request.images ? { images: request.images } : {}),
  });
  if (request.type === "get_state") {
    response(request, {
      sessionId: "fixture-session",
      sessionFile,
      isStreaming: false,
      messageCount,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      pendingMessageCount: 0,
      isCompacting: compacting,
    });
  } else if (request.type === "get_available_thinking_levels") {
    response(request, { levels: ["off", "low", "medium", "high"] });
  } else if (request.type === "get_available_models") {
    response(request, {
      models: [
        { provider: "fixture", id: "saved-model" },
        { provider: "fixture", id: "next/model" },
      ],
    });
  } else if (request.type === "set_model") {
    settings.model = { provider: request.provider, id: request.modelId };
    persistSetting({
      type: "model_change",
      provider: request.provider,
      modelId: request.modelId,
    });
    response(request);
  } else if (request.type === "set_thinking_level") {
    settings.thinkingLevel = request.level;
    persistSetting({
      type: "thinking_level_change",
      thinkingLevel: request.level,
    });
    response(request);
  } else if (request.type === "prompt") {
    if (request.message === "[reject]") {
      response(request, undefined, false);
      continue;
    }
    if (request.message === "[unknown]") continue;
    response(request);
    if (
      [
        "[compact-hold]",
        "[compact-fail]",
        "[compact-missing-evidence]",
        "[compact-history-mismatch]",
      ].includes(request.message)
    )
      compactMode = request.message.slice(1, -1).replace("compact-", "");
    send({ type: "agent_start" });
    await handlers.get("agent_start")?.({}, ctx);
    if (request.message === "[ask-user]") {
      void (async () => {
        const askArgs = {
          method: "select",
          title: "Choose a release window",
          options: ["Morning", "Evening"],
        };
        send({
          type: "tool_execution_start",
          toolCallId: "ask-tool-call",
          toolName: "ask_user_question",
          args: askArgs,
        });
        const result = await tools
          .get("ask_user_question")
          .execute("ask-tool-call", askArgs, undefined, undefined, ctx);
        send({
          type: "tool_execution_end",
          toolCallId: "ask-tool-call",
          result,
          isError: false,
        });
        start();
        final(result.content[0].text);
        settle();
      })();
      continue;
    }
    const uiMode = {
      "[ui-select]": {
        method: "select",
        title: "Choose a release window",
        options: ["Morning", "Evening"],
      },
      "[ui-confirm]": {
        method: "confirm",
        title: "Confirm release",
        message: "Publish the release?",
      },
      "[ui-input]": {
        method: "input",
        title: "Release name",
        placeholder: "name",
      },
      "[ui-editor]": {
        method: "editor",
        title: "Release notes",
        prefill: "Initial notes",
      },
      "[ui-timeout]": {
        method: "select",
        title: "Short lived question",
        options: ["Only"],
        timeout: 10,
      },
    }[request.message];
    if (uiMode) {
      pendingUi = { id: `ui-${request.id}`, request };
      send({ type: "extension_ui_request", id: pendingUi.id, ...uiMode });
      if (uiMode.timeout) {
        setTimeout(() => {
          if (!pendingUi || pendingUi.request !== request) return;
          pendingUi = undefined;
          start();
          final("UI cancelled");
          settle();
        }, uiMode.timeout + 5);
      }
      continue;
    }
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
  } else if (request.type === "compact") {
    compacting = true;
    send({ type: "compaction_start", reason: "manual" });
    if (compactMode === "hold") {
      heldCompaction = request;
      continue;
    }
    if (compactMode === "fail") {
      compacting = false;
      compactionEnd();
      response(request, undefined, false);
      continue;
    }
    const result = compactResult(
      compactMode === "history-mismatch"
        ? "fixture wrong history"
        : "fixture compacted"
    );
    if (compactMode !== "missing-evidence")
      persistSetting({
        type: "compaction",
        ...result,
        ...(compactMode === "history-mismatch"
          ? { summary: "fixture persisted mismatch" }
          : {}),
      });
    compacting = false;
    compactionEnd(result);
    response(request, result);
  } else if (request.type === "abort") {
    if (heldCompaction) {
      compacting = false;
      compactionEnd(undefined, true);
      response(heldCompaction, undefined, false);
      heldCompaction = undefined;
    }
    if (held) {
      final("stopped", "aborted");
      held = false;
      settle();
    }
    response(request);
  } else if (request.type === "extension_ui_response") {
    const resolveUi = uiPending.get(request.id);
    if (resolveUi) {
      uiPending.delete(request.id);
      resolveUi(
        request.cancelled
          ? undefined
          : request.confirmed !== undefined
            ? request.confirmed
            : request.value
      );
      continue;
    }
    if (!pendingUi || request.id !== pendingUi.id) continue;
    pendingUi = undefined;
    const answer = request.cancelled
      ? "cancelled"
      : request.confirmed !== undefined
        ? request.confirmed
          ? "confirmed"
          : "declined"
        : (request.value ?? "");
    start();
    final(`UI ${answer}`);
    settle();
  }
}
handlers.get("session_shutdown")?.({}, ctx);
