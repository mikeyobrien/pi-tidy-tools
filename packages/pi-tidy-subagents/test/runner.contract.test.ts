import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildChildArgs, runChild, type Runtime } from "../runner.js";
import type { ChildState, NormalizedEvent } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeRpc = join(here, "fake-rpc.mjs");
const ansi = /\x1b\[[0-9;]*m/g;

function child(prompt: string, root: string): ChildState {
  return {
    index: 0,
    id: "child-001",
    label: "contract",
    reason: "exercise runner contract",
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
    artifactPath: join(root, "child-001.md"),
  };
}

async function fixture<T>(
  fn: (root: string, runtime: Runtime) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-runner-contract-"));
  const runDir = join(root, "run");
  await mkdir(runDir);
  const previous = {
    executable: process.env.PI_TIDY_SUBAGENT_EXECUTABLE,
    args: process.env.PI_TIDY_SUBAGENT_ARGS,
    marker: process.env.RUNNER_CONTRACT_MARKER,
  };
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([fakeRpc]);
  try {
    return await fn(root, {
      cwd: root,
      model: "provider/model-x",
      thinking: "high",
      tools: ["read", "grep"],
      runDir,
      approved: true,
    });
  } finally {
    for (const [key, value] of [
      ["PI_TIDY_SUBAGENT_EXECUTABLE", previous.executable],
      ["PI_TIDY_SUBAGENT_ARGS", previous.args],
      ["RUNNER_CONTRACT_MARKER", previous.marker],
    ] as const)
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(root, { recursive: true, force: true });
  }
}

async function events(
  runtime: Runtime,
  id = "child-001"
): Promise<NormalizedEvent[]> {
  const text = await readFile(join(runtime.runDir, `${id}.jsonl`), "utf8");
  return text.trim()
    ? text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

function stableEvents(actual: NormalizedEvent[]) {
  return actual.map(({ timestamp, ...event }) => {
    assert.equal(new Date(timestamp).toISOString(), timestamp);
    return event;
  });
}

function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(ansi, ""));
}

async function useInlineRpc(runtime: Runtime, source: string): Promise<void> {
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([
    "--input-type=module",
    "--eval",
    source,
  ]);
}

const settleWith = (content: unknown, usage?: unknown) => `
 let input = "";
 process.stdin.on("data", chunk => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
  send({ type: "message_end", message: { role: "assistant", content: ${JSON.stringify(content)}, usage: ${JSON.stringify(usage)} } });
  send({ type: "agent_settled" });
 });
 setInterval(() => {}, 1000);
`;

test("buildChildArgs emits only approved RPC, model, thinking, and filtered tool flags", () => {
  assert.deepEqual(
    buildChildArgs({
      model: "openai/gpt",
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
      "openai/gpt",
      "--thinking",
      "high",
      "--tools",
      "read,grep",
    ]
  );
  assert.deepEqual(
    buildChildArgs({
      model: "openai/gpt",
      thinking: "off",
      tools: [],
      approved: false,
    }),
    [
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      "openai/gpt",
      "--thinking",
      "off",
      "--no-tools",
    ]
  );
});

test("runChild honors executable, environment args, cwd, inherited env, and child marker", async () =>
  fixture(async (root, runtime) => {
    const script = join(root, "inspect-rpc.mjs");
    await writeFile(
      script,
      `
  let input = "";
  process.stdin.on("data", chunk => {
   input += chunk;
   if (!input.includes("\\n")) return;
   const command = JSON.parse(input.split("\\n")[0]);
   const text = JSON.stringify({ cwd: process.cwd(), child: process.env.PI_TIDY_SUBAGENT_CHILD, inherited: process.env.RUNNER_CONTRACT_MARKER, arg: process.argv[2], command });
   const send = event => process.stdout.write(JSON.stringify(event) + "\\n");
   send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
   send({ type: "agent_settled" });
  });
  setInterval(() => {}, 1000);
 `
    );
    process.env.RUNNER_CONTRACT_MARKER = "inherited-value";
    process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([
      script,
      "sentinel-arg",
    ]);
    const state = child("inspect invocation", root);
    const result = await runChild(state, runtime, undefined, () => {});
    assert.deepEqual(JSON.parse(result.response), {
      cwd: root,
      child: "1",
      inherited: "inherited-value",
      arg: "sentinel-arg",
      command: {
        id: "child-001",
        type: "prompt",
        message: "inspect invocation",
      },
    });
    assert.equal(result.status, "completed");
  }));

test("runChild exactly normalizes text, matched tools, usage, changes, and event artifacts", async () =>
  fixture(async (root, runtime) => {
    const state = child("contract payload", root);
    const changes: boolean[] = [];
    const result = await runChild(
      state,
      runtime,
      undefined,
      (immediate = false) => changes.push(immediate)
    );
    assert.strictEqual(result, state);
    assert.equal(result.status, "completed");
    assert.equal(result.response, "# Result\n\ncontract payload ]]> kept");
    assert.deepEqual(
      {
        toolCount: result.toolCount,
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        providerTraffic: result.providerTraffic,
        tokens: result.tokens,
      },
      {
        toolCount: 2,
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        providerTraffic: 14,
        tokens: 14,
      }
    );
    assert.deepEqual(plain(result.activities), [
      "working fragments",
      "next line",
      "✓ 📖 read inspect the source",
      "  a.ts → 1 lines",
      "✓ ◆ mystery b",
      "  b → done",
      "# Result",
      "contract payload ]]> kept",
    ]);
    assert.deepEqual(result.activeTools, []);
    assert.equal(result.streamingLine, undefined);
    assert.equal(result.eventCount, 11);
    assert.equal(typeof result.startedAt, "number");
    assert.equal(typeof result.endedAt, "number");
    assert.ok(result.endedAt! >= result.startedAt!);
    assert.deepEqual(changes, [
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    assert.equal(changes.at(-1), true);
    assert.equal(result.artifactPath, join(root, "child-001.md"));

    const recorded = await events(runtime);
    assert.deepEqual(
      stableEvents(recorded),
      recorded.map((event, index) => ({
        schemaVersion: 1,
        sequence: index + 1,
        type: event.type,
        payload: event.payload,
      }))
    );
    assert.deepEqual(
      recorded.map((event) => event.type),
      [
        "response",
        "agent_start",
        "message_update",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_start",
        "tool_execution_end",
        "tool_execution_end",
        "message_end",
        "agent_settled",
      ]
    );
    assert.deepEqual(recorded[0]!.payload, {
      type: "response",
      id: "child-001",
      command: "prompt",
      success: true,
    });
    assert.deepEqual(recorded[9]!.payload, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "# Result\n\ncontract payload ]]> kept" },
        ],
        usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
      },
    });
  }));

