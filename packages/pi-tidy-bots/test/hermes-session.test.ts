import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  HermesSession,
  type HermesSessionOptions,
} from "../backends/hermes/session.ts";
import type { JsonObject } from "../src/gateway/protocol.ts";

test("fleet scope requires the exact live prompt and records admission before dispatch", async (t) => {
  let prompt: any;
  const f = fixture(t, (request) => {
    if (request.method === "session/prompt") prompt = request;
  });
  assert.throws(() =>
    f.session.fleetScope("s1", prompt?.params._meta.tidy.promptId ?? "missing")
  );
  await f.session.open("/disposable");
  assert.throws(() =>
    f.session.fleetScope("s1", prompt?.params._meta.tidy.promptId ?? "missing")
  );
  let admitted = false;
  const completion = f.session.submit(
    "op1",
    "turn1",
    [{ type: "text", text: "task" }],
    () => {
      admitted = true;
    }
  );
  assert.throws(() =>
    f.session.fleetScope("foreign", prompt.params._meta.tidy.promptId)
  );
  assert.equal(admitted, false);
  assert.deepEqual(
    f.session.fleetScope("s1", prompt?.params._meta.tidy.promptId ?? "missing"),
    {
      operationId: "op1",
      turnId: "turn1",
    }
  );
  assert.equal(admitted, true);
  assert.equal(
    f.events.filter((event) => event.type === "turn.started").length,
    1
  );
  f.session.fleetScope("s1", prompt?.params._meta.tidy.promptId ?? "missing");
  assert.equal(
    f.events.filter((event) => event.type === "turn.started").length,
    1
  );
  finish(prompt, f.send);
  await completion;
  assert.throws(() =>
    f.session.fleetScope("s1", prompt?.params._meta.tidy.promptId ?? "missing")
  );
  const stalePrompt = prompt.params._meta.tidy.promptId;
  const next = f.session.submit("op2", "turn2", [
    { type: "text", text: "next task" },
  ]);
  assert.throws(() => f.session.fleetScope("s1", stalePrompt));
  assert.deepEqual(
    f.session.fleetScope("s1", prompt.params._meta.tidy.promptId),
    { operationId: "op2", turnId: "turn2" }
  );
  finish(prompt, f.send);
  await next;
});

function fixture(
  t: TestContext,
  behavior: (request: any, send: (value: any) => void) => void,
  options: Partial<HermesSessionOptions> = {}
) {
  const input = new PassThrough(),
    output = new PassThrough();
  const events: any[] = [],
    calls: any[] = [],
    failures: string[] = [];
  const send = (value: any) =>
    output.write(Buffer.from(JSON.stringify(value) + "\n"));
  input.on("data", (frame) => {
    const request = JSON.parse(frame.toString());
    calls.push(request);
    if (request.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "hermes-agent", version: "0.20.5" },
          agentCapabilities: { loadSession: false },
          _meta: {
            tidy: {
              guardVersion: 4,
              approvalPolicy: "ask",
              environment: "explicit",
              ownedWorkers: "local-pipe-v1",
            },
          },
        },
      });
    else if (request.method === "session/new")
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "s1" } });
    else behavior(request, send);
  });
  const session = new HermesSession({
    input,
    output,
    requestTimeoutMs: 1000,
    emit: (event) => events.push(event),
    onFailure: (error) => failures.push(error.code),
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    ...options,
  });
  t.after(() => {
    session.close();
    input.destroy();
    output.destroy();
  });
  return { session, events, calls, failures, send };
}
function update(
  send: (value: any) => void,
  value: JsonObject,
  sessionId = "s1"
) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}
function text(send: (value: any) => void, value: string) {
  update(send, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
  });
}
function finish(
  request: any,
  send: (value: any) => void,
  evidence: JsonObject = {}
) {
  send({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      stopReason: "end_turn",
      _meta: {
        tidy: {
          guardVersion: 4,
          turnEvidence: {
            started: true,
            settled: true,
            failed: false,
            interrupted: false,
            observationsComplete: true,
            finalText: "Final answer",
            ...evidence,
          },
        },
      },
    },
  });
}
const input = [{ type: "text", text: "Inspect the fixture" }];

