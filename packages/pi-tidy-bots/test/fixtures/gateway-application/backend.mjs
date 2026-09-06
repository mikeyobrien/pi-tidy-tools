#!/usr/bin/env node
// Independent deterministic process fixture. It invokes no native model or service.
import { createInterface } from "node:readline";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
let init;
let sequence = 0;
const permissions = new Map();
const cancellable = new Map();
const discoveries = new Map();
const dispatches = new Map();
const dir = process.env.TIDY_DATA_DIR;
const logPath = join(dir, "calls.jsonl");
function record(value) {
  const fd = openSync(logPath, "a");
  try {
    appendFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function respond(message, result) {
  send({ jsonrpc: "2.0", id: message.id, result });
}
function event(request, type, payload, identities = {}) {
  sequence++;
  writeFileSync(join(dir, "sequence"), String(sequence));
  send({
    jsonrpc: "2.0",
    method: "event",
    params: {
      bindingId: init.bindingId,
      leaseGeneration: init.leaseGeneration,
      sourceSequence: sequence,
      eventId: `event-${sequence}`,
      operationId: request.operationId,
      turnId: request.turnId,
      type,
      payload,
      ...identities,
    },
  });
}
async function execute(request) {
  const text = request.input[0].text;
  if (["[tools]", "[tools-error]", "[tools-unfinished]"].includes(text)) {
    event(request, "turn.started", {});
    const first = `message:${request.operationId}:0`,
      second = `message:${request.operationId}:1`;
    const tool = { toolCallId: "native-tool" };
    event(
      request,
      "message.started",
      { role: "assistant", order: 0 },
      { messageId: first }
    );
    event(
      request,
      "text.snapshot",
      { revision: 1, text: "Before" },
      { messageId: first, blockId: "body" }
    );
    event(
      request,
      "tool.started",
      { state: "running", label: "Inspect", arguments: "PRIVATE_TOOL_CANARY" },
      tool
    );
    event(
      request,
      "tool.updated",
      { state: "running", output: "PRIVATE_TOOL_CANARY" },
      tool
    );
    if (text !== "[tools-unfinished]")
      event(
        request,
        "tool.finished",
        {
          state: text === "[tools-error]" ? "error" : "ended",
          output: "PRIVATE_TOOL_CANARY",
        },
        tool
      );
    event(
      request,
      "message.finished",
      {
        ts: "2026-09-05T12:00:00.000Z",
        blocks: [
          { type: "text", blockId: "body", text: "Before", revision: 1 },
        ],
      },
      { messageId: first }
    );
    event(
      request,
      "message.started",
      { role: "assistant", order: 1 },
      { messageId: second }
    );
    event(
      request,
      "message.finished",
      {
        ts: "2026-09-05T12:00:01.000Z",
        blocks: [{ type: "text", blockId: "body", text: "After", revision: 1 }],
      },
      { messageId: second }
    );
    event(request, "turn.terminal", {
      execution: "ended",
      observation: "complete",
    });
    return;
  }
  if (text === "[exit-after-native]") {
    process.exit(0);
  }
  if (text === "[interleaved]") {
    event(request, "turn.started", {});
    for (const [order, text] of ["First", "Second"].entries()) {
      const messageId = `message:${request.operationId}:${order}`;
      event(
        request,
        "message.started",
        { role: "assistant", order },
        { messageId }
      );
      event(
        request,
        "text.snapshot",
        { revision: 1, text },
        { messageId, blockId: "body" }
      );
    }
    for (const [order, text] of [
      [1, "Second"],
      [0, "First"],
    ]) {
      event(
        request,
        "message.finished",
        {
          ts: `2026-09-05T12:00:0${order}.000Z`,
          blocks: [{ type: "text", blockId: "body", revision: 1, text }],
        },
        { messageId: `message:${request.operationId}:${order}` }
      );
    }
    event(request, "turn.terminal", {
      execution: "ended",
      observation: "complete",
    });
    return;
  }
  const messageId = `message:${request.operationId}`;
  event(request, "turn.started", {});
  event(
    request,
    "message.started",
    { role: "assistant", order: 0 },
    { messageId }
  );
  event(
    request,
    "text.snapshot",
    { revision: 1, text: "Reply" },
    { messageId, blockId: "body" }
  );
  const reply = `Reply: ${text}`;
  event(
    request,
    "text.snapshot",
    { revision: 2, text: reply },
    { messageId, blockId: "body" }
  );
  if (text.includes("[hold]")) {
    while (!existsSync(join(dir, `release-${request.operationId}`)))
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  event(
    request,
    "message.finished",
    {
      ts: "2026-09-05T12:00:00.000Z",
      blocks: [{ type: "text", blockId: "body", revision: 2, text: reply }],
    },
    { messageId }
  );
  event(request, "turn.terminal", {
    execution: "ended",
    observation: "complete",
  });
}
const methods = [
  "health",
  "session.open",
  "session.snapshot",
  "operation.submit",
  "operation.inspect",
  "operation.cancel",
  "interaction.respond",
  "events.ack",
  "events.replay",
  "session.close",
  "shutdown",
];
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (dispatches.has(message.id)) {
    const pending = dispatches.get(message.id);
    dispatches.delete(message.id);
    record({
      dispatch: message.result ?? message.error,
      operationId: pending.request.operationId,
    });
    if (!pending.repeated && message.result) {
      const id = message.id + ":retry";
      dispatches.set(id, { ...pending, repeated: true });
      send({
        jsonrpc: "2.0",
        id,
        method: "host.call",
        params: { ...pending.params, callId: id },
      });
    } else void execute(pending.request);
    return;
  }
  if (discoveries.has(message.id)) {
    const request = discoveries.get(message.id);
    discoveries.delete(message.id);
    record({
      discovery: message.result ?? message.error,
      operationId: request.operationId,
    });
    void execute(request);
    return;
  }
  const p = message.params ?? {};
  if (message.method === "initialize") {
    init = p;
    if (existsSync(join(dir, "sequence")))
      sequence = Number(readFileSync(join(dir, "sequence"), "utf8"));
    record({ method: "initialize", instanceId: p.instanceId });
    respond(message, {
      protocol: { major: 1, minor: 0 },
      plugin: { id: p.expectedPlugin.id, version: p.expectedPlugin.version },
      runtime: {
        name: "independent-fixture",
        version: "1.0.0",
        transport: "stdio",
      },
      methods,
      health: p.config.health ?? "ready",
      capabilities: {
        input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
        sessions: { load: false, import: false, continuity: "unverified" },
        output: { text: "snapshots", tools: true, usage: "unknown" },
        operations: {
          nativeDedupe: "none",
          nativeReplay: "none",
          cancel: "cooperative",
          steer: false,
        },
        interactions: {
          permissions: p.config.permissions ? "exact-request" : "none",
          questions: false,
        },
        configuration: { model: false, thinking: false, compact: false },
        fleetTools: p.config.discovery === true,
      },
    });
    sequence++;
    writeFileSync(join(dir, "sequence"), String(sequence));
    send({
      jsonrpc: "2.0",
      method: "event",
      params: {
        bindingId: p.bindingId,
        leaseGeneration: p.leaseGeneration,
        sourceSequence: sequence,
        eventId: `event-${sequence}`,
        type: "session.state",
        payload: { health: p.config.health ?? "ready" },
      },
    });
  } else if (message.method === "session.open") {
    record({ method: "session.open", ...p });
    respond(message, {
      status: "opened",
      nativeReference: `session:${p.openId}`,
    });
  } else if (message.method === "operation.submit") {
    record({ method: "operation.submit", ...p });
    if (["[send]", "[send-forbidden]"].includes(p.input[0].text)) {
      const id = `send:${p.operationId}`;
      const params = {
        bindingId: init.bindingId,
        leaseGeneration: init.leaseGeneration,
        name: "fleet.send",
        callId: id,
        operationId: p.operationId,
        toolCallId: "native-tool-1",
        actionId: "action-1",
        payloadDigest: "fixture-action-intent",
        arguments: {
          target: p.input[0].text === "[send]" ? "allowed" : "hidden",
          text: "Delegated task",
        },
      };
      dispatches.set(id, { request: p, params });
      send({ jsonrpc: "2.0", id, method: "host.call", params });
      respond(message, { disposition: "accepted" });
      return;
    }
    if (["[discover]", "[discover-forged]"].includes(p.input[0].text)) {
      const id = `discover:${p.operationId}`;
      discoveries.set(id, p);
      send({
        jsonrpc: "2.0",
        id,
        method: "host.call",
        params: {
          bindingId: init.bindingId,
          leaseGeneration: init.leaseGeneration,
          name: "fleet.discover",
          callId: id,
          arguments:
            p.input[0].text === "[discover-forged]" ? { from: "hidden" } : {},
        },
      });
      respond(message, { disposition: "accepted" });
      return;
    }
    if (["[cancel-hold]", "[cancel-lost]"].includes(p.input[0].text)) {
      cancellable.set(p.operationId, p);
      event(p, "turn.started", {});
      respond(message, { disposition: "accepted" });
      return;
    }
    if (p.input[0].text === "[permission]") {
      const descriptor = {
        kind: "permission",
        bindingId: init.bindingId,
        instanceId: init.instanceId,
        operationId: p.operationId,
        turnId: p.turnId,
        interactionId: `permission:${p.operationId}`,
        optionsDigest: "sha256:fixture-options",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        revision: "1",
        options: [
          { id: "once-17", label: "Allow once", kind: "allow-once" },
          { id: "deny-17", label: "Deny", kind: "deny" },
        ],
      };
      permissions.set(descriptor.interactionId, {
        descriptor,
        request: p,
        submit: message,
      });
      event(p, "turn.started", {});
      event(p, "interaction.requested", descriptor, {
        interactionId: descriptor.interactionId,
      });
      // Acceptance is already observed, but the submit RPC intentionally stays
      // pending to exercise the gateway's independent permission dispatch path.
      return;
    }
    if (p.input[0].text === "[exit-after-native]") {
      process.exit(0);
      return;
    }
    if (p.input[0].text === "[unknown]") {
      respond(message, { disposition: "unknown" });
      return;
    }
    respond(message, { disposition: "accepted" });
    void execute(p);
  } else if (message.method === "operation.cancel") {
    record({ method: "operation.cancel", ...p });
    const target = cancellable.get(p.targetOperationId);
    if (target?.input[0].text === "[cancel-lost]") {
      process.exit(0);
      return;
    }
    respond(message, { status: target ? "requested" : "unknown" });
    if (target) {
      const poll = setInterval(() => {
        if (!existsSync(join(dir, "release-cancel"))) return;
        clearInterval(poll);
        event(target, "turn.terminal", {
          execution: "cancelled",
          observation: "complete",
        });
        cancellable.delete(p.targetOperationId);
      }, 10);
    }
  } else if (message.method === "interaction.respond") {
    record({ method: "interaction.respond", ...p });
    const pending = permissions.get(p.interactionId);
    if (!pending) {
      respond(message, { status: "expired" });
      return;
    }
    const resolution = {
      ...pending.descriptor,
      status: "applied",
      optionId: p.optionId,
    };
    event(pending.request, "turn.terminal", {
      execution: "ended",
      observation: "complete",
    });
    event(pending.request, "interaction.resolved", resolution, {
      interactionId: p.interactionId,
    });
    event(pending.request, "interaction.resolved", resolution, {
      interactionId: p.interactionId,
    });
    respond(message, { status: "applied" });
    respond(pending.submit, { disposition: "accepted" });
    permissions.delete(p.interactionId);
  } else if (message.method === "events.ack") {
    record({ method: "events.ack", sequence: p.sourceSequence });
  } else if (message.method === "shutdown") {
    respond(message, { status: "closed" });
    process.exit(0);
  } else if (message.id) respond(message, { status: "unsupported" });
});
input.on("close", () => process.exit(0));
