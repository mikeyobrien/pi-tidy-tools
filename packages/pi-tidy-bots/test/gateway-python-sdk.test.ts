import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginHost,
  type PluginHostOptions,
} from "../src/gateway/plugin-host.ts";
import { digestArtifact, PluginRegistry } from "../src/gateway/registry.ts";
import type { GatewayPluginEvent } from "../src/gateway/protocol.ts";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { ownedGroupHasExited } from "../src/gateway/process-ownership.ts";

const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(candidate) ? candidate : "python3");
const sdk = fileURLToPath(
  new URL("../sdk/python/tidy_backend_sdk", import.meta.url)
);
const backend = fileURLToPath(
  new URL("./fixtures/gateway-python/backend.py", import.meta.url)
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function setup(mode = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "tidy-python-sdk-"));
  const artifact = join(dir, "artifact");
  await mkdir(join(artifact, "sdk"), { recursive: true });
  await cp(sdk, join(artifact, "sdk", "tidy_backend_sdk"), {
    recursive: true,
    filter: (path) => !path.includes("__pycache__"),
  });
  await cp(backend, join(artifact, "backend.py"));
  await writeFile(
    join(artifact, "plugin"),
    `#!/bin/sh\nexec ${quote(python)} -B ${quote(join(artifact, "backend.py"))}\n`
  );
  await chmod(join(artifact, "plugin"), 0o700);
  await writeFile(
    join(artifact, "backend.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "org.example.python",
      version: "1.0.0",
      protocol: { major: 1, minMinor: 0, maxMinor: 0 },
      entrypoint: { path: "plugin", args: [] },
      configSchema: "config.schema.json",
      runtime: {
        name: "independent-python",
        testedVersion: "1.0.0",
        transport: "stdio",
      },
      requestedAccess: {
        workspace: "none",
        nativeProfile: mode === "registered-owned",
        network: false,
        gatewayTools: ["operator.enqueue"],
      },
    })
  );
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      type: "object",
      properties: {
        mode: { type: "string" },
        externalPid: { type: "integer" },
      },
      additionalProperties: false,
    })
  );
  const registry = join(dir, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.python",
          version: "1.0.0",
          artifactPath: "artifact",
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
      ],
    })
  );
  const installation = (
    await PluginRegistry.load(registry, {
      policy: {
        gatewayTools: ["operator.enqueue"],
        nativeProfile: mode === "registered-owned",
      },
    })
  ).resolve("org.example.python");
  const handles: PluginHost[] = [];
  const events: GatewayPluginEvent[] = [];
  const start = async (options: Partial<PluginHostOptions> = {}) => {
    const host = await PluginHost.start({
      installation,
      bindingId: "binding-python",
      leaseGeneration: 1,
      config: { mode },
      workspace: dir,
      dataDir: join(dir, "data"),
      allowedEnv: {},
      onEvent: async (event) => {
        events.push(event);
        return event.sourceSequence;
      },
      ...options,
    });
    handles.push(host);
    return host;
  };
  const calls = async (): Promise<Record<string, any>[]> =>
    (await readFile(join(dir, "data", "native-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const open = {
    openId: "open-1",
    operationId: "opening-1",
    payloadDigest: "claimed-open",
    conversationId: "conv-1",
    mode: "new",
    cwd: dir,
    policyRevision: "policy-1",
  };
  const submit = {
    operationId: "operation-1",
    payloadDigest: "claimed-submit",
    conversationId: "conv-1",
    turnId: "turn-1",
    policyRevision: "policy-1",
    input: [{ type: "text", text: "hello\u2028world\nnext" }],
  };
  return {
    dir,
    events,
    start,
    calls,
    open,
    submit,
    cleanup: async () => {
      await Promise.all(handles.map((host) => host.close()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until(probe: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, "fixture observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Python orderly cleanup confirms a registered detached child through the closing host", async () => {
  const f = await setup("registered-owned");
  let childId: string | undefined;
  const stopped: string[] = [];
  try {
    const host = await f.start({
      onLaunchPrepared: (id, parent) => {
        if (parent) childId = id;
      },
      onLaunchRecorded: async (id) => {
        if (id === childId)
          await assert.rejects(readFile(join(f.dir, "data", "child-effect")), {
            code: "ENOENT",
          });
      },
      onLaunchStopped: (id) => {
        stopped.push(id);
      },
    });
    assert.equal(
      ((await host.request("session.open", f.open)) as any).status,
      "opened"
    );
    await until(() => existsSync(join(f.dir, "data", "child-effect")));
    const child = (await f.calls()).find(
      (entry) => entry.kind === "registered"
    )!;
    await host.close();
    assert.equal(await ownedGroupHasExited(child.pid), true);
    const calls = await f.calls();
    assert.deepEqual(
      calls
        .filter((entry) => entry.kind === "cleanup_denied")
        .map((entry) => entry.method),
      ["prepare", "record"]
    );
    assert.ok(
      calls.some(
        (entry) =>
          entry.kind === "cleanup_confirmed" &&
          entry.inspected === childId &&
          entry.stopped === childId
      )
    );
    assert.ok(stopped.includes(childId!));
  } finally {
    await f.cleanup();
  }
});

test("Python SDK storage/framing tests run on the explicitly supported engine", () => {
  const result = spawnSync(
    python,
    [
      "-B",
      fileURLToPath(new URL("./gateway_python_sdk_test.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(
    result.status,
    0,
    `Set TIDY_TEST_PYTHON to Python >=3.11 with SQLite3.53.4.\n${result.stderr}\n${result.error ?? ""}`
  );
  assert.match(result.stderr, /Ran 20 tests/);
});

test("independently installed Python plugin runs through real host; repeated open/submit/control never repeat native work", async () => {
  const fixture = await setup();
  try {
    const host = await fixture.start();
    assert.equal(host.runtime.name, "independent-python");
    const opened = await host.request("session.open", fixture.open);
    assert.deepEqual(opened, {
      status: "opened",
      nativeReference: "python:open-1",
    });
    assert.deepEqual(await host.request("session.open", fixture.open), opened);
    await assert.rejects(
      host.request("session.open", { ...fixture.open, cwd: "/changed" }),
      { code: "payload_conflict" }
    );
    assert.deepEqual(await host.request("operation.submit", fixture.submit), {
      disposition: "accepted",
    });
    assert.deepEqual(await host.request("operation.submit", fixture.submit), {
      disposition: "accepted",
    });
    await assert.rejects(
      host.request("operation.submit", {
        ...fixture.submit,
        input: [{ type: "text", text: "changed" }],
      }),
      { code: "payload_conflict" }
    );
    await until(() =>
      fixture.events.some((event) => event.type === "turn.terminal")
    );
    assert.equal(fixture.events.length, 5);
    assert.deepEqual(
      fixture.events.map((event) => event.sourceSequence),
      [1, 2, 3, 4, 5]
    );
    assert.equal(
      fixture.events[2].payload.text,
      "Python: hello\u2028world\nnext"
    );
    const cancel = {
      operationId: "cancel-1",
      payloadDigest: "claimed-control",
      targetOperationId: fixture.submit.operationId,
    };
    assert.deepEqual(await host.request("operation.cancel", cancel), {
      status: "requested",
    });
    assert.deepEqual(await host.request("operation.cancel", cancel), {
      status: "requested",
    });
    await assert.rejects(
      host.request("operation.cancel", {
        ...cancel,
        targetOperationId: "different",
      }),
      { code: "payload_conflict" }
    );
    const decision = {
      operationId: "decision-1",
      payloadDigest: "claimed-decision",
      targetOperationId: fixture.submit.operationId,
      interactionId: "request-1",
      optionId: "deny",
      instanceId: host.instanceId,
    };
    assert.deepEqual(await host.request("interaction.respond", decision), {
      status: "applied",
    });
    await assert.rejects(
      host.request("interaction.respond", { ...decision, optionId: "allow" }),
      { code: "payload_conflict" }
    );
    assert.deepEqual(
      (await fixture.calls())
        .filter((call) =>
          ["open", "submit", "cancel", "decision"].includes(call.kind)
        )
        .map((call) => call.kind),
      ["open", "submit", "cancel", "decision"]
    );
    assert.equal(
      (
        (await host.request("operation.inspect", {
          operationId: fixture.submit.operationId,
        })) as { execution: string }
      ).execution,
      "ended"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Python crash after native creation or submission leaves unknown reservations across a new lease", async () => {
  for (const mode of ["crash-open", "crash-submit"]) {
    const fixture = await setup(mode);
    try {
      const host = await fixture.start();
      const method =
        mode === "crash-open" ? "session.open" : "operation.submit";
      const params = mode === "crash-open" ? fixture.open : fixture.submit;
      if (mode === "crash-submit")
        await host.request("session.open", fixture.open);
      await assert.rejects(host.request(method, params));
      await host.closed;
      const replacement = await fixture.start({ leaseGeneration: 2 });
      assert.deepEqual(
        await replacement.request(method, params),
        mode === "crash-open"
          ? { status: "creation_unknown" }
          : { disposition: "unknown" }
      );
      assert.equal(
        (await fixture.calls()).filter(
          (call) => call.kind === (mode === "crash-open" ? "open" : "submit")
        ).length,
        1
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("Python durable spool survives lost ack and re-envelopes replay without repeating native execution", async () => {
  const fixture = await setup();
  try {
    const original: GatewayPluginEvent[] = [];
    const host = await fixture.start({
      onEvent: async (event) => {
        original.push(event);
        return 0;
      },
    });
    await host.request("session.open", fixture.open);
    await host.request("operation.submit", fixture.submit);
    await until(() => original.length === 5);
    await host.close();
    const replayed: GatewayPluginEvent[] = [];
    const replacement = await fixture.start({
      leaseGeneration: 2,
      onEvent: async (event) => {
        replayed.push(event);
        return event.sourceSequence;
      },
    });
    assert.equal(
      (
        (await replacement.request("events.replay", {
          afterSourceSequence: 0,
        })) as { status: string }
      ).status,
      "replayed"
    );
    await until(() => replayed.length === 5);
    assert.deepEqual(
      replayed.map(({ leaseGeneration, ...event }) => event),
      original.map(({ leaseGeneration, ...event }) => event)
    );
    assert.ok(replayed.every((event) => event.leaseGeneration === 2));
    await until(() => replacement.acknowledgedSequence === 5);
    assert.equal(
      (
        (await replacement.request("events.replay", {
          afterSourceSequence: 0,
        })) as { status: string }
      ).status,
      "gap"
    );
    assert.equal(
      (await fixture.calls()).filter((call) => call.kind === "submit").length,
      1
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Python reverse mutation reserves before host effect and returns its retained result", async () => {
  const fixture = await setup("reverse");
  let effects = 0;
  try {
    const host = await fixture.start({
      onHostCall: async (call) => {
        assert.equal(call.name, "operator.enqueue");
        effects++;
        return { status: "admitted", itemId: "one" };
      },
    });
    await host.request("session.open", fixture.open);
    await host.request("operation.submit", fixture.submit);
    await host.request("operation.submit", fixture.submit);
    assert.equal(effects, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Python request deadline leaves unknown and parent shutdown reaps only its owned child", async () => {
  const slow = await setup("timeout");
  try {
    const host = await slow.start({ limits: { commandTimeoutMs: 200 } });
    await host.request("session.open", slow.open);
    await host.request("operation.submit", slow.submit).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await host.request("operation.submit", slow.submit), {
      disposition: "unknown",
    });
    assert.equal(
      (await slow.calls()).filter((call) => call.kind === "submit").length,
      1
    );
  } finally {
    await slow.cleanup();
  }
  const fixture = await setup("owned");
  try {
    const host = await fixture.start();
    await host.request("session.open", fixture.open);
    const child = (await fixture.calls()).find(
      (call) => call.kind === "owned"
    )!.pid;
    process.kill(child, 0);
    await host.close();
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    assert.equal(
      (await fixture.calls()).filter((call) => call.kind === "reaped").length,
      1
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Python stdin EOF invokes owned cleanup and attached shutdown preserves the independent service", async () => {
  const fixture = await setup("owned");
  try {
    const host = await fixture.start();
    await host.request("session.open", fixture.open);
    const child = (await fixture.calls()).find(
      (call) => call.kind === "owned"
    )!.pid;
    // Exercise actual pipe loss, without sending the protocol shutdown request.
    (host as unknown as { child: { stdin: Writable } }).child.stdin.end();
    await host.closed;
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    assert.equal(
      (await fixture.calls()).filter((call) => call.kind === "reaped").length,
      1
    );
  } finally {
    await fixture.cleanup();
  }

  const service = spawn(python, ["-B", "-c", "import time; time.sleep(600)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    service.once("close", () => resolve())
  );
  const attached = await setup("attached");
  try {
    assert.ok(service.pid);
    const host = await attached.start({
      config: { mode: "attached", externalPid: service.pid },
    });
    await host.request("session.open", attached.open);
    const result = (await host.request("session.close", {
      mode: "interrupt",
    })) as Record<string, unknown>;
    assert.equal(result.ownership, "attached");
    assert.equal(result.nativeOutcome, "unknown");
    assert.equal(result.ownedStopped, undefined);
    await host.closed;
    process.kill(service.pid, 0);
    assert.equal(
      (await attached.calls()).find((call) => call.kind === "attached_closed")!
        .stopOwned,
      false
    );
  } finally {
    service.kill();
    await exited;
    await attached.cleanup();
  }
});

test("Python rejects invalid close and unsupported drain before cancelling active native work", async () => {
  const fixture = await setup("timeout");
  try {
    const host = await fixture.start({ limits: { commandTimeoutMs: 5000 } });
    await host.request("session.open", fixture.open);
    const pending = host.request("operation.submit", fixture.submit);
    // Attach a failure observer immediately while preserving the actual result.
    void pending.catch(() => {});
    await until(async () =>
      (await fixture.calls()).some((call) => call.kind === "submit")
    );
    for (const mode of [undefined, "invalid"]) {
      await assert.rejects(
        host.request("session.close", mode ? { mode } : {}),
        { code: "invalid_payload" }
      );
    }
    await assert.rejects(host.request("session.close", { mode: "drain" }), {
      code: "capability_unavailable",
    });
    assert.deepEqual(await host.request("health", {}), { health: "ready" });
    const before = await fixture.calls();
    assert.equal(
      before.filter(
        (call) => call.kind === "handler_cancelled" || call.kind === "closed"
      ).length,
      0
    );
    assert.equal(before.filter((call) => call.kind === "submit").length, 1);
    const closed = (await host.request("session.close", {
      mode: "interrupt",
    })) as Record<string, unknown>;
    assert.equal(closed.nativeOutcome, "unknown");
    assert.deepEqual(await pending, { disposition: "unknown" });
    await host.closed;
    const after = await fixture.calls();
    assert.equal(
      after.filter((call) => call.kind === "handler_cancelled").length,
      1
    );
    assert.deepEqual(
      after.find((call) => call.kind === "closed"),
      { kind: "closed", stopOwned: true, mode: "interrupt", ownership: "owned" }
    );
  } finally {
    await fixture.cleanup();
  }
});

test("real startFleet admits HTTP contract 2 messages through the independently installed Python SDK", async () => {
  const fixture = await setup();
  let handle: FleetHandle | undefined;
  try {
    await writeFile(
      join(fixture.dir, "AGENTS.md"),
      "Disposable Python SDK integration fleet. No model calls.\n"
    );
    await writeFile(
      join(fixture.dir, "bots.toml"),
      '[gateway]\nregistry = "registry.json"\ngateway_tools = ["operator.enqueue"]\n[[bot]]\nname = "python"\ndir = "."\nbackend = "org.example.python"\n'
    );
    handle = await startFleet({
      dir: fixture.dir,
      port: 0,
      token: "python-integration-token",
      log: () => {},
    });
    assert.ok(handle.port && handle.port > 0);
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(handle!.url + path, {
        ...options,
        headers: {
          authorization: "Bearer python-integration-token",
          ...options.headers,
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    };
    const discovery = await request("/api/version");
    assert.ok(discovery.body.capabilities.includes("backend-capabilities-v1"));
    assert.ok(discovery.body.capabilities.includes("operation-receipts-v1"));
    const legacy = await request("/api/bots/python/message", {
      method: "POST",
    });
    assert.equal(legacy.status, 426);
    assert.equal(legacy.body.requiredContract, 2);
    const binding = (await request("/api/bots/python/capabilities")).body;
    assert.equal(binding.backend.id, "org.example.python");
    const send = () =>
      request("/api/bots/python/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": binding.bindingRevision,
        },
        body: JSON.stringify({
          operationId: "http-python-1",
          clientMessageId: "http-python-1",
          conversationId: binding.conversationId,
          text: "gateway path",
        }),
      });
    const admitted = await send();
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.body.delivery, "queued");
    await until(
      async () =>
        (await request("/api/bots/python/operations/http-python-1")).body
          .execution === "ended"
    );
    const transcript = (await request("/api/bots/python/transcript")).body
      .transcript;
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].id, admitted.body.userEntryId);
    assert.deepEqual(
      transcript.map((entry: Record<string, unknown>) => entry.text),
      ["gateway path", "Python: gateway path"]
    );
    assert.ok(
      transcript.every(
        (entry: Record<string, unknown>) =>
          entry.operationId === "http-python-1"
      )
    );
    const duplicate = await send();
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.userEntryId, admitted.body.userEntryId);
    assert.equal(duplicate.body.execution, "ended");
    const trace = (
      await readFile(
        join(
          fixture.dir,
          ".fleet/plugins",
          binding.bindingId,
          "native-calls.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(trace.filter((call) => call.kind === "open").length, 1);
    assert.equal(trace.filter((call) => call.kind === "submit").length, 1);
    await handle.stop();
    await assert.rejects(fetch(handle.url + "/api/version"));
    handle = undefined;
  } finally {
    await handle?.stop();
    await fixture.cleanup();
  }
});
