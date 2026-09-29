import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEMODE_REASONING_GUIDELINE,
  MISSING_REASONING_ERROR,
  addUsage,
  captureCodemodeDefinition,
  generateOutputReasoning,
  resolveSummaryModel,
  scriptReasoning,
  summaryPrompt,
} from "../codemode.js";
import {
  loadTidyOutputReasoning,
  saveTidyOutputReasoning,
  saveTidyOutputReasoningModel,
  type TidyMode,
} from "../config.js";
import { buildToolBlock, createTidyExtension } from "../index.js";

const withoutAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m/g, "");

test("script reasoning is read from the leading comment block only", () => {
  assert.equal(
    scriptReasoning('// @options: {"timeout_ms": 1000}\n// @reasoning: count the test files\nreturn 1;'),
    "count the test files"
  );
  assert.equal(scriptReasoning("//@reasoning:   trim it  \nreturn 1;"), "trim it");
  assert.equal(scriptReasoning("\n\n// note\n// @reasoning: after a note\nx()"), "after a note");
  assert.equal(scriptReasoning("return 1;\n// @reasoning: too late"), undefined);
  assert.equal(scriptReasoning("// @reasoning:\nreturn 1;"), undefined);
  assert.equal(scriptReasoning("return 1;"), undefined);
  assert.equal(scriptReasoning(undefined), undefined);
});

test("capture takes the host codemode registration and forwards every other call", () => {
  const settings = { codemode: { mode: "only" } };
  const pi = {
    marker: "host",
    getSettings(this: any) {
      assert.equal(this.marker, "host");
      return settings;
    },
    registerTool() {
      throw new Error("the host registration must not happen");
    },
  };
  let observed: unknown;
  const factory = () => (proxy: any) => {
    observed = proxy.getSettings();
    proxy.registerTool({ name: "codemode", parameters: { type: "object" } });
  };
  const captured = captureCodemodeDefinition(pi, factory);
  assert.equal(captured?.name, "codemode");
  assert.equal(observed, settings);
  assert.equal(captureCodemodeDefinition(pi, undefined), undefined);
});

test("the summary model is an explicit provider/id or the session model", () => {
  const session = { id: "session" };
  const override = { id: "gpt-oss-20b" };
  const ctx = {
    model: session,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "groq" && id === "openai/gpt-oss-20b" ? override : undefined,
    },
  };
  assert.equal(resolveSummaryModel(ctx, undefined).model, session);
  assert.equal(resolveSummaryModel(ctx, "groq/openai/gpt-oss-20b").model, override);
  assert.match(resolveSummaryModel(ctx, "groq/missing").error!, /not found/);
  assert.match(resolveSummaryModel(ctx, "no-slash").error!, /provider\/id/);
  assert.match(resolveSummaryModel({}, undefined).error!, /no session model/);
});

test("usage adds field by field, including nested cost", () => {
  assert.deepEqual(
    addUsage(
      { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5, input: 0.25 } },
      { input: 10, output: 20, totalTokens: 30, cost: { total: 1, input: 0.5 } }
    ),
    { input: 11, output: 22, totalTokens: 33, cost: { total: 1.5, input: 0.75 } }
  );
  assert.deepEqual(addUsage(undefined, { input: 1 }), { input: 1 });
  assert.equal(addUsage(undefined, undefined), undefined);
});

