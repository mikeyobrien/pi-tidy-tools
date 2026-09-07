import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openFleetMcp } from "../backends/hermes/fleet-mcp.ts";
import { DEFAULT_LIMITS } from "../src/gateway/protocol.ts";
import type { PluginContext, HostCallInput } from "../src/plugin-sdk/index.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore } from "../src/plugin-sdk/store.ts";

test(
  "installed Hermes MCP client interoperates with the private endpoint",
  {
    skip: !process.env.TIDY_HERMES_MCP_PYTHON,
    timeout: 15000,
  },
  async (t) => {
    const f = await fixture(t);
    const child = spawn(
      process.env.TIDY_HERMES_MCP_PYTHON!,
      [
        "-I",
        "-B",
        fileURLToPath(new URL("./hermes_fleet_mcp_client.py", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.stdin.end(JSON.stringify(f.endpoint.descriptor));
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(code, 0, errors);
    assert.match(output, /installed_mcp_interoperability_passed/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].actionId, f.calls[1].actionId);
  }
);

async function fixture(t: TestContext) {
  const calls: HostCallInput[] = [];
  const dir = await mkdtemp(join(tmpdir(), "tidy-mcp-store-"));
  const store = new PluginStore(join(dir, "plugin.sqlite"), {
    bindingId: "binding-one",
    instanceId: "instance-one",
    leaseGeneration: 1,
  });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const abort = new AbortController();
  let operationId: string | undefined = "op-one";
  let failure = false;
  const endpoint = await openFleetMcp(
    {
      initialization: {
        bindingId: "binding-one",
        limits: DEFAULT_LIMITS,
      } as PluginContext["initialization"],
      signal: abort.signal,
      hostCall: async (call) => {
        calls.push(call);
        if (failure) throw new Error("private path /secret/credential");
        const key = `action:${call.actionId}`;
        if (call.name === "fleet.send") {
          const retained = store.reserve(
            key,
            "host.call",
            String(call.payloadDigest),
            call
          );
          if (!retained.created) return retained.result;
        }
        const result = { status: "admitted", dispatchId: "dispatch-one" };
        if (call.name === "fleet.send") store.settle(key, result);
        return result;
      },
    },
    (sessionId, promptId) => {
      assert.equal(promptId, "prompt-one");
      assert.equal(sessionId, "acp-one");
      assert.ok(operationId);
      return { operationId, turnId: "turn-one" };
    }
  );
  t.after(() => endpoint.close());
  const headers = { Authorization: endpoint.descriptor.headers[0].value };
  const client = new Client({ name: "disposable-native-mcp", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.descriptor.url), {
      requestInit: { headers },
    })
  );
  const send = (
    args: Record<string, unknown> = { target: "peer", text: "task" },
    identity: unknown = {
      sessionId: "acp-one",
      promptId: "prompt-one",
      nativeToolCallId: "native-call-one",
      toolName: "fleet_send",
    }
  ) =>
    client.callTool({
      name: "fleet_send",
      arguments: args,
      _meta: { tidy: identity },
    });
  return {
    endpoint,
    headers,
    client,
    calls,
    abort,
    send,
    setOperation: (value?: string) => {
      operationId = value;
    },
    fail: () => {
      failure = true;
    },
  };
}

test("private MCP discovery and sends retain native action identity across transport requests", async (t) => {
  const f = await fixture(t);
  const listed = await f.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["fleet_discover", "fleet_send"]
  );
  assert.equal((await f.send()).isError, undefined);
  assert.equal(
    (await f.send({ text: "task", target: "peer" })).isError,
    undefined
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].actionId, f.calls[1].actionId);
  assert.equal(f.calls[0].payloadDigest, f.calls[1].payloadDigest);
  assert.equal(f.calls[0].callId, f.calls[1].callId);
  assert.equal(
    (await f.send({ target: "peer", text: "changed" })).isError,
    true
  );
  assert.equal(f.calls[0].actionId, f.calls[2].actionId);
  assert.notEqual(f.calls[0].payloadDigest, f.calls[2].payloadDigest);
  f.setOperation("op-two");
  await f.send();
  assert.notEqual(f.calls[0].actionId, f.calls[3].actionId);
  assert.equal(
    JSON.stringify(f.calls).includes(f.headers.Authorization),
    false
  );
});

test("MCP refuses uncorrelated, inactive and sender-forged calls before host dispatch", async (t) => {
  const f = await fixture(t);
  for (const identity of [
    null,
    {},
    { sessionId: "foreign", nativeToolCallId: "call", toolName: "fleet_send" },
    {
      sessionId: "acp-one",
      promptId: "prompt-one",
      nativeToolCallId: "call",
      toolName: "fleet_discover",
    },
  ])
    assert.equal((await f.send(undefined, identity)).isError, true);
  assert.equal(
    (await f.send({ target: "peer", text: "task", from: "atlas" })).isError,
    true
  );
  assert.equal(
    (await f.send({ target: "peer", text: "x".repeat(65537) })).isError,
    true
  );
  f.setOperation();
  assert.equal((await f.send()).isError, true);
  assert.equal(f.calls.length, 0);
});

test("MCP authentication, origin, request bounds and shutdown fence the private endpoint", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await fetch(f.endpoint.descriptor.url, { method: "POST", body: "{}" }))
      .status,
    403
  );
  assert.equal(
    (
      await fetch(f.endpoint.descriptor.url, {
        method: "POST",
        headers: { ...f.headers, Origin: "http://example.com" },
        body: "{}",
      })
    ).status,
    403
  );
  assert.equal(
    (
      await fetch(f.endpoint.descriptor.url, {
        method: "POST",
        headers: f.headers,
        body: "x".repeat(DEFAULT_LIMITS.maxFrameBytes + 1),
      })
    ).status,
    413
  );
  f.fail();
  const result = await f.send();
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  f.abort.abort();
  await f.endpoint.close();
  await assert.rejects(
    fetch(f.endpoint.descriptor.url, { headers: f.headers })
  );
});