test("runChild preserves unknown, sparse, CRLF, unmatched error, and bounded active-tool events", async () =>
  fixture(async (root, runtime) => {
    const result = await runChild(
      child("edge-events", root),
      runtime,
      undefined,
      () => {}
    );
    const recorded = await events(runtime);
    assert.equal(result.status, "completed");
    assert.equal(
      result.response,
      `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\nedge complete`
    );
    assert.equal(result.toolCount, 2);
    assert.deepEqual(result.activeTools, [
      { id: "undefined", name: "tool", activityIndex: -14 },
    ]);
    assert.equal(result.streamingLine, undefined);
    assert.equal(result.activities.length, 15);
    assert.deepEqual(plain(result.activities.slice(-4)), [
      "line 19",
      "edge complete",
      "✓ 📖 read edge.ts",
      "  edge.ts → 1 lines",
    ]);
    assert.deepEqual(
      recorded.map((event) => event.type),
      [
        "response",
        "agent_start",
        "unknown",
        "message_update",
        "tool_execution_start",
        "tool_execution_end",
        "message_end",
        "tool_execution_start",
        "message_end",
        "tool_execution_end",
        "agent_settled",
      ]
    );
    assert.deepEqual(recorded[2]!.payload, { payload: "sparse" });
    assert.deepEqual(recorded[3]!.payload, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
    });
    assert.deepEqual(recorded[4]!.payload, { type: "tool_execution_start" });
    assert.deepEqual(recorded[5]!.payload, {
      type: "tool_execution_end",
      toolCallId: "unmatched",
      isError: true,
    });
    assert.equal(recorded[2]!.type, "unknown");
    assert.equal(result.input, 1);
    assert.equal(result.output, 2);
    assert.equal(result.cacheRead, 0);
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.providerTraffic, 3);
  }));

test("runChild normalizes numeric strings, aliases, missing usage, and cumulative traffic", async () =>
  fixture(async (root, runtime) => {
    const result = await runChild(
      child("usage", root),
      runtime,
      undefined,
      () => {}
    );
    assert.deepEqual(
      {
        response: result.response,
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        providerTraffic: result.providerTraffic,
        tokens: result.tokens,
      },
      {
        response: "usage complete",
        input: 3_500_000,
        output: 169_000,
        cacheRead: 33_000,
        cacheWrite: 5_000,
        providerTraffic: 3_707_000,
        tokens: 3_707_000,
      }
    );
    assert.deepEqual(result.activities, ["first", "usage complete"]);
  }));

test("runChild rejects prompt responses and records the rejection before exit", async () =>
  fixture(async (root, runtime) => {
    const changes: boolean[] = [];
    const result = await runChild(
      child("reject", root),
      runtime,
      undefined,
      (immediate = false) => changes.push(immediate)
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error, "prompt rejected");
    assert.equal(result.response, "");
    assert.deepEqual(stableEvents(await events(runtime)), [
      {
        schemaVersion: 1,
        sequence: 1,
        type: "response",
        payload: {
          type: "response",
          id: "child-001",
          command: "prompt",
          success: false,
          error: "prompt rejected",
        },
      },
    ]);
    assert.equal(changes.at(-1), true);
  }));

