import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { PiFleetBridge } from "../backends/pi/fleet-bridge.ts";
import { PluginStore } from "../src/plugin-sdk/store.ts";
import type { PluginContext } from "../src/plugin-sdk/runtime.ts";
import {
  DEFAULT_LIMITS,
  FrameDecoder,
  encodeFrame,
  type JsonObject,
} from "../src/gateway/protocol.ts";

async function context(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-pi-fleet-"));
  const store = new PluginStore(join(dir, "plugin.sqlite"), {
    bindingId: "binding-one",
    instanceId: "instance-one",
    leaseGeneration: 1,
  });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const calls: any[] = [],
    activities: any[] = [];
  let admissions = 0,
    failures = 0;
  const abort = new AbortController();
  const ctx = {
    initialization: {
      bindingId: "binding-one",
      limits: DEFAULT_LIMITS,
    } as PluginContext["initialization"],
    signal: abort.signal,
    hostCall: async (call: any) => {
      assert.ok(activities.length > 0);
      calls.push(call);
      const key = `action:${call.actionId}`;
      const retained = store.reserve(
        key,
        "host.call",
        call.payloadDigest,
        call
      );
      if (!retained.created) return retained.result;
      admissions++;
      const result = { status: "admitted", dispatchId: "dispatch-one" };
      store.settle(key, result);
      return result;
    },
  };
  const hooks = {
    onFailure: () => {
      failures++;
    },
    onActivity: (value: unknown) => {
      activities.push(value);
    },
  };
  return {
    ctx,
    hooks,
    calls,
    activities,
    abort,
    admissions: () => admissions,
    failures: () => failures,
  };
}

test(
  "Pi bridge connects the shipped extension to immutable SDK fleet actions",
  { timeout: 10000 },
  async (t) => {
    const f = await context(t);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/pi-adapter/fleet-extension.mjs", import.meta.url)
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] }
    );
    const bridge = new PiFleetBridge(child.stdio[3] as Duplex, f.ctx, f.hooks);
    const pending = new Map<string, (value: any) => void>();
    const reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    let errors = "";
    child.stderr!.on("data", (chunk) => {
      errors += chunk;
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve())
    );
    t.after(async () => {
      bridge.close();
      child.stdin!.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(timer);
      reader.close();
      assert.equal(child.exitCode, 0);
      assert.equal(errors, "");
    });
    const command = (method: string, params: JsonObject = {}) =>
      new Promise<any>((resolve) => {
        const id = randomUUID();
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ id, method, ...params }) + "\n");
      });
    assert.equal(await bridge.initialize(), "native-session");
    await bridge.activate("op-one", "turn-one");
    await command("start");
    const first = await command("call"),
      retry = await command("call");
    assert.deepEqual(
      JSON.parse(first.result.content[0].text),
      JSON.parse(retry.result.content[0].text)
    );
    assert.equal(f.admissions(), 1);
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.deepEqual(f.activities[0], {
      operationId: "op-one",
      turnId: "turn-one",
    });
    assert.equal(JSON.stringify(f.calls).includes("promptId"), false);
    const conflict = await command("call", {
      args: { target: "peer", text: "changed" },
    });
    assert.ok(conflict.error);
    assert.equal(f.admissions(), 1);
    await command("end");
    bridge.finishPrompt("op-one");
    await bridge.activate("op-two", "turn-two");
    await command("start");
    assert.ok((await command("call")).result);
    assert.equal(f.admissions(), 2);
    assert.notEqual(f.calls[0].actionId, f.calls.at(-1).actionId);
    assert.equal(f.failures(), 0);
  }
);

test("Pi parent rejects stale and forged native context before host dispatch", async (t) => {
  const f = await context(t);
  const input = new PassThrough(),
    output = new PassThrough();
  const stream = Duplex.from({ readable: input, writable: output });
  const frames: any[] = [];
  let promptId: unknown;
  const parser = new FrameDecoder();
  const send = (message: any) => input.write(encodeFrame(message));
  output.on("data", (bytes) =>
    parser.push(bytes, (message) => {
      if (message.method === "initialize")
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            bridgeVersion: 1,
            nativeSessionId: "session",
            tools: ["fleet_discover", "fleet_send"],
          },
        });
      else if (message.method === "activate") {
        promptId = message.params!.promptId;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { status: "armed", promptId },
        });
      } else frames.push(message);
    })
  );
  const bridge = new PiFleetBridge(stream, f.ctx, f.hooks);
  t.after(() => bridge.close());
  await bridge.initialize();
  await bridge.activate("op-one", "turn-one");
  const stale = promptId;
  bridge.finishPrompt("op-one");
  await bridge.activate("op-two", "turn-two");
  for (const override of [
    { promptId: stale },
    { nativeSessionId: "foreign" },
    { operationId: "forged" },
    { arguments: { target: "peer", text: "task", from: "atlas" } },
  ])
    send({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "fleet.call",
      params: {
        nativeSessionId: "session",
        promptId,
        nativeToolCallId: "native-call",
        name: "fleet.send",
        arguments: { target: "peer", text: "task" },
        ...override,
      },
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 4);
  assert.ok(frames.every((frame) => frame.error));
  assert.equal(f.calls.length, 0);
  assert.equal(f.activities.length, 0);
  f.abort.abort();
  await assert.rejects(bridge.activate("op-three", "turn-three"));
  assert.equal(f.failures(), 0);
});
