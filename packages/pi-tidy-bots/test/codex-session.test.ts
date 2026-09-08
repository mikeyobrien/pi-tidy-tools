import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { CodexSession } from "../backends/codex/session.ts";
import { object } from "../src/gateway/protocol.ts";
import type { JsonObject } from "../src/gateway/protocol.ts";

async function until(probe: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, "codex session fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("stale turn completion does not settle the current operation", async (t) => {
  const f = fixture(t);
  await f.session.open("/tmp");
  const completion = f.session.submit("op-current", "turn-current", [
    { type: "text", text: "live" },
  ]);
  await until(() => f.events.some((event) => event.type === "turn.started"));
  const liveTurnId = f.nativeTurnId;
  f.notify("item/completed", {
    threadId: f.threadId,
    turnId: "turn-stale",
    item: { id: "item-stale", type: "agentMessage", text: "stale-invented" },
  });
  f.notify("turn/completed", {
    threadId: f.threadId,
    turn: { id: "turn-stale", items: [], status: "completed" },
  });
  await Promise.resolve();
  assert.equal(
    f.events.some((event) => event.type === "turn.terminal"),
    false
  );
  assert.equal(
    f.events.some((event) => String(event.payload?.text ?? "").includes("stale")),
    false
  );
  f.notify("item/completed", {
    threadId: f.threadId,
    turnId: liveTurnId,
    item: { id: "item-live", type: "agentMessage", text: "live-final" },
  });
  f.notify("turn/completed", {
    threadId: f.threadId,
    turn: { id: liveTurnId, items: [], status: "completed" },
  });
  assert.deepEqual(await completion, { disposition: "accepted" });
  const terminal = f.events.find((event) => event.type === "turn.terminal");
  assert.equal(terminal?.operationId, "op-current");
  assert.equal(terminal?.turnId, "turn-current");
  assert.deepEqual(terminal?.payload, {
    execution: "ended",
    observation: "complete",
    evidence: "codex_app_server_turn",
  });
  assert.equal(
    f.events.find((event) => event.type === "text.snapshot")?.payload.text,
    "live-final"
  );
  assert.deepEqual(f.failures, []);
});

for (const status of [undefined, "invented", "inProgress"]) {
  test(`missing or unknown Codex terminal status ${String(status)} is uncertainty`, async (t) => {
    const f = fixture(t);
    await f.session.open("/tmp");
    const completion = f.session.submit("op1", "turn1", [
      { type: "text", text: "unknown-status" },
    ]);
    await until(() => f.events.some((event) => event.type === "turn.started"));
    f.notify("turn/completed", {
      threadId: f.threadId,
      turn:
        status === undefined
          ? { id: f.nativeTurnId, items: [] }
          : { id: f.nativeTurnId, items: [], status },
    });
    assert.deepEqual(await completion, { disposition: "accepted" });
    assert.equal(
      f.events.some((event) => event.type === "turn.terminal"),
      false
    );
    assert.deepEqual(f.failures, ["native_observation_gap"]);
    assert.deepEqual(await f.session.submit("op2", "turn2", [
      { type: "text", text: "next" },
    ]), { disposition: "unknown" });
  });
}

test("cancel losing the race to native completed keeps the receipt completed", async (t) => {
  const f = fixture(t);
  await f.session.open("/tmp");
  const completion = f.session.submit("op1", "turn1", [
    { type: "text", text: "cancel-then-completed" },
  ]);
  await until(() => f.events.some((event) => event.type === "turn.started"));
  assert.deepEqual(f.session.cancel("op1"), { status: "requested" });
  await f.interrupted;
  f.notify("turn/completed", {
    threadId: f.threadId,
    turn: { id: f.nativeTurnId, items: [], status: "completed" },
  });
  assert.deepEqual(await completion, { disposition: "accepted" });
  assert.equal(
    f.events.find((event) => event.type === "turn.terminal")?.payload.execution,
    "ended"
  );
  assert.deepEqual(f.failures, []);
});

test("native interrupted after cancel still reports cancelled", async (t) => {
  const f = fixture(t);
  await f.session.open("/tmp");
  const completion = f.session.submit("op1", "turn1", [
    { type: "text", text: "cancel-hold" },
  ]);
  await until(() => f.events.some((event) => event.type === "turn.started"));
  assert.deepEqual(f.session.cancel("op1"), { status: "requested" });
  await f.interrupted;
  f.notify("turn/completed", {
    threadId: f.threadId,
    turn: { id: f.nativeTurnId, items: [], status: "interrupted" },
  });
  assert.deepEqual(await completion, { disposition: "accepted" });
  assert.equal(
    f.events.find((event) => event.type === "turn.terminal")?.payload.execution,
    "cancelled"
  );
});

function fixture(t: TestContext) {
  const input = new PassThrough(),
    output = new PassThrough();
  const events: any[] = [],
    failures: string[] = [];
  let threadId = "";
  let nativeTurnId = "";
  let resolveInterrupted!: (value: JsonObject) => void;
  const interrupted = new Promise<JsonObject>((resolve) => {
    resolveInterrupted = resolve;
  });
  const send = (value: JsonObject) =>
    output.write(Buffer.from(JSON.stringify(value) + "\n"));
  let turns = 0;
  input.on("data", (frame) => {
    const request = JSON.parse(frame.toString()) as JsonObject;
    if (request.method === "initialize") {
      send({
        id: request.id,
        result: {
          userAgent: "codex-fixture/0.145.0",
          codexHome: "/tmp",
        },
      });
      return;
    }
    if (request.method === "thread/start") {
      threadId = "thr-session-1";
      send({
        id: request.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });
      return;
    }
    if (request.method === "turn/start") {
      nativeTurnId = `turn-${++turns}`;
      send({
        id: request.id,
        result: { turn: { id: nativeTurnId, items: [], status: "inProgress" } },
      });
      return;
    }
    if (request.method === "turn/interrupt") {
      send({
        id: request.id,
        result: {
          turn: {
            id: object(request.params) ? request.params.turnId : undefined,
            items: [],
            status: "interrupted",
          },
        },
      });
      resolveInterrupted(request);
    }
  });
  const session = new CodexSession({
    input,
    output,
    expectedHome: "/tmp",
    requestTimeoutMs: 1000,
    promptTimeoutMs: 1000,
    emit: (event) => events.push(event),
    onFailure: (error) => failures.push(error.code),
  });
  t.after(() => {
    session.close();
    input.destroy();
    output.destroy();
  });
  return {
    session,
    events,
    failures,
    interrupted,
    get threadId() {
      return threadId;
    },
    get nativeTurnId() {
      return nativeTurnId;
    },
    notify(method: string, params: JsonObject) {
      send({ method, params });
    },
  };
}
