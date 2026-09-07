import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFleet } from "../src/daemon.ts";
import { digestArtifact } from "../src/gateway/registry.ts";

type PiInput = {
  executable: string;
  packageJson: string;
  provider: string;
  model: string;
  credentialKey: string;
};
const enabled = process.env.PI_TIDY_BOTS_REAL_SMOKE === "1";
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
