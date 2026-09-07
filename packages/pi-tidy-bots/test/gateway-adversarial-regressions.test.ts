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
import { digestArtifact } from "../src/gateway/registry.ts";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { WebSocket } from "ws";

type Obj = Record<string, any>;
const token = "adversarial-test-token";

async function waitFor<T>(
  probe: () => Promise<T>,
  ok: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for fixture state");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function fixture(
  permissions = false,
  initialBackend = "org.example.independent"
) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-gateway-adversarial-"));
  const artifact = join(dir, "plugin");
  const alternate = join(dir, "plugin-alt");
  const alternateMarker = join(dir, "alternate-started");
  await mkdir(artifact);
  await mkdir(alternate);
  await writeFile(
    join(dir, "AGENTS.md"),
    "Disposable test fixture; no native provider.\n"
  );
  const source = fileURLToPath(
    new URL("./fixtures/gateway-application/backend.mjs", import.meta.url)
  );
  await copyFile(source, join(artifact, "backend.mjs"));
  await chmod(join(artifact, "backend.mjs"), 0o755);
  await copyFile(source, join(alternate, "backend.mjs"));
  await chmod(join(alternate, "backend.mjs"), 0o755);
  const alternateSource = (
    await readFile(join(alternate, "backend.mjs"), "utf8")
  ).replace(
    "const dir = process.env.TIDY_DATA_DIR;",
    `const dir = process.env.TIDY_DATA_DIR; writeFileSync(${JSON.stringify(alternateMarker)}, "started\\n");`
  );
  await writeFile(join(alternate, "backend.mjs"), alternateSource);
  const backend = {
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
  };
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
    join(alternate, "backend.json"),
    JSON.stringify({ ...backend, id: "org.example.alternate" })
  );
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      type: "object",
      properties: { permissions: { type: "boolean" } },
      additionalProperties: false,
    })
  );
  await copyFile(
    join(artifact, "config.schema.json"),
    join(alternate, "config.schema.json")
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
        {
          id: "org.example.alternate",
          version: "1.0.0",
          artifactPath: alternate,
          sha256: await digestArtifact(alternate),
          enabled: true,
        },
      ],
    })
  );
  const base = (backendId = "org.example.independent") =>
    `[gateway]\nregistry = "registry.json"\nenvironment = ["PATH"]\n[[bot]]\nname = "fixture"\ndir = "."\nbackend = "${backendId}"\n`;
  const manifest = (backendId = "org.example.independent") =>
    base(backendId) +
    (permissions ? "[bot.backend_config]\npermissions = true\n" : "");
  await writeFile(join(dir, "bots.toml"), manifest(initialBackend));
  const handles: FleetHandle[] = [];
  const start = async () => {
    const h = await startFleet({ dir, port: 0, token, log: () => {} });
    handles.push(h);
    return h;
  };
  const request = async (
    h: FleetHandle,
    path: string,
    options: RequestInit = {}
  ) => {
    const response = await fetch(h.url + path, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
    });
    return { status: response.status, body: (await response.json()) as Obj };
  };
  const binding = async (h: FleetHandle) =>
    (await request(h, "/api/bots/fixture/capabilities")).body;
  const calls = async (b: Obj) =>
    (
      await readFile(
        join(dir, ".fleet/plugins", b.bindingId, "calls.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Obj);
  const alternateStarted = async () => {
    try {
      return (await readFile(alternateMarker, "utf8")) === "started\n";
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const stop = async () => {
    while (handles.length) await handles.pop()!.stop();
  };
  return {
    dir,
    manifest,
    start,
    request,
    binding,
    calls,
    alternateStarted,
    stop,
    cleanup: async () => {
      await stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("concurrent permission retries collapse to one response and reject the competing choice", async () => {
  const f = await fixture(true);
  try {
    const h = await f.start(),
      b = await f.binding(h);
    const ws = new WebSocket(
      `${h.url.replace("http", "ws")}/api/ws?token=${token}`
    );
    const events: Obj[] = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await f.request(h, "/api/bots/fixture/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tidy-client-contract": "2",
        "x-tidy-binding-revision": b.bindingRevision,
      },
      body: JSON.stringify({
        operationId: "target",
        clientMessageId: "target",
        conversationId: b.conversationId,
        text: "[permission]",
      }),
    });
    const q = (await waitFor(
      async () => events.find((e) => e.entry?.permission)?.entry.permission,
      Boolean
    )) as Obj;
    const base = {
      kind: "permission",
      operationId: "decision",
      conversationId: b.conversationId,
      bindingId: q.bindingId,
      instanceId: q.instanceId,
      targetOperationId: q.operationId,
      turnId: q.turnId,
      interactionId: q.interactionId,
      optionsDigest: q.optionsDigest,
      expiresAt: q.expiresAt,
      revision: q.revision,
      optionId: "once-17",
    };
    const post = (body: Obj) =>
      f.request(
        h,
        `/api/bots/fixture/permissions/${encodeURIComponent(q.interactionId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tidy-client-contract": "2",
            "x-tidy-binding-revision": b.bindingRevision,
          },
          body: JSON.stringify(body),
        }
      );
    const [one, two] = await Promise.all([
      post(base),
      post({ ...base, optionId: "deny-17" }),
    ]);
    assert.deepEqual([one.status, two.status].sort(), [202, 409]);
    const receipt = await waitFor(
      async () =>
        (await f.request(h, "/api/bots/fixture/operations/decision")).body,
      (value) => value.execution === "ended"
    );
    assert.deepEqual(receipt.result, { status: "applied" });
    assert.equal(
      (await f.calls(b)).filter((c) => c.method === "interaction.respond")
        .length,
      1
    );
    ws.close();
  } finally {
    await f.cleanup();
  }
});

test("alternate launch marker is observable in a valid control startup", async () => {
  const f = await fixture(false, "org.example.alternate");
  try {
    const h = await f.start();
    await f.binding(h);
    assert.equal(await f.alternateStarted(), true);
  } finally {
    await f.cleanup();
  }
});

test("concurrent identical permission retries return one canonical receipt", async () => {
  const f = await fixture(true);
  try {
    const h = await f.start(),
      b = await f.binding(h);
    const ws = new WebSocket(
      `${h.url.replace("http", "ws")}/api/ws?token=${token}`
    );
    const events: Obj[] = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await f.request(h, "/api/bots/fixture/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tidy-client-contract": "2",
        "x-tidy-binding-revision": b.bindingRevision,
      },
      body: JSON.stringify({
        operationId: "target",
        clientMessageId: "target",
        conversationId: b.conversationId,
        text: "[permission]",
      }),
    });
    const q = (await waitFor(
      async () => events.find((e) => e.entry?.permission)?.entry.permission,
      Boolean
    )) as Obj;
    const decision = {
      kind: "permission",
      operationId: "decision",
      conversationId: b.conversationId,
      bindingId: q.bindingId,
      instanceId: q.instanceId,
      targetOperationId: q.operationId,
      turnId: q.turnId,
      interactionId: q.interactionId,
      optionsDigest: q.optionsDigest,
      expiresAt: q.expiresAt,
      revision: q.revision,
      optionId: "once-17",
    };
    const post = () =>
      f.request(
        h,
        `/api/bots/fixture/permissions/${encodeURIComponent(q.interactionId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tidy-client-contract": "2",
            "x-tidy-binding-revision": b.bindingRevision,
          },
          body: JSON.stringify(decision),
        }
      );
    const [one, two] = await Promise.all([post(), post()]);
    assert.deepEqual([one.status, two.status].sort(), [202, 202]);
    const receipt = await waitFor(
      async () =>
        (await f.request(h, "/api/bots/fixture/operations/decision")).body,
      (value) => value.execution === "ended"
    );
    assert.deepEqual(one.body.receipt, two.body.receipt);
    assert.deepEqual(receipt.result, { status: "applied" });
    assert.equal(
      (await f.calls(b)).filter((c) => c.method === "interaction.respond")
        .length,
      1
    );
    ws.close();
  } finally {
    await f.cleanup();
  }
});

test("active and queued work remain pinned when a replacement backend policy is refused", async () => {
  const f = await fixture();
  try {
    let h = await f.start(),
      b = await f.binding(h);
    const originalBinding = { ...b };
    const submit = (operationId: string, text: string) =>
      f.request(h, "/api/bots/fixture/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": b.bindingRevision,
        },
        body: JSON.stringify({
          operationId,
          clientMessageId: operationId,
          conversationId: b.conversationId,
          text,
        }),
      });
    await submit("active", "[hold]");
    await waitFor(
      async () =>
        (await f.request(h, "/api/bots/fixture/operations/active")).body,
      (v) => v.execution === "running"
    );
    await submit("queued", "queued behind active");
    assert.equal(
      (await f.request(h, "/api/bots/fixture/operations/queued")).body.delivery,
      "queued"
    );
    await h.stop();
    await writeFile(
      join(f.dir, "bots.toml"),
      f.manifest("org.example.alternate")
    );
    await assert.rejects(
      f.start(),
      (error: any) => error?.code === "binding_conflict"
    );
    assert.equal(await f.alternateStarted(), false);
    await writeFile(join(f.dir, "bots.toml"), f.manifest());
    h = await f.start();
    b = await f.binding(h);
    assert.equal(b.bindingId, originalBinding.bindingId);
    assert.equal(b.conversationId, originalBinding.conversationId);
    assert.equal(
      (await f.request(h, "/api/bots/fixture/operations/active")).body
        .observation,
      "reconciliation_required"
    );
    assert.equal(
      (await f.request(h, "/api/bots/fixture/operations/queued")).body.delivery,
      "queued"
    );
    assert.equal(
      (await f.calls(b)).filter((c) => c.method === "operation.submit").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});
