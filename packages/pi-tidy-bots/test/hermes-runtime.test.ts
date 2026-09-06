import assert from "node:assert/strict";
import test from "node:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  openHermesRuntime,
  validateHermesConfiguration,
  type HermesRuntime,
} from "../backends/hermes/runtime.ts";
import { PluginStore } from "../src/plugin-sdk/store.ts";
import type { PluginContext } from "../src/plugin-sdk/runtime.ts";
import { DEFAULT_LIMITS } from "../src/gateway/protocol.ts";
import { ownedGroupHasExited } from "../src/gateway/process-ownership.ts";

const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(candidate) ? candidate : "/usr/bin/python3");

async function fixture(version = "0.20.5") {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-runtime-"));
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
    `__version__ = ${JSON.stringify(version)}\nfrom .fixture import install\ninstall()\n`
  );
  await writeFile(join(source, "acp_adapter/__init__.py"), "");
  await writeFile(
    join(source, "acp_adapter/server.py"),
    "from hermes_cli.env_loader import load_hermes_dotenv\nload_hermes_dotenv()\nfrom hermes_cli.fixture import FakeAgent as HermesACPAgent\n"
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
  await writeFile(
    join(dir, "hermes_cli.py"),
    "raise Exception('untrusted cwd import')\n"
  );
  const store = new PluginStore(join(dir, "sdk.sqlite"), {
    bindingId: "b",
    instanceId: "i",
    leaseGeneration: 1,
  });
  const events: any[] = [],
    failures: string[] = [];
  const launchId = `tidy-launch-${randomUUID()}`;
  const calls: string[] = [];
  let pid: number | undefined;
  const abort = new AbortController();
  const ctx: PluginContext = {
    initialization: {
      bindingId: "b",
      instanceId: "i",
      leaseGeneration: 1,
      config: {},
      workspace: dir,
      dataDir: dir,
      limits: DEFAULT_LIMITS,
    },
    store,
    signal: abort.signal,
    async hostCall() {
      throw new Error("Unexpected agent host service");
    },
    emit: (event) => {
      store.append(event);
      events.push(event);
    },
    async ownedProcess(method, params) {
      calls.push(method);
      assert.ok(store.reservation(`operation:${launchId}`));
      if (method === "prepare")
        return {
          launchId,
          state: "prepared",
          executable: process.execPath,
          launcherPath: fileURLToPath(
            new URL("../src/gateway/owned-launcher.mjs", import.meta.url)
          ),
        };
      pid = params.pid as number;
      await assert.rejects(readFile(join(profile, "effects.jsonl")), {
        code: "ENOENT",
      });
      return { launchId, state: "started", identity: { pid, token: launchId } };
    },
  };
  const config = {
    executable: python,
    source_dir: source,
    home_dir: home,
    profile_dir: profile,
    environment_keys: [],
  };
  const hooks = {
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onFailure: (error: { code: string }) => {
      failures.push(error.code);
    },
  };
  return {
    dir,
    source,
    home,
    profile,
    config,
    store,
    ctx,
    launchId,
    calls,
    events,
    failures,
    hooks,
    abort,
    pid: () => pid,
    async cleanup() {
      abort.abort();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("guarded Hermes ACP runs through the reserved SDK launcher and normalizes native evidence", async () => {
  const f = await fixture();
  let runtime: HermesRuntime | undefined;
  try {
    runtime = await openHermesRuntime(f.ctx, f.launchId, f.config, f.hooks);
    assert.equal(runtime.nativeReference, "native-one");
    assert.deepEqual(f.calls, ["prepare", "record"]);
    f.store.reserve("operation:operation-1", "operation.submit", "intent", {
      operationId: "operation-1",
      turnId: "turn-1",
      conversationId: "c",
    });
    assert.deepEqual(
      await runtime.session.submit("operation-1", "turn-1", [
        { type: "text", text: "hello" },
      ]),
      { disposition: "accepted" }
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "text.snapshot" &&
          event.payload.text === "Transformed final answer"
      )
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "turn.terminal" &&
          event.payload.execution === "ended" &&
          event.payload.observation === "complete"
      )
    );
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.store.inspect("operation-1"), {
      disposition: "accepted",
      execution: "ended",
      observation: "complete",
    });
    assert.equal(
      (await readFile(join(f.profile, "effects.jsonl"), "utf8")).includes(
        "unscoped_environment_loaded"
      ),
      false
    );
    await runtime.close();
    await runtime.close();
    assert.equal(await ownedGroupHasExited(f.pid()!), true);
    await assert.rejects(
      openHermesRuntime(f.ctx, f.launchId, f.config, f.hooks),
      { code: "launch_already_reserved" }
    );
  } finally {
    await runtime?.close();
    await f.cleanup();
  }
});

test("unsupported native version fails opening and joins the registered process group", async () => {
  const f = await fixture("wrong-version");
  try {
    await assert.rejects(
      openHermesRuntime(f.ctx, f.launchId, f.config, f.hooks)
    );
    assert.equal(await ownedGroupHasExited(f.pid()!), true);
    await assert.rejects(readFile(join(f.profile, "effects.jsonl")), {
      code: "ENOENT",
    });
    assert.ok(f.failures.length > 0);
  } finally {
    await f.cleanup();
  }
});

test("lost native execution evidence closes Hermes and retains an unknown prompt outcome", async () => {
  const f = await fixture();
  let runtime: HermesRuntime | undefined;
  try {
    runtime = await openHermesRuntime(f.ctx, f.launchId, f.config, f.hooks);
    f.store.reserve("operation:op", "operation.submit", "intent", {
      operationId: "op",
      turnId: "turn",
      conversationId: "c",
    });
    assert.deepEqual(
      await runtime.session.submit("op", "turn", [
        { type: "text", text: "[executor-not-started]" },
      ]),
      { disposition: "unknown" }
    );
    await runtime.closed;
    assert.equal(await ownedGroupHasExited(f.pid()!), true);
    assert.deepEqual(f.failures, ["native_observation_gap"]);
  } finally {
    await runtime?.close();
    await f.cleanup();
  }
});

test("Hermes configuration preserves venv paths and rejects ambient startup overrides", async () => {
  const f = await fixture();
  try {
    const executable = join(f.dir, "venv-python");
    await symlink(python, executable);
    const valid = await validateHermesConfiguration({
      ...f.config,
      executable,
    });
    assert.equal(valid.executable, executable);
    assert.deepEqual(valid.environment, {
      HOME: valid.home,
      HERMES_HOME: valid.profile,
    });
    for (const name of [
      "HOME",
      "HERMES_HOME",
      "PYTHONPATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "VIRTUAL_ENV",
      "TIDY_DATA_DIR",
    ])
      await assert.rejects(
        validateHermesConfiguration({ ...f.config, environment_keys: [name] }),
        { code: "invalid_config" }
      );
    for (const changes of [
      { executable: "python" },
      { source_dir: f.config.executable },
      { home_dir: "/missing-tidy-directory" },
      { unknown: true },
    ])
      await assert.rejects(
        validateHermesConfiguration({ ...f.config, ...changes }),
        { code: "invalid_config" }
      );
  } finally {
    await f.cleanup();
  }
});
