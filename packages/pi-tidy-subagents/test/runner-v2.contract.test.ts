import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildChildArgs,
  launchRuntime,
  runChild,
  type Runtime,
} from "../runner.js";
import type { ChildRuntimePlan, ChildState } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeRpc = join(here, "fake-rpc.mjs");

function makeChild(
  root: string,
  prompt: string,
  runtimePlan?: ChildRuntimePlan
): ChildState {
  return {
    index: 0,
    id: "child-v2",
    label: "runner-v2",
    reason: "exercise current RPC contract",
    prompt,
    status: "queued",
    model: "model-x",
    thinking: "high",
    toolCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    providerTraffic: 0,
    tokens: 0,
    activities: [],
    activeTools: [],
    eventCount: 0,
    response: "",
    artifactPath: join(root, "child-v2.md"),
    ...(runtimePlan ? { runtimePlan } : {}),
  };
}

async function fixture<T>(
  fn: (root: string, runtime: Runtime) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-runner-v2-"));
  const runDir = join(root, "run");
  await mkdir(runDir);
  const previous = {
    executable: process.env.PI_TIDY_SUBAGENT_EXECUTABLE,
    args: process.env.PI_TIDY_SUBAGENT_ARGS,
    stateMode: process.env.PI_TIDY_FAKE_RPC_STATE_MODE,
    observedThinking: process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING,
  };
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([fakeRpc]);
  delete process.env.PI_TIDY_FAKE_RPC_STATE_MODE;
  delete process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING;
  try {
    return await fn(root, {
      cwd: root,
      model: "fake/model-x",
      thinking: "high",
      tools: ["read"],
      runDir,
      approved: true,
    });
  } finally {
    for (const [key, value] of [
      ["PI_TIDY_SUBAGENT_EXECUTABLE", previous.executable],
      ["PI_TIDY_SUBAGENT_ARGS", previous.args],
      ["PI_TIDY_FAKE_RPC_STATE_MODE", previous.stateMode],
      ["PI_TIDY_FAKE_RPC_OBSERVED_THINKING", previous.observedThinking],
    ] as const)
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(root, { recursive: true, force: true });
  }
}

const plan = (): ChildRuntimePlan => ({
  provider: "fake",
  modelId: "model-x",
  model: "fake/model-x",
  thinking: "high",
  provenance: "parent",
  thinkingProvenance: "parent",
  resolvedThinking: "high",
});

const plain = (lines: string[]): string[] =>
  lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

