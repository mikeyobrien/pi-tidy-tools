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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { digestArtifact } from "../src/gateway/registry.ts";
import { DEFAULT_LIMITS } from "../src/gateway/protocol.ts";
import { acquireFleetLock } from "../src/lock.ts";

const token = "gateway-server-safety-token";
const headers = { authorization: `Bearer ${token}` };
async function fixture(
  delayInitialize = false,
  delayShutdown = false,
  failInitialize = false
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
  ready: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 5_000;
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
