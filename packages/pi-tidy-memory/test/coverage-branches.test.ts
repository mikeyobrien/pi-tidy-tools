import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadMemoryConfig,
  parseMemoryConfig,
  resolveApiKey,
  resolveConfigPath,
  sanitizedConfigSummary,
  type HindsightBackendConfig,
} from "../config.js";
import { createMemoryExtension } from "../index.js";
import { renderMemoryLines, MemoryToolComponent } from "../render.js";
import {
  MemoryRuntime,
  settledExchange,
  toolRecallText,
  toolReflectText,
} from "../runtime.js";
import type { BackendFactory, MemoryBackend } from "../types.js";

const hindsight = {
  type: "hindsight",
  baseUrl: "https://memory.example.test",
  bankId: "pi",
  apiKeyEnv: "KEY",
};
const baseConfig = {
  version: 1 as const,
  enabled: true,
  backend: hindsight,
  requestTimeoutMs: 1_000,
  lifecycle: {
    autoRecall: false,
    autoRetain: false,
    maxRecallTokens: 512,
    maxRetainChars: 2_000,
  },
};

test("config defensive branches normalize limits paths and summaries", async () => {
  for (const backend of [
    { ...hindsight, baseUrl: 1 },
    { ...hindsight, baseUrl: "not a url" },
    { ...hindsight, envFile: 1 },
    { ...hindsight, token: "x" },
    { ...hindsight, headers: {} },
    { type: "Bad Type" },
    null,
  ])
    assert.throws(() => parseMemoryConfig({ ...baseConfig, backend }));

  const parsed = parseMemoryConfig({
    version: 1,
    backend: {
      ...hindsight,
      baseUrl: "http://localhost:8888/",
      recallBudget: "invalid",
      recallTypes: ["world", 2, ""],
      asyncRetain: false,
    },
    requestTimeoutMs: 100_000,
    lifecycle: { maxRecallTokens: 1, maxRetainChars: 100_000 },
  });
  const backend = parsed.backend as HindsightBackendConfig;
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.requestTimeoutMs, 60_000);
  assert.equal(parsed.lifecycle.maxRecallTokens, 128);
  assert.equal(parsed.lifecycle.maxRetainChars, 64_000);
  assert.equal(backend.recallBudget, "mid");
  assert.deepEqual(backend.recallTypes, ["world"]);
  assert.equal(backend.asyncRetain, false);
  assert.equal(
    resolveApiKey({ ...backend, apiKeyEnv: undefined }, {}),
    undefined
  );
  assert.equal(resolveApiKey(backend, {}), undefined);
  assert.equal(resolveConfigPath("~").endsWith("/home"), true);
  assert.match(resolveConfigPath("~/x"), /\/home\/x$/);
  assert.equal(resolveConfigPath("/absolute"), "/absolute");
  assert.match(resolveConfigPath("relative"), /\/home\/relative$/);

  const custom = parseMemoryConfig({
    ...baseConfig,
    enabled: false,
    backend: { type: "mnemosyne" },
  });
  assert.match(
    sanitizedConfigSummary({ config: custom, path: "x" }),
    /disabled backend=mnemosyne/
  );
  const noAuth = parseMemoryConfig({
    ...baseConfig,
    backend: { ...hindsight, apiKeyEnv: undefined },
  });
  assert.match(
    sanitizedConfigSummary({ config: noAuth, path: "x" }),
    /auth=none/
  );

  const root = await mkdtemp(join(tmpdir(), "tidy-memory-malformed-"));
  try {
    await writeFile(join(root, "config.json"), "{");
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.error, "not configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime and rendering defensive branches stay bounded", async () => {
  assert.throws(
    () =>
      new MemoryRuntime(
        { ...baseConfig, backend: { type: "missing" } },
        { factories: [] }
      ),
    /Unsupported/
  );
  const noClose: MemoryBackend = {
    type: "fake",
    label: "fake",
    capabilities: new Set(),
    async health() {
      return { ok: true, message: "ok" };
    },
    async recall() {
      return { memories: [] };
    },
    async retain() {
      return { accepted: 0, deferred: false };
    },
    async reflect() {
      return { text: "" };
    },
  };
  const factory: BackendFactory = { type: "hindsight", create: () => noClose };
  await new MemoryRuntime(baseConfig, { factories: [factory] }).close();
  assert.equal(toolRecallText([]), "No relevant memories found.");
  assert.match(toolReflectText("x\u001b[31mred"), /xred/);
  assert.equal(
    settledExchange([{ role: "user", content: "only" }], 100),
    undefined
  );
  assert.equal(
    settledExchange([null, "bad", { role: "user", content: 2 }], 100),
    undefined
  );

  assert.match(
    renderMemoryLines("retain", {}, undefined, false, true, false)[0],
    /working/
  );
  assert.match(
    renderMemoryLines(
      "retain",
      { content: "x" },
      { operation: "retain", accepted: 1, deferred: false },
      false,
      false,
      false
    )[0],
    /1 accepted/
  );
  assert.match(
    renderMemoryLines("recall", {}, undefined, false, false, true)[0],
    /failed/
  );
  assert.match(
    renderMemoryLines("reflect", {}, undefined, false, false, false)[0],
    /done/
  );
  const component = new MemoryToolComponent(
    "recall",
    {},
    undefined,
    false,
    false,
    false
  );
  component.invalidate();
  assert.equal(component.render(200).length, 1);
});

function registerExtension(config: any, backend?: MemoryBackend) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const factories = backend
    ? [{ type: config.backend.type, create: () => backend } as BackendFactory]
    : [];
  createMemoryExtension({
    configResult: { config, path: "/config" },
    factories,
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
  return { tools, commands, events };
}

test("extension renderers cover pending settled and error shells", () => {
  const backend: MemoryBackend = {
    type: "fake",
    label: "fake",
    capabilities: new Set(),
    async health() {
      return { ok: true, message: "ok" };
    },
    async recall() {
      return { memories: [] };
    },
    async retain() {
      return { accepted: 1, deferred: false };
    },
    async reflect() {
      return { text: "ok" };
    },
  };
  const { tools } = registerExtension(baseConfig, backend);
  const theme = { bg: (name: string, value: string) => `${name}:${value}` };
  const recall = tools.get("recall");
  assert(
    recall.renderCall({ query: "q" }, theme, { isPartial: true }).render(80)
      .length > 0
  );
  assert.equal(recall.renderCall({}, theme, {}).render(80).length, 0);
  assert.equal(
    recall.renderResult({}, { isPartial: true }, theme, {}).render(80).length,
    0
  );
  assert(
    recall
      .renderResult(
        { details: { operation: "recall", memories: [] } },
        { expanded: false },
        theme,
        { args: { query: "q" }, isError: false }
      )
      .render(80).length > 0
  );
  assert(
    recall
      .renderResult({ isError: true }, { expanded: false }, theme, { args: {} })
      .render(80)[0]
      .includes("toolErrorBg")
  );
});

test("extension active diagnostics and lifecycle failures warn once", async () => {
  const notes: Array<[string, string]> = [];
  const backend: MemoryBackend = {
    type: "fake",
    label: "fake",
    capabilities: new Set(),
    async health() {
      return { ok: false, message: "down" };
    },
    async recall() {
      throw new Error("recall boom");
    },
    async retain() {
      throw new Error("retain boom");
    },
    async reflect() {
      return { text: "ok" };
    },
  };
  const active = registerExtension(
    {
      ...baseConfig,
      lifecycle: {
        ...baseConfig.lifecycle,
        autoRecall: true,
        autoRetain: true,
      },
    },
    backend
  );
  const context = {
    ui: {
      notify: (message: string, level: string) => notes.push([message, level]),
    },
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "question" } },
        { type: "message", message: { role: "assistant", content: "answer" } },
      ],
    },
  };
  assert.deepEqual(
    active.commands.get("tidy-memory").getArgumentCompletions(" C"),
    [{ value: "check", label: "check" }]
  );
  await active.commands.get("tidy-memory").handler("check", context);
  assert.match(notes.at(-1)![0], /health=failed down/);
  await active.events.get("before_agent_start")(
    { prompt: "question" },
    context
  );
  await active.events.get("before_agent_start")(
    { prompt: "question" },
    context
  );
  assert.equal(
    notes.filter(([message]) => message.includes("recall boom")).length,
    1
  );
  await active.events.get("agent_settled")({}, context);
  await active.events.get("agent_settled")({}, context);
  assert.equal(
    notes.filter(([message]) => message.includes("retain boom")).length,
    1
  );

  const throwing = {
    ...backend,
    async health() {
      throw new Error("health boom");
    },
  };
  const brokenHealth = registerExtension(baseConfig, throwing);
  await brokenHealth.commands.get("tidy-memory").handler("check", context);
  assert.match(notes.at(-1)![0], /health=failed health boom/);

  const unsupported = registerExtension({
    ...baseConfig,
    backend: { type: "missing" },
  });
  await unsupported.commands.get("tidy-memory").handler("status", context);
  assert.match(notes.at(-1)![0], /Unsupported memory backend/);
  assert.equal(unsupported.events.size, 0);
});

test("extension inactive and diagnostic branches fail safely", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events: any[] = [];
  createMemoryExtension({
    configResult: { path: "/missing", error: "not configured" },
  })({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(...args: any[]) {
      events.push(args);
    },
  } as any);
  assert.equal(events.length, 0);
  await assert.rejects(
    () => tools.get("recall").execute("x", { query: "x" }),
    /not configured/
  );
  const notes: Array<[string, string]> = [];
  const ctx = {
    ui: {
      notify: (message: string, level: string) => notes.push([message, level]),
    },
  };
  await commands.get("tidy-memory").handler("wat", ctx);
  await commands.get("tidy-memory").handler("status", ctx);
  await commands.get("tidy-memory").handler("check", ctx);
  assert.match(notes[0][0], /Usage/);
  assert.equal(notes[1][1], "warning");
  assert.equal(notes[2][1], "warning");
});