test("Hermes prompt settlement outlives short admission and emits acceptance once", async (t) => {
  let prompt: any;
  const f = fixture(
    t,
    (request, send) => {
      prompt = request;
      text(send, "Working");
      text(send, " on it");
    },
    { requestTimeoutMs: 10, promptTimeoutMs: 500 }
  );
  await f.session.open("/disposable");
  let accepted = 0;
  const submitted = f.session.submit("op1", "turn1", input, () => {
    accepted++;
  });
  assert.equal(accepted, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(f.failures, []);
  assert.equal(
    f.events.some((event) => event.type === "turn.terminal"),
    false
  );
  finish(prompt, f.send);
  assert.deepEqual(await submitted, { disposition: "accepted" });
  assert.equal(accepted, 1);
});

for (const stopReason of ["end_turn", "cancelled"]) {
  test(`Hermes cancellation requests once and preserves native ${stopReason} evidence`, async (t) => {
    let prompt: any;
    const f = fixture(t, (request) => {
      if (request.method === "session/prompt") prompt = request;
    });
    await f.session.open("/disposable");
    assert.deepEqual(f.session.cancel("op1"), { status: "unknown" });
    const submitted = f.session.submit("op1", "turn1", input);
    assert.deepEqual(f.session.cancel("foreign"), { status: "unknown" });
    assert.deepEqual(f.session.cancel("op1"), { status: "requested" });
    assert.deepEqual(f.session.cancel("op1"), { status: "requested" });
    const cancels = f.calls.filter((call) => call.method === "session/cancel");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].id, undefined);
    assert.deepEqual(cancels[0].params, { sessionId: "s1" });
    assert.equal(
      f.events.some((event) => event.type === "turn.terminal"),
      false
    );
    finish(prompt, (response) => {
      response.result.stopReason = stopReason;
      f.send(response);
    });
    await submitted;
    assert.equal(
      f.events.find((event) => event.type === "turn.terminal").payload
        .execution,
      stopReason === "cancelled" ? "cancelled" : "ended"
    );
    assert.deepEqual(f.session.cancel("op1"), { status: "unknown" });
    assert.equal(
      f.calls.filter((call) => call.method === "session/cancel").length,
      1
    );
  });
}

test("Hermes cancellation cannot cross a settled turn into a new operation", async (t) => {
  let prompt: any;
  const f = fixture(t, (request) => {
    if (request.method === "session/prompt") prompt = request;
  });
  await f.session.open("/disposable");
  const first = f.session.submit("op1", "turn1", input);
  f.session.cancel("op1");
  finish(prompt, f.send);
  await first;
  const second = f.session.submit("op2", "turn2", input);
  assert.deepEqual(f.session.cancel("op1"), { status: "unknown" });
  assert.equal(
    f.calls.filter((call) => call.method === "session/cancel").length,
    1
  );
  assert.deepEqual(f.session.cancel("op2"), { status: "requested" });
  finish(prompt, f.send);
  await second;
  assert.equal(
    f.calls.filter((call) => call.method === "session/cancel").length,
    2
  );
});

test("Hermes lost cancellation remains unknown without fabricating a terminal event", async (t) => {
  const f = fixture(t, () => {});
  await f.session.open("/disposable");
  const submitted = f.session.submit("op1", "turn1", input);
  assert.deepEqual(f.session.cancel("op1"), { status: "requested" });
  f.session.transport.close();
  assert.deepEqual(f.session.cancel("op1"), { status: "unknown" });
  await submitted;
  assert.equal(
    f.events.some((event) => event.type === "turn.terminal"),
    false
  );
  assert.equal(
    f.calls.filter((call) => call.method === "session/cancel").length,
    1
  );
});

