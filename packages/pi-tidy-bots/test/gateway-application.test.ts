import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { loadFleetConfig } from "../src/config.ts";
import { digestArtifact } from "../src/gateway/registry.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";

type ObjectValue = Record<string, any>;
async function waitFor<T>(
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  description = "condition"
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${description}: ${JSON.stringify(value)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function fixture(permissions = false) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-gateway-application-"));
  const artifact = join(dir, "plugin");
  await mkdir(artifact);
  await writeFile(
    join(dir, "AGENTS.md"),
    "Disposable gateway integration workspace. No native model calls.\n"
  );
  await copyFile(
    fileURLToPath(
      new URL("./fixtures/gateway-application/backend.mjs", import.meta.url)
    ),
    join(artifact, "backend.mjs")
  );
  await chmod(join(artifact, "backend.mjs"), 0o755);
  await writeFile(
    join(artifact, "backend.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "org.example.independent",
      version: "1.0.0",
      protocol: { major: 1, minMinor: 0, maxMinor: 0 },
      entrypoint: { path: "backend.mjs", args: [] },
      configSchema: "config.schema.json",
      runtime: {
        name: "independent-fixture",
        testedVersion: "1.0.0",
        transport: "stdio",
      },
      requestedAccess: {
        workspace: "none",
        nativeProfile: false,
        network: false,
        gatewayTools: [],
      },
    })
  );
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      type: "object",
      properties: {
        health: { type: "string", enum: ["ready", "auth_required"] },
        permissions: { type: "boolean" },
      },
      additionalProperties: false,
    })
  );
  await writeFile(
    join(dir, "registry.json"),
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.independent",
          version: "1.0.0",
          artifactPath: artifact,
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
      ],
    })
  );
  const manifest = `[gateway]\nregistry = "registry.json"\nenvironment = ["PATH"]\n[[bot]]\nname = "fixture"\ndir = "."\nbackend = "org.example.independent"\n`;
  await writeFile(
    join(dir, "bots.toml"),
    manifest + (permissions ? "[bot.backend_config]\npermissions = true\n" : "")
  );
  const handles: FleetHandle[] = [];
  let fleetToken = "disposable-test-token";
  const start = async () => {
    const handle = await startFleet({
      dir,
      port: 0,
      token: fleetToken,
      log: () => {},
    });
    handles.push(handle);
    return handle;
  };
  const request = async (
    handle: FleetHandle,
    path: string,
    options: RequestInit = {}
  ) => {
    const response = await fetch(handle.url + path, {
      ...options,
      headers: {
        authorization: `Bearer ${fleetToken}`,
        ...options.headers,
      },
    });
    return {
      status: response.status,
      body: (await response.json()) as ObjectValue,
      headers: response.headers,
    };
  };
  const binding = async (handle: FleetHandle) =>
    (await request(handle, "/api/bots/fixture/capabilities")).body;
  const calls = async (descriptor: ObjectValue): Promise<ObjectValue[]> => {
    const source = await readFile(
      join(dir, ".fleet/plugins", descriptor.bindingId, "calls.jsonl"),
      "utf8"
    );
    return source
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const submit = async (
    handle: FleetHandle,
    descriptor: ObjectValue,
    operationId: string,
    text: string,
    extra: ObjectValue = {}
  ) =>
    request(handle, "/api/bots/fixture/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tidy-client-contract": "2",
        "x-tidy-binding-revision": descriptor.bindingRevision,
      },
      body: JSON.stringify({
        operationId,
        clientMessageId: operationId,
        conversationId: descriptor.conversationId,
        text,
        ...extra,
      }),
    });
  const inspect = async (handle: FleetHandle, id: string) =>
    (
      await request(
        handle,
        `/api/bots/fixture/operations/${encodeURIComponent(id)}`
      )
    ).body;
  const socket = async (handle: FleetHandle, since = 0) => {
    const ws = new WebSocket(
      handle.url.replace("http", "ws") +
        `/api/ws?token=${encodeURIComponent(fleetToken)}&since=${since}`
    );
    const events: ObjectValue[] = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await waitFor(
      () => events,
      (values) => values.some((value) => value.type === "hello")
    );
    return { ws, events };
  };
  return {
    dir,
    setToken: (token: string) => {
      fleetToken = token;
    },
    manifest,
    start,
    request,
    binding,
    calls,
    submit,
    inspect,
    socket,
    cleanup: async () => {
      await Promise.all(handles.map((handle) => handle.stop()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("HTTP permissions interrupt a pending submit and retain one late resolution and decision", async () => {
  const f = await fixture(true);
  try {
    const handle = await f.start();
    const binding = await f.binding(handle);
    const { ws, events } = await f.socket(handle);
    try {
      assert.equal(
        (await f.submit(handle, binding, "permission-target", "[permission]"))
          .status,
        202
      );
      const request = await waitFor<ObjectValue>(
        () => events.find((e) => e.entry?.permission)?.entry.permission,
        Boolean
      );
      const decision = {
        kind: "permission",
        operationId: "permission-decision",
        conversationId: binding.conversationId,
        bindingId: request.bindingId,
        instanceId: request.instanceId,
        targetOperationId: request.operationId,
        turnId: request.turnId,
        interactionId: request.interactionId,
        optionsDigest: request.optionsDigest,
        expiresAt: request.expiresAt,
        revision: request.revision,
        optionId: "once-17",
      };
      const decide = (body = decision) =>
        f.request(
          handle,
          `/api/bots/fixture/permissions/${encodeURIComponent(request.interactionId)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tidy-client-contract": "2",
              "x-tidy-binding-revision": binding.bindingRevision,
            },
            body: JSON.stringify(body),
          }
        );
      assert.equal(
        (await decide({ ...decision, revision: "wrong" })).status,
        409
      );
      assert.equal((await decide()).status, 202);
      const receipt = await waitFor(
        () => f.inspect(handle, decision.operationId),
        (v) => v.execution === "ended"
      );
      assert.deepEqual(receipt.result, { status: "applied" });
      await waitFor(
        () => events.filter((e) => e.entry?.permissionResolved),
        (v) => v.length === 1
      );
      assert.deepEqual((await decide()).body, receipt);
      assert.equal(
        (await decide({ ...decision, optionId: "deny-17" })).status,
        409
      );
      assert.equal(
        (await f.inspect(handle, "permission-target")).execution,
        "ended"
      );
      assert.equal(
        (await f.calls(binding)).filter(
          (c) => c.method === "interaction.respond"
        ).length,
        1
      );
      assert.equal(events.filter((e) => e.entry?.permissionResolved).length, 1);
      assert.equal(events.filter((e) => e.entry?.role === "user").length, 1);
    } finally {
      ws.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("hard gateway crash recovers expired ownership without repeating native admission", async () => {
  const f = await fixture();
  const readyPath = join(f.dir, "ready.json");
  const source = new URL("../src/daemon.ts", import.meta.url).href;
  const driver = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import {startFleet} from ${JSON.stringify(source)}; import {writeFileSync} from 'node:fs'; const h=await startFleet({dir:${JSON.stringify(f.dir)},port:0,token:'disposable-test-token',log:()=>{}}); writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({url:h.url,port:h.port}));`,
    ],
    { stdio: "ignore" }
  );
  try {
    const running = (await waitFor(
      async () => {
        try {
          return JSON.parse(await readFile(readyPath, "utf8"));
        } catch {
          return null;
        }
      },
      Boolean,
      "child gateway readiness"
    )) as FleetHandle;
    const binding = await f.binding(running);
    assert.equal(
      (await f.submit(running, binding, "parent-crash", "[hold]")).status,
      202
    );
    await waitFor(
      () => f.inspect(running, "parent-crash"),
      (value) => value.execution === "running"
    );
    const childExit = new Promise<void>((resolve) =>
      driver.once("exit", () => resolve())
    );
    driver.kill("SIGKILL");
    await childExit;
    const journal = new GatewayJournal(join(f.dir, ".fleet/gateway.sqlite"));
    const previous = journal.getWriterState()!;
    assert.equal(previous.reconciled, false);
    assert.ok(
      journal
        .getSupervisorRecord()!
        .launches.some((launch) => launch.state === "started")
    );
    journal.close();
    await assert.rejects(f.start(), { code: "writer_busy" });
    // Lease expiry is necessary but not sufficient: startup also checks the old
    // controller and every recorded owned group. This uses the real TTL.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, previous.expiresAt - Date.now()) + 10)
    );
    const restarted = await f.start();
    const receipt = await f.inspect(restarted, "parent-crash");
    assert.equal(receipt.delivery, "accepted");
    assert.equal(receipt.execution, "unknown");
    assert.equal(receipt.observation, "reconciliation_required");
    const calls = await f.calls(binding);
    assert.equal(
      calls.filter((call) => call.method === "operation.submit").length,
      1
    );
    assert.equal(
      calls.filter((call) => call.method === "session.open").length,
      1
    );
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) {
      const childExit = new Promise<void>((resolve) =>
        driver.once("exit", () => resolve())
      );
      driver.kill("SIGKILL");
      await childExit;
    }
    await f.cleanup();
  }
});

test("established binding refuses erased plugin storage before starting a replacement", async () => {
  const f = await fixture();
  try {
    const handle = await f.start();
    const binding = await f.binding(handle);
    await handle.stop();
    const dataDir = join(f.dir, ".fleet/plugins", binding.bindingId);
    await rm(dataDir, { recursive: true });
    await assert.rejects(f.start(), { code: "corrupt_storage" });
    await assert.rejects(readFile(join(dataDir, "calls.jsonl")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(dataDir, ".gateway-namespace.json")), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("real startFleet gateway advertises only implemented capabilities and requires HTTP/WS auth and contract revision", async () => {
  const f = await fixture();
  try {
    const handle = await f.start(),
      binding = await f.binding(handle);
    assert.ok(handle.port && handle.port > 0);
    assert.equal((await fetch(handle.url + "/api/fleet")).status, 401);
    assert.equal(
      (await fetch(handle.url + "/api/fleet?token=disposable-test-token"))
        .status,
      401
    );
    const version = await f.request(handle, "/api/version");
    assert.ok(version.body.capabilities.includes("backend-capabilities-v1"));
    assert.ok(version.body.capabilities.includes("operation-receipts-v1"));
    assert.equal(binding.backend.id, "org.example.independent");
    assert.equal(binding.capabilities.configuration.model, false);
    const legacy = await f.request(handle, "/api/bots/fixture/message", {
      method: "POST",
    });
    assert.equal(legacy.status, 426);
    const stale = await f.submit(
      handle,
      { ...binding, bindingRevision: "old" },
      "stale",
      "hello"
    );
    assert.equal(stale.status, 409);
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      0
    );
    const cors = await fetch(handle.url + "/api/bots/fixture/message", {
      method: "OPTIONS",
    });
    assert.equal(cors.status, 204);
    assert.match(
      cors.headers.get("access-control-allow-headers")!,
      /X-Tidy-Binding-Revision/
    );
    const rejected = new WebSocket(
      handle.url.replace("http", "ws") + "/api/ws?token=wrong"
    );
    await new Promise<void>((resolve) => {
      rejected.once("unexpected-response", (_request, response) => {
        assert.equal(response.statusCode, 401);
        response.resume();
        rejected.terminate();
        resolve();
      });
      rejected.on("error", () => {});
    });
  } finally {
    await f.cleanup();
  }
});

test("message admission correlates one canonical entry, complete-text snapshots, deterministic finals, and immutable retries", async () => {
  const f = await fixture();
  try {
    const handle = await f.start(),
      binding = await f.binding(handle),
      { ws, events } = await f.socket(handle);
    const admitted = await f.submit(handle, binding, "message-1", "hello");
    assert.equal(admitted.status, 202);
    assert.equal(admitted.body.delivery, "queued");
    assert.equal(admitted.body.operationId, "message-1");
    const final = await waitFor(
      () => f.inspect(handle, "message-1"),
      (receipt) => receipt.execution === "ended",
      "terminal receipt"
    );
    assert.equal(final.result.taskOutcome, "unknown");
    assert.equal(final.observation, "complete");
    const transcript = (await f.request(handle, "/api/bots/fixture/transcript"))
      .body.transcript;
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].id, admitted.body.userEntryId);
    assert.equal(transcript[0].operationId, "message-1");
    assert.equal(transcript[1].text, "Reply: hello");
    assert.deepEqual(transcript[1].parts, [
      { type: "text", text: "Reply: hello" },
    ]);
    const snapshots = events.filter(
      (event) =>
        event.type === "bubble" && event.phase === "parts" && event.text
    );
    assert.deepEqual(
      snapshots.map((event) => event.text),
      ["Reply", "Reply: hello"]
    );
    assert.equal(
      (await f.submit(handle, binding, "message-1", "hello")).body.userEntryId,
      admitted.body.userEntryId
    );
    const conflict = await f.submit(handle, binding, "message-1", "changed");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "operation_conflict");
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      1
    );
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("same-conversation FIFO and fresh post-hello snapshots survive reconnect without new native submission", async () => {
  const f = await fixture();
  try {
    const handle = await f.start(),
      binding = await f.binding(handle);
    const first = await f.socket(handle);
    await f.submit(handle, binding, "first", "[hold]");
    await waitFor(
      () => first.events,
      (events) =>
        events.some(
          (event) => event.type === "bubble" && event.text === "Reply: [hold]"
        )
    );
    await f.submit(handle, binding, "second", "second");
    assert.equal((await f.inspect(handle, "second")).delivery, "queued");
    const since = Math.max(
      ...first.events.map((event) => Number(event.seq ?? 0))
    );
    first.ws.terminate();
    const next = await f.socket(handle, since);
    const hello = next.events.find((event) => event.type === "hello")!;
    const snapshot = await waitFor(
      () =>
        next.events.find(
          (event) => event.type === "bubble" && event.text === "Reply: [hold]"
        ),
      Boolean
    );
    assert.ok(snapshot!.seq > hello.seq);
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      1
    );
    await writeFile(
      join(f.dir, ".fleet/plugins", binding.bindingId, "release-first"),
      "yes"
    );
    await waitFor(
      () => f.inspect(handle, "second"),
      (receipt) => receipt.execution === "ended"
    );
    assert.deepEqual(
      (await f.calls(binding))
        .filter((call) => call.method === "operation.submit")
        .map((call) => call.operationId),
      ["first", "second"]
    );
    next.ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("interleaved assistant messages retain their started order when finals arrive in reverse order", async () => {
  const f = await fixture();
  try {
    const handle = await f.start(),
      binding = await f.binding(handle);
    await f.submit(handle, binding, "ordered", "[interleaved]");
    await waitFor(
      () => f.inspect(handle, "ordered"),
      (receipt) => receipt.execution === "ended"
    );
    const entries = (await f.request(handle, "/api/bots/fixture/transcript"))
      .body.transcript;
    assert.deepEqual(
      entries.map((entry: ObjectValue) => entry.text),
      ["[interleaved]", "First", "Second"]
    );
    assert.equal(
      new Set(entries.map((entry: ObjectValue) => entry.id)).size,
      3
    );
  } finally {
    await f.cleanup();
  }
});

test("auth-required initialization does not reserve or create a native session", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.dir, "bots.toml"),
      f.manifest + '[bot.backend_config]\nhealth = "auth_required"\n'
    );
    const handle = await f.start(),
      binding = await f.binding(handle);
    assert.equal(
      (await f.calls(binding)).filter((call) => call.method === "session.open")
        .length,
      0
    );
    assert.equal(
      (await f.submit(handle, binding, "no-auth", "hello")).status,
      503
    );
    assert.equal(
      (await f.request(handle, "/api/fleet")).body.bots[0].gatewayStatus,
      "auth_required"
    );
  } finally {
    await f.cleanup();
  }
});

test("shutdown preserves queued messages without making another native reservation", async () => {
  const f = await fixture();
  try {
    let handle = await f.start();
    const binding = await f.binding(handle);
    await f.submit(handle, binding, "active", "[hold]");
    await waitFor(
      () => f.inspect(handle, "active"),
      (receipt) => receipt.execution === "running"
    );
    await f.submit(handle, binding, "waiting", "queued");
    await handle.stop();
    handle = await f.start();
    assert.equal((await f.inspect(handle, "waiting")).delivery, "queued");
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

for (const prompt of ["[unknown]", "[exit-after-native]"]) {
  test(`ambiguous ${prompt} is retained across daemon restart and never resent`, async () => {
    const f = await fixture();
    try {
      let handle = await f.start();
      const binding = await f.binding(handle);
      const admitted = await f.submit(handle, binding, "unknown-1", prompt);
      await waitFor(
        () => f.inspect(handle, "unknown-1"),
        (receipt) => receipt.delivery === "unknown"
      );
      assert.equal(
        (await f.submit(handle, binding, "unknown-1", prompt)).body.operationId,
        "unknown-1"
      );
      await handle.stop();
      handle = await f.start();
      const restarted = await f.binding(handle);
      assert.deepEqual(restarted, binding);
      const receipt = await f.inspect(handle, "unknown-1");
      assert.equal(receipt.delivery, "unknown");
      assert.equal(receipt.userEntryId, admitted.body.userEntryId);
      assert.equal(
        (await f.request(handle, "/api/bots/fixture/transcript")).body
          .transcript.length,
        1
      );
      assert.equal(
        (await f.calls(binding)).filter(
          (call) => call.method === "operation.submit"
        ).length,
        1
      );
      assert.equal(
        (await f.calls(binding)).filter(
          (call) => call.method === "session.open"
        ).length,
        1
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("unsupported media and complete encoded frame overflow are rejected before any receipt or native dispatch", async () => {
  const f = await fixture();
  try {
    const handle = await f.start(),
      binding = await f.binding(handle);
    const media = await f.submit(handle, binding, "media", "with image", {
      images: [{ mediaType: "image/png", data: "AAAA" }],
    });
    assert.equal(media.status, 422);
    const overhead = Buffer.byteLength(
      JSON.stringify({
        operationId: "large",
        clientMessageId: "large",
        conversationId: binding.conversationId,
        text: "",
      })
    );
    // HTTP itself fits; the larger plugin envelope (binding, turn, digest,
    // policy, RPC ID and LF) must still be rejected before durable admission.
    const oversized = await f.submit(
      handle,
      binding,
      "large",
      '"'.repeat(Math.floor((1024 * 1024 - overhead) / 2) - 10)
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (await f.request(handle, "/api/bots/fixture/transcript")).body.transcript
        .length,
      0
    );
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      0
    );
  } finally {
    await f.cleanup();
  }
});

test("backend config cannot fall through to legacy execution or silently accept Pi-only keys", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.dir, "bots.toml"),
      '[[bot]]\nname = "fixture"\nbackend = "org.example.independent"\n'
    );
    assert.throws(() => loadFleetConfig(f.dir), /requires \[gateway\]/);
    await writeFile(
      join(f.dir, "bots.toml"),
      f.manifest + 'model = "opaque-model"\n'
    );
    assert.throws(() => loadFleetConfig(f.dir), /legacy Pi key/);
    await writeFile(
      join(f.dir, "bots.toml"),
      f.manifest + "[bot.backend_config]\nunknown = true\n"
    );
    await assert.rejects(f.start(), { code: "invalid_config" });
  } finally {
    await f.cleanup();
  }
});

test("the shipped CLI selects the neutral gateway and awaits journal shutdown before immediate restart", async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  const launch = async (): Promise<FleetHandle> => {
    await mkdir(join(f.dir, "home"), { recursive: true });
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../bin/pi-tidy-bots.mjs", import.meta.url)),
        "start",
        f.dir,
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--json",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(f.dir, "home"),
          PI_TIDY_BOTS_REGISTRY: join(f.dir, "fleets.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "",
      errors = "";
    child.stdout!.on("data", (data) => {
      output += data;
    });
    child.stderr!.on("data", (data) => {
      errors += data;
    });
    const readiness = await waitFor<ObjectValue | undefined>(
      () => {
        if (child!.exitCode !== null)
          throw new Error(`CLI exited before readiness: ${errors}`);
        return output
          .split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .find((value) => value.url);
      },
      Boolean,
      "CLI gateway readiness"
    );
    assert.equal(
      typeof readiness!.token,
      "string",
      "gateway CLI mints authentication on loopback"
    );
    assert.equal(
      (await readFile(join(f.dir, ".fleet/token"), "utf8")).trim(),
      readiness!.token
    );
    f.setToken(readiness!.token);
    return { url: readiness!.url } as FleetHandle;
  };
  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const stopped = new Promise<void>((resolve) =>
      current.once("exit", () => resolve())
    );
    current.kill("SIGTERM");
    await stopped;
  };
  try {
    let handle = await launch();
    const { probeDaemonIdentity } = await import("../src/cli-core.ts");
    assert.deepEqual(
      await probeDaemonIdentity(
        Number(new URL(handle.url).port),
        f.dir,
        undefined,
        (await readFile(join(f.dir, ".fleet/token"), "utf8")).trim()
      ),
      { kind: "match", fleetDir: f.dir },
      "lifecycle commands can identify this authenticated gateway before signalling it"
    );
    const binding = await f.binding(handle);
    const admitted = await f.submit(
      handle,
      binding,
      "cli-message",
      "through the bin"
    );
    assert.equal(admitted.status, 202);
    await waitFor(
      () => f.inspect(handle, "cli-message"),
      (receipt) => receipt.execution === "ended"
    );
    await stopChild();
    handle = await launch();
    assert.deepEqual(await f.binding(handle), binding);
    assert.equal((await f.inspect(handle, "cli-message")).execution, "ended");
    assert.equal(
      (await f.calls(binding)).filter(
        (call) => call.method === "operation.submit"
      ).length,
      1
    );
  } finally {
    await stopChild();
    await f.cleanup();
  }
});
