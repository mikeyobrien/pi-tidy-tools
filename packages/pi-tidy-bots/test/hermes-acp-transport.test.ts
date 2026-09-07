import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  AcpTransport,
  AcpRequestError,
  type AcpTransportOptions,
} from "../backends/hermes/acp-transport.ts";

function fixture(t: TestContext, overrides: Partial<AcpTransportOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, any>[] = [];
  const notifications: unknown[] = [];
  const failures: string[] = [];
  input.on("data", (frame) => frames.push(JSON.parse(frame.toString())));
  const transport = new AcpTransport({
    input,
    output,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    onFailure: (error) => failures.push(error.code),
    ...overrides,
  });
  t.after(() => {
    transport.close();
    input.destroy();
    output.destroy();
  });
  const send = (value: unknown) =>
    output.write(Buffer.from(JSON.stringify(value) + "\n"));
  return { input, output, frames, notifications, failures, transport, send };
}

test("ACP real child can await a numeric permission request while prompt is pending", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import {createInterface} from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    let prompt;
    createInterface({input:process.stdin}).on('line', line => {
      const value=JSON.parse(line);
      if(value.method==='session/prompt') {
        prompt=value;
        send({jsonrpc:'2.0',id:7,method:'session/request_permission',params:{sessionId:'s1',options:[]}});
        send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting'}}}});
      } else if(value.id===7 && value.result.outcome.optionId==='allow_once') {
        send({jsonrpc:'2.0',id:prompt.id,result:{stopReason:'end_turn'}});
      } else process.exit(3);
    });
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  let resolvePermission!: (value: unknown) => void;
  let observed!: () => void;
  const update = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const transport = new AcpTransport({
    input: child.stdin,
    output: child.stdout,
    onNotification: (method) => {
      assert.equal(method, "session/update");
      observed();
    },
    onRequest: async (method, params, id) => {
      assert.equal(method, "session/request_permission");
      assert.equal(params.sessionId, "s1");
      assert.equal(id, 7);
      return new Promise((resolve) => {
        resolvePermission = resolve;
      });
    },
    onFailure: () => {},
    requestTimeoutMs: 2000,
  });
  t.after(async () => {
    transport.close();
    child.kill();
    await exited;
  });
  const prompt = transport.request("session/prompt", {
    sessionId: "s1",
    prompt: [],
  });
  await update;
  resolvePermission({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  assert.deepEqual(await prompt, { stopReason: "end_turn" });
});

test("ACP decodes fragmented UTF-8 and LF frames without splitting Unicode line separators", async (t) => {
  const f = fixture(t);
  const result = f.transport.request("initialize", {});
  const frame = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: f.frames[0].id,
      result: { text: "雪\u2028line" },
    }) + "\n"
  );
  for (const byte of frame) f.output.write(Buffer.from([byte]));
  assert.deepEqual(await result, { text: "雪\u2028line" });
  assert.deepEqual(f.failures, []);
});

test("correlated ACP errors remain distinct from loss and don't expose native diagnostic data", async (t) => {
  const f = fixture(t);
  const first = f.transport.request("session/new", {});
  f.send({
    jsonrpc: "2.0",
    id: f.frames[0].id,
    error: {
      code: -32000,
      message: "private-token",
      data: "private-reasoning",
    },
  });
  await assert.rejects(
    first,
    (error) =>
      error instanceof AcpRequestError &&
      error.code === -32000 &&
      !JSON.stringify(error).includes("private")
  );
  const second = f.transport.request("initialize", {});
  f.send({ jsonrpc: "2.0", id: f.frames[1].id, result: {} });
  assert.deepEqual(await second, {});
  assert.deepEqual(f.failures, []);
});

for (const [name, bytes, code] of [
  ["invalid UTF-8", Buffer.from([0xff, 10]), "native_protocol_error"],
  ["batch", Buffer.from("[]\n"), "native_protocol_error"],
  [
    "unknown response",
    Buffer.from('{"jsonrpc":"2.0","id":"unknown","result":{}}\n'),
    "native_protocol_error",
  ],
  ["oversized unterminated frame", Buffer.alloc(257, 32), "resource_limit"],
] as const) {
  test(`ACP ${name} fails all pending requests without replay`, async (t) => {
    const f = fixture(t, { maxFrameBytes: 256 });
    const pending = f.transport.request("initialize", {});
    f.output.write(bytes);
    await assert.rejects(pending, { code });
    await assert.rejects(f.transport.request("initialize", {}), { code });
    assert.equal(f.frames.length, 1);
    assert.deepEqual(f.failures, [code]);
  });
}

test("ACP truncated EOF rejects pending operations and aborts live permission futures", async (t) => {
  let signal: AbortSignal | undefined;
  let reply!: (value: unknown) => void;
  const f = fixture(t, {
    onRequest: async (_method, _params, _id, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
  });
  const pending = f.transport.request("session/prompt", {});
  f.send({
    jsonrpc: "2.0",
    id: 1,
    method: "session/request_permission",
    params: {},
  });
  f.output.end(Buffer.from("{"));
  await assert.rejects(pending, { code: "native_truncated_frame" });
  assert.equal(signal?.aborted, true);
  reply({ outcome: { outcome: "selected", optionId: "allow_once" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.frames.length, 1);
});

test("ACP timeout permanently rejects the channel instead of reusing an uncertain request", async (t) => {
  const f = fixture(t, { requestTimeoutMs: 10 });
  const pending = f.transport.request("session/prompt", {});
  await assert.rejects(pending, { code: "native_timeout" });
  f.send({
    jsonrpc: "2.0",
    id: f.frames[0].id,
    result: { stopReason: "end_turn" },
  });
  await assert.rejects(f.transport.request("session/prompt", {}), {
    code: "native_timeout",
  });
  assert.equal(f.frames.length, 1);
});

test("ACP rejects reused native request IDs after completion instead of answering another future", async (t) => {
  const f = fixture(t);
  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "session/request_permission",
    params: {},
  };
  f.send(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.frames[0].id, 7);
  f.send(request);
  assert.deepEqual(f.failures, ["native_protocol_error"]);
  assert.equal(f.frames.length, 1);
});

test("ACP refuses asynchronous observation callbacks that could reorder durable events", async (t) => {
  const f = fixture(t, {
    onNotification: async () => {
      throw new Error("private diagnostic");
    },
  });
  const pending = f.transport.request("session/prompt", {});
  f.send({ jsonrpc: "2.0", method: "session/update", params: {} });
  await assert.rejects(pending, { code: "native_protocol_error" });
  assert.deepEqual(f.failures, ["native_protocol_error"]);
});

test("ACP counts complete encoded outbound frames before writing or reserving", async (t) => {
  const f = fixture(t, { maxFrameBytes: 256, maxPendingRequests: 1 });
  await assert.rejects(
    f.transport.request("session/prompt", { text: "雪".repeat(100) }),
    { code: "resource_limit" }
  );
  assert.equal(f.frames.length, 0);
  const pending = f.transport.request("initialize", {});
  await assert.rejects(f.transport.request("initialize", {}), {
    code: "resource_limit",
  });
  f.send({ jsonrpc: "2.0", id: f.frames[0].id, result: {} });
  await pending;
  assert.deepEqual(f.failures, []);
});