test("Hermes session replaces transformed final chunks and omits raw reasoning", async (t) => {
  const f = fixture(t, (request, send) => {
    update(send, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private reasoning" },
    });
    text(send, "Original draft");
    text(send, "Final answer");
    finish(request, send);
  });
  assert.equal(await f.session.open("/disposable"), "s1");
  assert.deepEqual(await f.session.submit("op1", "turn1", input), {
    disposition: "accepted",
  });
  const finals = f.events.filter((event) => event.type === "message.finished");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].payload.blocks[0].text, "Final answer");
  assert.equal(
    f.events.filter((event) => event.type === "turn.started").length,
    1
  );
  assert.ok(!JSON.stringify(f.events).includes("private reasoning"));
  assert.equal(f.events.at(-1).payload.execution, "ended");
  await assert.rejects(f.session.open("/disposable"), {
    code: "session_unavailable",
  });
});

test("Hermes session preserves ordered messages around tools without exposing native arguments", async (t) => {
  const f = fixture(t, (request, send) => {
    text(send, "I will inspect the file.");
    update(send, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "read",
      status: "in_progress",
      title: "private path",
      rawInput: { secret: "private token" },
    });
    update(send, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "private result",
    });
    text(send, "Draft conclusion");
    finish(request, send);
  });
  await f.session.open("/disposable");
  await f.session.submit("op1", "turn1", input);
  const finals = f.events.filter((event) => event.type === "message.finished");
  assert.deepEqual(
    finals.map((event) => [event.messageId, event.payload.blocks[0].text]),
    [
      ["op1:message:0", "I will inspect the file."],
      ["op1:message:1", "Final answer"],
    ]
  );
  assert.equal(
    f.events.find((event) => event.type === "tool.started").payload.label,
    "Read"
  );
  assert.equal(f.events.at(-1).payload.observation, "complete");
  assert.ok(!JSON.stringify(f.events).includes("private"));
});

test("Hermes executor failure cannot become successful execution from ACP end_turn", async (t) => {
  const f = fixture(t, (request, send) => {
    text(send, "Native error details");
    finish(request, send, { failed: true, finalText: undefined });
  });
  await f.session.open("/disposable");
  assert.equal(
    (await f.session.submit("op1", "turn1", input)).disposition,
    "accepted"
  );
  assert.equal(f.events.at(-1).payload.execution, "failed");
  assert.equal(
    f.events.find((event) => event.type === "message.finished").payload
      .blocks[0].text,
    "The native turn failed."
  );
});

test("Hermes missing run evidence stays unknown and prevents another native prompt", async (t) => {
  const f = fixture(t, (request, send) => {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
  });
  await f.session.open("/disposable");
  assert.equal(
    (await f.session.submit("op1", "turn1", input)).disposition,
    "unknown"
  );
  assert.equal(
    (await f.session.submit("op2", "turn2", input)).disposition,
    "unknown"
  );
  assert.equal(
    f.calls.filter((call) => call.method === "session/prompt").length,
    1
  );
  assert.equal(
    f.events.some((event) => event.type === "turn.terminal"),
    false
  );
  assert.equal(f.events.at(-1).type, "observation.gap");
});

test("Hermes explicit preflight refusal rejects without fabricating a turn", async (t) => {
  const f = fixture(t, (request, send) => {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        stopReason: "refusal",
        _meta: {
          tidy: {
            rejectedBeforePrompt: true,
            code: "approval_policy_unavailable",
          },
        },
      },
    });
  });
  await f.session.open("/disposable");
  assert.equal(
    (await f.session.submit("op1", "turn1", input)).disposition,
    "rejected"
  );
  assert.deepEqual(f.events, []);
});

test("Hermes tools left running require reconciliation despite settled native prompt", async (t) => {
  const f = fixture(t, (request, send) => {
    update(send, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "execute",
      status: "in_progress",
    });
    finish(request, send);
  });
  await f.session.open("/disposable");
  await f.session.submit("op1", "turn1", input);
  assert.equal(f.events.at(-1).payload.observation, "reconciliation_required");
  assert.equal(
    (await f.session.submit("op2", "turn2", input)).disposition,
    "unknown"
  );
});

