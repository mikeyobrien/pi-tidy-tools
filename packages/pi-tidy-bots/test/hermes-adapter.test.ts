import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry, digestArtifact } from "../src/gateway/registry.ts";
import { PluginHost } from "../src/gateway/plugin-host.ts";
import { ownedGroupHasExited } from "../src/gateway/process-ownership.ts";
import type { GatewayPluginEvent } from "../src/gateway/protocol.ts";

const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(candidate) ? candidate : "/usr/bin/python3");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-adapter-"));
  const source = join(dir, "source"),
    home = join(dir, "home"),
    profile = join(dir, "profile");
  for (const path of [
    home,
    profile,
    join(source, "hermes_cli"),
    join(source, "acp_adapter"),
    join(source, "agent_client_protocol-0.9.0.dist-info"),
  ])
    await mkdir(path, { recursive: true });
  await copyFile(
    new URL("./fixtures/hermes-native/fixture.py", import.meta.url),
    join(source, "hermes_cli/fixture.py")
  );
  await writeFile(
    join(source, "hermes_cli/__init__.py"),
    "__version__ = '0.20.5'\nfrom .fixture import install\ninstall()\n"
  );
  await writeFile(join(source, "acp_adapter/__init__.py"), "");
  await writeFile(
    join(source, "acp_adapter/server.py"),
    "from hermes_cli.fixture import FakeAgent as HermesACPAgent\n"
  );
  await writeFile(
    join(source, "acp_adapter/entry.py"),
    "def _setup_logging():\n    pass\n"
  );
  await writeFile(
    join(source, "agent_client_protocol-0.9.0.dist-info/METADATA"),
    "Name: agent-client-protocol\nVersion: 0.9.0\n"
  );
  await writeFile(
    join(profile, "config.yaml"),
    JSON.stringify({ approvals: { mode: "manual" } })
  );
  const artifact = fileURLToPath(
    new URL("../backends/hermes", import.meta.url)
  );
  const registry = join(dir, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "tidy.hermes",
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
      policy: { workspace: "read-write", nativeProfile: true, network: true },
    })
  ).resolve("tidy.hermes");
  const events: GatewayPluginEvent[] = [];
  const launches = new Map<string, { pid?: number; stopped?: boolean }>();
  const host = await PluginHost.start({
    installation,
    bindingId: "hermes-binding",
    leaseGeneration: 1,
    workspace: dir,
    dataDir: join(dir, "data"),
    allowedEnv: { PATH: dirname(process.execPath) },
    config: {
      executable: python,
      source_dir: source,
      home_dir: home,
      profile_dir: profile,
      environment_keys: [],
    },
    onEvent: async (event) => {
      events.push(event);
      return event.sourceSequence;
    },
    onLaunchPrepared: (id) => {
      launches.set(id, {});
    },
    onLaunchRecorded: (id, identity) => {
      launches.get(id)!.pid = identity.pid;
    },
    onLaunchStopped: (id) => {
      launches.get(id)!.stopped = true;
    },
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
    profile,
    host,
    events,
    launches,
    open,
    submit,
    async cleanup() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function until(probe: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, "native fixture observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("installed Hermes adapter durably joins exact permission controls", async () => {
  const f = await setup();
  try {
    await f.host.request("session.open", f.open);
    const submitting = f.host.request(
      "operation.submit",
      f.submit("[permission-callback]")
    );
    await until(() =>
      f.events.some((event) => event.type === "interaction.requested")
    );
    const descriptor = f.events.find(
      (event) => event.type === "interaction.requested"
    )!.payload;
    const decision = {
      ...descriptor,
      operationId: "decision1",
      targetOperationId: "op1",
      optionId: "allow_once",
      payloadDigest: "decision-intent",
    };
    const result = await f.host.request("interaction.respond", decision);
    assert.deepEqual(result, { status: "applied" });
    assert.deepEqual(
      await f.host.request("interaction.respond", decision),
      result
    );
    assert.equal(((await submitting) as any).disposition, "accepted");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    assert.equal(
      f.events.filter((event) => event.type === "interaction.resolved").length,
      1
    );
    const calls = (await readFile(join(f.profile, "effects.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.kind === "prompt_permission").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("installed Hermes adapter separates cancellation from terminal execution", async () => {
  const f = await setup();
  try {
    await f.host.request("session.open", f.open);
    const submitting = f.host.request(
      "operation.submit",
      f.submit("[cancel-wait]")
    );
    await until(async () =>
      (await readFile(join(f.profile, "effects.jsonl"), "utf8")).includes(
        "[cancel-wait]"
      )
    );
    const cancel = {
      operationId: "cancel1",
      targetOperationId: "op1",
      payloadDigest: "cancel-intent",
    };
    const result = await f.host.request("operation.cancel", cancel);
    assert.deepEqual(result, { status: "requested" });
    assert.deepEqual(await f.host.request("operation.cancel", cancel), result);
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

for (const text of ["hello", "[owned-worker]"]) {
  test(`installed Hermes adapter preserves durable ${text} and registered cleanup`, async () => {
    const f = await setup();
    try {
      assert.equal(f.host.capabilities.sessions.load, false);
      assert.equal(
        f.host.capabilities.interactions.permissions,
        "exact-request"
      );
      assert.equal(f.host.capabilities.fleetTools, false);
      const opened = await f.host.request("session.open", f.open);
      assert.equal((opened as any).nativeReference, "hermes:native-one");
      assert.deepEqual(await f.host.request("session.open", f.open), opened);
      const submitted = await f.host.request(
        "operation.submit",
        f.submit(text)
      );
      assert.equal((submitted as any).disposition, "accepted");
      assert.deepEqual(
        await f.host.request("operation.submit", f.submit(text)),
        submitted
      );
      const deadline = Date.now() + 5000;
      while (!f.events.some((event) => event.type === "turn.terminal")) {
        assert.ok(Date.now() < deadline, "native turn did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const calls = (await readFile(join(f.profile, "effects.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(calls.filter((call) => call.kind === "new").length, 1);
      assert.equal(calls.filter((call) => call.kind === "prompt").length, 1);
      await f.host.close();
      assert.equal(f.launches.size, text === "hello" ? 2 : 3);
      for (const launch of f.launches.values()) {
        assert.equal(launch.stopped, true);
        if (launch.pid)
          assert.equal(await ownedGroupHasExited(launch.pid), true);
      }
    } finally {
      await f.cleanup();
    }
  });
}