test("runChild reports stderr exits, code and signal exits, and unavailable executables", async () =>
  fixture(async (root, runtime) => {
    const crashed = await runChild(
      child("crash", root),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(crashed.status, "failed");
    assert.equal(crashed.error, "provider failed");

    const codeState = child("code", root);
    codeState.id = "child-code";
    await useInlineRpc(
      runtime,
      "process.stdin.once('data', () => process.exit(9));"
    );
    const coded = await runChild(codeState, runtime, undefined, () => {});
    assert.equal(coded.status, "failed");
    assert.equal(coded.error, "Pi RPC exited 9 before settling");

    const signalState = child("signal", root);
    signalState.id = "child-signal";
    await useInlineRpc(
      runtime,
      "process.stdin.once('data', () => process.kill(process.pid, 'SIGKILL'));"
    );
    const signalled = await runChild(signalState, runtime, undefined, () => {});
    assert.equal(signalled.status, "failed");
    assert.equal(signalled.error, "Pi RPC exited by signal before settling");

    process.env.PI_TIDY_SUBAGENT_EXECUTABLE = join(root, "missing-rpc");
    delete process.env.PI_TIDY_SUBAGENT_ARGS;
    const missing = child("missing", root);
    const changes: boolean[] = [];
    await assert.rejects(
      runChild(missing, runtime, undefined, (immediate = false) =>
        changes.push(immediate)
      ),
      /Could not start Pi RPC: spawn .* ENOENT/
    );
    assert.equal(missing.status, "failed");
    assert.match(missing.error!, /^Could not start Pi RPC: spawn .* ENOENT$/);
    assert.equal(typeof missing.endedAt, "number");
    assert.deepEqual(changes, [true, true]);
  }));

test("runChild warns for empty and whitespace-only assistant output", async () =>
  fixture(async (root, runtime) => {
    const empty = await runChild(
      child("empty", root),
      runtime,
      undefined,
      () => {}
    );
    assert.equal(empty.status, "warning");
    assert.equal(empty.response, "");
    assert.equal(empty.error, "Child completed without assistant output");

    const whitespaceState = child("whitespace", root);
    whitespaceState.id = "child-whitespace";
    await useInlineRpc(
      runtime,
      settleWith([
        { type: "text", text: " \n\t " },
        { type: "image", data: "ignored" },
      ])
    );
    const whitespace = await runChild(
      whitespaceState,
      runtime,
      undefined,
      () => {}
    );
    assert.equal(whitespace.status, "warning");
    assert.equal(whitespace.response, " \n\t ");
    assert.equal(whitespace.error, "Child completed without assistant output");
    assert.deepEqual(whitespace.activities, []);
  }));

test("runChild turns malformed output into a durable-stream error after prior events", async () =>
  fixture(async (root, runtime) => {
    const state = child("malformed", root);
    await assert.rejects(
      runChild(state, runtime, undefined, () => {}),
      /Could not maintain durable child event stream: .*JSON/
    );
    assert.deepEqual(
      (await events(runtime)).map(({ type, payload }) => ({ type, payload })),
      [
        {
          type: "response",
          payload: {
            type: "response",
            id: "child-001",
            command: "prompt",
            success: true,
          },
        },
        { type: "agent_start", payload: { type: "agent_start" } },
      ]
    );
    assert.equal(typeof state.endedAt, "number");
  }));

test("runChild cancels signals already aborted before spawn completes", async () =>
  fixture(async (root, runtime) => {
    const controller = new AbortController();
    controller.abort();
    const state = child("hang", root);
    const changes: Array<{ status: string; immediate: boolean }> = [];
    const result = await runChild(
      state,
      runtime,
      controller.signal,
      (immediate = false) => changes.push({ status: state.status, immediate })
    );
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Cancelled");
    assert.deepEqual(changes, [
      { status: "starting", immediate: true },
      { status: "cancelled", immediate: true },
      { status: "cancelled", immediate: true },
    ]);
    assert.deepEqual(
      (await events(runtime)).map((event) => event.type),
      ["response", "agent_start"]
    );
  }));

test("runChild cancels during startup and while running, writing abort and final changed(true)", async () =>
  fixture(async (root, runtime) => {
    for (const phase of ["starting", "running"] as const) {
      const state = child("hang", root);
      state.id = `child-${phase}`;
      const controller = new AbortController();
      const changes: Array<{ status: string; immediate: boolean }> = [];
      const result = await runChild(
        state,
        runtime,
        controller.signal,
        (immediate = false) => {
          changes.push({ status: state.status, immediate });
          if (state.status === phase && !controller.signal.aborted)
            controller.abort();
        }
      );
      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "Cancelled");
      assert.equal(changes.at(-1)?.immediate, true);
      assert.equal(changes.at(-1)?.status, "cancelled");
      assert.ok(
        changes.some(
          (change) => change.status === "cancelled" && change.immediate
        )
      );
    }
  }));
