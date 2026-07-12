import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Value } from "typebox/value";
import extension, { concurrencyCap } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

function register(marker?: string) {
  let tool: any;
  const events: Array<{ name: string; handler: () => void }> = [];
  let registrations = 0;
  const previous = process.env.PI_TIDY_SUBAGENT_CHILD;
  if (marker === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = marker;
  try {
    extension({
      registerTool(value: any) {
        registrations++;
        tool = value;
      },
      on(name: string, handler: () => void) {
        events.push({ name, handler });
      },
      getThinkingLevel: () => "medium",
      getActiveTools: () => ["read", "subagent", "grep"],
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
    else process.env.PI_TIDY_SUBAGENT_CHILD = previous;
  }
  return { tool, events, registrations };
}

const context = (
  cwd: string,
  model: any = { provider: "fake", id: "model-x" }
) => ({
  cwd,
  mode: "tui",
  model,
  isProjectTrusted: () => true,
});

async function fixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-subagent-contract-"));
  const saved = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    executable: process.env.PI_TIDY_SUBAGENT_EXECUTABLE,
    args: process.env.PI_TIDY_SUBAGENT_ARGS,
  };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([
    join(here, "fake-rpc.mjs"),
  ]);
  try {
    return await run(root);
  } finally {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["PI_TIDY_SUBAGENT_EXECUTABLE", saved.executable],
      ["PI_TIDY_SUBAGENT_ARGS", saved.args],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      assert.fail("timed out waiting for exact child state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("registers the exact public extension only outside child processes", () => {
  const child = register("1");
  assert.equal(child.registrations, 0);
  assert.deepEqual(child.events, []);
  assert.equal(child.tool, undefined);

  const parent = register();
  assert.equal(parent.registrations, 1);
  assert.equal(parent.events.length, 1);
  assert.equal(parent.events[0]?.name, "session_shutdown");
  assert.deepEqual(
    {
      name: parent.tool.name,
      label: parent.tool.label,
      renderShell: parent.tool.renderShell,
      executionMode: parent.tool.executionMode,
      description: parent.tool.description,
      promptGuidelines: parent.tool.promptGuidelines,
    },
    {
      name: "subagent",
      label: "subagent",
      renderShell: "self",
      executionMode: "parallel",
      description:
        "Run an ordered synchronous fan-out of isolated child Pi agents. Every agent needs a short reason and verbatim prompt. Children share the working tree; assign non-overlapping writes.",
      promptGuidelines: [
        "Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives.",
      ],
    }
  );
  assert.deepEqual(parent.tool.parameters, {
    type: "object",
    required: ["agents"],
    properties: {
      agents: {
        type: "array",
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
          },
        },
        minItems: 1,
      },
    },
  });
});

test("schema validation has exact defaults and failure outcomes", () => {
  const { tool } = register();
  const outcomes = [
    {},
    { agents: [] },
    { agents: [{}] },
    { agents: [{ reason: 1, prompt: "work" }] },
    { agents: [{ reason: "inspect work", prompt: "work" }] },
  ].map((value) => ({
    valid: Value.Check(tool.parameters, value),
    errors: [...Value.Errors(tool.parameters, value)].map((error) => ({
      keyword: error.keyword,
      schemaPath: error.schemaPath,
      instancePath: error.instancePath,
      message: error.message,
    })),
  }));
  assert.deepEqual(outcomes, [
    {
      valid: false,
      errors: [
        {
          keyword: "required",
          schemaPath: "#",
          instancePath: "",
          message: "must have required properties agents",
        },
      ],
    },
    {
      valid: false,
      errors: [
        {
          keyword: "minItems",
          schemaPath: "#/properties/agents",
          instancePath: "/agents",
          message: "must not have fewer than 1 items",
        },
      ],
    },
    {
      valid: false,
      errors: [
        {
          keyword: "required",
          schemaPath: "#/properties/agents/items",
          instancePath: "/agents/0",
          message: "must have required properties reason, prompt",
        },
      ],
    },
    {
      valid: false,
      errors: [
        {
          keyword: "type",
          schemaPath: "#/properties/agents/items/properties/reason",
          instancePath: "/agents/0/reason",
          message: "must be string",
        },
      ],
    },
    { valid: true, errors: [] },
  ]);
});

