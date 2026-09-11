import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";
import { processIdentity } from "../src/gateway/process-ownership.ts";
import { digestArtifact } from "../src/gateway/registry.ts";
import { DEFAULT_LIMITS } from "../src/gateway/protocol.ts";
import { acquireFleetLock } from "../src/lock.ts";

const token = "gateway-server-safety-token";
const headers = { authorization: `Bearer ${token}` };
async function fixture(
  delayInitialize = false,
  delayShutdown = false,
  failInitialize = false,
  slowReaderFlood = false
) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-gateway-server-safety-"));
  const artifact = join(dir, "plugin");
  await mkdir(artifact);
  await writeFile(
    join(dir, "AGENTS.md"),
    "Disposable fixture; no native model calls.\n"
  );
  let script = await readFile(
    new URL("./fixtures/gateway-application/backend.mjs", import.meta.url),
    "utf8"
  );
  if (failInitialize)
    script = script.replace(
      "version: p.expectedPlugin.version",
      'version: "invalid"'
    );
  if (delayInitialize)
    script = script.replace(
      "const input = createInterface",
      "await new Promise((resolve) => setTimeout(resolve, 350));\nconst input = createInterface"
    );
  if (delayShutdown)
    script = script.replace(
      'if (message.method === "initialize") {',
      'if (message.method === "shutdown") { record({method: "shutdown-pending", pid: process.pid}); setTimeout(() => { respond(message, {status: "closed"}); process.exit(0); }, 350); return; }\nif (message.method === "initialize") {'
    );
  if (slowReaderFlood)
    script = script.replace(
      "const text = request.input[0].text;",
      `const text = request.input[0].text;
  if (text === "[ws-slow-reader-flood]") {
    event(request, "turn.started", {});
    for (let order = 0; order < 32; order++) {
      const messageId = \`message:\${request.operationId}:\${order}\`;
      let state = order + 1;
      let text = \`\${order}:\`;
      while (text.length < 512_000) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        text += state.toString(36);
      }
      event(request, "message.started", { role: "assistant", order }, { messageId });
      event(request, "text.snapshot", { revision: 1, text }, { messageId, blockId: "body" });
      event(request, "message.finished", { ts: "2026-09-05T12:00:00.000Z", blocks: [{ type: "text", blockId: "body", revision: 1, text }] }, { messageId });
    }
    event(request, "turn.terminal", { execution: "ended", observation: "complete" });
    return;
  }`
    );
  await writeFile(join(artifact, "backend.mjs"), script);
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
      properties: {},
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
  await writeFile(
    join(dir, "bots.toml"),
    '[gateway]\nregistry = "registry.json"\nenvironment = ["PATH"]\n[[bot]]\nname = "fixture"\ndir = "."\nbackend = "org.example.independent"\n'
  );
  const handles: FleetHandle[] = [];
  return {
    dir,
    async start(options: { port?: number; token?: string } = {}) {
      const handle = await startFleet({
        dir,
        port: 0,
        token,
        ...options,
        log: () => {},
      });
      handles.push(handle);
      return handle;
    },
    async cleanup() {
      await Promise.all(handles.map((handle) => handle.stop()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function listener(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener address");
  return { server, port: address.port };
}
async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function eventually<T>(
  probe: () => Promise<T> | T,
  ready: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for server state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function binding(handle: FleetHandle): Promise<Record<string, unknown>> {
  const response = await fetch(`${handle.url}/api/bots/fixture/capabilities`, {
    headers,
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

test("gateway refuses missing loopback credentials before opening storage or spawning a plugin", async () => {
  const f = await fixture();
  try {
    for (const missing of [undefined, "", "   "]) {
      await assert.rejects(
        f.start({ token: missing }),
        /requires a fleet token/
      );
      assert.equal(existsSync(join(f.dir, ".fleet")), false);
    }
  } finally {
    await f.cleanup();
  }
});

test("failed initialization retains shared ownership when durable cleanup cannot be confirmed", async () => {
  const f = await fixture(false, false, true);
  try {
    const script = `import assert from 'node:assert/strict'; import {startFleet} from ${JSON.stringify(new URL("../src/daemon.ts", import.meta.url).href)}; import {GatewayJournal} from ${JSON.stringify(new URL("../src/gateway/journal.ts", import.meta.url).href)}; import {acquireFleetLock} from ${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)}; GatewayJournal.prototype.completeOwnedLaunch=function(){throw new Error('Injected durable cleanup failure')}; await assert.rejects(startFleet({dir:${JSON.stringify(f.dir)},port:0,token:${JSON.stringify(token)},log:()=>{}})); const competing=acquireFleetLock(${JSON.stringify(f.dir)}); if(competing.ok) competing.lock.release(); assert.equal(competing.ok,false,'Startup cleanup failure released the cross-mode ownership guard'); process.exit(0);`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 15_000 }
    );
    assert.equal(child.status, 0, `${child.stderr}\n${child.error ?? ""}`);
  } finally {
    await f.cleanup();
  }
});

test("unexpired writer lease preflight releases the lock without heartbeat resurrection", async () => {
  const f = await fixture();
  const seed = new GatewayJournal(join(f.dir, ".fleet", "gateway.sqlite"));
  try {
    seed.acquireWriterLease("gateway-previous", {
      ownerProcess: await processIdentity(process.pid),
    });
  } finally {
    seed.close();
  }
  try {
    await assert.rejects(f.start(), { code: "writer_busy" });
    const lockPath = join(f.dir, ".fleet", "lock.json");
    assert.equal(existsSync(lockPath), false, "preflight never owned a plugin");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(
      existsSync(lockPath),
      false,
      "failed starter must not resurrect its lock"
    );
    const next = acquireFleetLock(f.dir);
    assert.ok(next.ok, "preflight releases the shared guard immediately");
    if (next.ok) next.lock.release();
  } finally {
    await f.cleanup();
  }
});

test("failed startup ownership leaves a frozen heartbeat, not a live one", async () => {
  // An expired lease with a still-live previous controller is genuinely
  // unconfirmed recovery, unlike the safe unexpired-lease preflight above.
  // Retain the file guard but stop the failed starter's heartbeat.
  const f = await fixture();
  const previousController = spawn(process.execPath, [
    "-e",
    "setInterval(()=>{},1<<30)",
  ]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const seed = new GatewayJournal(join(f.dir, ".fleet", "gateway.sqlite"));
    const lease = seed.acquireWriterLease("gateway-previous", {
      ownerProcess: await processIdentity(previousController.pid!),
      ttlMs: 1,
    });
    seed.close();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, lease.expiresAt - Date.now()) + 10)
    );
    await assert.rejects(
      f.start(),
      { code: "ownership_unreconciled" },
      "lease expiry must not authorize takeover of a live controller"
    );
    const lockPath = join(f.dir, ".fleet", "lock.json");
    const frozen = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(
      frozen.pid,
      process.pid,
      "the failed start owned the file lock in-process"
    );
    const competing = acquireFleetLock(f.dir);
    if (competing.ok) competing.lock.release();
    assert.equal(
      competing.ok,
      false,
      "fresh retained guard still fences competitors"
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const still = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(
      still.heartbeatAt,
      frozen.heartbeatAt,
      "heartbeat must freeze after the failed start instead of beating forever"
    );
    const takeover = acquireFleetLock(f.dir, { staleMs: 1_000 });
    assert.ok(
      takeover.ok,
      "frozen heartbeat must permit takeover after staleness"
    );
    if (takeover.ok) takeover.lock.release();
  } finally {
    previousController.kill("SIGKILL");
    await new Promise((resolve) => previousController.once("exit", resolve));
    await f.cleanup();
  }
});

test("cross-origin requests still require bearer auth even when browser preflight succeeds", async () => {
  const f = await fixture();
  try {
    const handle = await f.start();
    const origin = "https://untrusted.example";
    const preflight = await fetch(`${handle.url}/api/bots/fixture/message`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,x-tidy-client-contract,x-tidy-binding-revision",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      (await fetch(`${handle.url}/api/fleet`, { headers: { origin } })).status,
      401
    );
    assert.equal(
      (
        await fetch(`${handle.url}/api/bots/fixture/message`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401
    );
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/ws`, {
      origin,
    });
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("Unauthenticated WebSocket opened"));
      });
      ws.once("unexpected-response", (_request, response) => {
        assert.equal(response.statusCode, 401);
        response.resume();
        ws.terminate();
        resolve();
      });
    });
  } finally {
    await f.cleanup();
  }
});

test("invalid ports fail before durable native-session admission", async () => {
  const f = await fixture();
  try {
    for (const port of [-1, 65536, 1.5, NaN, Infinity]) {
      await assert.rejects(
        f.start({ port }),
        /Gateway port must be an integer/
      );
      assert.equal(existsSync(join(f.dir, ".fleet")), false);
    }
  } finally {
    await f.cleanup();
  }
});

test("an occupied listener cannot create sessions or poison a later successful startup", async () => {
  const f = await fixture();
  const occupied = await listener();
  try {
    await assert.rejects(
      f.start({ port: occupied.port }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    );
    assert.equal(existsSync(join(f.dir, ".fleet", "gateway.sqlite")), false);
    assert.equal(existsSync(join(f.dir, ".fleet", "plugins")), false);
    assert.equal(existsSync(join(f.dir, ".fleet", "lock.json")), false);
    const afterFailure = acquireFleetLock(f.dir);
    assert.equal(afterFailure.ok, true);
    if (afterFailure.ok) afterFailure.lock.release();
    await close(occupied.server);
    const handle = await f.start({ port: occupied.port });
    const response = await fetch(`${handle.url}/api/fleet`, { headers });
    const roster = (await response.json()) as { bots: { online: boolean }[] };
    assert.equal(roster.bots[0].online, true);
  } finally {
    await close(occupied.server);
    await f.cleanup();
  }
});

test("gateway refuses an existing shared fleet owner before opening its SQLite journal", async () => {
  const f = await fixture();
  const legacyOwnership = acquireFleetLock(f.dir);
  assert.equal(legacyOwnership.ok, true);
  try {
    await assert.rejects(f.start(), /Fleet lock held by pid/);
    assert.equal(existsSync(join(f.dir, ".fleet", "gateway.sqlite")), false);
    assert.equal(existsSync(join(f.dir, ".fleet", "plugins")), false);
    if (legacyOwnership.ok) legacyOwnership.lock.release();
    const handle = await f.start();
    assert.equal(
      (await fetch(`${handle.url}/api/fleet`, { headers })).status,
      200
    );
  } finally {
    if (legacyOwnership.ok) legacyOwnership.lock.release();
    await f.cleanup();
  }
});

test("changing a running gateway fleet to legacy on another port cannot spawn a second runtime", async () => {
  const f = await fixture();
  const priorExceptions = new Set(process.listeners("uncaughtException"));
  const priorRejections = new Set(process.listeners("unhandledRejection"));
  try {
    const handle = await f.start();
    await writeFile(
      join(f.dir, "bots.toml"),
      '[[bot]]\nname = "fixture"\ndir = "."\n'
    );
    // Even if this assertion regresses, the native executable is an absent fixture,
    // never the installed Pi binary or a provider-connected daemon.
    await assert.rejects(async () => {
      const unexpected = await startFleet({
        dir: f.dir,
        port: 0,
        token,
        piBin: join(f.dir, "must-not-spawn-native"),
        log: () => {},
      });
      await unexpected.stop();
    }, /fleet lock held by pid/);
    assert.equal(existsSync(join(f.dir, ".fleet", "sessions")), false);
    assert.equal(
      (await fetch(`${handle.url}/api/fleet`, { headers })).status,
      200
    );
  } finally {
    // The legacy path installs defensive listeners before its ownership check.
    for (const listener of process.listeners("uncaughtException"))
      if (!priorExceptions.has(listener))
        process.removeListener("uncaughtException", listener);
    for (const listener of process.listeners("unhandledRejection"))
      if (!priorRejections.has(listener))
        process.removeListener("unhandledRejection", listener);
    await f.cleanup();
  }
});

test("the shared ownership guard remains held until the plugin process finishes shutdown", async () => {
  const f = await fixture(false, true);
  try {
    const handle = await f.start();
    const descriptor = await binding(handle);
    const callsPath = join(
      f.dir,
      ".fleet",
      "plugins",
      String(descriptor.bindingId),
      "calls.jsonl"
    );
    const stopping = handle.stop();
    const calls = await eventually(
      async () =>
        (await readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      (values) => values.some((value) => value.method === "shutdown-pending")
    );
    const pid = Number(
      calls.find((value) => value.method === "shutdown-pending")!.pid
    );
    assert.doesNotThrow(() => process.kill(pid, 0));
    const duringShutdown = acquireFleetLock(f.dir);
    if (duringShutdown.ok) duringShutdown.lock.release();
    assert.equal(duringShutdown.ok, false);
    await stopping;
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
    );
    const afterShutdown = acquireFleetLock(f.dir);
    assert.equal(afterShutdown.ok, true);
    if (afterShutdown.ok) afterShutdown.lock.release();
  } finally {
    await f.cleanup();
  }
});

test("listener is reserved but answers starting/503 until plugin initialization completes", async () => {
  const f = await fixture(true);
  const available = await listener();
  await close(available.server);
  const pending = f.start({ port: available.port });
  try {
    const response = await eventually(
      async () => {
        try {
          return await fetch(`http://127.0.0.1:${available.port}/api/fleet`, {
            headers,
          });
        } catch {
          return null;
        }
      },
      (result) => result !== null
    );
    assert.equal(response!.status, 503);
    assert.deepEqual(await response!.json(), { error: "gateway_starting" });
    const handle = await pending;
    assert.equal(
      (await fetch(`${handle.url}/api/fleet`, { headers })).status,
      200
    );
  } finally {
    await pending.catch(() => {});
    await f.cleanup();
  }
});

test("a future replay cursor receives hello/reset and resumes newly sequenced live output", async () => {
  const f = await fixture();
  let ws: WebSocket | undefined;
  try {
    const handle = await f.start();
    const descriptor = await binding(handle);
    const events: Record<string, unknown>[] = [];
    ws = new WebSocket(
      `${handle.url.replace("http", "ws")}/api/ws?token=${token}&since=${Number.MAX_SAFE_INTEGER}`
    );
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    await eventually(
      () => events,
      (value) => value.some((event) => event.type === "roster")
    );
    const hello = events.find((event) => event.type === "hello")!;
    assert.equal(hello.replayReset, true);
    assert.equal(typeof hello.bootId, "string");
    assert.ok(
      Number(events.find((event) => event.type === "roster")!.seq) >
        Number(hello.seq)
    );
    const admitted = await fetch(`${handle.url}/api/bots/fixture/message`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "x-tidy-client-contract": "2",
        "x-tidy-binding-revision": String(descriptor.bindingRevision),
      },
      body: JSON.stringify({
        text: "after reset",
        operationId: "after-reset",
        clientMessageId: "after-reset",
        conversationId: descriptor.conversationId,
      }),
    });
    assert.equal(admitted.status, 202);
    await eventually(
      () => events,
      (value) =>
        value.some(
          (event) =>
            event.type === "append" &&
            (event.entry as Record<string, unknown>)?.role === "assistant"
        )
    );
    assert.ok(
      events
        .filter((event) => event.type !== "hello")
        .every((event) => Number(event.seq) > Number(hello.seq))
    );
  } finally {
    ws?.terminate();
    await f.cleanup();
  }
});

