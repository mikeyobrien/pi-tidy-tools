import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Value } from "typebox/value";
import extension, {
  CHILD_SKIP_DIAGNOSTIC,
  MODEL_FIELD_DESCRIPTION,
  STANDARD_TASK_CLASSES,
  THINKING_FIELD_DESCRIPTION,
  loadRoutingConfig,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

type Registered = {
  tool: any;
  commands: Map<string, any>;
  events: Array<{ name: string; handler: () => void }>;
  registrations: number;
  thinkingReads: number;
};

function register(
  options: {
    thinking?: string;
    tools?: string[];
    childEnv?: string;
    argv?: string[];
  } = {}
): Registered {
  let tool: any;
  let registrations = 0;
  let thinkingReads = 0;
  const commands = new Map<string, any>();
  const events: Array<{ name: string; handler: () => void }> = [];
  const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
  const previousArgv = process.argv;
  if (options.childEnv === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = options.childEnv;
  if (options.argv) process.argv = options.argv;
  try {
    extension({
      registerTool(value: any) {
        registrations++;
        if (value.name === "subagent") tool = value;
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      on(name: string, handler: () => void) {
        events.push({ name, handler });
      },
      getThinkingLevel() {
        thinkingReads++;
        return options.thinking ?? "medium";
      },
      getActiveTools: () => options.tools ?? ["read", "subagent", "grep"],
    } as any);
  } finally {
    process.argv = previousArgv;
    if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
    else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
  }
  return { tool, commands, events, registrations, thinkingReads };
}

function registry() {
  const entries = new Map([
    ["fake\0model-x", { provider: "fake", id: "model-x" }],
    ["fake\0fast", { provider: "fake", id: "fast" }],
    ["other\0strong", { provider: "other", id: "strong" }],
  ]);
  return {
    find(provider: string, id: string) {
      return entries.get(`${provider}\0${id}`);
    },
    hasConfiguredAuth(model: { provider: string; id: string }) {
      return entries.has(`${model.provider}\0${model.id}`);
    },
  };
}

function context(root: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    mode: "tui",
    model: { provider: "fake", id: "model-x" },
    modelRegistry: registry(),
    isProjectTrusted: () => true,
    ...overrides,
  };
}

async function fixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-subagent-index-v2-"));
  const keys = [
    "PI_CODING_AGENT_DIR",
    "PI_TIDY_SUBAGENT_EXECUTABLE",
    "PI_TIDY_SUBAGENT_ARGS",
    "PI_TIDY_FAKE_RPC_OBSERVED_THINKING",
    "PI_TIDY_FAKE_RPC_MISMATCH",
    "PI_TIDY_FAKE_RPC_MALFORMED_STATE",
    "PI_TIDY_FAKE_RPC_STATE_ERROR",
    "PI_TIDY_FAKE_RPC_STATE_MODE",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([
    join(here, "fake-rpc.mjs"),
  ]);
  for (const key of keys.slice(3)) delete process.env[key];
  try {
    return await run(root);
  } finally {
    for (const key of keys)
      saved[key] === undefined
        ? delete process.env[key]
        : (process.env[key] = saved[key]);
    await rm(root, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      assert.fail("timed out waiting for lifecycle state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("registers the exact extension, lifecycle, command, and tool contracts", () => {
  const registered = register();
  assert.equal(registered.registrations, 2);
  assert.deepEqual(
    registered.events.map((event) => event.name),
    ["session_start", "session_shutdown"]
  );
  assert.deepEqual([...registered.commands.keys()], ["tidy-subagents-routing", "subagents"]);
  const command = registered.commands.get("tidy-subagents-routing");
  assert.equal(
    command.description,
    "Set up structured subagent routing map (task→thinking/model) from authenticated models into agent-dir config"
  );
  assert.deepEqual(
    command.getArgumentCompletions(""),
    ["setup", "defaults", "status", "clear"].map((value) => ({
      value,
      label: value,
    }))
  );
  assert.deepEqual(command.getArgumentCompletions("  ST"), [
    { value: "status", label: "status" },
  ]);
  assert.deepEqual(command.getArgumentCompletions(" clear "), [
    { value: "clear", label: "clear" },
  ]);
  assert.deepEqual(command.getArgumentCompletions("missing"), []);
  assert.deepEqual(
    {
      name: registered.tool.name,
      label: registered.tool.label,
      renderShell: registered.tool.renderShell,
      executionMode: registered.tool.executionMode,
      description: registered.tool.description,
      promptGuidelines: registered.tool.promptGuidelines,
    },
    {
      name: "subagent",
      label: "subagent",
      renderShell: "self",
      executionMode: "parallel",
      description:
        "Launch ordered foreground and background child Pi agents. Omitted execution remains synchronous foreground. Background children are session-scoped, share the same scheduler and working tree, and return durable acknowledgements rather than partial output.",
      promptGuidelines: [
        "Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives.",
        "Thinking is the primary per-child control. Prefer omit thinking to inherit parent; otherwise pick a closed Pi level for the task shape.",
        "Prefer omit model (inherit parent). Pass an exact registered provider/model-id only when capability or cost warrants. No aliases, profiles, or fuzzy patterns.",
        "Optional model/thinking precedence (most specific wins): (1) explicit per-child model/thinking request fields on the tool call; (2) user turn instructions; (3) AGENTS.md / project agent instructions; (4) optional structured agent-dir routing map from /tidy-subagents-routing; (5) extension short schema defaults / promptGuidelines; (6) parent inheritance when fields remain omitted. Extension does not parse AGENTS.md or auto-inject routing.",
        "No agent-dir routing map yet. Run /tidy-subagents-routing to build a task→{thinking,model?} map from authenticated models (thinking-primary; model omit=inherit).",
        "Use subagent execution=background only when the parent can proceed without the result; omission stays foreground and synchronous.",
        "Use subagent_control to inspect, background, steer, cancel, change delivery, or collect one session child by canonical target or unambiguous label.",
      ],
    }
  );
});

test("publishes the exact schema and validation boundary", () => {
  const { tool } = register();
  assert.deepEqual(tool.parameters, {
    type: "object",
    required: ["agents"],
    properties: {
      agents: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["reason", "prompt"],
          properties: {
            label: {
              type: "string",
              description: "Short display label; defaults to agent",
            },
            reason: {
              type: "string",
              description:
                "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)",
            },
            prompt: {
              type: "string",
              description:
                "Full context, skills, objective, and output expectations sent verbatim to the child",
            },
            model: { type: "string", description: MODEL_FIELD_DESCRIPTION },
            thinking: {
              anyOf: [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ].map((value) => ({ type: "string", const: value })),
              description: THINKING_FIELD_DESCRIPTION,
            },
            execution: {
              anyOf: ["foreground", "background"].map((value) => ({ type: "string", const: value })),
              description: "Ownership mode. Omit for synchronous foreground execution; background returns after durable registration.",
            },
          },
        },
      },
    },
  });
  const cases = [
    [{}, false],
    [{ agents: [] }, false],
    [{ agents: [{}] }, false],
    [{ agents: [{ reason: 1, prompt: "x" }] }, false],
    [{ agents: [{ reason: "x", prompt: "y", thinking: "turbo" }] }, false],
    [
      {
        agents: [
          {
            reason: "x",
            prompt: "y",
            label: "z",
            model: "fake/fast",
            thinking: "high",
          },
        ],
      },
      true,
    ],
  ] as const;
  assert.deepEqual(
    cases.map(([value]) => Value.Check(tool.parameters, value)),
    cases.map(([, valid]) => valid)
  );
});

test("true child RPC skips every registration, warns exactly, and clears its marker", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) =>
    warnings.push(values.map(String).join(" "));
  try {
    const child = register({
      childEnv: "1",
      argv: ["node", "pi", "--mode", "rpc"],
    });
    assert.equal(child.registrations, 0);
    assert.equal(child.tool, undefined);
    assert.deepEqual(child.events, []);
    assert.deepEqual([...child.commands], []);
    assert.deepEqual(warnings, [CHILD_SKIP_DIAGNOSTIC]);
  } finally {
    console.warn = originalWarn;
  }
  const parent = register({
    childEnv: "1",
    argv: ["node", "pi", "--mode", "json"],
  });
  assert.equal(parent.registrations, 2);
  assert.equal(parent.commands.size, 2);
});