const scriptResult = {
  content: [
    { type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
    { type: "text", text: '{"files":3}' },
  ],
  details: {
    calls: [
      { name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 12 },
      { name: "read", args: '{"path":"a"}', status: "error", error: "ENOENT" },
    ],
  },
};

function fakeRegistry(reply: any, seen: any[] = []) {
  return {
    streamSimple(model: unknown, context: unknown, options: unknown) {
      seen.push({ model, context, options });
      return { result: async () => reply };
    },
  };
}

test("outputReasoning asks the resolved model for one sentence about the script", async () => {
  const seen: any[] = [];
  const usage = { input: 5, output: 7, totalTokens: 12 };
  const ctx = {
    model: { id: "session" },
    modelRegistry: fakeRegistry(
      { content: [{ type: "text", text: " Listed three\nfiles. " }], stopReason: "stop", usage },
      seen
    ),
  };
  const summary = await generateOutputReasoning(ctx, "// @reasoning: x\nls()", scriptResult, {});
  assert.deepEqual(summary, { text: "Listed three files.", usage });
  assert.equal(seen[0].model, ctx.model);
  assert.match(seen[0].context.systemPrompt, /ONE plain sentence/);
  const prompt = seen[0].context.messages[0].content[0].text;
  assert.match(prompt, /Tool calls \(2\):/);
  assert.match(prompt, /read \{"path":"a"\} \[error\] ENOENT/);
  assert.match(prompt, /\{"files":3\}/);
  assert.equal(summaryPrompt("x", scriptResult), prompt.replace("// @reasoning: x\nls()", "x"));
  assert.equal(seen[0].options.maxTokens, 120);
  assert.ok(seen[0].options.signal instanceof AbortSignal);
});

test("outputReasoning failures come back as errors, never throws", async () => {
  const failing = {
    model: {},
    modelRegistry: fakeRegistry({ content: [], stopReason: "error", errorMessage: "rate limited" }),
  };
  assert.match((await generateOutputReasoning(failing, "", scriptResult, {})).error!, /rate limited/);
  const empty = {
    model: {},
    modelRegistry: fakeRegistry({ content: [], stopReason: "stop" }),
  };
  assert.match((await generateOutputReasoning(empty, "", scriptResult, {})).error!, /no text/);
  const throwing = {
    model: {},
    modelRegistry: { streamSimple() { throw new Error("boom"); } },
  };
  assert.match((await generateOutputReasoning(throwing, "", scriptResult, {})).error!, /boom/);
  const oldHost = { model: {}, modelRegistry: {} };
  assert.match((await generateOutputReasoning(oldHost, "", scriptResult, {})).error!, /Pi >= 0\.99/);
});

test("output reasoning is on unless disabled and keeps its model override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-output-reasoning-"));
  const path = join(dir, "config.json");
  try {
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: true });
    await saveTidyOutputReasoning(false, path);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: false, model: undefined });
    await saveTidyOutputReasoning(true, path);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: true, model: undefined });
    await saveTidyOutputReasoningModel("cerebras/gpt-oss-120b", path);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: true, model: "cerebras/gpt-oss-120b" });
    await saveTidyOutputReasoningModel(undefined, path);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: true, model: undefined });
    assert.equal(JSON.parse(await readFile(path, "utf8")).outputReasoningModel, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const codemodeSchema = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };

interface CodemodeHarness {
  tool: any;
  executed: unknown[][];
}