test("oversized authenticated bodies return 413 without a durable operation", async () => {
  const f = await fixture();
  try {
    const handle = await f.start();
    const descriptor = await binding(handle);
    const response = await fetch(`${handle.url}/api/bots/fixture/message`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "x-tidy-client-contract": "2",
        "x-tidy-binding-revision": String(descriptor.bindingRevision),
      },
      body: JSON.stringify({
        text: "x".repeat(DEFAULT_LIMITS.maxFrameBytes),
        operationId: "oversized",
        clientMessageId: "oversized",
        conversationId: descriptor.conversationId,
      }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "resource_limit" });
    assert.equal(
      (
        await fetch(`${handle.url}/api/bots/fixture/operations/oversized`, {
          headers,
        })
      ).status,
      404
    );
  } finally {
    await f.cleanup();
  }
});

test("a paused public WebSocket is evicted without stalling healthy delivery or native ingress", async () => {
  const f = await fixture(false, false, false, true);
  let slow: WebSocket | undefined;
  let healthy: WebSocket | undefined;
  try {
    const handle = await f.start();
    const descriptor = await binding(handle);
    const connect = async (
      onMessage?: (data: WebSocket.RawData) => void
    ): Promise<WebSocket> => {
      const socket = new WebSocket(
        `${handle.url.replace("http", "ws")}/api/ws?token=${token}`
      );
      if (onMessage) socket.on("message", onMessage);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
    };
    const slowEvents: Record<string, unknown>[] = [];
    slow = await connect((data) => slowEvents.push(JSON.parse(String(data))));
    const healthyEvents: Record<string, unknown>[] = [];
    healthy = await connect((data) =>
      healthyEvents.push(JSON.parse(String(data)))
    );
    await eventually(
      () => healthyEvents,
      (events) => events.some((event) => event.type === "roster")
    );
    await eventually(
      () => slowEvents,
      (events) => events.some((event) => event.type === "roster")
    );

    // Pause the actual TCP receive side after the WS handshake. The server must
    // observe its own bufferedAmount bound; this does not mock `send` or the
    // gateway's subscriber path.
    const slowSocket = (
      slow as unknown as { _socket?: { pause(): void; resume(): void } }
    )._socket;
    assert.ok(slowSocket, "ws client exposes its live TCP socket");
    slowSocket.pause();
    let slowClosed = false;
    let slowError: Error | undefined;
    let wakeSlowClose: (() => void) | undefined;
    slow.once("close", () => {
      slowClosed = true;
      wakeSlowClose?.();
    });
    slow.once("error", (error) => {
      slowError = error;
      wakeSlowClose?.();
    });

    const admit = async (operationId: string, text: string) => {
      const response = await fetch(`${handle.url}/api/bots/fixture/message`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": String(descriptor.bindingRevision),
        },
        body: JSON.stringify({
          text,
          operationId,
          clientMessageId: operationId,
          conversationId: descriptor.conversationId,
        }),
      });
      assert.equal(response.status, 202);
      return (await response.json()) as Record<string, unknown>;
    };

    await admit("slow-reader-flood", "[ws-slow-reader-flood]");
    await eventually(
      () => healthyEvents,
      (events) =>
        events.filter(
          (event) =>
            event.type === "append" &&
            (event.entry as Record<string, unknown>)?.operationId ===
              "slow-reader-flood" &&
            (event.entry as Record<string, unknown>)?.role === "assistant"
        ).length === 32,
      20_000
    );
    // The independent healthy client has received the entire native flood;
    // now resume only to observe the server's already-issued close frame.
    slowSocket.resume();
    if (!slowClosed && !slowError)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for slow WS eviction")),
          10_000
        );
        wakeSlowClose = () => {
          clearTimeout(timer);
          if (slowError) reject(slowError);
          else resolve();
        };
      });
    if (slowError) throw slowError;
    assert.equal(slowClosed, true, "server evicted the paused WebSocket");

    const after = await admit("after-slow-reader", "native ingress continues");
    const afterEvents = await eventually(
      () => healthyEvents,
      (events) =>
        events.some(
          (event) =>
            event.type === "append" &&
            (event.entry as Record<string, unknown>)?.operationId ===
              after.operationId &&
            (event.entry as Record<string, unknown>)?.role === "assistant"
        )
    );
    const afterEntry = afterEvents.find(
      (event) =>
        event.type === "append" &&
        (event.entry as Record<string, unknown>)?.operationId ===
          after.operationId &&
        (event.entry as Record<string, unknown>)?.role === "assistant"
    )!.entry as Record<string, unknown>;
    assert.equal(afterEntry.operationId, "after-slow-reader");
    assert.equal(typeof afterEntry.turnId, "string");
    assert.ok(String(afterEntry.turnId));
    await eventually(
      () => healthyEvents,
      (events) =>
        events.some(
          (event) =>
            event.type === "bubble" &&
            event.phase === "final" &&
            event.turnId === afterEntry.turnId
        )
    );
    const sequences = healthyEvents
      .filter((event) => event.type !== "hello")
      .map((event) => Number(event.seq));
    assert.equal(new Set(sequences).size, sequences.length);
    assert.ok(
      sequences.every((seq, index) => index === 0 || seq > sequences[index - 1])
    );
    const calls = (
      await readFile(
        join(
          f.dir,
          ".fleet",
          "plugins",
          String(descriptor.bindingId),
          "calls.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "operation.submit" &&
          call.operationId === "after-slow-reader"
      ).length,
      1
    );
  } finally {
    slow?.terminate();
    healthy?.terminate();
    await f.cleanup();
  }
});
