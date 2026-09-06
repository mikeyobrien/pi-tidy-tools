import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginHost,
  type PluginHostOptions,
} from "../src/gateway/plugin-host.ts";
import {
  digestArtifact,
  PluginRegistry,
  type PluginInstallation,
} from "../src/gateway/registry.ts";

const fixturePath = fileURLToPath(
  new URL("./fixtures/gateway-plugin/fake-plugin.mjs", import.meta.url)
);
const manifest = () => ({
  manifestVersion: 1,
  id: "org.example.fixture",
  version: "1.0.0",
  protocol: { major: 1, minMinor: 0, maxMinor: 0 },
  entrypoint: { path: "plugin.mjs", args: [] },
  configSchema: "config.schema.json",
  runtime: { name: "fixture", testedVersion: "1.0.0", transport: "stdio" },
  requestedAccess: {
    workspace: "none",
    nativeProfile: false,
    network: false,
    gatewayTools: [],
  },
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "tidy-plugin-host-"));
  const artifact = join(dir, "artifact");
  await mkdir(artifact);
  await copyFile(fixturePath, join(artifact, "plugin.mjs"));
  await chmod(join(artifact, "plugin.mjs"), 0o755);
  await writeFile(join(artifact, "backend.json"), JSON.stringify(manifest()));
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { mode: { type: "string" } },
      additionalProperties: false,
    })
  );
  const registryPath = join(dir, "registry.json");
  const repin = async (overrides = {}, gatewayTools: string[] = []) => {
    await writeFile(
      registryPath,
      JSON.stringify({
        registryVersion: 1,
        plugins: [
          {
            id: "org.example.fixture",
            version: "1.0.0",
            artifactPath: "artifact",
            sha256: await digestArtifact(artifact),
            enabled: true,
            ...overrides,
          },
        ],
      })
    );
    return (
      await PluginRegistry.load(registryPath, { policy: { gatewayTools } })
    ).resolve("org.example.fixture");
  };
  let installation: PluginInstallation = await repin();
  const start = async (overrides: Partial<PluginHostOptions> = {}) =>
    PluginHost.start({
      installation,
      bindingId: "binding-1",
      leaseGeneration: 7,
      config: {},
      workspace: dir,
      dataDir: join(dir, "data"),
      allowedEnv: { PATH: dirname(process.execPath), ONLY_ALLOWED: "yes" },
      onEvent: async (event) => event.sourceSequence,
      ...overrides,
    });
  return {
    dir,
    artifact,
    registryPath,
    installation,
    repin,
    start,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
async function waitUntil(
  probe: () => Promise<boolean> | boolean
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real executable initializes with pinned identity and only allowed environment, then reaps on close", async () => {
  const fixture = await setup();
  const host = await fixture.start();
  try {
    assert.equal(host.isReady, true);
    assert.equal(host.runtime.name, "fixture");
    assert.equal(host.capabilities.sessions.load, false);
    const result = (await host.request("session.snapshot", {
      bindingId: "forged",
      leaseGeneration: 0,
    })) as { params: Record<string, unknown> };
    assert.equal(result.params.bindingId, "binding-1");
    assert.equal(result.params.leaseGeneration, 7);
    const env = JSON.parse(
      await readFile(join(fixture.dir, "data/environment.json"), "utf8")
    );
    assert.deepEqual(
      Object.keys(env)
        .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
        .sort(),
      [
        "ONLY_ALLOWED",
        "PATH",
        "TIDY_BINDING_ID",
        "TIDY_DATA_DIR",
        "TIDY_INSTANCE_ID",
        "TIDY_LEASE_GENERATION",
        "TIDY_WORKSPACE",
      ].sort()
    );
    assert.equal(env.TIDY_INSTANCE_ID, host.instanceId);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
  assert.equal(host.isReady, false);
  assert.throws(() => process.kill(host.pid!, 0), { code: "ESRCH" });
});

test("allowlisted runtime preload cannot execute before supervisor identity is durably recorded", async () => {
  const fixture = await setup();
  const preload = join(fixture.dir, "preload.cjs");
  const marker = join(fixture.dir, "preload-effect");
  await writeFile(
    preload,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded')`
  );
  const allowedEnv = {
    PATH: dirname(process.execPath),
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  };
  try {
    await assert.rejects(
      fixture.start({
        allowedEnv,
        onLaunchRecorded: async () => {
          await assert.rejects(readFile(marker), { code: "ENOENT" });
          throw new Error("Durable identity write failed");
        },
      }),
      /Durable identity write failed/
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const host = await fixture.start({ allowedEnv });
    assert.equal(await readFile(marker, "utf8"), "loaded");
    await host.close();
  } finally {
    await fixture.cleanup();
  }
});

test("registry refuses disabled, changed, mismatched, escaping and excessive-access artifacts before spawn", async () => {
  const fixture = await setup();
  try {
    await fixture.repin({ enabled: false }).then(
      () => assert.fail("disabled plugin resolved"),
      (error) => assert.equal(error.code, "invalid_config")
    );
    await fixture.repin();
    await writeFile(join(fixture.artifact, "extra.txt"), "tampered");
    await assert.rejects(PluginRegistry.load(fixture.registryPath), {
      code: "invalid_config",
    });
    await assert.rejects(fixture.start(), { code: "invalid_config" });
    await fixture.repin();
    await writeFile(
      join(fixture.artifact, "backend.json"),
      JSON.stringify({ ...manifest(), version: "2.0.0" })
    );
    await assert.rejects(fixture.repin(), { code: "invalid_config" });
    await writeFile(
      join(fixture.artifact, "backend.json"),
      JSON.stringify({
        ...manifest(),
        entrypoint: { path: "../outside", args: [] },
      })
    );
    await writeFile(join(fixture.dir, "outside"), "untrusted");
    await assert.rejects(fixture.repin(), { code: "invalid_config" });
    await writeFile(
      join(fixture.artifact, "backend.json"),
      JSON.stringify({
        ...manifest(),
        requestedAccess: { ...manifest().requestedAccess, network: true },
      })
    );
    await assert.rejects(fixture.repin(), { code: "invalid_config" });
    await symlink(
      join(fixture.dir, "outside"),
      join(fixture.artifact, "escape")
    );
    await assert.rejects(digestArtifact(fixture.artifact), {
      code: "invalid_config",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("configuration schema rejects unknown keys and external references before launching executable", async () => {
  const fixture = await setup();
  try {
    await assert.rejects(fixture.start({ config: { unknown: true } }), {
      code: "invalid_config",
    });
    await assert.rejects(readFile(join(fixture.dir, "data/environment.json")), {
      code: "ENOENT",
    });
    await writeFile(
      join(fixture.artifact, "config.schema.json"),
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: { value: { $ref: "https://example.invalid/schema" } },
      })
    );
    await assert.rejects(fixture.repin(), { code: "invalid_config" });
  } finally {
    await fixture.cleanup();
  }
});

for (const mode of [
  "bad-identity",
  "missing-method",
  "untruthful-dedupe",
  "preinitialize-event",
  "initialize-hang",
]) {
  test(`initialization refuses ${mode} and reaps the process`, async () => {
    const fixture = await setup();
    try {
      await assert.rejects(
        fixture.start({
          config: { mode },
          limits: { initializeTimeoutMs: 100 },
        })
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

test("subscribes before initialization; immediate event is persisted before acknowledgement", async () => {
  const fixture = await setup();
  let committed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await fixture.start({
    config: { mode: "immediate-event" },
    onEvent: async () => {
      await gate;
      committed = true;
      return 1;
    },
  });
  try {
    assert.equal(host.acknowledgedSequence, 0);
    const first = (await host.request("health")) as { ack: number };
    assert.equal(first.ack, 0);
    assert.equal(committed, false);
    release();
    await waitUntil(() => host.acknowledgedSequence === 1);
    const after = (await host.request("health")) as { ack: number };
    assert.equal(after.ack, 1);
  } finally {
    release();
    await host.close();
    await fixture.cleanup();
  }
});

test("commit failure never acknowledges discarded events and isolates only that plugin", async () => {
  const first = await setup(),
    second = await setup();
  const healthy = await second.start();
  const broken = await first.start({
    onEvent: async () => {
      throw new Error("disk full");
    },
  });
  try {
    await broken.request("fixture.events", { sequences: [1] }).catch(() => {});
    await broken.closed;
    assert.equal(broken.acknowledgedSequence, 0);
    assert.equal(broken.diagnostics.code, "event_commit_failed");
    assert.equal(
      ((await healthy.request("health")) as { method: string }).method,
      "health"
    );
  } finally {
    await broken.close();
    await healthy.close();
    await first.cleanup();
    await second.cleanup();
  }
});

test("duplicates and out-of-order events only advance acknowledgements by durable contiguous watermark", async () => {
  const fixture = await setup();
  const stored = new Set<number>();
  let contiguous = 0;
  const host = await fixture.start({
    onEvent: async (event) => {
      stored.add(event.sourceSequence);
      while (stored.has(contiguous + 1)) contiguous++;
      return contiguous;
    },
  });
  try {
    await host.request("fixture.events", { sequences: [2, 1, 1, 3] });
    await waitUntil(() => host.acknowledgedSequence === 3);
    assert.deepEqual([...stored].sort(), [1, 2, 3]);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

for (const method of [
  "fixture.numeric-id",
  "fixture.garbage",
  "fixture.oversize",
  "fixture.stale",
]) {
  test(`${method} is isolated and its in-flight request remains failed, never successful`, async () => {
    const fixture = await setup();
    const host = await fixture.start({ limits: { maxFrameBytes: 4096 } });
    try {
      await assert.rejects(host.request(method));
      await host.closed;
      assert.equal(host.isReady, false);
      assert.equal(host.acknowledgedSequence, 0);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });
}

test("pending/deadline/frame limits reject locally without blind retries", async () => {
  const fixture = await setup();
  const host = await fixture.start({
    limits: { maxFrameBytes: 4096, maxPendingRequests: 1 },
  });
  try {
    const pending = host.request("fixture.hang", {}, { timeoutMs: 100 });
    const rejection = assert.rejects(pending, { code: "request_timeout" });
    await assert.rejects(host.request("health"), { code: "resource_limit" });
    await rejection;
    assert.throws(
      () =>
        host.assertSubmitFits({
          input: [{ type: "text", text: "🙂".repeat(5000) }],
        }),
      { code: "resource_limit" }
    );
    host.assertSubmitFits({ input: [{ type: "text", text: "hello" }] });
    await assert.rejects(
      host.request("operation.submit", {
        input: [{ type: "text", text: "🙂".repeat(5000) }],
      }),
      { code: "resource_limit" }
    );
    await assert.rejects(host.request("session.compact"), {
      code: "capability_unavailable",
    });
    await host.request("health");
    const lines = (
      await readFile(join(fixture.dir, "data/calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      lines.filter((line) => line.method === "fixture.hang").length,
      1
    );
    assert.equal(
      lines.filter((line) => line.method === "operation.submit").length,
      0
    );
    assert.equal(
      lines.filter((line) => line.method === "session.compact").length,
      0
    );
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

test("unacknowledged event credits stay bounded even when commits report a sequence gap", async () => {
  const fixture = await setup();
  const host = await fixture.start({
    limits: { maxUnacknowledgedEvents: 2 },
    onEvent: async () => 0,
  });
  try {
    await host
      .request("fixture.events", { sequences: [2, 3, 4] })
      .catch(() => {});
    await host.closed;
    assert.equal(host.diagnostics.code, "resource_limit");
    assert.equal(host.acknowledgedSequence, 0);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

test("stderr is counted without disclosing contents; ungranted reverse calls cannot reach host services", async () => {
  const fixture = await setup();
  let invoked = false;
  const host = await fixture.start({
    onHostCall: async () => {
      invoked = true;
      return {};
    },
  });
  try {
    await host.request("fixture.stderr");
    await waitUntil(() => host.diagnostics.stderrBytes > 0);
    assert.doesNotMatch(JSON.stringify(host.diagnostics), /very-secret-value/);
    await host.request("fixture.host-call");
    await host.request("health");
    assert.equal(invoked, false);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

test("supervisor reaps owned descendants when parent exits while they hold protocol pipes open", async () => {
  const fixture = await setup();
  const host = await fixture.start();
  try {
    const { childPid } = (await host.request("fixture.exit-with-child")) as {
      childPid: number;
    };
    await Promise.race([
      host.closed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Supervisor did not close after parent exit")),
          3000
        );
        timer.unref();
      }),
    ]);
    await waitUntil(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(host.isReady, false);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

test("event byte budget is released after durable commit instead of accumulating over a session", async () => {
  const fixture = await setup();
  const host = await fixture.start({ limits: { maxSpoolBytes: 2048 } });
  try {
    for (let sequence = 1; sequence <= 20; sequence++) {
      await host.request("fixture.events", { sequences: [sequence] });
      await waitUntil(() => host.acknowledgedSequence === sequence);
    }
    assert.equal(host.isReady, true);
  } finally {
    await host.close();
    await fixture.cleanup();
  }
});

test("close drains already-entered durable callbacks before storage may be closed", async () => {
  const fixture = await setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const host = await fixture.start({
    onEvent: async (event) => {
      entered();
      await gate;
      return event.sourceSequence;
    },
  });
  try {
    await host.request("fixture.events", { sequences: [1] });
    await enteredGate;
    let settled = false;
    const closing = host.close().then(() => {
      settled = true;
    });
    await waitUntil(() => {
      try {
        process.kill(host.pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(settled, false);
    release();
    await closing;
    assert.equal(settled, true);
  } finally {
    release();
    await host.close();
    await fixture.cleanup();
  }
});

test("close drains an admitted reverse host service before storage may be closed", async () => {
  const fixture = await setup();
  const accessManifest = manifest();
  await writeFile(
    join(fixture.artifact, "backend.json"),
    JSON.stringify({
      ...accessManifest,
      requestedAccess: {
        ...accessManifest.requestedAccess,
        gatewayTools: ["artifact.read"],
      },
    })
  );
  const installation = await fixture.repin({}, ["artifact.read"]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const host = await fixture.start({
    installation,
    onHostCall: async (call) => {
      assert.equal(call.name, "artifact.read");
      entered();
      await gate;
      return { data: "fixture" };
    },
  });
  try {
    await host.request("fixture.host-call", { name: "artifact.read" });
    await enteredGate;
    let settled = false;
    const closing = host.close().then(() => {
      settled = true;
    });
    await waitUntil(() => {
      try {
        process.kill(host.pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(settled, false);
    release();
    await closing;
    assert.equal(settled, true);
  } finally {
    release();
    await host.close();
    await fixture.cleanup();
  }
});
