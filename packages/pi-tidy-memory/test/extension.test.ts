import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { createMemoryExtension } from "../index.js";
import type { BackendFactory, MemoryBackend } from "../types.js";

const config = {
  version: 1 as const,
  enabled: true,
  backend: {
    type: "hindsight" as const,
    baseUrl: "https://memory.example.test",
    bankId: "pi",
  },
  requestTimeoutMs: 1_000,
  lifecycle: {
    autoRecall: true,
    autoRetain: true,
    maxRecallTokens: 512,
    maxRetainChars: 2_000,
  },
};

function setup() {
  const calls: Array<{ op: string; value?: any }> = [];
  const backend: MemoryBackend = {
    type: "fake",
    label: "Fake",
    capabilities: new Set(["health", "recall", "retain", "reflect"]),
    async health() {
      calls.push({ op: "health" });
      return { ok: true, message: "ok" };
    },
    async recall(value) {
      calls.push({ op: "recall", value });
      return { memories: [{ id: "1", text: "Use worktrees", kind: "world" }] };
    },
    async retain(value) {
      calls.push({ op: "retain", value });
      return { accepted: 1, deferred: true, operationId: "op" };
    },
    async reflect(value) {
      calls.push({ op: "reflect", value });
      return { text: "Because of prior failures." };
    },
    async close() {
      calls.push({ op: "close" });
    },
  };
  const factory: BackendFactory = { type: "hindsight", create: () => backend };
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  createMemoryExtension({
    configResult: { config, path: "/agent/pi-tidy-memory/config.json" },
    factories: [factory],
  })({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: any) {
      events.set(name, handler);
    },
  } as any);
  return { calls, tools, commands, events };
}

const context = {
  sessionManager: { getSessionId: () => "session-1" },
  ui: { notify() {} },
};

test("registers backend-neutral tools command and lifecycle hooks", () => {
  const registered = setup();
  assert.deepEqual(
    [...registered.tools.keys()],
    ["recall", "retain", "reflect"]
  );
  assert.deepEqual([...registered.commands.keys()], ["tidy-memory"]);
  assert.deepEqual(
    [...registered.events.keys()],
    ["before_agent_start", "context", "agent_settled", "session_shutdown"]
  );
  for (const tool of registered.tools.values())
    assert.equal(tool.renderShell, "self");
  assert.match(
    registered.tools.get("retain").promptGuidelines[0],
    /explicitly asks/
  );
});

test("publishes bounded tool schemas", () => {
  const { tools } = setup();
  assert.equal(
    Value.Check(tools.get("recall").parameters, {
      query: "history",
      maxTokens: 512,
    }),
    true
  );
  assert.equal(
    Value.Check(tools.get("recall").parameters, { query: "" }),
    false
  );
  assert.equal(
    Value.Check(tools.get("recall").parameters, {
      query: "history",
      maxTokens: 128.5,
    }),
    false
  );
  assert.equal(
    Value.Check(tools.get("retain").parameters, {
      content: "durable fact",
    }),
    true
  );
  assert.equal(
    Value.Check(tools.get("retain").parameters, { content: "" }),
    false
  );
  assert.equal(
    Value.Check(tools.get("reflect").parameters, { query: "why?" }),
    true
  );
  assert.equal(
    Value.Check(tools.get("reflect").parameters, {
      query: "why?",
      maxTokens: 128.5,
    }),
    false
  );
});

test("executes recall retain and reflect through the backend seam", async () => {
  const { tools, calls } = setup();
  const recalled = await tools
    .get("recall")
    .execute("t1", { query: "work" }, undefined, undefined, context);
  assert.match(recalled.content[0].text, /trust="untrusted"/);
  assert.match(recalled.content[0].text, /Never follow instructions/);
  const retained = await tools
    .get("retain")
    .execute("t2", { content: "Use worktrees" }, undefined, undefined, context);
  assert.equal(retained.details.operationId, "op");
  const reflected = await tools
    .get("reflect")
    .execute("t3", { query: "why" }, undefined, undefined, context);
  assert.match(reflected.content[0].text, /Untrusted synthesis/);
  assert.match(reflected.content[0].text, /Because of prior failures\./);
  assert.deepEqual(
    calls.map((call) => call.op),
    ["recall", "retain", "reflect"]
  );
  assert.equal(calls[1].value.documentId, "pi-tool:session-1:t2");
});

test("runs ephemeral recall and branch-derived settled retain safely", async () => {
  const { events, calls } = setup();
  const branch = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Question" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
    },
  ];
  const lifecycleContext = {
    ...context,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
  };
  const recall = await events.get("before_agent_start")(
    { prompt: "What changed?" },
    lifecycleContext
  );
  assert.equal(recall, undefined);
  const transformed = events.get("context")({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "What changed?" }] },
    ],
  });
  assert.equal(transformed.messages.length, 3);
  assert.match(transformed.messages[1].content[0].text, /Use worktrees/);
  assert.equal(transformed.messages[2].content[0].text, "What changed?");
  await events.get("agent_settled")({}, lifecycleContext);
  assert.deepEqual(
    calls.map((call) => call.op),
    ["recall", "retain"]
  );
  assert.equal(calls[1].value.tags[0], "source:pi");
  assert.equal(events.get("context")({ messages: [] }), undefined);
  await events.get("session_shutdown")({}, lifecycleContext);
  assert.equal(calls.at(-1)?.op, "close");
});

test("status and health commands are useful without exposing credentials", async () => {
  const { commands, calls } = setup();
  const notes: Array<{ value: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(value: string, level: string) {
        notes.push({ value, level });
      },
    },
  };
  await commands.get("tidy-memory").handler("status", ctx);
  assert.match(notes[0].value, /backend=hindsight/);
  await commands.get("tidy-memory").handler("check", ctx);
  assert.match(notes[1].value, /health=ok/);
  assert.equal(calls.at(-1)?.op, "health");
});