async function events(runtime: Runtime): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(runtime.runDir, "child-v2.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function useInlineRpc(root: string, handler: string): Promise<void> {
  const path = join(root, "inline-rpc.mjs");
  await writeFile(
    path,
    `
let buffer = "";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.on("data", (chunk) => {
 buffer += chunk.toString("utf8");
 const lines = buffer.split("\\n"); buffer = lines.pop() ?? "";
 for (const line of lines) {
  if (!line) continue;
  const command = JSON.parse(line);
  ${handler}
 }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([path]);
}

const stateResponse = `
if (command.type === "get_state") {
 send({ type: "response", id: command.id, command: "get_state", success: true,
  data: { model: { provider: "fake", id: "model-x" }, thinkingLevel: "high" } });
 continue;
}
`;

test("launch helpers preserve exact argument order and shared runtime ownership", () => {
  const shared = {
    cwd: "/work",
    tools: ["read", "grep"],
    runDir: "/run",
    approved: true,
  };
  assert.deepEqual(
    launchRuntime({ model: "fake/model-x", thinking: "high" }, shared),
    {
      cwd: "/work",
      tools: ["read", "grep"],
      runDir: "/run",
      approved: true,
      model: "fake/model-x",
      thinking: "high",
    }
  );
  assert.deepEqual(
    buildChildArgs({
      model: "fake/model-x",
      thinking: "high",
      tools: ["read", "grep"],
      approved: true,
    }),
    [
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      "--model",
      "fake/model-x",
      "--thinking",
      "high",
      "--tools",
      "read,grep",
    ]
  );
  assert.deepEqual(
    buildChildArgs({
      model: "fake/model-x",
      thinking: "off",
      tools: [],
      approved: false,
    }),
    [
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      "fake/model-x",
      "--thinking",
      "off",
      "--no-tools",
    ]
  );
});

test("the full RPC narrative records exact prompt, events, usage, tools, and callbacks", async () =>
  fixture(async (root, runtime) => {
    const child = makeChild(root, "first", plan());
    const callbacks: Array<{
      immediate: boolean | undefined;
      status: string;
      events: number;
      tools: number;
      active: number;
    }> = [];
    const result = await runChild(child, runtime, undefined, (immediate) =>
      callbacks.push({
        immediate,
        status: child.status,
        events: child.eventCount,
        tools: child.toolCount,
        active: child.activeTools.length,
      })
    );
    assert.equal(result, child);
    assert.equal(result.status, "completed");
    assert.equal(result.response, "# Result\n\nfirst ]]> kept");
    assert.equal(result.error, undefined);
    assert.equal(result.model, "model-x");
    assert.equal(result.thinking, "high");
    assert.equal(result.toolCount, 2);
    assert.deepEqual(
      {
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        providerTraffic: result.providerTraffic,
        tokens: result.tokens,
        eventCount: result.eventCount,
      },
      {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        providerTraffic: 14,
        tokens: 14,
        eventCount: 12,
      }
    );
    assert.deepEqual(result.activeTools, []);
    assert.equal(result.streamingLine, undefined);
    assert.deepEqual(plain(result.activities), [
      "working fragments",
      "next line",
      "✓ 📖 read inspect the source",
      "  a.ts → 1 lines",
      "✓ ◆ mystery b",
      "  b → done",
      "# Result",
      "first ]]> kept",
    ]);
    assert.ok(
      result.startedAt && result.endedAt && result.endedAt >= result.startedAt
    );
    assert.deepEqual(result.runtimePlan, {
      ...plan(),
      observed: {
        provider: "fake",
        modelId: "model-x",
        model: "fake/model-x",
        thinking: "high",
      },
    });
    assert.deepEqual(callbacks, [
      { immediate: true, status: "starting", events: 0, tools: 0, active: 0 },
      { immediate: true, status: "running", events: 0, tools: 0, active: 0 },
      { immediate: true, status: "running", events: 1, tools: 0, active: 0 },
      { immediate: false, status: "running", events: 4, tools: 0, active: 0 },
      { immediate: false, status: "running", events: 5, tools: 0, active: 0 },
      { immediate: true, status: "running", events: 6, tools: 0, active: 0 },
      { immediate: true, status: "running", events: 7, tools: 1, active: 1 },
      { immediate: true, status: "running", events: 8, tools: 2, active: 2 },
      { immediate: true, status: "running", events: 9, tools: 2, active: 1 },
      { immediate: true, status: "running", events: 10, tools: 2, active: 0 },
      { immediate: true, status: "running", events: 11, tools: 2, active: 0 },
      { immediate: true, status: "running", events: 12, tools: 2, active: 0 },
      { immediate: true, status: "completed", events: 12, tools: 2, active: 0 },
    ]);
    const recorded = await events(runtime);
    assert.deepEqual(
      recorded.map(({ schemaVersion, sequence, type }) => ({
        schemaVersion,
        sequence,
        type,
      })),
      [
        { schemaVersion: 1, sequence: 1, type: "response" },
        { schemaVersion: 1, sequence: 2, type: "response" },
        { schemaVersion: 1, sequence: 3, type: "agent_start" },
        { schemaVersion: 1, sequence: 4, type: "message_update" },
        { schemaVersion: 1, sequence: 5, type: "message_update" },
        { schemaVersion: 1, sequence: 6, type: "message_end" },
        { schemaVersion: 1, sequence: 7, type: "tool_execution_start" },
        { schemaVersion: 1, sequence: 8, type: "tool_execution_start" },
        { schemaVersion: 1, sequence: 9, type: "tool_execution_end" },
        { schemaVersion: 1, sequence: 10, type: "tool_execution_end" },
        { schemaVersion: 1, sequence: 11, type: "message_end" },
        { schemaVersion: 1, sequence: 12, type: "agent_settled" },
      ]
    );
    assert.deepEqual(recorded[0]?.payload, {
      type: "response",
      id: "child-v2:get_state",
      command: "get_state",
      success: true,
      data: {
        model: { provider: "fake", id: "model-x", name: "model-x" },
        thinkingLevel: "high",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionId: "fake",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    assert.deepEqual(recorded[1]?.payload, {
      type: "response",
      id: "child-v2",
      command: "prompt",
      success: true,
      promptBeforeState: false,
    });
    for (const event of recorded)
      assert.match(event.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }));

test("the prompt command carries the exact child id, type, and unmodified message", async () =>
  fixture(async (root, runtime) => {
    await useInlineRpc(
      root,
      `${stateResponse}
 if (command.type === "prompt") {
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(command) }] } });
  send({ type: "agent_settled" });
 }
 `
    );
    const result = await runChild(
      makeChild(root, "exact prompt ]]> \\n line", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(result.status, "completed");
    assert.equal(
      result.response,
      JSON.stringify({
        id: "child-v2",
        type: "prompt",
        message: "exact prompt ]]> \\n line",
      })
    );
  }));

test("usage accumulates camel and snake case components exactly", async () =>
  fixture(async (root, runtime) => {
    const result = await runChild(
      makeChild(root, "usage", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.deepEqual(
      {
        status: result.status,
        response: result.response,
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        providerTraffic: result.providerTraffic,
        tokens: result.tokens,
        events: result.eventCount,
      },
      {
        status: "completed",
        response: "usage complete",
        input: 3_500_000,
        output: 169_000,
        cacheRead: 33_000,
        cacheWrite: 5_000,
        providerTraffic: 3_707_000,
        tokens: 3_707_000,
        events: 6,
      }
    );
    assert.deepEqual(result.activities, ["first", "usage complete"]);
  }));

test("get_state updates legacy children without inventing a runtime plan", async () =>
  fixture(async (root, runtime) => {
    const child = makeChild(root, "first");
    const result = await runChild(child, runtime, undefined, () => {});
    assert.equal(result.status, "completed");
    assert.equal(result.model, "model-x");
    assert.equal(result.thinking, "high");
    assert.equal(result.runtimePlan, undefined);
  }));

test("observed state reconciles the child-owned runtime plan before prompting", async () =>
  fixture(async (root, runtime) => {
    process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING = "low";
    const result = await runChild(
      makeChild(root, "first", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(result.status, "completed");
    assert.equal(result.thinking, "low");
    assert.deepEqual(result.runtimePlan?.observed, {
      provider: "fake",
      modelId: "model-x",
      model: "fake/model-x",
      thinking: "low",
    });
    assert.deepEqual(result.runtimePlan?.thinkingAdjustment, {
      from: "high",
      to: "low",
      reason: "observed",
    });
  }));

test("activity retention rebases active tools and appends unmatched tool endings", async () =>
  fixture(async (root, runtime) => {
    const result = await runChild(
      makeChild(root, "runner-branches", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(result.status, "completed");
    assert.equal(result.activities.length, 15);
    assert.deepEqual(result.activeTools, [
      { id: "active", name: "read", activityIndex: -10 },
    ]);
    assert.deepEqual(plain(result.activities), [
      ...Array.from({ length: 12 }, (_, index) => `line ${index + 8}`),
      "✗ 📖 read read",
      "  read → error",
      "branches complete",
    ]);
    assert.equal(result.toolCount, 1);
    assert.equal(result.eventCount, 8);
    assert.equal(result.response, "branches complete");
  }));

test("a child exit during get_state fails before the prompt", async () =>
  fixture(async (root, runtime) => {
    process.env.PI_TIDY_FAKE_RPC_STATE_MODE = "exit";
    const result = await runChild(
      makeChild(root, "first", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error, "state probe exited");
    assert.equal(result.response, "");
  }));

test("an unanswered get_state times out without sending the prompt", async (context) =>
  fixture(async (root, runtime) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    process.env.PI_TIDY_FAKE_RPC_STATE_MODE = "ignore";
    let running!: () => void;
    const reachedRunning = new Promise<void>((resolve) => {
      running = resolve;
    });
    const child = makeChild(root, "first", plan());
    const pending = runChild(child, runtime, undefined, () => {
      if (child.status === "running") running();
    });
    await reachedRunning;
    context.mock.timers.tick(15_000);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Timed out waiting for child RPC get_state");
    assert.equal(result.response, "");
    assert.equal(result.eventCount, 0);
  }));

test("get_state rejects RPC errors, every malformed identity, and either mismatch", async () => {
  const cases: Array<{ name: string; response: string; error: string }> = [
    {
      name: "explicit error",
      response: `{ type: "response", id: command.id, command: "get_state", success: false, error: "state unavailable" }`,
      error: "state unavailable",
    },
    {
      name: "default error",
      response: `{ type: "response", id: command.id, command: "get_state", success: false }`,
      error: "RPC get_state failed",
    },
    {
      name: "missing model",
      response: `{ type: "response", id: command.id, success: true, data: {} }`,
      error: "Child RPC state missing model provider/id",
    },
    {
      name: "empty provider",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: "", id: "model-x" } } }`,
      error: "Child RPC state missing model provider/id",
    },
    {
      name: "non-string provider",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: 7, id: "model-x" } } }`,
      error: "Child RPC state missing model provider/id",
    },
    {
      name: "empty model",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: "fake", id: "" } } }`,
      error: "Child RPC state missing model provider/id",
    },
    {
      name: "non-string model",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: "fake", id: 7 } } }`,
      error: "Child RPC state missing model provider/id",
    },
    {
      name: "provider mismatch",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: "other", id: "model-x" } } }`,
      error:
        "Child startup model mismatch: observed other/model-x, expected fake/model-x",
    },
    {
      name: "model mismatch",
      response: `{ type: "response", id: command.id, success: true, data: { model: { provider: "fake", id: "other" } } }`,
      error:
        "Child startup model mismatch: observed fake/other, expected fake/model-x",
    },
  ];
  for (const entry of cases)
    await fixture(async (root, runtime) => {
      await useInlineRpc(
        root,
        `if (command.type === "get_state") { send(${entry.response}); continue; } throw new Error("prompt sent after ${entry.name}");`
      );
      const child = makeChild(root, "must-not-prompt", plan());
      const callbacks: Array<[boolean | undefined, string, number]> = [];
      const result = await runChild(child, runtime, undefined, (immediate) =>
        callbacks.push([immediate, child.status, child.eventCount])
      );
      assert.equal(result.status, "failed", entry.name);
      assert.equal(result.error, entry.error, entry.name);
      assert.equal(result.response, "", entry.name);
      assert.equal(result.eventCount, 1, entry.name);
      assert.deepEqual(
        callbacks,
        [
          [true, "starting", 0],
          [true, "running", 0],
          [true, "failed", 1],
        ],
        entry.name
      );
    });
});