test("routing command covers status, defaults, clear, usage, and unavailable models", async () =>
  fixture(async () => {
    const command = register().commands.get("tidy-subagents-routing");
    const notes: Array<{ message: string; type?: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, type?: string) {
          notes.push({ message, type });
        },
        async select() {
          assert.fail("selection must not run");
        },
      },
      modelRegistry: { getAvailable: () => [] },
    };
    await command.handler(" status ", ctx);
    assert.deepEqual(notes.pop(), {
      message:
        "No routing map at agent-dir pi-tidy-subagents/routing.json. Run /tidy-subagents-routing setup.",
      type: "info",
    });
    await command.handler("DEFAULTS", ctx);
    assert.match(
      notes.at(-1)!.message,
      /^Wrote thinking-primary defaults \(model=inherit\) to .*routing\.json\.\n/
    );
    assert.equal(notes.at(-1)!.type, "info");
    await command.handler("status", ctx);
    assert.match(
      notes.at(-1)!.message,
      /^User routing map \(agent-dir pi-tidy-subagents\/routing\.json\)/
    );
    assert.equal(notes.at(-1)!.type, "info");
    await command.handler("clear", ctx);
    assert.deepEqual(notes.at(-1), {
      message: "Cleared agent-dir routing map.",
      type: "info",
    });
    await command.handler("clear", ctx);
    assert.deepEqual(notes.at(-1), {
      message: "No routing map to clear.",
      type: "info",
    });
    await command.handler("wat", ctx);
    assert.deepEqual(notes.at(-1), {
      message: "Usage: /tidy-subagents-routing [setup|defaults|status|clear]",
      type: "warning",
    });
    await command.handler("", ctx);
    assert.deepEqual(notes.at(-1), {
      message:
        "No authenticated models available. Configure provider auth, then re-run /tidy-subagents-routing setup.",
      type: "warning",
    });
  }));

