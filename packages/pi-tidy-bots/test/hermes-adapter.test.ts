import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
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
import { WebSocket } from "ws";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
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

async function setup(
  artifact = fileURLToPath(new URL("../backends/hermes", import.meta.url)),
  profileConfig: Record<string, unknown> = {}
) {
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
    join(source, "mcp-2.0.0.dist-info"),
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
    join(source, "mcp-2.0.0.dist-info/METADATA"),
    "Name: mcp\nVersion: 2.0.0\n"
  );
  await writeFile(
    join(profile, "config.yaml"),
    JSON.stringify({ approvals: { mode: "manual" }, ...profileConfig })
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
      policy: {
        workspace: "read-write",
        nativeProfile: true,
        network: true,
        gatewayTools: ["fleet.discover", "fleet.send", "artifact.read"],
      },
    })
  ).resolve("tidy.hermes");
  const events: GatewayPluginEvent[] = [];
  const hostCalls: any[] = [];
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
    onHostCall: async (call) => {
      hostCalls.push(call);
      return { status: "admitted", dispatchId: "fixture-dispatch" };
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
    source,
    home,
    profile,
    host,
    events,
    hostCalls,
    launches,
    open,
    submit,
    async cleanup() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("packed Hermes artifact contains its executable contract and runs after extraction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-package-"));
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
      "native_guard.py",
      "native_owned.py",
    ])
      assert.ok(
        metadata.files.some(
          (file: { path: string }) => file.path === `backends/hermes/${path}`
        ),
        `Package omitted ${path}`
      );
    const extracted = spawnSync(
      "tar",
      ["-xzf", join(dir, metadata.filename), "-C", dir],
      { encoding: "utf8", timeout: 30000 }
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    // Reuse already installed dependencies without a network install. All
    // package-owned source, manifests and entrypoints come from the tarball.
    await symlink(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(dir, "package/node_modules"),
      "dir"
    );
    f = await setup(join(dir, "package/backends/hermes"));
    assert.equal(
      ((await f.host.request("session.open", f.open)) as any).nativeReference,
      "hermes:native-one"
    );
    assert.equal(
      (
        (await f.host.request(
          "operation.submit",
          f.submit("packed artifact")
        )) as any
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
  } finally {
    await f?.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Hermes startup failure remains unknown without an uncorrelated event", async () => {
  const f = await setup(undefined, { newSessionError: true });
  try {
    await assert.rejects(f.host.request("session.open", f.open), {
      code: "native_startup_native_session",
    });
    assert.deepEqual(f.events, []);
  } finally {
    await f.cleanup();
  }
});

test("Hermes active native failure persists one correlated observation gap", async () => {
  const f = await setup();
  try {
    await f.host.request("session.open", f.open);
    await assert.rejects(
      f.host.request("operation.submit", f.submit("[update-error]")),
      { code: "plugin_eof" }
    );
    await until(() =>
      f.events.some((event) => event.type === "observation.gap")
    );
    const gaps = f.events.filter((event) => event.type === "observation.gap");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].operationId, "op1");
    assert.equal(gaps[0].turnId, "turn1");
    assert.deepEqual(gaps[0].payload, { code: "native_observation_gap" });
  } finally {
    await f.cleanup();
  }
});

