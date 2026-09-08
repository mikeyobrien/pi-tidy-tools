import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { WebSocket } from "ws";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry, digestArtifact } from "../src/gateway/registry.ts";
import { PluginHost } from "../src/gateway/plugin-host.ts";
import type { GatewayPluginEvent } from "../src/gateway/protocol.ts";
import { runLocalConformance } from "../src/conformance.ts";

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/codex-native/app-server.mjs", import.meta.url)
);

async function until(probe: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, "codex fixture observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup(
  artifact = fileURLToPath(new URL("../backends/codex", import.meta.url)),
  extras: { lieHome?: boolean } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-codex-adapter-"));
  const home = join(dir, "home"),
    profile = join(dir, "profile");
  await mkdir(home);
  await mkdir(profile);
  if (extras.lieHome) await writeFile(join(home, "lie-home"), "1\n");
  const executable = join(dir, "codex-fixture");
  await copyFile(fixtureExecutable, executable);
  await chmod(executable, 0o755);
  const registry = join(dir, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "tidy.codex",
          version: "0.1.0-dev",
          artifactPath: artifact,
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
      ],
    })
  );
  const installation = (
    await PluginRegistry.load(registry, {
      policy: {
        workspace: "read-write",
        nativeProfile: true,
        network: true,
        gatewayTools: [],
      },
    })
  ).resolve("tidy.codex");
  const events: GatewayPluginEvent[] = [];
  const host = await PluginHost.start({
    installation,
    bindingId: "codex-binding",
    leaseGeneration: 1,
    workspace: dir,
    dataDir: join(dir, "data"),
    allowedEnv: { PATH: dirname(process.execPath) },
    config: {
      executable,
      home_dir: home,
      profile_dir: profile,
      environment_keys: ["PATH"],
    },
    onEvent: async (event) => {
      events.push(event);
      return event.sourceSequence;
    },
    onHostCall: async () => ({
      status: "admitted",
      dispatchId: "fixture-dispatch",
    }),
    onLaunchPrepared: () => {},
    onLaunchRecorded: () => {},
    onLaunchStopped: () => {},
  });
  const open = {
    openId: "open-1",
    operationId: "opening-1",
    payloadDigest: "open",
    conversationId: "c1",
    mode: "new",
    cwd: dir,
    policyRevision: "policy-1",
  };
  const submit = (text: string) => ({
    operationId: "op1",
    turnId: "turn1",
    payloadDigest: "intent",
    conversationId: "c1",
    policyRevision: "policy-1",
    input: [{ type: "text", text }],
  });
  return {
    dir,
    home,
    profile,
    executable,
    host,
    events,
    open,
    submit,
    async cleanup() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("packed Codex artifact contains its executable contract and runs after extraction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-codex-package-"));
  let f: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const packed = spawnSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 30000,
      }
    );
    assert.equal(packed.status, 0, packed.stderr);
    const metadata = JSON.parse(packed.stdout)[0];
    for (const path of [
      "backend.mjs",
      "backend.json",
      "config.schema.json",
      "adapter.ts",
      "runtime.ts",
      "session.ts",
      "transport.ts",
      "CAPABILITIES.md",
    ])
      assert.ok(
        metadata.files.some(
          (file: { path: string }) => file.path === `backends/codex/${path}`
        ),
        `Package omitted ${path}`
      );
    const extracted = spawnSync(
      "tar",
      ["-xzf", join(dir, metadata.filename), "-C", dir],
      { encoding: "utf8", timeout: 30000 }
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    await symlink(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(dir, "package/node_modules"),
      "dir"
    );
    f = await setup(join(dir, "package/backends/codex"));
    const opened = (await f.host.request("session.open", f.open)) as {
      nativeReference: string;
    };
    assert.match(opened.nativeReference, /^codex:thr-fixture-/);
    assert.equal(
      (
        (await f.host.request(
          "operation.submit",
          f.submit("packed artifact")
        )) as { disposition: string }
      ).disposition,
      "accepted"
    );
    await until(() =>
      f!.events.some((event) => event.type === "turn.terminal")
    );
    assert.equal(
      f.events.find((event) => event.type === "turn.terminal")!.payload
        .execution,
      "ended"
    );
    const snapshots = f.events.filter((event) => event.type === "text.snapshot");
    assert.ok(snapshots.length >= 1);
    assert.equal(
      snapshots[snapshots.length - 1]!.payload.text,
      "codex:packed artifact"
    );
  } finally {
    await f?.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex open/submit/stream/close uses app-server not Chat Completions", async () => {
  const f = await setup();
  try {
    const opened = (await f.host.request("session.open", f.open)) as {
      nativeReference: string;
      continuity: string;
    };
    assert.match(opened.nativeReference, /^codex:thr-fixture-/);
    assert.equal(opened.continuity, "unverified");
    // New sessions stay unverified. Load continuity is proven separately.
    assert.equal(
      ((await f.host.request("operation.submit", f.submit("hello"))) as {
        disposition: string;
      }).disposition,
      "accepted"
    );
    await until(() =>
      f.events.some((event) => event.type === "turn.terminal")
    );
    assert.ok(f.events.some((event) => event.type === "turn.started"));
    assert.ok(f.events.some((event) => event.type === "text.snapshot"));
    assert.equal(
      f.events.find((event) => event.type === "turn.terminal")!.payload
        .execution,
      "ended"
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex cancel is cooperative turn/interrupt and not terminal proof", async () => {
  const f = await setup();
  try {
    await f.host.request("session.open", f.open);
    const submitting = f.host.request(
      "operation.submit",
      f.submit("[cancel-hold]")
    );
    await until(() =>
      f.events.some((event) => event.type === "turn.started")
    );
    const cancel = {
      operationId: "cancel1",
      targetOperationId: "op1",
      payloadDigest: "cancel-intent",
    };
    const result = await f.host.request("operation.cancel", cancel);
    assert.deepEqual(result, { status: "requested" });
    await submitting;
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    assert.equal(
      f.events.find((event) => event.type === "turn.terminal")!.payload
        .execution,
      "cancelled"
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex load restores the same native thread across adapter restart", async () => {
  const f = await setup();
  try {
    const first = (await f.host.request("session.open", f.open)) as {
      nativeReference: string;
    };
    await f.host.request("operation.submit", f.submit("remember"));
    await until(() =>
      f.events.some((event) => event.type === "turn.terminal")
    );
    await f.host.close();
    const registry = join(f.dir, "registry.json");
    const installation = (
      await PluginRegistry.load(registry, {
        policy: {
          workspace: "read-write",
          nativeProfile: true,
          network: true,
          gatewayTools: [],
        },
      })
    ).resolve("tidy.codex");
    const reloadEvents: GatewayPluginEvent[] = [];
    const reload = await PluginHost.start({
      installation,
      bindingId: "codex-binding",
      leaseGeneration: 2,
      workspace: f.dir,
      dataDir: join(f.dir, "data-reload"),
      allowedEnv: { PATH: dirname(process.execPath) },
      config: {
        executable: f.executable,
        home_dir: f.home,
        profile_dir: f.profile,
        environment_keys: ["PATH"],
      },
      onEvent: async (event) => {
        reloadEvents.push(event);
        return event.sourceSequence;
      },
      onHostCall: async () => ({
        status: "admitted",
        dispatchId: "fixture-dispatch",
      }),
      onLaunchPrepared: () => {},
      onLaunchRecorded: () => {},
      onLaunchStopped: () => {},
    });
    try {
      const loaded = (await reload.request("session.open", {
        ...f.open,
        openId: "open-2",
        operationId: "opening-2",
        mode: "load",
        nativeReference: first.nativeReference,
      })) as { nativeReference: string };
      assert.equal(loaded.nativeReference, first.nativeReference);
      assert.equal(
        (
          (await reload.request("operation.submit", {
            ...f.submit("again"),
            operationId: "op2",
            turnId: "turn2",
          })) as { disposition: string }
        ).disposition,
        "accepted"
      );
      await until(() =>
        reloadEvents.some((event) => event.type === "turn.terminal")
      );
    } finally {
      await reload.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("Codex load miss fails closed and never starts a fresh thread", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.host.request("session.open", {
        ...f.open,
        mode: "load",
        nativeReference: "codex:thr-missing",
      }),
      { code: "session_not_found" }
    );
    assert.equal(existsSync(join(f.home, "threads.json")), false);
  } finally {
    await f.cleanup();
  }
});

test("Codex initialize home mismatch fails closed", async () => {
  const f = await setup(undefined, { lieHome: true });
  try {
    await assert.rejects(f.host.request("session.open", f.open), {
      code: "continuity_unverified",
    });
    assert.equal(existsSync(join(f.home, "threads.json")), false);
  } finally {
    await f.cleanup();
  }
});

test("disposable dual-backend Codex and Pi fixture smoke stays off 4317", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-codex-mixed-"));
  let fleet: FleetHandle | undefined;
  let ws: WebSocket | undefined;
  try {
    const home = join(dir, "codex-home"),
      profile = join(dir, "codex-profile"),
      piHome = join(dir, "pi-home"),
      piProfile = join(dir, "pi-profile"),
      piNative = join(dir, "pi-native");
    for (const path of [home, profile, piHome, piProfile, piNative])
      await mkdir(path);
    const executable = join(dir, "codex-fixture");
    await copyFile(fixtureExecutable, executable);
    await chmod(executable, 0o755);
    const piExecutable = join(piNative, "native.mjs"),
      piMetadata = join(piNative, "package.json");
    await copyFile(
      new URL("./fixtures/pi-adapter/native.mjs", import.meta.url),
      piExecutable
    );
    await chmod(piExecutable, 0o755);
    await writeFile(
      piMetadata,
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.85.0",
        bin: { pi: "native.mjs" },
      })
    );
    const plugins = await Promise.all(
      ["pi", "codex"].map(async (name) => {
        const artifactPath = fileURLToPath(
          new URL(`../backends/${name}`, import.meta.url)
        );
        return {
          id: `tidy.${name}`,
          version: "0.1.0-dev",
          artifactPath,
          sha256: await digestArtifact(artifactPath),
          enabled: true,
        };
      })
    );
    await writeFile(
      join(dir, "registry.json"),
      JSON.stringify({ registryVersion: 1, plugins })
    );
    await writeFile(
      join(dir, "AGENTS.md"),
      "Disposable Codex↔Pi fixture smoke.\n"
    );
    await writeFile(
      join(dir, "bots.toml"),
      [
        "[gateway]",
        'registry = "registry.json"',
        'environment = ["PATH"]',
        'workspace_access = "read-write"',
        "native_profile = true",
        "network = true",
        'gateway_tools = ["fleet.discover", "fleet.send", "artifact.read"]',
        "[[bot]]",
        'name = "pi"',
        'dir = "."',
        'backend = "tidy.pi"',
        "[bot.backend_config]",
        `executable = ${JSON.stringify(piExecutable)}`,
        `package_json = ${JSON.stringify(piMetadata)}`,
        `home_dir = ${JSON.stringify(piHome)}`,
        `profile_dir = ${JSON.stringify(piProfile)}`,
        'environment_keys = ["PATH"]',
        "[[bot]]",
        'name = "codex"',
        'dir = "."',
        'backend = "tidy.codex"',
        "[bot.backend_config]",
        `executable = ${JSON.stringify(executable)}`,
        `home_dir = ${JSON.stringify(home)}`,
        `profile_dir = ${JSON.stringify(profile)}`,
        'environment_keys = ["PATH"]',
        "",
      ].join("\n")
    );
    fleet = await startFleet({
      dir,
      port: 0,
      token: "mixed-codex-token",
      log() {},
    });
    assert.notEqual(fleet.port, 4317);
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(fleet!.url + path, {
        ...options,
        headers: {
          authorization: "Bearer mixed-codex-token",
          ...options.headers,
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          bindingRevision?: string;
          conversationId?: string;
          backend?: { id?: string };
          capabilities?: { fleetTools?: boolean; sessions?: { load?: boolean } };
          execution?: string;
        },
      };
    };
    const bindings = Object.fromEntries(
      await Promise.all(
        ["pi", "codex"].map(async (name) => [
          name,
          (await request(`/api/bots/${name}/capabilities`)).body,
        ])
      )
    );
    assert.equal(bindings.pi.backend?.id, "tidy.pi");
    assert.equal(bindings.codex.backend?.id, "tidy.codex");
    assert.equal(bindings.codex.capabilities?.sessions?.load, true);
    assert.equal(bindings.codex.capabilities?.fleetTools, false);
    const events: { type?: string }[] = [];
    ws = new WebSocket(
      fleet.url.replace("http", "ws") +
        "/api/ws?token=mixed-codex-token&clientContract=2"
    );
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    await until(() => events.some((event) => event.type === "hello"));
    const send = (name: string) =>
      request(`/api/bots/${name}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": bindings[name].bindingRevision ?? "",
        },
        body: JSON.stringify({
          operationId: `mixed-${name}`,
          clientMessageId: `mixed-${name}`,
          conversationId: bindings[name].conversationId,
          text: name === "pi" ? "[multi]" : "hello Codex",
        }),
      });
    const receipts = await Promise.all([send("pi"), send("codex")]);
    for (const receipt of receipts)
      assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
    await until(async () =>
      (
        await Promise.all(
          ["pi", "codex"].map(
            async (name) =>
              (await request(`/api/bots/${name}/operations/mixed-${name}`)).body
                .execution
          )
        )
      ).every((execution) => execution === "ended")
    );
  } finally {
    ws?.close();
    await fleet?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex local conformance receipts cover open/submit/stream/cancel/close", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-codex-conformance-"));
  try {
    const home = join(root, "home"),
      profile = join(root, "profile");
    await mkdir(home);
    await mkdir(profile);
    const executable = join(root, "codex-fixture");
    await copyFile(fixtureExecutable, executable);
    await chmod(executable, 0o755);
    const artifact = fileURLToPath(
      new URL("../backends/codex", import.meta.url)
    );
    const registry = join(root, "registry.json");
    await writeFile(
      registry,
      JSON.stringify({
        registryVersion: 1,
        plugins: [
          {
            id: "tidy.codex",
            version: "0.1.0-dev",
            artifactPath: artifact,
            sha256: await digestArtifact(artifact),
            enabled: true,
          },
        ],
      })
    );
    const report = await runLocalConformance({
      registryPath: registry,
      pluginId: "tidy.codex",
      config: {
        executable,
        home_dir: home,
        profile_dir: profile,
        environment_keys: ["PATH"],
      },
      policy: {
        workspace: "read-write",
        nativeProfile: true,
        network: true,
        gatewayTools: [],
      },
      fixture: {
        version: 1,
        cells: [
          {
            id: "open-submit-stream",
            kind: "message",
            operationId: "codex-open",
            text: "hello",
            events: { minFrames: 3, terminalFinals: 1 },
            expect: { status: 202, execution: "ended" },
          },
        ],
      },
    });
    await writeFile(
      "/tmp/tidy-codex-197-conformance.json",
      JSON.stringify(report, null, 2)
    );
    assert.equal(report.cells[0]?.status, "passed", JSON.stringify(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