test("routing setup uses exact prompts, suggestions, selections, and parent isolation", async () =>
  fixture(async () => {
    const command = register().commands.get("tidy-subagents-routing");
    const titles: string[] = [];
    const optionsSeen: string[][] = [];
    const answers = STANDARD_TASK_CLASSES.flatMap((task, index) => {
      const suggested: Record<string, string> = {
        "bounded-lookup": "minimal (suggested)",
        "mechanical-implementation": "low (suggested)",
        "ordinary-review": "medium (suggested)",
        "architectural-judgment": "high (suggested)",
        "concurrency-analysis": "high (suggested)",
        "cost-sensitive": "minimal (suggested)",
      };
      return [
        suggested[task] ?? "inherit (parent)",
        index === 0 ? "fake/fast" : "inherit (parent)",
      ];
    });
    let answer = 0;
    let modelMutations = 0;
    let thinkingMutations = 0;
    const notes: Array<{ message: string; type?: string }> = [];
    await command.handler("setup", {
      ui: {
        notify(message: string, type?: string) {
          notes.push({ message, type });
        },
        async select(title: string, options: string[]) {
          titles.push(title);
          optionsSeen.push(options);
          return answers[answer++];
        },
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "fake", id: "fast" },
          { provider: "other", id: "strong" },
        ],
      },
      setModel() {
        modelMutations++;
      },
      setThinkingLevel() {
        thinkingMutations++;
      },
    });
    assert.equal(answer, STANDARD_TASK_CLASSES.length * 2);
    assert.deepEqual(titles.slice(0, 2), [
      "bounded-lookup: thinking (primary)",
      "bounded-lookup: model (optional override)",
    ]);
    assert.deepEqual(optionsSeen[0], [
      "inherit (parent)",
      "off",
      "minimal (suggested)",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(optionsSeen[1], [
      "inherit (parent)",
      "fake/fast",
      "other/strong",
    ]);
    assert.equal(modelMutations, 0);
    assert.equal(thinkingMutations, 0);
    assert.match(
      notes[0]!.message,
      /^Saved routing map to .*routing\.json\. Parent session model\/thinking unchanged\.\n/
    );
    assert.equal(notes[0]!.type, "info");
    const config = loadRoutingConfig(process.env.PI_CODING_AGENT_DIR!);
    assert.equal(config!.taskClasses["bounded-lookup"]!.thinking, "minimal");
    assert.equal(config!.taskClasses["bounded-lookup"]!.model, "fake/fast");
    assert.deepEqual(config!.taskClasses["similarly-named-models"], undefined);
  }));

test("routing setup cancels at both selection boundaries", async () =>
  fixture(async () => {
    const command = register().commands.get("tidy-subagents-routing");
    for (const answers of [[undefined], ["minimal (suggested)", undefined]]) {
      const notes: Array<{ message: string; type?: string }> = [];
      let index = 0;
      await command.handler("setup", {
        ui: {
          notify(message: string, type?: string) {
            notes.push({ message, type });
          },
          async select() {
            return answers[index++];
          },
        },
        modelRegistry: {
          getAvailable: () => [{ provider: "fake", id: "fast" }],
        },
      });
      assert.deepEqual(notes, [
        { message: "Routing setup cancelled.", type: "warning" },
      ]);
    }
  }));