test("a non-string observed thinking leaves the complete runtime plan unchanged except identity", async () =>
  fixture(async (root, runtime) => {
    await useInlineRpc(
      root,
      `
 if (command.type === "get_state") {
  send({ type: "response", id: command.id, success: true, data: { model: { provider: "fake", id: "model-x" }, thinkingLevel: 7 } });
  continue;
 }
 if (command.type === "prompt") {
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  send({ type: "agent_settled" });
 }
 `
    );
    const childPlan = {
      ...plan(),
      requestedThinking: "high",
      thinkingAdjustment: {
        from: "xhigh",
        to: "high",
        reason: "inherited-clamp" as const,
      },
    };
    const result = await runChild(
      makeChild(root, "thinking", childPlan),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(result.status, "completed");
    assert.equal(result.thinking, "high");
    assert.deepEqual(result.runtimePlan, {
      ...childPlan,
      observed: { provider: "fake", modelId: "model-x", model: "fake/model-x" },
    });
  }));

test("event routing ignores near misses while preserving exact mixed assistant text and tool state", async () =>
  fixture(async (root, runtime) => {
    await useInlineRpc(
      root,
      `${stateResponse}
 if (command.type === "prompt") {
  send({ type: "response", id: "unrelated", command: "noop", success: false, error: "ignore me" });
  send({});
  send({ type: "message_update", assistantMessageEvent: { type: "not_text", delta: "wrong" } });
  send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "wrong" }] } });
  send({ type: "tool_execution_start", toolCallId: "zero", toolName: "read", args: { path: "zero.ts" } });
  send({ type: "tool_execution_end", toolCallId: "zero", toolName: "read", result: { content: [{ type: "text", text: "one\\ntwo" }] } });
  send({ type: "message_end", message: { role: "assistant", content: [
   { type: "text", text: "A" }, { type: "image", text: "wrong" }, { type: "text", text: null }, { type: "text", text: "B" }
  ], usage: { input: null, output: "2", cache_read: "3", cache_write: "4" } } });
  send({ type: "agent_settled" });
 }
 `
    );
    const result = await runChild(
      makeChild(root, "events", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.deepEqual(
      {
        status: result.status,
        response: result.response,
        toolCount: result.toolCount,
        activeTools: result.activeTools,
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        providerTraffic: result.providerTraffic,
        tokens: result.tokens,
        eventCount: result.eventCount,
      },
      {
        status: "completed",
        response: "AB",
        toolCount: 1,
        activeTools: [],
        input: 0,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        providerTraffic: 9,
        tokens: 9,
        eventCount: 9,
      }
    );
    assert.deepEqual(plain(result.activities), [
      "✓ 📖 read zero.ts",
      "  zero.ts → 2 lines",
      "AB",
    ]);
    const recorded = await events(runtime);
    assert.deepEqual(
      recorded.map((event) => event.type),
      [
        "response",
        "response",
        "unknown",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "message_end",
        "agent_settled",
      ]
    );
    assert.equal(recorded[2]?.payload.type, undefined);
  }));

test("prompt rejection uses explicit and fallback errors", async () => {
  for (const [errorSource, expected] of [
    [`, error: "prompt rejected"`, "prompt rejected"],
    ["", "Pi RPC rejected the prompt"],
  ] as const) {
    await fixture(async (root, runtime) => {
      await useInlineRpc(
        root,
        `${stateResponse} if (command.type === "prompt") { send({ type: "response", command: "prompt", success: false${errorSource} }); }`
      );
      const result = await runChild(
        makeChild(root, "reject", plan()),
        runtime,
        undefined,
        () => {}
      );
      assert.deepEqual(
        {
          status: result.status,
          error: result.error,
          response: result.response,
          events: result.eventCount,
        },
        { status: "failed", error: expected, response: "", events: 2 }
      );
    });
  }
});

test("empty output warns and an unsettled provider exit reports stderr", async () => {
  await fixture(async (root, runtime) => {
    const result = await runChild(
      makeChild(root, "empty", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.deepEqual(
      { status: result.status, error: result.error, response: result.response },
      {
        status: "warning",
        error: "Child completed without assistant output",
        response: "",
      }
    );
  });
  await fixture(async (root, runtime) => {
    const result = await runChild(
      makeChild(root, "crash", plan()),
      runtime,
      undefined,
      () => {}
    );
    assert.deepEqual(
      { status: result.status, error: result.error, response: result.response },
      { status: "failed", error: "provider failed", response: "" }
    );
  });
});

test("unsettled exits distinguish an exit code from termination by signal", async () => {
  for (const [action, expected] of [
    [`process.exit(7)`, "Pi RPC exited 7 before settling"],
    [
      `process.kill(process.pid, "SIGTERM")`,
      "Pi RPC exited by signal before settling",
    ],
  ] as const)
    await fixture(async (root, runtime) => {
      await useInlineRpc(
        root,
        `${stateResponse} if (command.type === "prompt") { ${action}; }`
      );
      const result = await runChild(
        makeChild(root, "exit", plan()),
        runtime,
        undefined,
        () => {}
      );
      assert.deepEqual(
        {
          status: result.status,
          error: result.error,
          response: result.response,
          events: result.eventCount,
        },
        { status: "failed", error: expected, response: "", events: 1 }
      );
    });
});

test("cancellation is terminal, sends abort, and never sends the prompt", async () =>
  fixture(async (root, runtime) => {
    const controller = new AbortController();
    const child = makeChild(root, "must-not-prompt", plan());
    const callbacks: Array<[boolean | undefined, string, number]> = [];
    const result = await runChild(
      child,
      runtime,
      controller.signal,
      (immediate) => {
        callbacks.push([immediate, child.status, child.eventCount]);
        if (child.status === "running" && child.eventCount === 1)
          controller.abort();
      }
    );
    assert.deepEqual(
      {
        status: result.status,
        error: result.error,
        response: result.response,
        events: result.eventCount,
      },
      { status: "cancelled", error: "Cancelled", response: "", events: 1 }
    );
    assert.deepEqual(callbacks, [
      [true, "starting", 0],
      [true, "running", 0],
      [true, "running", 1],
      [true, "cancelled", 1],
      [true, "cancelled", 1],
    ]);
  }));

test("spawn failures throw after exact starting and failed callbacks", async () =>
  fixture(async (root, runtime) => {
    process.env.PI_TIDY_SUBAGENT_EXECUTABLE = join(root, "missing-pi");
    const child = makeChild(root, "never", plan());
    const callbacks: Array<[boolean | undefined, string]> = [];
    await assert.rejects(
      runChild(child, runtime, undefined, (immediate) =>
        callbacks.push([immediate, child.status])
      ),
      /^Error: Could not start Pi RPC: spawn .* ENOENT$/
    );
    assert.equal(child.status, "failed");
    assert.match(
      child.error ?? "",
      /^Could not start Pi RPC: spawn .* ENOENT$/
    );
    assert.ok(
      child.startedAt && child.endedAt && child.endedAt >= child.startedAt
    );
    assert.deepEqual(callbacks, [
      [true, "starting"],
      [true, "failed"],
    ]);
  }));

test("invalid stdout rejects when the durable event stream cannot be maintained", async () =>
  fixture(async (root, runtime) => {
    await useInlineRpc(
      root,
      `${stateResponse} if (command.type === "prompt") { process.stdout.write("not-json\\n"); setTimeout(() => process.exit(9), 5); }`
    );
    const child = makeChild(root, "never", plan());
    await assert.rejects(
      runChild(child, runtime, undefined, () => {}),
      /^Error: Could not maintain durable child event stream: Unexpected token/
    );
    assert.equal(child.status, "running");
    assert.equal(child.eventCount, 1);
    assert.ok(child.endedAt);
  }));
