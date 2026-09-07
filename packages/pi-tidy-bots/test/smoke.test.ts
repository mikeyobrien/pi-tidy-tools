import assert from "node:assert/strict";
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
import test from "node:test";
import { startFleet } from "../src/daemon.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";
import { digestArtifact } from "../src/gateway/registry.ts";

type PiInput = {
  executable: string;
  packageJson: string;
  provider: string;
  model: string;
  credentialKey: string;
};
const enabled = process.env.PI_TIDY_BOTS_REAL_SMOKE === "1";
const fixturePython = process.env.TIDY_TEST_PYTHON;
const realInput = (): PiInput => ({
  executable: process.env.TIDY_REAL_PI_EXECUTABLE ?? "",
  packageJson: process.env.TIDY_REAL_PI_PACKAGE_JSON ?? "",
  provider: process.env.TIDY_REAL_PI_PROVIDER ?? "",
  model: process.env.TIDY_REAL_PI_MODEL ?? "",
  credentialKey: process.env.TIDY_REAL_PI_CREDENTIAL_KEY ?? "",
});

async function generatedPiFleet(input: PiInput) {
  if (
    !input.executable.startsWith("/") ||
    !input.packageJson.startsWith("/") ||
    !/^[A-Z][A-Z0-9_]*$/.test(input.credentialKey) ||
    !input.provider ||
    input.provider.includes("/") ||
    !input.model.startsWith(`${input.provider}/`) ||
    input.model.length <= input.provider.length + 1
  )
    throw new Error(
      "Pi smoke needs explicit paths, one credential key, and provider/model"
    );
  const dir = await mkdtemp(join(tmpdir(), "tidy-real-pi-"));
  try {
    const home = join(dir, "home"),
      profile = join(dir, "profile"),
      artifact = fileURLToPath(new URL("../backends/pi", import.meta.url));
    await Promise.all([
      mkdir(home),
      mkdir(profile),
      writeFile(join(dir, "AGENTS.md"), "Disposable gateway Pi smoke.\n"),
    ]);
    await writeFile(
      join(dir, "registry.json"),
      JSON.stringify({
        registryVersion: 1,
        plugins: [
          {
            id: "tidy.pi",
            version: "0.1.0-dev",
            artifactPath: artifact,
            sha256: await digestArtifact(artifact),
            enabled: true,
          },
        ],
      })
    );
    await writeFile(
      join(dir, "bots.toml"),
      [
        "[gateway]",
        'registry = "registry.json"',
        `environment = ["PATH", ${JSON.stringify(input.credentialKey)}]`,
        'workspace_access = "read-write"',
        "native_profile = true",
        "network = true",
        'gateway_tools = ["fleet.discover", "fleet.send", "artifact.read"]',
        "[[bot]]",
        'name = "pi"',
        'dir = "."',
        'backend = "tidy.pi"',
        "[bot.backend_config]",
        `executable = ${JSON.stringify(input.executable)}`,
        `package_json = ${JSON.stringify(input.packageJson)}`,
        `home_dir = ${JSON.stringify(home)}`,
        `profile_dir = ${JSON.stringify(profile)}`,
        `environment_keys = ["PATH", ${JSON.stringify(input.credentialKey)}]`,
        `model = ${JSON.stringify(input.model)}`,
        "",
      ].join("\n")
    );
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function request(
  url: string,
  token: string,
  path: string,
  init: RequestInit = {}
) {
  const response = await fetch(url + path, {
    ...init,
    signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function runSmoke(input: PiInput, text: string, timeoutMs: number) {
  const fleet = await generatedPiFleet(input);
  let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
  try {
    const token = `pi-smoke-${crypto.randomUUID()}`;
    handle = await startFleet({ dir: fleet.dir, port: 0, token, log() {} });
    assert.notEqual(handle.port, 4317);
    const caps = (await request(handle.url, token, "/api/bots/pi/capabilities"))
      .body;
    const operationId = `smoke-${crypto.randomUUID()}`;
    assert.equal(
      (
        await request(handle.url, token, "/api/bots/pi/message", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tidy-client-contract": "2",
            "x-tidy-binding-revision": caps.bindingRevision,
          },
          body: JSON.stringify({
            operationId,
            clientMessageId: operationId,
            conversationId: caps.conversationId,
            text,
          }),
        })
      ).status,
      202
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [operation, transcript] = await Promise.all([
        request(handle.url, token, `/api/bots/pi/operations/${operationId}`),
        request(handle.url, token, "/api/bots/pi/transcript"),
      ]);
      if (
        ["ended", "failed", "cancelled", "interrupted"].includes(
          operation.body.execution
        )
      ) {
        assert.equal(operation.body.execution, "ended");
        assert.ok(
          transcript.body.transcript.some(
            (entry: any) =>
              entry.operationId === operationId && entry.role === "assistant"
          )
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "Pi smoke terminal was not observed; no retry was attempted"
    );
  } finally {
    try {
      await handle?.stop();
    } finally {
      await fleet.cleanup();
    }
  }
}

test(
  "approved gateway Pi smoke submits one bounded prompt",
  { skip: !enabled },
  async () => {
    await runSmoke(realInput(), "Reply with exactly: smoke-ready", 60_000);
  }
);
test("generated Pi smoke proves gateway receipt, terminal correlation, and cleanup", async () => {
  await assert.rejects(
    generatedPiFleet({
      executable: "",
      packageJson: "",
      provider: "",
      model: "",
      credentialKey: "",
    })
  );
  const native = await mkdtemp(join(tmpdir(), "tidy-pi-smoke-native-"), {
    encoding: "utf8",
  });
  const prior = process.env.SMOKE_FAKE_CREDENTIAL;
  try {
    const executable = join(native, "native.mjs"),
      packageJson = join(native, "package.json");
    await copyFile(
      new URL("./fixtures/pi-adapter/native.mjs", import.meta.url),
      executable
    );
    await chmod(executable, 0o700);
    await writeFile(
      packageJson,
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.85.0",
        bin: { pi: "native.mjs" },
      })
    );
    process.env.SMOKE_FAKE_CREDENTIAL = "fixture-only";
    await runSmoke(
      {
        executable,
        packageJson,
        provider: "fixture",
        model: "fixture/saved-model",
        credentialKey: "SMOKE_FAKE_CREDENTIAL",
      },
      "fixture reply",
      3_000
    );
  } finally {
    if (prior === undefined) delete process.env.SMOKE_FAKE_CREDENTIAL;
    else process.env.SMOKE_FAKE_CREDENTIAL = prior;
    await rm(native, { recursive: true, force: true });
  }
});

type HermesInput = {
  executable: string;
  source: string;
  provider: string;
  model: string;
  credentialKey: string;
  environmentKeys?: string[];
};

const hermesEnabled = process.env.PI_TIDY_BOTS_REAL_HERMES_SMOKE === "1";
const hermesInitEnabled =
  process.env.PI_TIDY_BOTS_REAL_HERMES_INIT_ONLY === "1";
const realHermesInput = (): HermesInput => ({
  executable: process.env.TIDY_REAL_HERMES_PYTHON ?? "",
  source: process.env.TIDY_REAL_HERMES_SOURCE ?? "",
  provider: process.env.TIDY_REAL_HERMES_PROVIDER ?? "",
  model: process.env.TIDY_REAL_HERMES_MODEL ?? "",
  credentialKey: process.env.TIDY_REAL_HERMES_CREDENTIAL_KEY ?? "",
  environmentKeys: (process.env.TIDY_REAL_HERMES_ENVIRONMENT_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
});

const validHermesInput = (input: HermesInput, source: string) =>
  input.executable.startsWith("/") &&
  source.startsWith("/") &&
  /^[A-Z][A-Z0-9_]*$/.test(input.credentialKey) &&
  !/^(TIDY_|PI_TIDY_|HERMES_|PYTHON|NODE_|LD_|DYLD_|HOME$|VIRTUAL_ENV$)/.test(
    input.credentialKey
  ) &&
  typeof process.env[input.credentialKey] === "string" &&
  input.provider.length > 0 &&
  !input.provider.includes("/") &&
  input.model.startsWith(`${input.provider}/`) &&
  input.model.length > input.provider.length + 1 &&
  (input.environmentKeys ?? []).every(
    (key) =>
      /^[A-Z][A-Z0-9_]*$/.test(key) &&
      !/^(TIDY_|PI_TIDY_|HERMES_|PYTHON|NODE_|LD_|DYLD_|HOME$|VIRTUAL_ENV$)/.test(
        key
      ) &&
      typeof process.env[key] === "string"
  ) &&
  new Set(input.environmentKeys ?? []).size ===
    (input.environmentKeys ?? []).length;

async function generatedHermesSource(dir: string) {
  const source = join(dir, "source");
  for (const path of [
    join(source, "hermes_cli"),
    join(source, "acp_adapter"),
    join(source, "agent_client_protocol-0.9.0.dist-info"),
    join(source, "mcp-2.0.0.dist-info"),
  ])
    await mkdir(path, { recursive: true });
  await copyFile(
    new URL("./fixtures/hermes-native/fixture.py", import.meta.url),
    join(source, "hermes_cli/fixture.py")
  );
  await Promise.all([
    writeFile(
      join(source, "hermes_cli/__init__.py"),
      "__version__='0.20.5'\nfrom .fixture import install\ninstall()\n"
    ),
    writeFile(join(source, "acp_adapter/__init__.py"), ""),
    writeFile(
      join(source, "acp_adapter/server.py"),
      "from hermes_cli.fixture import FakeAgent as HermesACPAgent\n"
    ),
    writeFile(
      join(source, "acp_adapter/entry.py"),
      "def _setup_logging(): pass\n"
    ),
    writeFile(
      join(source, "agent_client_protocol-0.9.0.dist-info/METADATA"),
      "Name: agent-client-protocol\nVersion: 0.9.0\n"
    ),
    writeFile(
      join(source, "mcp-2.0.0.dist-info/METADATA"),
      "Name: mcp\nVersion: 2.0.0\n"
    ),
  ]);
  return source;
}

async function generatedHermesFleet(
  input: HermesInput,
  setupSource?: (dir: string) => Promise<string>,
  fixtureHistoryPersistence = false
) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-smoke-"));
  try {
    const home = join(dir, "home");
    const profile = join(dir, "profile");
    await Promise.all([mkdir(home), mkdir(profile)]);
    const source = setupSource ? await setupSource(dir) : input.source;
    if (!validHermesInput(input, source))
      throw new Error(
        "Hermes smoke needs explicit runtime paths, one allowed credential name, and provider/model"
      );
    const artifact = fileURLToPath(
      new URL("../backends/hermes", import.meta.url)
    );
    await Promise.all([
      writeFile(join(dir, "AGENTS.md"), "Disposable Hermes smoke.\n"),
      writeFile(
        join(profile, "config.yaml"),
        JSON.stringify({
          approvals: { mode: "manual" },
          // The guard proves the two gateway MCP tools against Hermes'
          // visible surface. Keep the disposable smoke profile out of
          // progressive disclosure, which intentionally defers MCP tools.
          tools: { tool_search: false },
          // This fixture-only switch makes its deterministic ACP state file
          // available for the native load assertion below. Real Hermes uses
          // its installed persistence defaults and the durable gateway record.
          ...(fixtureHistoryPersistence ? { historyPersistence: true } : {}),
          // The installed Hermes profile contract selects a provider and its
          // model separately. The adapter itself intentionally has no model
          // configuration capability, so this is the only native input path.
          model: {
            provider: input.provider,
            default: input.model.slice(input.provider.length + 1),
          },
        })
      ),
      writeFile(
        join(dir, "registry.json"),
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
      ),
    ]);
    await writeFile(
      join(dir, "bots.toml"),
      [
        "[gateway]",
        'registry="registry.json"',
        `environment=${JSON.stringify([
          "PATH",
          input.credentialKey,
          ...(input.environmentKeys ?? []),
        ])}`,
        'workspace_access="read-write"',
        "native_profile=true",
        "network=true",
        'gateway_tools=["fleet.discover","fleet.send","artifact.read"]',
        "[[bot]]",
        'name="hermes"',
        'dir="."',
        'backend="tidy.hermes"',
        "[bot.backend_config]",
        `executable=${JSON.stringify(input.executable)}`,
        `source_dir=${JSON.stringify(source)}`,
        `home_dir=${JSON.stringify(home)}`,
        `profile_dir=${JSON.stringify(profile)}`,
        `environment_keys=${JSON.stringify([
          input.credentialKey,
          ...(input.environmentKeys ?? []),
        ])}`,
        "",
      ].join("\n")
    );
    return {
      dir,
      profile,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function runHermesSmoke(
  input: HermesInput,
  text: string,
  timeoutMs: number,
  setupSource?: (dir: string) => Promise<string>,
  assertCheckpoint?: (profile: string) => Promise<void>,
  fixtureHistoryPersistence = false
) {
  const fleet = await generatedHermesFleet(
    input,
    setupSource,
    fixtureHistoryPersistence
  );
  let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
  const faults: string[] = [];
  try {
    const token = `hermes-smoke-${crypto.randomUUID()}`;
    const launch = () =>
      startFleet({
        dir: fleet.dir,
        port: 0,
        token,
        log() {},
        onPluginFault: (fault) => faults.push(fault.code),
      });
    handle = await launch();
    assert.notEqual(handle.port, 4317);
    const submit = async (message: string, phase: "initial" | "reload") => {
      const caps = (
        await request(handle!.url, token, "/api/bots/hermes/capabilities")
      ).body;
      assert.equal(caps.capabilities.sessions.load, true);
      const operationId = `hermes-smoke-${crypto.randomUUID()}`;
      const rosterBefore = await request(handle!.url, token, "/api/fleet");
      const before = rosterBefore.body.bots.find(
        (candidate: any) => candidate.name === "hermes"
      );
      const submitted = await request(
        handle!.url,
        token,
        "/api/bots/hermes/message",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tidy-client-contract": "2",
            "x-tidy-binding-revision": caps.bindingRevision,
          },
          body: JSON.stringify({
            operationId,
            clientMessageId: operationId,
            conversationId: caps.conversationId,
            text: message,
          }),
        }
      );
      const rosterAfter = await request(handle!.url, token, "/api/fleet");
      const after = rosterAfter.body.bots.find(
        (candidate: any) => candidate.name === "hermes"
      );
      assert.equal(
        submitted.status,
        202,
        `Hermes ${phase} submit returned ${submitted.status}; ${JSON.stringify({
          before: {
            online: before?.online === true,
            gatewayStatus:
              typeof before?.gatewayStatus === "string"
                ? before.gatewayStatus
                : "ready",
          },
          after: {
            online: after?.online === true,
            gatewayStatus:
              typeof after?.gatewayStatus === "string"
                ? after.gatewayStatus
                : "ready",
          },
          faults: [...faults].sort(),
        })}`
      );
      console.log(
        `SMOKE_HERMES_PHASE ${JSON.stringify({ phase, admitted: true })}`
      );
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [operation, transcript] = await Promise.all([
          request(
            handle!.url,
            token,
            `/api/bots/hermes/operations/${operationId}`
          ),
          request(handle!.url, token, "/api/bots/hermes/transcript"),
        ]);
        if (
          ["ended", "failed", "cancelled", "interrupted"].includes(
            operation.body.execution
          )
        ) {
          assert.equal(operation.body.execution, "ended");
          assert.ok(
            transcript.body.transcript.some(
              (entry: any) =>
                entry.operationId === operationId && entry.role === "assistant"
            )
          );
          console.log(
            `SMOKE_HERMES_PHASE ${JSON.stringify({
              phase,
              admitted: true,
              terminal: "ended",
            })}`
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Hermes smoke terminal was not observed; no retry was attempted"
      );
    };
    await submit(text, "initial");
    await handle.stop();
    handle = undefined;
    const initial = readHermesSessionCheckpoint(fleet.dir, "open:");
    handle = await launch();
    await submit(`${text} after verified session load`, "reload");
    await handle.stop();
    handle = undefined;
    const restored = readHermesSessionCheckpoint(fleet.dir, "load:");
    assert.equal(restored.nativeReference, initial.nativeReference);
    assert.equal(restored.conversationId, initial.conversationId);
    await assertCheckpoint?.(fleet.profile);
  } finally {
    try {
      await handle?.stop();
    } finally {
      await fleet.cleanup();
    }
  }
}

async function runHermesInitialization(input: HermesInput) {
  const fleet = await generatedHermesFleet(input);
  const faults: string[] = [];
  let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
  try {
    const token = `hermes-init-${crypto.randomUUID()}`;
    handle = await startFleet({
      dir: fleet.dir,
      port: 0,
      token,
      log() {},
      onPluginFault: (fault) => faults.push(fault.code),
    });
    const transcript = await request(
      handle.url,
      token,
      "/api/bots/hermes/transcript"
    );
    assert.equal(transcript.status, 200);
    assert.deepEqual(transcript.body.transcript, []);
    const roster = await request(handle.url, token, "/api/fleet");
    const bot = roster.body.bots.find(
      (candidate: any) => candidate.name === "hermes"
    );
    assert.ok(bot);
    return {
      faults: [...faults].sort(),
      online: bot.online === true,
      gatewayStatus:
        typeof bot.gatewayStatus === "string" ? bot.gatewayStatus : "ready",
    };
  } finally {
    try {
      await handle?.stop();
    } finally {
      await fleet.cleanup();
    }
  }
}

function readHermesSessionCheckpoint(dir: string, prefix: "open:" | "load:") {
  const journal = new GatewayJournal(join(dir, ".fleet", "gateway.sqlite"));
  try {
    const record = journal
      .listOperationRecords()
      .find(
        (candidate) =>
          candidate.receipt.kind === "session_open" &&
          candidate.receipt.operationId.startsWith(prefix) &&
          candidate.receipt.execution === "ended" &&
          candidate.receipt.observation === "complete"
      );
    assert.ok(record, `missing ${prefix} Hermes session checkpoint`);
    const nativeReference = record.receipt.result?.nativeReference;
    assert.equal(
      typeof nativeReference,
      "string",
      `missing native reference in ${prefix} checkpoint (${Object.keys(record.receipt.result ?? {}).join(",")})`
    );
    assert.ok(nativeReference);
    return {
      nativeReference,
      conversationId: record.receipt.conversationId,
    };
  } finally {
    journal.close();
  }
}

test(
  "approved gateway Hermes smoke submits and reloads one bounded session",
  { skip: !hermesEnabled },
  async () => {
    await runHermesSmoke(
      realHermesInput(),
      "Reply with exactly: smoke-ready",
      60_000
    );
  }
);

test(
  "authorized Hermes initializer records only safe startup diagnostics",
  { skip: !hermesInitEnabled },
  async () => {
    const result = await runHermesInitialization(realHermesInput());
    // This opt-in diagnostic deliberately sends no prompt. Keep only bounded
    // host-generated codes in its captured test output.
    console.log(`SMOKE_INIT ${JSON.stringify(result)}`);
  }
);

test(
  "generated Hermes fixture proves gateway receipt, terminal correlation, load checkpoint, and cleanup",
  { skip: !fixturePython?.startsWith("/") },
  async () => {
    await assert.rejects(
      generatedHermesFleet({
        executable: "",
        source: "",
        provider: "",
        model: "",
        credentialKey: "",
      })
    );
    const prior = process.env.SMOKE_HERMES_CREDENTIAL;
    const priorBaseUrl = process.env.SMOKE_HERMES_BASE_URL;
    try {
      process.env.SMOKE_HERMES_CREDENTIAL = "fixture-only";
      process.env.SMOKE_HERMES_BASE_URL = "https://example.invalid/explicit";
      await runHermesSmoke(
        {
          executable: fixturePython!,
          source: "",
          provider: "fixture",
          model: "fixture/saved-model",
          credentialKey: "SMOKE_HERMES_CREDENTIAL",
          environmentKeys: ["SMOKE_HERMES_BASE_URL"],
        },
        "fixture reply",
        3_000,
        generatedHermesSource,
        async (profile) => {
          const config = JSON.parse(
            await readFile(join(profile, "config.yaml"), "utf8")
          );
          assert.equal(config.tools.tool_search, false);
          const effects = (
            await readFile(join(profile, "effects.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(
            effects.filter((effect) => effect.kind === "new").length,
            1
          );
          assert.equal(
            effects.filter((effect) => effect.kind === "load").length,
            1
          );
          assert.equal(
            effects.filter((effect) => effect.kind === "prompt").length,
            2
          );
          assert.deepEqual(
            effects.filter((effect) => effect.kind === "explicit_environment"),
            [
              {
                kind: "explicit_environment",
                name: "SMOKE_HERMES_BASE_URL",
                value: "https://example.invalid/explicit",
              },
            ]
          );
        },
        true
      );
    } finally {
      if (prior === undefined) delete process.env.SMOKE_HERMES_CREDENTIAL;
      else process.env.SMOKE_HERMES_CREDENTIAL = prior;
      if (priorBaseUrl === undefined) delete process.env.SMOKE_HERMES_BASE_URL;
      else process.env.SMOKE_HERMES_BASE_URL = priorBaseUrl;
    }
  }
);