test("execution emits exact queued and settled public snapshots and persisted truth", async () =>
  fixture(async (root) => {
    process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING = "low";
    const registered = register({
      tools: ["read", "subagent", "grep"],
      thinking: "high",
    });
    const updates: any[] = [];
    const result = await registered.tool.execute(
      "contract-call",
      {
        agents: [
          {
            label: "alpha",
            reason: "inspect exact flow",
            prompt: "first",
            model: "fake/fast",
            thinking: "high",
          },
          { reason: "exercise warning", prompt: "empty" },
        ],
      },
      undefined,
      (update: any) => updates.push(update),
      context(root, { isProjectTrusted: () => false })
    );
    assert.ok(updates.length >= 5);
    assert.deepEqual(updates[0].content, [
      { type: "text", text: "Subagents running" },
    ]);
    assert.deepEqual(
      updates[0].details.children.map((child: any) => ({
        index: child.index,
        id: child.id,
        label: child.label,
        reason: child.reason,
        prompt: child.prompt,
        response: child.response,
        status: child.status,
        model: child.model,
        thinking: child.thinking,
        activities: child.activities,
        activeTools: child.activeTools,
        eventCount: child.eventCount,
      })),
      [
        {
          index: 0,
          id: "child-001",
          label: "alpha",
          reason: "inspect exact flow",
          prompt: "",
          response: "",
          status: "queued",
          model: "fast",
          thinking: "high",
          activities: [],
          activeTools: [],
          eventCount: 0,
        },
        {
          index: 1,
          id: "child-002",
          label: "agent",
          reason: "exercise warning",
          prompt: "",
          response: "",
          status: "queued",
          model: "model-x",
          thinking: "high",
          activities: [],
          activeTools: [],
          eventCount: 0,
        },
      ]
    );
    assert.deepEqual(updates.at(-1), {
      content: [{ type: "text", text: "Subagents running" }],
      details: result.details,
    });
    assert.deepEqual(result.details.runtime, {
      provider: "fake",
      modelId: "model-x",
      model: "fake/model-x",
      thinking: "high",
      activeTools: ["read", "grep"],
      projectTrusted: false,
    });
    assert.equal(result.details.schemaVersion, 3);
    assert.equal(result.details.cwd, root);
    assert.equal(result.details.cap > 0, true);
    assert.match(
      result.details.createdAt,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
    );
    assert.match(
      result.details.runId,
      /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}$/
    );
    assert.equal(
      result.details.runDir,
      join(
        process.env.PI_CODING_AGENT_DIR!,
        "pi-tidy-subagents",
        "runs",
        result.details.runId
      )
    );
    assert.deepEqual(
      result.details.children.map((child: any) => child.status),
      ["completed", "warning"]
    );
    const first = result.details.children[0];
    assert.equal(
      first.artifactPath,
      join(result.details.runDir, "child-001.md")
    );
    assert.equal(first.prompt, "");
    assert.equal(first.response, "");
    assert.deepEqual(first.activeTools, []);
    assert.deepEqual(first.runtimePlan, {
      provider: "fake",
      modelId: "fast",
      model: "fake/fast",
      thinking: "low",
      provenance: "request",
      requestedModel: "fake/fast",
      thinkingProvenance: "request",
      requestedThinking: "high",
      resolvedThinking: "high",
      observed: {
        provider: "fake",
        modelId: "fast",
        model: "fake/fast",
        thinking: "low",
      },
      thinkingAdjustment: { from: "high", to: "low", reason: "observed" },
    });
    assert.match(
      result.content[0].text,
      /^<subagent_result index="0" label="alpha" status="completed"/
    );
    assert.match(
      result.content[0].text,
      /<subagent_result index="1" label="agent" status="warning"/
    );
    assert.match(
      result.content[0].text,
      /# Result\n\nfirst \]\]\]\]><!\[CDATA\[> kept/
    );
    const persisted = JSON.parse(
      await readFile(join(result.details.runDir, "run.json"), "utf8")
    );
    assert.equal(persisted.children[0].prompt, "first");
    assert.equal("response" in persisted.children[0], false);
    assert.equal(
      await readFile(first.artifactPath, "utf8"),
      "# Result\n\nfirst ]]> kept"
    );
    assert.deepEqual(persisted.children[0].runtimePlan, first.runtimePlan);
  }));