test("execution emits exact updates and a redacted completed result with defaults", async () =>
  fixture(async (root) => {
    const { tool } = register();
    const updates: any[] = [];
    const result = await tool.execute(
      "complete",
      { agents: [{ reason: "inspect work", prompt: "first" }] },
      undefined,
      (update: any) => updates.push(update),
      context(root)
    );
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
        activities: child.activities,
        activeTools: child.activeTools,
      })),
      [
        {
          index: 0,
          id: "child-001",
          label: "agent",
          reason: "inspect work",
          prompt: "",
          response: "",
          status: "queued",
          activities: [],
          activeTools: [],
        },
      ]
    );
    assert.deepEqual(updates.at(-1)?.content, [
      { type: "text", text: "Subagents running" },
    ]);
    assert.deepEqual(updates.at(-1)?.details, result.details);
    assert.equal(result.details.children[0].status, "completed");
    assert.equal(result.details.children[0].prompt, "");
    assert.equal(result.details.children[0].response, "");
    assert.deepEqual(result.details.runtime, {
      provider: "fake",
      modelId: "model-x",
      model: "fake/model-x",
      thinking: "medium",
      activeTools: ["read", "grep"],
      projectTrusted: true,
    });
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: `<subagent_result index="0" label="agent" status="completed" artifact="${result.details.children[0].artifactPath}"><content format="markdown"><![CDATA[# Result\n\nfirst ]]]]><![CDATA[> kept]]></content></subagent_result>`,
      },
    ]);
  }));

test("execution reports exact model and child failure errors", async () =>
  fixture(async (root) => {
    const { tool } = register();
    await assert.rejects(
      tool.execute(
        "no-model",
        { agents: [{ reason: "inspect work", prompt: "first" }] },
        undefined,
        undefined,
        context(root, null)
      ),
      { name: "Error", message: "subagent requires a resolved parent model" }
    );
    const rejected = await tool.execute(
      "rejected",
      { agents: [{ reason: "test rejection", prompt: "reject" }] },
      undefined,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: rejected.details.children[0].status,
        error: rejected.details.children[0].error,
      },
      { status: "failed", error: "prompt rejected" }
    );
    assert.deepEqual(rejected.content, [
      {
        type: "text",
        text: `<subagent_result index="0" label="agent" status="failed" artifact="${rejected.details.children[0].artifactPath}"><content format="markdown"><![CDATA[prompt rejected]]></content></subagent_result>`,
      },
    ]);
    const crashed = await tool.execute(
      "crashed",
      { agents: [{ reason: "test crash", prompt: "crash" }] },
      undefined,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: crashed.details.children[0].status,
        error: crashed.details.children[0].error,
      },
      { status: "failed", error: "provider failed" }
    );
  }));

test("shared concurrency and cancellation settle exactly as cancelled and not-started", async () =>
  fixture(async (root) => {
    const { tool } = register();
    const cap = concurrencyCap();
    const controller = new AbortController();
    let latest: any;
    const pending = tool.execute(
      "bounded",
      {
        agents: Array.from({ length: cap + 1 }, (_, index) => ({
          reason: `wait ${index}`,
          prompt: "hang",
        })),
      },
      controller.signal,
      (update: any) => {
        latest = update.details;
      },
      context(root)
    );
    await waitUntil(
      () =>
        latest?.children.filter((child: any) => child.status === "running")
          .length === cap &&
        latest?.children.filter((child: any) => child.status === "queued")
          .length === 1
    );
    assert.deepEqual(
      latest.children.map((child: any) => child.status),
      [...Array(cap).fill("running"), "queued"]
    );
    controller.abort();
    const result = await pending;
    assert.deepEqual(
      result.details.children.map((child: any) => child.status),
      [...Array(cap).fill("cancelled"), "not-started"]
    );
    assert.deepEqual(
      result.details.children.map((child: any) => child.error),
      Array(cap + 1).fill("Cancelled")
    );
  }));