test("Hermes swallowed notification failures cannot claim complete observation", async (t) => {
  const f = fixture(t, (request, send) =>
    finish(request, send, { observationsComplete: false })
  );
  await f.session.open("/disposable");
  await f.session.submit("op1", "turn1", input);
  assert.equal(f.events.at(-1).payload.observation, "reconciliation_required");
  assert.equal(
    (await f.session.submit("op2", "turn2", input)).disposition,
    "unknown"
  );
});

test("Hermes permission callback carries the active operation and can finish the pending native prompt", async (t) => {
  let prompt: any;
  const receipts: unknown[] = [];
  const f = fixture(
    t,
    (request, send) => {
      if (request.method === "session/prompt") {
        prompt = request;
        send({
          jsonrpc: "2.0",
          id: 17,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            _meta: { tidy: { permissionId: "permission-1" } },
          },
        });
      } else {
        assert.equal(request.id, 17);
        assert.deepEqual(request.result, {
          outcome: { outcome: "selected", optionId: "allow_once" },
        });
        assert.deepEqual(receipts, []);
        send({
          jsonrpc: "2.0",
          method: "_tidy/permission_consumed",
          params: {
            sessionId: "s1",
            permissionId: "permission-1",
            optionId: "allow_once",
            evidence: "native_callback_returned",
          },
        });
        finish(prompt, send);
      }
    },
    {
      onPermissionConsumed: (receipt) => {
        receipts.push(receipt);
      },
      onPermission: async (_params, id, turn, signal) => {
        assert.equal(id, 17);
        assert.deepEqual(turn, { operationId: "op1", turnId: "turn1" });
        assert.equal(signal.aborted, false);
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
    }
  );
  await f.session.open("/disposable");
  assert.equal(
    (await f.session.submit("op1", "turn1", input)).disposition,
    "accepted"
  );
  assert.equal(f.events.at(-1).payload.execution, "ended");
  assert.deepEqual(receipts, [
    {
      permissionId: "permission-1",
      optionId: "allow_once",
      operationId: "op1",
      turnId: "turn1",
    },
  ]);
});

test("Hermes ownership bridge forwards only scoped lifecycle fields and permits later reconciliation", async (t) => {
  const launchId = `tidy-launch-${randomUUID()}`;
  const ownership: unknown[] = [];
  let prompt: any;
  const f = fixture(
    t,
    (request, send) => {
      if (request.method === "session/prompt") {
        prompt = request;
        send({
          jsonrpc: "2.0",
          id: 80,
          method: "_tidy/ownership.prepare",
          params: { sessionId: "s1", launchId },
        });
      } else if (request.id === 80) {
        send({
          jsonrpc: "2.0",
          id: 81,
          method: "_tidy/ownership.record",
          params: { sessionId: "s1", launchId, pid: 123 },
        });
      } else if (request.id === 81) finish(prompt, send);
    },
    {
      onOwnedProcess: async (method, params) => {
        ownership.push({ method, params });
        return {
          launchId,
          state: method === "prepare" ? "prepared" : "started",
        };
      },
    }
  );
  await f.session.open("/disposable");
  await f.session.submit("op", "turn", input);
  f.send({
    jsonrpc: "2.0",
    id: 82,
    method: "_tidy/ownership.stopped",
    params: { sessionId: "s1", launchId },
  });
  await setImmediate();
  assert.deepEqual(ownership, [
    { method: "prepare", params: { launchId } },
    { method: "record", params: { launchId, pid: 123 } },
    { method: "stopped", params: { launchId } },
  ]);
  assert.deepEqual(f.failures, []);
});

test("Hermes cannot reassign a retained worker launch to a later operation", async (t) => {
  const launchId = `tidy-launch-${randomUUID()}`;
  let prompt: any,
    sequence = 80,
    admissions = 0;
  const f = fixture(
    t,
    (request, send) => {
      if (request.method === "session/prompt") {
        prompt = request;
        send({
          jsonrpc: "2.0",
          id: sequence++,
          method: "_tidy/ownership.prepare",
          params: { sessionId: "s1", launchId },
        });
      } else finish(prompt, send);
    },
    {
      onOwnedProcess: async () => {
        admissions++;
        return { launchId, state: "prepared" };
      },
    }
  );
  await f.session.open("/disposable");
  await f.session.submit("op1", "turn1", input);
  assert.deepEqual(await f.session.submit("op2", "turn2", input), {
    disposition: "unknown",
  });
  assert.equal(admissions, 1);
  assert.ok(f.failures.length > 0);
});