test("execution rejects missing parents and preserves exact pre-cancellation truth", async () =>
  fixture(async (root) => {
    const { tool } = register();
    await assert.rejects(
      tool.execute(
        "no-parent",
        { agents: [{ reason: "require parent", prompt: "first" }] },
        undefined,
        undefined,
        context(root, { model: undefined })
      ),
      { name: "Error", message: "subagent requires a resolved parent model" }
    );
    const pre = new AbortController();
    pre.abort();
    const untouched = await tool.execute(
      "pre-aborted",
      { agents: [{ reason: "never launch", prompt: "first" }] },
      pre.signal,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: untouched.details.children[0].status,
        error: untouched.details.children[0].error,
        eventCount: untouched.details.children[0].eventCount,
        endedAt: typeof untouched.details.children[0].endedAt,
      },
      {
        status: "not-started",
        error: "Cancelled before start",
        eventCount: 0,
        endedAt: "number",
      }
    );
  }));

test("session shutdown cancels active work, clears ownership, and rejects later scheduling", async () =>
  fixture(async (root) => {
    const registered = register();
    let latest: any;
    const pending = registered.tool.execute(
      "shutdown",
      { agents: [{ reason: "wait forever", prompt: "hang" }] },
      undefined,
      (update: any) => {
        latest = update.details;
      },
      context(root)
    );
    await waitUntil(() => latest?.children[0].status === "running");
    registered.events.find((event) => event.name === "session_shutdown")!.handler();
    const stopped = await pending;
    assert.deepEqual(
      {
        status: stopped.details.children[0].status,
        error: stopped.details.children[0].error,
      },
      { status: "cancelled", error: "Cancelled" }
    );
    const after = await registered.tool.execute(
      "after-shutdown",
      { agents: [{ reason: "cannot schedule", prompt: "first" }] },
      undefined,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: after.details.children[0].status,
        error: after.details.children[0].error,
      },
      { status: "failed", error: "scheduler shut down" }
    );
  }));

test("render call and result select exact shell, expansion, and lifecycle backgrounds", () => {
  const { tool } = register();
  assert.deepEqual(tool.renderCall().render(80), []);
  const child = {
    index: 0,
    id: "child-001",
    label: "alpha",
    reason: "inspect alpha",
    prompt: "",
    status: "completed",
    model: "model-x",
    thinking: "medium",
    toolCount: 2,
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    providerTraffic: 14,
    tokens: 14,
    activities: ["first", "second", "third"],
    activeTools: [],
    eventCount: 1,
    response: "",
    artifactPath: "/tmp/child-001.md",
    startedAt: 1_000,
    endedAt: 2_500,
  };
  const details: any = {
    children: [
      child,
      { ...child, index: 1, id: "child-002", label: "beta", status: "failed" },
    ],
  };
  const backgrounds: string[] = [];
  const theme = {
    bg(name: string, text: string) {
      backgrounds.push(name);
      return `[${name}]${text}`;
    },
  };
  const mixed = tool
    .renderResult({ details }, { expanded: false, isPartial: false }, theme)
    .render(200)
    .map(plain);
  assert.match(
    mixed[0].replace(/\[toolErrorBg\]/g, ""),
    /✓.*🤖.*alpha\[model-x\|medium\] inspect alpha/
  );
  assert.equal(
    mixed.some((line: string) => line === ""),
    true
  );
  assert.equal(
    backgrounds.every((name) => name === "toolErrorBg"),
    true
  );
  backgrounds.length = 0;
  child.status = "warning";
  details.children = [child];
  const pending = tool
    .renderResult({ details }, { expanded: true, isPartial: true }, theme)
    .render(200)
    .map(plain);
  assert.match(pending[0].replace(/\[toolPendingBg\]/g, ""), /!.*🤖.*alpha/);
  assert.ok(pending.some((line: string) => line.includes("first")));
  assert.equal(
    backgrounds.every((name) => name === "toolPendingBg"),
    true
  );
  backgrounds.length = 0;
  const success = tool
    .renderResult({ details }, { expanded: false, isPartial: false }, theme)
    .render(200)
    .map(plain);
  assert.match(success[0].replace(/\[toolSuccessBg\]/g, ""), /!.*🤖.*alpha/);
  assert.equal(
    backgrounds.every((name) => name === "toolSuccessBg"),
    true
  );
  assert.deepEqual(
    tool
      .renderResult({}, { expanded: false, isPartial: false }, theme)
      .render(80),
    []
  );
});