test("pre-cancel and shutdown cover not-started and active cancellation branches", async () =>
  fixture(async (root) => {
    const preCancelled = register().tool;
    const controller = new AbortController();
    controller.abort();
    const untouched = await preCancelled.execute(
      "pre-cancel",
      { agents: [{ reason: "never start", prompt: "first" }] },
      controller.signal,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: untouched.details.children[0].status,
        error: untouched.details.children[0].error,
        eventCount: untouched.details.children[0].eventCount,
      },
      { status: "not-started", error: "Cancelled before start", eventCount: 0 }
    );

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
    registered.events[0].handler();
    const stopped = await pending;
    assert.deepEqual(
      {
        status: stopped.details.children[0].status,
        error: stopped.details.children[0].error,
      },
      { status: "cancelled", error: "Cancelled" }
    );
    const afterShutdown = await registered.tool.execute(
      "after-shutdown",
      { agents: [{ reason: "cannot queue", prompt: "first" }] },
      undefined,
      undefined,
      context(root)
    );
    assert.deepEqual(
      {
        status: afterShutdown.details.children[0].status,
        error: afterShutdown.details.children[0].error,
      },
      { status: "failed", error: "scheduler shut down" }
    );
  }));

test("renderers expose exact detail, expansion, and native backgrounds", () => {
  const { tool } = register();
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
    activities: ["first activity", "second activity", "third activity"],
    activeTools: [],
    eventCount: 1,
    response: "",
    artifactPath: "/tmp/child-001.md",
    startedAt: 1_000,
    endedAt: 2_500,
  };
  const details: any = { children: [child] };
  const backgrounds: string[] = [];
  const theme = {
    bg(name: string, text: string) {
      backgrounds.push(name);
      return text;
    },
  };
  assert.deepEqual(tool.renderCall().render(80), []);
  const settledLines = tool
    .renderResult({ details }, { expanded: false, isPartial: false }, theme)
    .render(200)
    .map(plain);
  assert.deepEqual(
    settledLines.map((line: string) => line.trimEnd()),
    [
      "  ┊ ✓ 🤖 alpha[model-x|medium] inspect alpha → 2 tools · ↑2 ↓3 · 1s",
      "  ┊     second activity",
      "  ┊     third activity",
    ]
  );
  assert.deepEqual(
    settledLines.map((line: string) => line.length),
    [200, 200, 200]
  );
  assert.equal(
    backgrounds.every((name) => name === "toolSuccessBg"),
    true
  );
  backgrounds.length = 0;
  assert.deepEqual(
    tool
      .renderResult({ details }, { expanded: true, isPartial: true }, theme)
      .render(200)
      .map((line: string) => plain(line).trimEnd()),
    [
      "  ┊ ✓ 🤖 alpha[model-x|medium] inspect alpha → 2 tools · ↑2 ↓3 · 1s",
      "  ┊     first activity",
      "  ┊     second activity",
      "  ┊     third activity",
    ]
  );
  assert.equal(
    backgrounds.every((name) => name === "toolPendingBg"),
    true
  );
  const failureHeaders = [
    [
      "failed",
      "  ┊ ✗ 🤖 alpha[model-x|medium] inspect alpha → 2 tools · ↑2 ↓3 · 1s",
    ],
    [
      "cancelled",
      "  ┊ ■ 🤖 alpha[model-x|medium] inspect alpha → 2 tools · ↑2 ↓3 · 1s",
    ],
    [
      "not-started",
      "  ┊ ○ 🤖 alpha[model-x|medium] inspect alpha → 2 tools · ↑2 ↓3 · 1s",
    ],
  ] as const;
  for (const [status, header] of failureHeaders) {
    backgrounds.length = 0;
    child.status = status;
    assert.equal(
      plain(
        tool
          .renderResult(
            { details },
            { expanded: false, isPartial: false },
            theme
          )
          .render(200)[0]
      ).trimEnd(),
      header
    );
    assert.equal(
      backgrounds.every((name) => name === "toolErrorBg"),
      true
    );
  }
  assert.deepEqual(
    tool
      .renderResult({}, { expanded: false, isPartial: false }, theme)
      .render(80),
    []
  );
});