for (const mode of [
  "idle",
  "foreign-session",
  "unknown-launch",
  "injected-binding",
  "ungranted",
  "invalid-method",
]) {
  test(`Hermes ownership ${mode} never reaches the host service`, async (t) => {
    const launchId = `tidy-launch-${randomUUID()}`;
    const ownership: unknown[] = [];
    const sendRequest = (send: (message: any) => void) =>
      send({
        jsonrpc: "2.0",
        id: 80,
        method:
          mode === "unknown-launch"
            ? "_tidy/ownership.record"
            : mode === "invalid-method"
              ? "_tidy/ownership.kill"
              : "_tidy/ownership.prepare",
        params: {
          sessionId: mode === "foreign-session" ? "stale" : "s1",
          launchId,
          ...(mode === "unknown-launch" ? { pid: 123 } : {}),
          ...(mode === "injected-binding"
            ? { bindingId: "other-binding" }
            : {}),
        },
      });
    const f = fixture(t, (_request, send) => sendRequest(send), {
      ...(mode === "ungranted"
        ? {}
        : {
            onOwnedProcess: async (_method: string, params: unknown) => {
              ownership.push(params);
              return {};
            },
          }),
    });
    await f.session.open("/disposable");
    if (mode === "idle") {
      sendRequest(f.send);
      await setImmediate();
    } else await f.session.submit("op", "turn", input);
    assert.deepEqual(ownership, []);
    assert.ok(f.failures.length > 0);
  });
}

for (const mode of [
  "missing",
  "wrong-option",
  "wrong-session",
  "duplicate",
  "persist-failed",
  "async-persist",
  "reused-identity",
]) {
  test(`Hermes permission receipt ${mode} prevents complete observation`, async (t) => {
    let prompt: any;
    const receipts: unknown[] = [];
    const f = fixture(
      t,
      (request, send) => {
        if (request.method === "session/prompt") {
          prompt = request;
          send({
            jsonrpc: "2.0",
            id: 17,
            method: "session/request_permission",
            params: {
              sessionId: "s1",
              _meta: { tidy: { permissionId: "permission-1" } },
            },
          });
        } else {
          const receipt = {
            jsonrpc: "2.0",
            method: "_tidy/permission_consumed",
            params: {
              sessionId: mode === "wrong-session" ? "stale" : "s1",
              permissionId: "permission-1",
              optionId: mode === "wrong-option" ? "deny" : "allow_once",
              evidence: "native_callback_returned",
            },
          };
          if (mode !== "missing") send(receipt);
          if (mode === "duplicate") send(receipt);
          if (mode === "reused-identity")
            send({
              jsonrpc: "2.0",
              id: 18,
              method: "session/request_permission",
              params: {
                sessionId: "s1",
                _meta: { tidy: { permissionId: "permission-1" } },
              },
            });
          finish(prompt, send);
        }
      },
      {
        onPermission: async () => ({
          outcome: { outcome: "selected", optionId: "allow_once" },
        }),
        onPermissionConsumed: (receipt) => {
          if (mode === "async-persist")
            return Promise.reject(
              new Error("Unsupported asynchronous receipt append")
            );
          if (mode === "persist-failed")
            throw new Error("Durable receipt append failed");
          receipts.push(receipt);
        },
      }
    );
    await f.session.open("/disposable");
    await f.session.submit("op1", "turn1", input);
    assert.ok(f.failures.length > 0);
    assert.equal(
      (await f.session.submit("op2", "turn2", input)).disposition,
      "unknown"
    );
    if (!["duplicate", "reused-identity"].includes(mode))
      assert.deepEqual(receipts, []);
    else assert.equal(receipts.length, 1);
  });
}