async function until(probe: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, "native fixture observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const dispatch of [false, true]) {
  test(
    dispatch
      ? "Pi and Hermes dispatch bidirectionally with one completion each and restart without replay"
      : "Pi and Hermes shipped adapters share authenticated HTTP and WS without crossing bot identities",
    async () => {
      const f = await setup();
      let fleet: FleetHandle | undefined;
      let ws: WebSocket | undefined;
      try {
        await f.host.close();
        await writeFile(
          join(f.profile, "config.yaml"),
          JSON.stringify({
            approvals: { mode: "manual" },
            historyPersistence: true,
          })
        );
        const piHome = join(f.dir, "pi-home"),
          piProfile = join(f.dir, "pi-profile"),
          piNative = join(f.dir, "pi-native");
        for (const path of [piHome, piProfile, piNative]) await mkdir(path);
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
          ["pi", "hermes"].map(async (name) => {
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
          join(f.dir, "registry.json"),
          JSON.stringify({ registryVersion: 1, plugins })
        );
        await writeFile(
          join(f.dir, "AGENTS.md"),
          "Disposable deterministic mixed-fleet fixture.\n"
        );
        const configs = {
          pi: {
            executable: piExecutable,
            package_json: piMetadata,
            home_dir: piHome,
            profile_dir: piProfile,
            environment_keys: ["PATH"],
          },
          hermes: {
            executable: python,
            source_dir: f.source,
            home_dir: f.home,
            profile_dir: f.profile,
            environment_keys: [],
          },
        };
        await writeFile(
          join(f.dir, "bots.toml"),
          [
            "[gateway]",
            'registry = "registry.json"',
            'environment = ["PATH"]',
            'workspace_access = "read-write"',
            "native_profile = true",
            "network = true",
            'gateway_tools = ["fleet.discover", "fleet.send", "artifact.read"]',
            ...Object.entries(configs).flatMap(([name, config]) => [
              "[[bot]]",
              `name = "${name}"`,
              'dir = "."',
              `backend = "tidy.${name}"`,
              ...(dispatch
                ? [`routes = ["${name === "pi" ? "hermes" : "pi"}"]`]
                : []),
              "[bot.backend_config]",
              ...Object.entries(config).map(
                ([key, value]) => `${key} = ${JSON.stringify(value)}`
              ),
            ]),
            "",
          ].join("\n")
        );
        fleet = await startFleet({
          dir: f.dir,
          port: 0,
          token: "mixed-fixture-token",
          log() {},
        });
        const request = async (path: string, options: RequestInit = {}) => {
          const response = await fetch(fleet!.url + path, {
            ...options,
            headers: {
              authorization: "Bearer mixed-fixture-token",
              ...options.headers,
            },
          });
          return {
            status: response.status,
            body: (await response.json()) as any,
          };
        };
        assert.equal((await fetch(fleet.url + "/api/fleet")).status, 401);
        const bindings = Object.fromEntries(
          await Promise.all(
            ["pi", "hermes"].map(async (name) => [
              name,
              (await request(`/api/bots/${name}/capabilities`)).body,
            ])
          )
        );
        assert.notEqual(bindings.pi.bindingId, bindings.hermes.bindingId);
        assert.notEqual(
          bindings.pi.conversationId,
          bindings.hermes.conversationId
        );
        assert.equal(bindings.pi.backend.id, "tidy.pi");
        assert.equal(bindings.hermes.backend.id, "tidy.hermes");
        const events: any[] = [];
        ws = new WebSocket(
          fleet.url.replace("http", "ws") +
            "/api/ws?token=mixed-fixture-token&clientContract=2"
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
              "x-tidy-binding-revision": bindings[name].bindingRevision,
            },
            body: JSON.stringify({
              operationId: `mixed-${name}`,
              clientMessageId: `mixed-${name}`,
              conversationId: bindings[name].conversationId,
              text: dispatch
                ? `[fleet-send:${name === "pi" ? "hermes" : "pi"}]`
                : name === "pi"
                  ? "[multi]"
                  : "hello Hermes",
            }),
          });
        const receipts = await Promise.all([send("pi"), send("hermes")]);
        for (const receipt of receipts)
          assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
        await until(async () =>
          (
            await Promise.all(
              ["pi", "hermes"].map(
                async (name) =>
                  (await request(`/api/bots/${name}/operations/mixed-${name}`))
                    .body.execution
              )
            )
          ).every((execution) => execution === "ended")
        ).catch(async (error) => {
          const states = await Promise.all(
            ["pi", "hermes"].map(async (name) => ({
              name,
              receipt: (
                await request(`/api/bots/${name}/operations/mixed-${name}`)
              ).body,
            }))
          );
          throw new Error(JSON.stringify({ states }), { cause: error });
        });
        const retained: Record<string, any[]> = {};
        if (dispatch) {
          await until(async () => {
            for (const name of ["pi", "hermes"]) {
              const transcript = (await request(`/api/bots/${name}/transcript`))
                .body.transcript;
              if (
                transcript.length !== (name === "pi" ? 7 : 6) ||
                transcript.filter((entry: any) => entry.completion === true)
                  .length !== 1
              )
                return false;
              const operations = [
                ...new Set(transcript.map((entry: any) => entry.operationId)),
              ];
              if (operations.length !== 3) return false;
              for (const operation of operations)
                if (
                  (await request(`/api/bots/${name}/operations/${operation}`))
                    .body.execution !== "ended"
                )
                  return false;
            }
            return true;
          });
        }
        for (const [index, name] of ["pi", "hermes"].entries()) {
          assert.equal(
            (await send(name)).body.userEntryId,
            receipts[index].body.userEntryId
          );
          const transcript = (await request(`/api/bots/${name}/transcript`))
            .body.transcript;
          retained[name] = transcript;
          if (dispatch) {
            assert.equal(transcript.length, name === "pi" ? 7 : 6);
            const incoming = transcript.filter(
              (entry: any) =>
                entry.origin === "fleet" && entry.completion !== true
            );
            const completions = transcript.filter(
              (entry: any) => entry.completion === true
            );
            assert.equal(incoming.length, 1);
            assert.equal(incoming[0].text, "fixture task");
            assert.equal(completions.length, 1);
            assert.equal(
              completions[0].operationId,
              `completion-${completions[0].dispatchId}`
            );
            assert.notEqual(completions[0].dispatchId, incoming[0].dispatchId);
          } else
            assert.deepEqual(
              transcript.map((entry: any) => entry.text),
              name === "pi"
                ? ["[multi]", "First corrected", "second"]
                : ["hello Hermes", "Transformed final answer"]
            );
          assert.ok(
            events.some(
              (event) => event.type === "bubble" && event.bot === name
            )
          );
          if (!dispatch)
            assert.ok(
              transcript.every(
                (entry: any) => entry.operationId === `mixed-${name}`
              )
            );
        }
        if (dispatch) {
          for (const name of ["pi", "hermes"]) {
            const peer = name === "pi" ? "hermes" : "pi";
            const completion = retained[name].find(
              (entry: any) => entry.completion === true
            );
            const target = retained[peer].find(
              (entry: any) =>
                entry.origin === "fleet" && entry.completion !== true
            );
            assert.equal(completion.dispatchId, target.dispatchId);
            assert.equal(completion.from, bindings[peer].botId);
          }
        }
        if (!dispatch) {
          const upload = () =>
            request("/api/bots/hermes/message", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-tidy-client-contract": "2",
                "x-tidy-binding-revision": bindings.hermes.bindingRevision,
              },
              body: JSON.stringify({
                operationId: "hermes-artifact",
                clientMessageId: "hermes-artifact",
                conversationId: bindings.hermes.conversationId,
                text: "Read file",
                images: [
                  {
                    name: "notes.txt",
                    mediaType: "text/plain",
                    data: Buffer.from("Hermes file 🦋 content").toString(
                      "base64"
                    ),
                  },
                ],
              }),
            });
          assert.equal((await upload()).status, 202);
          await until(
            async () =>
              (await request("/api/bots/hermes/operations/hermes-artifact"))
                .body.execution === "ended"
          );
          assert.equal((await upload()).status, 202);
          const effects = (
            await readFile(join(f.profile, "effects.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const prompts = effects.filter((call) => call.kind === "prompt");
          assert.equal(prompts.length, 2);
          assert.ok(prompts[1].text.includes("Hermes file 🦋 content"));
          const require = createRequire(import.meta.url);
          const pixels = {
            width: 1,
            height: 1,
            data: Buffer.from([1, 2, 3, 255]),
          };
          const images = [
            {
              mediaType: "image/png",
              data: require("pngjs").PNG.sync.write(pixels).toString("base64"),
            },
            {
              mediaType: "image/jpeg",
              data: require("jpeg-js")
                .encode(pixels, 80)
                .data.toString("base64"),
            },
          ];
          for (const [index, image] of images.entries()) {
            const uploadImage = () =>
              request("/api/bots/hermes/message", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-tidy-client-contract": "2",
                  "x-tidy-binding-revision": bindings.hermes.bindingRevision,
                },
                body: JSON.stringify({
                  operationId: `hermes-image-${index}`,
                  clientMessageId: `hermes-image-${index}`,
                  conversationId: bindings.hermes.conversationId,
                  text: "",
                  images: [image],
                }),
              });
            assert.equal((await uploadImage()).status, 202);
            await until(
              async () =>
                (
                  await request(
                    `/api/bots/hermes/operations/hermes-image-${index}`
                  )
                ).body.execution === "ended"
            );
            assert.equal((await uploadImage()).status, 202);
          }
          const nativeImages = (
            await readFile(join(f.profile, "effects.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((call) => call.kind === "native_image_input");
          assert.equal(nativeImages.length, 2);
          for (const [index, call] of nativeImages.entries())
            assert.deepEqual(call.content[1], {
              type: "image_url",
              image_url: {
                url: `data:${images[index].mediaType};base64,${images[index].data}`,
              },
            });
          retained.hermes = (
            await request("/api/bots/hermes/transcript")
          ).body.transcript;
        }
        ws.terminate();
        await fleet.stop();
        fleet = await startFleet({
          dir: f.dir,
          port: 0,
          token: "mixed-fixture-token",
          log() {},
        });
        for (const [index, name] of ["pi", "hermes"].entries()) {
          const previous = bindings[name];
          bindings[name] = (
            await request(`/api/bots/${name}/capabilities`)
          ).body;
          assert.equal(bindings[name].bindingId, previous.bindingId);
          assert.equal(
            (await send(name)).body.userEntryId,
            receipts[index].body.userEntryId
          );
          assert.equal(
            (await request(`/api/bots/${name}/operations/mixed-${name}`)).body
              .execution,
            "ended"
          );
          const transcript = (await request(`/api/bots/${name}/transcript`))
            .body.transcript;
          assert.deepEqual(transcript, retained[name]);
        }
        assert.ok(
          (await request("/api/fleet")).body.bots.every(
            (bot: any) => bot.online
          )
        );
        const piCalls = (
          await readFile(
            join(
              f.dir,
              ".fleet/plugins",
              bindings.pi.bindingId,
              "native-effects.jsonl"
            ),
            "utf8"
          )
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const hermesCalls = (
          await readFile(join(f.profile, "effects.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(
          piCalls.filter((call) => call.command === "prompt").length,
          dispatch ? 3 : 1
        );
        assert.equal(
          hermesCalls.filter((call) => call.kind === "prompt").length,
          dispatch ? 3 : 4
        );
        assert.equal(
          hermesCalls.filter((call) => call.kind === "new").length,
          1
        );
        assert.equal(
          hermesCalls.filter((call) => call.kind === "load").length,
          1
        );
        for (const name of ["pi", "hermes"]) {
          assert.equal(
            (
              await request(`/api/bots/${name}/message`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-tidy-client-contract": "2",
                  "x-tidy-binding-revision": bindings[name].bindingRevision,
                },
                body: JSON.stringify({
                  operationId: `resumed-${name}`,
                  clientMessageId: `resumed-${name}`,
                  conversationId: bindings[name].conversationId,
                  text: "continue after restart",
                }),
              })
            ).status,
            202
          );
          await until(
            async () =>
              (await request(`/api/bots/${name}/operations/resumed-${name}`))
                .body.execution === "ended"
          );
        }
      } finally {
        ws?.terminate();
        await fleet?.stop();
        await f.cleanup();
      }
    }
  );
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

for (const text of ["hello", "[owned-worker]", "[fleet-send]"]) {
  test(`installed Hermes adapter preserves durable ${text} and registered cleanup`, async () => {
    const f = await setup();
    try {
      assert.equal(f.host.capabilities.sessions.load, true);
      assert.equal(f.host.capabilities.sessions.proof, "retained-history");
      assert.equal(f.host.capabilities.sessions.emptySeat, "non-restorable");
      assert.equal(
        f.host.capabilities.interactions.permissions,
        "exact-request"
      );
      assert.equal(f.host.capabilities.fleetTools, true);
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
      if (text === "[fleet-send]") {
        assert.equal(f.hostCalls.length, 1);
        assert.equal(f.hostCalls[0].name, "fleet.send");
        assert.equal(f.hostCalls[0].operationId, "op1");
        assert.equal(f.hostCalls[0].toolCallId, "native-tool-one");
        assert.deepEqual(f.hostCalls[0].arguments, {
          target: "peer",
          text: "fixture task",
        });
        const results = calls.filter((call) => call.kind === "fleet_result");
        assert.equal(results.length, 2);
        // The retained SDK result is canonical JSON, so compare its value,
        // independently of the host's original object insertion order.
        assert.deepEqual(
          JSON.parse(results[0].result.content[0].text),
          JSON.parse(results[1].result.content[0].text)
        );
      }
      await f.host.close();
      assert.equal(f.launches.size, text === "[owned-worker]" ? 3 : 2);
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
