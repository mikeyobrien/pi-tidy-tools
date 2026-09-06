import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  FrameDecoder,
  encodeFrame,
  type JsonObject,
  type ProtocolLimits,
} from "../src/gateway/protocol.ts";

function fixture(t: TestContext, hold = false) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./fixtures/pi-adapter/fleet-extension.mjs", import.meta.url)
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] }
  );
  const control = child.stdio[3] as Duplex;
  const waiting = new Map<
    string,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const native = new Map<string, (value: any) => void>();
  const calls: any[] = [];
  let errors = "";
  child.stderr!.on("data", (chunk) => {
    errors += chunk;
  });
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", (line) => {
    const response = JSON.parse(line);
    native.get(response.id)?.(response);
    native.delete(response.id);
  });
  const write = (value: any) => control.write(encodeFrame(value));
  const reply = (call: any) =>
    write({
      jsonrpc: "2.0",
      id: call.id,
      result: { status: "admitted", dispatchId: "dispatch-one" },
    });
  const parser = new FrameDecoder();
  control.on("data", (bytes) =>
    parser.push(bytes, (message) => {
      if (message.method === "fleet.call") {
        calls.push(message);
        if (!hold) reply(message);
        return;
      }
      const pending = waiting.get(message.id!);
      if (!pending) return;
      waiting.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("control rejected"));
      else pending.resolve(message.result);
    })
  );
  control.on("error", () => {});
  control.on("close", () => {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("control closed"));
    }
    waiting.clear();
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  t.after(async () => {
    child.stdin!.end();
    control.destroy();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
    reader.close();
    assert.equal(errors, "");
  });
  const request = (method: string, params: JsonObject) =>
    new Promise<any>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("control timeout"));
      }, 3000);
      waiting.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const command = (method: string, params: JsonObject = {}) =>
    new Promise<any>((resolve) => {
      const id = randomUUID();
      native.set(id, resolve);
      child.stdin!.write(JSON.stringify({ id, method, ...params }) + "\n");
    });
  return {
    calls,
    control,
    command,
    request,
    reply,
    initialize: (limits: ProtocolLimits = DEFAULT_LIMITS) =>
      request("initialize", { limits }),
    activate: (promptId: string) =>
      request("activate", { promptId, nativeSessionId: "native-session" }),
  };
}

test(
  "Pi extension proves registration and scopes native IDs to an armed prompt",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    assert.deepEqual(await f.initialize(), {
      nativeSessionId: "native-session",
      tools: ["fleet_discover", "fleet_send"],
      bridgeVersion: 1,
    });
    assert.match((await f.command("call")).error, /Fleet tool unavailable/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.activate("prompt-one"), {
      status: "armed",
      promptId: "prompt-one",
    });
    await f.command("start");
    const first = await f.command("call"),
      second = await f.command("call");
    assert.deepEqual(first.result, second.result);
    assert.equal(f.calls.length, 2);
    assert.notEqual(f.calls[0].id, f.calls[1].id);
    assert.deepEqual(f.calls[0].params, f.calls[1].params);
    assert.deepEqual(f.calls[0].params, {
      nativeSessionId: "native-session",
      promptId: "prompt-one",
      nativeToolCallId: "native-call",
      name: "fleet.send",
      arguments: { target: "peer", text: "fixture" },
    });
    await f.command("end");
    assert.ok((await f.command("call")).error);
    await f.activate("prompt-two");
    await f.command("start");
    assert.ok(
      (await f.command("call", { name: "fleet_discover", args: {} })).result
    );
    assert.equal(f.calls[2].params.promptId, "prompt-two");
    assert.equal(f.calls[2].params.name, "fleet.discover");
  }
);

test(
  "Pi extension refuses forged sender, session, cancelled and oversized tool calls before IPC",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    await f.activate("prompt-one");
    await f.command("start");
    for (const params of [
      { foreign: true },
      { aborted: true },
      { toolCallId: "" },
      { args: { target: "peer", text: "task", from: "atlas" } },
      { args: { target: "peer", text: "x".repeat(65537) } },
    ])
      assert.ok((await f.command("call", params)).error);
    assert.equal(f.calls.length, 0);
  }
);

test(
  "Pi extension bounds pending native calls and ignores a late timed-out response",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t, true);
    await f.initialize({
      ...DEFAULT_LIMITS,
      maxPendingRequests: 1,
      commandTimeoutMs: 100,
    });
    await f.activate("prompt-one");
    await f.command("start");
    const first = f.command("call");
    const second = f.command("call", { toolCallId: "second" });
    assert.ok((await second).error);
    assert.ok((await first).error);
    assert.equal(f.calls.length, 1);
    f.reply(f.calls[0]);
    await f.command("end");
    await f.activate("prompt-two");
  }
);

test(
  "overlapping prompt activation closes the Pi private bridge",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    await f.initialize();
    await f.activate("prompt-one");
    await assert.rejects(f.activate("prompt-two"), /control closed/);
    assert.ok((await f.command("call")).error);
    assert.equal(f.calls.length, 0);
  }
);