async function loadCodemode(
  options: { mode?: TidyMode; outputReasoning?: { enabled: boolean; model?: string } } = {}
): Promise<CodemodeHarness> {
  const tools = new Map<string, any>();
  const sessionStart: Array<() => unknown> = [];
  let registrations = 0;
  const executed: unknown[][] = [];
  const hostDefinition = {
    name: "codemode",
    label: "codemode",
    description: "Run JavaScript",
    parameters: codemodeSchema,
    promptGuidelines: ["Use codemode to batch."],
    exposure: "model-only",
    constrainedSampling: { type: "grammar" },
    prepareLoadout: () => ({ descriptions: {} }),
    defaultActive: false,
    execute: async (...args: unknown[]) => {
      executed.push(args);
      return structuredClone(scriptResult);
    },
  };
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    await createTidyExtension({
      createIntegration: (() => ({
        async initialize() {
          return { skipTidyTools: new Set(), commit() {} };
        },
        async run() {
          return { message: "", level: "info", reload: "none", status: {} };
        },
      })) as any,
      loadMode: () => options.mode ?? "default",
      loadIcons: () => false,
      loadOutputReasoning: () => options.outputReasoning ?? { enabled: false },
      createCodemodeExtension: () => (pi: any) => pi.registerTool(hostDefinition),
    })({
      on: (event: string, handler: () => unknown) => {
        if (event === "session_start") sessionStart.push(handler);
      },
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool: (tool: any) => {
        if (tool.name === "codemode") registrations++;
        tools.set(tool.name, tool);
      },
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  // Registering codemode during load would make Pi drop its built-in
  // codemode extension with a startup warning; it must wait for the session.
  assert.equal(tools.has("codemode"), false, "codemode is not registered during load");
  for (const handler of sessionStart) await handler();
  for (const handler of sessionStart) await handler();
  assert.equal(registrations, 1, "registered once, on the first session_start");
  const tool = tools.get("codemode");
  assert.ok(tool, "codemode registered");
  assert.equal(tool.parameters, codemodeSchema, "schema identity is the host's");
  assert.equal(tool.prepareLoadout, hostDefinition.prepareLoadout);
  assert.equal(tool.constrainedSampling, hostDefinition.constrainedSampling);
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.defaultActive, false);
  return { tool, executed };
}

const SCRIPT = "// @reasoning: count the test files\nreturn (await tools.bash({ command: 'ls' }));";

test("codemode requires the script's reasoning line and delegates to the host", async () => {
  const { tool, executed } = await loadCodemode();
  assert.deepEqual(tool.promptGuidelines, ["Use codemode to batch.", CODEMODE_REASONING_GUIDELINE]);
  await assert.rejects(
    tool.execute("c1", { code: "return 1;" }, undefined, undefined, {}),
    { message: MISSING_REASONING_ERROR }
  );
  assert.equal(executed.length, 0);
  const ctx = { model: {} };
  const result = await tool.execute("c2", { code: SCRIPT }, undefined, undefined, ctx);
  assert.deepEqual(result, scriptResult, "no summary when disabled");
  assert.deepEqual(executed[0].slice(0, 2), ["c2", { code: SCRIPT }]);
  assert.equal(executed[0][4], ctx);
});

test("result mode neither requires nor advertises codemode reasoning", async () => {
  const { tool } = await loadCodemode({ mode: "result" });
  assert.deepEqual(tool.promptGuidelines, ["Use codemode to batch."]);
  const result = await tool.execute("c1", { code: "return 1;" }, undefined, undefined, {});
  assert.deepEqual(result, scriptResult);
});

test("opted-in outputReasoning lands in details and in the call's usage", async () => {
  const { tool } = await loadCodemode({ outputReasoning: { enabled: true } });
  const seen: any[] = [];
  const ctx = {
    model: { id: "session" },
    modelRegistry: fakeRegistry(
      {
        content: [{ type: "text", text: "Counted three test files." }],
        stopReason: "stop",
        usage: { input: 3, output: 4, totalTokens: 7 },
      },
      seen
    ),
  };
  const result = await tool.execute("c1", { code: SCRIPT }, undefined, undefined, ctx);
  assert.equal(result.details.outputReasoning, "Counted three test files.");
  assert.deepEqual(result.details.calls, scriptResult.details.calls);
  assert.deepEqual(result.usage, { input: 3, output: 4, totalTokens: 7 });
  assert.deepEqual(result.content, scriptResult.content, "the main model never sees the summary");
  assert.equal(seen[0].model, ctx.model, "inherits the session model");

  const theme = { bg: (_name: string, text: string) => text };
  const card = tool.renderResult(
    result,
    { isPartial: false, expanded: false },
    theme,
    { args: { code: SCRIPT }, toolCallId: "c1", isPartial: false, isError: false }
  );
  const lines = card.render(160).map((line: string) => withoutAnsi(line).trimEnd());
  assert.equal(lines[0], "codemode count the test files");
  assert.equal(lines[1], '  ✓ bash <1s {"command":"ls"}');
  assert.equal(lines[2], '  ✗ read {"path":"a"}');
  assert.equal(lines[3], '  {"files":3}');
  assert.match(lines[4], /^ {2}↳ Counted three test files\. → done \(2 calls\) in /);
  assert.equal(lines.length, 5);
});

test("an unavailable summary model is reported on the card, not thrown", async () => {
  const { tool } = await loadCodemode({ outputReasoning: { enabled: true, model: "groq/missing" } });
  const ctx = { model: {}, modelRegistry: { find: () => undefined, streamSimple() { throw new Error("unused"); } } };
  const result = await tool.execute("c1", { code: SCRIPT }, undefined, undefined, ctx);
  assert.match(result.details.outputReasoningError, /groq\/missing not found/);
  assert.equal(result.details.outputReasoning, undefined);
});

test("hosts without a codemode export register no codemode tool", async () => {
  const tools = new Map<string, any>();
  const handlers: Array<() => unknown> = [];
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    await createTidyExtension({
      createIntegration: (() => ({
        async initialize() {
          return { skipTidyTools: new Set(), commit() {} };
        },
        async run() {
          return {};
        },
      })) as any,
      createCodemodeExtension: undefined,
    })({
      on: (event: string, handler: () => unknown) => {
        if (event === "session_start") handlers.push(handler);
      },
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  for (const handler of handlers) await handler();
  assert.equal(tools.has("codemode"), false);
  assert.equal(tools.has("bash"), true);
});

test("codemode blocks draw the script goal, falling back to the first code line", () => {
  const plain = buildToolBlock("codemode", { code: "// setup\nconst x = 1;\nreturn x;" }, scriptResult, {
    elapsedMs: 1200,
    icons: false,
  }).map(withoutAnsi);
  assert.deepEqual(plain, [
    "codemode const x = 1;",
    '  ✓ bash <1s {"command":"ls"}',
    '  ✗ read {"path":"a"}',
    '  {"files":3}',
    "  const x = 1; → done (2 calls) in 1s",
  ]);

  const failed = buildToolBlock("codemode", { code: SCRIPT }, { ...scriptResult, isError: true }, {
    isError: true,
    icons: false,
  }).map(withoutAnsi);
  assert.match(failed.at(-1)!, /→ failed \(2 calls\) in <1s$/, "a script failure keeps its header out");
  const rejected = buildToolBlock(
    "codemode",
    { code: "return 1;" },
    { content: [{ type: "text", text: MISSING_REASONING_ERROR }], isError: true },
    { isError: true, icons: false }
  ).map(withoutAnsi);
  assert.equal(rejected[1], `  ${MISSING_REASONING_ERROR} → failed (0 calls) in <1s`);

  const running = buildToolBlock("codemode", { code: SCRIPT }, {}, {
    isPartial: true,
    icons: false,
  }).map(withoutAnsi);
  assert.equal(running[0], "· codemode count the test files");

  const oneLine = buildToolBlock(
    "codemode",
    { code: SCRIPT },
    { ...scriptResult, details: { ...scriptResult.details, outputReasoning: "Counted." } },
    { mode: "reasoning", icons: false }
  ).map(withoutAnsi);
  assert.deepEqual(oneLine, [
    "codemode count the test files → done (2 calls) in <1s",
    '  ✓ bash <1s {"command":"ls"}',
    '  ✗ read {"path":"a"}',
    '  {"files":3}',
    "  ↳ Counted.",
  ]);
});

test("expanded codemode blocks add failure details and the script, not a short output again", () => {
  const lines = buildToolBlock(
    "codemode",
    { code: SCRIPT },
    { ...scriptResult, details: { ...scriptResult.details, outputReasoningError: "outputReasoning model x not found" } },
    { expanded: true, icons: false }
  ).map(withoutAnsi);
  assert.deepEqual(lines.slice(5), [
    "  outputReasoning model x not found",
    "  ✗ read: ENOENT",
    "  // @reasoning: count the test files",
    "  return (await tools.bash({ command: 'ls' }));",
  ]);
});

test("/tidy output-reasoning writes the opt-out and model without a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-output-reasoning-cmd-"));
  const path = join(dir, "config.json");
  const previousConfig = process.env.PI_TIDY_TOOLS_CONFIG;
  process.env.PI_TIDY_TOOLS_CONFIG = path;
  const commands = new Map<string, any>();
  try {
    await createTidyExtension({
      createIntegration: (() => ({
        async initialize() {
          return { skipTidyTools: new Set(), commit() {} };
        },
        async run() {
          return {};
        },
      })) as any,
      loadState: () => ({ enabled: false, source: "default" }),
    })({
      on() {},
      registerCommand: (name: string, options: any) => commands.set(name, options),
    } as any);
    const notices: string[] = [];
    let reloads = 0;
    const ctx = {
      ui: { notify: (message: string) => notices.push(message) },
      reload: async () => {
        reloads++;
      },
    };
    const tidy = commands.get("tidy");
    await tidy.handler("output-reasoning on", ctx);
    await tidy.handler("output-reasoning model Groq/openai/GPT-OSS-20B", ctx);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: true, model: "Groq/openai/GPT-OSS-20B" });
    await tidy.handler("output-reasoning model inherit", ctx);
    await tidy.handler("output-reasoning off", ctx);
    await tidy.handler("output-reasoning status", ctx);
    assert.deepEqual(loadTidyOutputReasoning(path), { enabled: false, model: undefined });
    assert.equal(reloads, 0);
    assert.equal(notices.at(-1), "codemode outputReasoning is off, model inherited from the session.");
    assert.equal(notices[1], "codemode outputReasoning is on, model Groq/openai/GPT-OSS-20B.");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_TIDY_TOOLS_CONFIG;
    else process.env.PI_TIDY_TOOLS_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("every nested call gets a line, MCP calls with whole-second durations", () => {
  const result = {
    content: [{ type: "text", text: "Script completed\nWall time 338.2 seconds\nOutput:\n" }],
    details: {
      calls: [
        { name: "mcp__jira__search", args: '{"q":"open bugs"}', status: "ok", durationMs: 13_200 },
        { name: "mcp__ci__wait_for_build", args: "", status: "ok", durationMs: 325_000 },
        { name: "bash", args: '{"command":"true"}', status: "cancelled", durationMs: 400 },
      ],
      outputReasoning: "Found 4 open bugs and waited for the green build.",
    },
  };
  const lines = buildToolBlock("codemode", { code: "// @reasoning: triage open bugs\nx()" }, result, {
    elapsedMs: 338_200,
    icons: false,
  }).map(withoutAnsi);
  assert.deepEqual(lines, [
    "codemode triage open bugs",
    '  ✓ mcp__jira__search 13s {"q":"open bugs"}',
    "  ✓ mcp__ci__wait_for_build 325s",
    '  ⊘ bash <1s {"command":"true"}',
    "  ↳ Found 4 open bugs and waited for the green build. → done (3 calls) in 5m 38s",
  ]);
});

const HEADER = "Script completed\nWall time 0.3 seconds\nOutput:\n";
const outputResult = (lines: string[]) => ({
  content: [{ type: "text", text: HEADER }, ...lines.map((text) => ({ type: "text", text }))],
  details: { calls: [] },
});

test("short codemode output shows whole on the card, one console.log per line", () => {
  const five = ["open: 4", "closed: 12", "", "oldest:\tPI-7", "newest: PI-42"];
  const lines = buildToolBlock("codemode", { code: SCRIPT }, outputResult(five), { icons: false }).map(withoutAnsi);
  assert.deepEqual(lines, [
    "codemode count the test files",
    "  open: 4",
    "  closed: 12",
    "  ",
    "  oldest: PI-7",
    "  newest: PI-42",
    "  return (await tools.bash({ command: 'ls' })); → done (0 calls) in <1s",
  ]);
  // A single block holding several lines is split the same way.
  const joined = buildToolBlock("codemode", { code: SCRIPT }, outputResult(["a\nb"]), { icons: false }).map(withoutAnsi);
  assert.deepEqual(joined.slice(1, 3), ["  a", "  b"]);
});

test("longer codemode output stays behind ctrl+o", () => {
  const six = ["1", "2", "3", "4", "5", "6"];
  const collapsed = buildToolBlock("codemode", { code: SCRIPT }, outputResult(six), { icons: false }).map(withoutAnsi);
  assert.equal(collapsed.length, 2);
  const expanded = buildToolBlock("codemode", { code: SCRIPT }, outputResult(six), {
    icons: false,
    expanded: true,
  }).map(withoutAnsi);
  assert.deepEqual(expanded.slice(-6), six.map((line) => `  ${line}`));
});

test("a failed script shows its short error output on the card", () => {
  const failed = {
    content: [
      { type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "Script error:\nTypeError: not a function" },
    ],
    details: { calls: [] },
    isError: true,
  };
  const lines = buildToolBlock("codemode", { code: SCRIPT }, failed, { isError: true, icons: false }).map(withoutAnsi);
  assert.deepEqual(lines.slice(1, 3), ["  Script error:", "  TypeError: not a function"]);
  assert.match(lines[3], /→ failed \(0 calls\)/);
});
