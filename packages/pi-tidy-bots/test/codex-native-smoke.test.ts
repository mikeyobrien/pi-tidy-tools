import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFleet } from "../src/daemon.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";
import { PluginHost } from "../src/gateway/plugin-host.ts";
import { PluginRegistry, digestArtifact } from "../src/gateway/registry.ts";

const enabled = process.env.PI_TIDY_BOTS_REAL_CODEX_SMOKE === "1";
const executable = process.env.TIDY_REAL_CODEX_EXECUTABLE ?? "";
const authPath = process.env.TIDY_REAL_CODEX_AUTH ?? "";

const ready =
  enabled &&
  executable.startsWith("/") &&
  authPath.startsWith("/") &&
  existsSync(executable) &&
  existsSync(authPath);

async function until(probe: () => boolean | Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, "native Codex observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function isolatedHome(root: string) {
  const home = join(root, "home");
  const profile = join(root, "profile");
  await mkdir(home);
  await mkdir(profile);
  await symlink(authPath, join(home, "auth.json"));
  await writeFile(
    join(home, "config.toml"),
    'approval_policy = "never"\nsandbox_mode = "workspace-write"\n'
  );
  return { home, profile };
}

async function request(
  url: string,
  token: string,
  path: string,
  init: RequestInit = {}
) {
  const response = await fetch(url + path, {
    ...init,
    signal: AbortSignal.timeout(8_000),
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  return { status: response.status, body: (await response.json()) as any };
}

function readOpen(dir: string, prefix: "open:" | "load:") {
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
    assert.ok(record, `missing ${prefix} Codex session checkpoint`);
    const nativeReference = record.receipt.result?.nativeReference;
    assert.equal(typeof nativeReference, "string");
    assert.ok(nativeReference);
    return {
      nativeReference: String(nativeReference),
      conversationId: record.receipt.conversationId,
    };
  } finally {
    journal.close();
  }
}

test(
  "native Codex load miss fails closed and never starts a fresh thread",
  { skip: !ready },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tidy-codex-native-miss-"));
    let host: Awaited<ReturnType<typeof PluginHost.start>> | undefined;
    try {
      const { home, profile } = await isolatedHome(dir);
      const artifact = fileURLToPath(
        new URL("../backends/codex", import.meta.url)
      );
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
      host = await PluginHost.start({
        installation,
        bindingId: "codex-native-miss",
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
        onEvent: async (event) => event.sourceSequence,
        onHostCall: async () => ({
          status: "admitted",
          dispatchId: "native-miss",
        }),
        onLaunchPrepared: () => {},
        onLaunchRecorded: () => {},
        onLaunchStopped: () => {},
      });
      await assert.rejects(
        host.request("session.open", {
          openId: "open-miss",
          operationId: "opening-miss",
          payloadDigest: "open",
          conversationId: "c-miss",
          mode: "load",
          nativeReference: "codex:00000000-0000-4000-8000-000000000000",
          cwd: dir,
          policyRevision: "policy-1",
        }),
        { code: "session_not_found" }
      );
      assert.equal(existsSync(join(home, "sessions")), false);
    } finally {
      await host?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "approved gateway Codex smoke submits and reloads one bounded session",
  { skip: !ready },
  async () => {
    const fleetDir = await mkdtemp(join(tmpdir(), "tidy-codex-native-smoke-"));
    let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
    try {
      const { home, profile } = await isolatedHome(fleetDir);
      const artifact = fileURLToPath(
        new URL("../backends/codex", import.meta.url)
      );
      await writeFile(
        join(fleetDir, "AGENTS.md"),
        "Disposable native Codex smoke. Reply with exactly the requested token. Do not use tools.\n"
      );
      await writeFile(
        join(fleetDir, "registry.json"),
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
      await writeFile(
        join(fleetDir, "bots.toml"),
        [
          "[gateway]",
          'registry = "registry.json"',
          'environment = ["PATH"]',
          'workspace_access = "read-write"',
          "native_profile = true",
          "network = true",
          'gateway_tools = ["fleet.discover", "fleet.send", "artifact.read"]',
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
      const token = `codex-smoke-${crypto.randomUUID()}`;
      const launch = () =>
        startFleet({ dir: fleetDir, port: 0, token, log() {} });
      handle = await launch();
      assert.notEqual(handle.port, 4317);
      const submit = async (text: string, phase: "initial" | "reload") => {
        const caps = (
          await request(handle!.url, token, "/api/bots/codex/capabilities")
        ).body;
        assert.equal(caps.backend?.id, "tidy.codex");
        assert.equal(caps.capabilities?.sessions?.load, true);
        const operationId = `codex-smoke-${crypto.randomUUID()}`;
        const submitted = await request(
          handle!.url,
          token,
          "/api/bots/codex/message",
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
              text,
            }),
          }
        );
        assert.equal(
          submitted.status,
          202,
          `Codex ${phase} submit returned ${submitted.status}`
        );
        console.log(
          `SMOKE_CODEX_PHASE ${JSON.stringify({ phase, admitted: true })}`
        );
        await until(async () => {
          const operation = await request(
            handle!.url,
            token,
            `/api/bots/codex/operations/${operationId}`
          );
          return ["ended", "failed", "cancelled", "interrupted"].includes(
            operation.body.execution
          );
        }, 90_000);
        const [operation, transcript] = await Promise.all([
          request(handle!.url, token, `/api/bots/codex/operations/${operationId}`),
          request(handle!.url, token, "/api/bots/codex/transcript"),
        ]);
        assert.equal(operation.body.execution, "ended");
        assert.ok(
          transcript.body.transcript.some(
            (entry: { operationId?: string; role?: string }) =>
              entry.operationId === operationId && entry.role === "assistant"
          )
        );
        console.log(
          `SMOKE_CODEX_PHASE ${JSON.stringify({
            phase,
            admitted: true,
            terminal: "ended",
          })}`
        );
      };
      await submit("Reply with exactly: smoke-ready", "initial");
      await handle.stop();
      handle = undefined;
      const initial = readOpen(fleetDir, "open:");
      handle = await launch();
      assert.notEqual(handle.port, 4317);
      await submit("Reply with exactly: smoke-ready after verified session load", "reload");
      await handle.stop();
      handle = undefined;
      const restored = readOpen(fleetDir, "load:");
      assert.equal(restored.nativeReference, initial.nativeReference);
      assert.equal(restored.conversationId, initial.conversationId);
    } finally {
      try {
        await handle?.stop();
      } finally {
        await rm(fleetDir, { recursive: true, force: true });
      }
    }
  }
);
