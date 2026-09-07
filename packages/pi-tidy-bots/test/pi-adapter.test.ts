import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { PluginRegistry, digestArtifact } from "../src/gateway/registry.ts";
import { PluginHost } from "../src/gateway/plugin-host.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";
import { startFleet, type FleetHandle } from "../src/daemon.ts";
import {
  object,
  type GatewayPluginEvent,
  type JsonObject,
} from "../src/gateway/protocol.ts";

function questionForOperation(
  transcript: JsonObject[],
  operationId: string
): JsonObject | undefined {
  const entry = transcript.find(
    (candidate) =>
      object(candidate.question) &&
      candidate.question.operationId === operationId
  );
  return entry && object(entry.question) ? entry.question : undefined;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-pi-adapter-"));
  const nativeDirectory = join(directory, "native");
  const profile = join(directory, "profile");
  const home = join(directory, "home");
  await Promise.all([mkdir(nativeDirectory), mkdir(profile), mkdir(home)]);
  const executable = join(nativeDirectory, "native.mjs");
  await copyFile(
    new URL("./fixtures/pi-adapter/native.mjs", import.meta.url),
    executable
  );
  await chmod(executable, 0o755);
  const metadata = join(nativeDirectory, "package.json");
  await writeFile(
    metadata,
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.85.0",
      bin: { pi: "native.mjs" },
    })
  );
  const artifact = fileURLToPath(new URL("../backends/pi", import.meta.url));
  const registry = join(directory, "registry.json");
  await writeFile(
    registry,
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
  const installation = (
    await PluginRegistry.load(registry, {
      policy: {
        workspace: "read-write",
        nativeProfile: true,
        network: true,
        gatewayTools: ["fleet.discover", "fleet.send", "artifact.read"],
      },
    })
  ).resolve("tidy.pi");
  const config = {
    executable,
    package_json: metadata,
    home_dir: home,
    profile_dir: profile,
    environment_keys: ["PATH"],
  };
  const events: GatewayPluginEvent[] = [];
  const hostCalls: any[] = [];
  const hosts: PluginHost[] = [];
  const dataDir = join(directory, "data");
  return {
    directory,
    dataDir,
    config,
    events,
    hostCalls,
    metadata,
    profile,
    async start(overrides: JsonObject = {}, lease = 1) {
      const host = await PluginHost.start({
        installation,
        bindingId: "pi-binding",
        leaseGeneration: lease,
        config: { ...config, ...overrides },
        workspace: directory,
        dataDir,
        allowedEnv: {
          PATH: dirname(process.execPath),
          FIXTURE_PARENT_SECRET: "must-not-cross",
        },
        limits: { commandTimeoutMs: 1500, inspectTimeoutMs: 1500 },
        onEvent: async (event) => {
          events.push(event);
          return event.sourceSequence;
        },
        onHostCall: async (call) => {
          hostCalls.push(call);
          return { status: "admitted", dispatchId: "fixture-dispatch" };
        },
      });
      hosts.push(host);
      return host;
    },
    open(host: PluginHost) {
      return host.request("session.open", {
        openId: "open-one",
        payloadDigest: "open-digest",
        conversationId: "conversation",
        mode: "new",
        cwd: directory,
      });
    },
    submit(host: PluginHost, text: string, id = "operation-one") {
      return host.request("operation.submit", {
        operationId: id,
        turnId: `turn:${id}`,
        payloadDigest: text,
        conversationId: "conversation",
        input: [{ type: "text", text }],
      });
    },
    compact(host: PluginHost, id = "compact-one") {
      return host.request("session.compact", {
        operationId: id,
        turnId: `turn:${id}`,
        payloadDigest: `sha256:${id}`,
        conversationId: "conversation",
      });
    },
    async effects(): Promise<JsonObject[]> {
      try {
        return (await readFile(join(dataDir, "native-effects.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async cleanup() {
      await Promise.all(hosts.map((host) => host.close()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Expected adapter event was not observed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("registered Pi artifact negotiates without a native launch and isolates its new session", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    assert.equal(host.runtime.version, "0.85.0");
    assert.equal(host.capabilities.fleetTools, true);
    assert.deepEqual(await f.effects(), []);
    const first = await f.open(host);
    assert.deepEqual(await f.open(host), first);
    const effects = await f.effects();
    assert.equal(effects.filter((e) => e.launch).length, 1);
    const launch = effects.find((e) => e.launch)!;
    assert.equal(launch.profile, await realpath(f.profile));
    assert.ok(
      !(launch.environmentKeys as string[]).some(
        (key) => key.startsWith("TIDY_") || key.startsWith("PI_TIDY_")
      )
    );
    assert.ok((launch.argv as string[]).includes("--no-builtin-tools"));
    assert.ok(
      !(launch.environmentKeys as string[]).includes("FIXTURE_PARENT_SECRET")
    );
    assert.ok(!(launch.argv as string[]).includes("--continue"));
  } finally {
    await f.cleanup();
  }
});

test("shipped Pi fleet tool retries produce one host admission and complete tool evidence", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    assert.deepEqual(await f.submit(host, "[fleet-send]"), {
      disposition: "accepted",
    });
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    assert.equal(f.hostCalls.length, 1);
    assert.equal(f.hostCalls[0].name, "fleet.send");
    assert.equal(f.hostCalls[0].operationId, "operation-one");
    assert.equal(f.hostCalls[0].toolCallId, "fleet-native-one");
    assert.deepEqual(f.hostCalls[0].arguments, {
      target: "peer",
      text: "fixture task",
    });
    assert.equal(
      f.events.filter((event) => event.type === "tool.started").length,
      1
    );
    assert.equal(
      f.events.filter((event) => event.type === "tool.finished").length,
      1
    );
    assert.equal(
      f.events.find((event) => event.type === "turn.terminal")!.payload
        .observation,
      "complete"
    );
    const results = (await f.effects()).filter(
      (effect) => effect.fleetResult
    ) as any[];
    assert.equal(results.length, 2);
    assert.deepEqual(
      JSON.parse(results[0].fleetResult.content[0].text),
      JSON.parse(results[1].fleetResult.content[0].text)
    );
    assert.equal(JSON.stringify(f.hostCalls).includes("promptId"), false);
  } finally {
    await f.cleanup();
  }
});

test("startFleet HTTP contract admits and projects messages through the shipped Pi artifact", async () => {
  const f = await setup();
  let handle: FleetHandle | undefined;
  try {
    await writeFile(
      join(f.directory, "AGENTS.md"),
      "Disposable deterministic native fixture.\n"
    );
    await writeFile(
      join(f.directory, "bots.toml"),
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
        ...Object.entries(f.config).map(
          ([key, value]) => `${key} = ${JSON.stringify(value)}`
        ),
        "",
      ].join("\n")
    );
    handle = await startFleet({
      dir: f.directory,
      port: 0,
      token: "pi-fixture-token",
      log() {},
    });
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(handle!.url + path, {
        ...options,
        headers: {
          authorization: "Bearer pi-fixture-token",
          ...options.headers,
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    };
    const binding = (await request("/api/bots/pi/capabilities")).body;
    assert.equal(binding.backend.id, "tidy.pi");
    assert.equal(binding.capabilities.configuration.model, true);
    assert.equal(binding.capabilities.configuration.thinking, true);
    assert.equal((await fetch(handle.url + "/api/bots/pi/model")).status, 401);
    assert.deepEqual((await request("/api/bots/pi/model")).body, {
      model: "fixture/saved-model",
    });
    const send = () =>
      request("/api/bots/pi/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": binding.bindingRevision,
        },
        body: JSON.stringify({
          operationId: "http-pi",
          clientMessageId: "http-pi",
          conversationId: binding.conversationId,
          text: "[multi]",
        }),
      });
    const receipt = await send();
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
    await until(
      async () =>
        (await request("/api/bots/pi/operations/http-pi")).body.execution ===
        "ended"
    );
    const transcript = (await request("/api/bots/pi/transcript")).body
      .transcript as JsonObject[];
    assert.deepEqual(
      transcript.map((entry) => entry.text),
      ["[multi]", "First corrected", "second"]
    );
    assert.equal(new Set(transcript.map((entry) => entry.id)).size, 3);
    assert.equal((await send()).body.userEntryId, receipt.body.userEntryId);
    const beforeCompactTranscript = transcript;
    const compact = () =>
      request("/api/bots/pi/compact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client-contract": "2",
          "x-tidy-binding-revision": binding.bindingRevision,
        },
        body: JSON.stringify({
          kind: "compact",
          operationId: "http-compact",
          conversationId: binding.conversationId,
        }),
      });
    assert.equal((await compact()).status, 202);
    await until(
      async () =>
        (await request("/api/bots/pi/operations/http-compact")).body
          .execution === "ended"
    );
    const compactReceipt = (
      await request("/api/bots/pi/operations/http-compact")
    ).body;
    assert.deepEqual(compactReceipt.result, { status: "applied" });
    assert.deepEqual(
      (await request("/api/bots/pi/transcript")).body.transcript,
      beforeCompactTranscript
    );
    assert.equal((await compact()).body.operationId, "http-compact");
    const effects = (
      await readFile(
        join(
          f.directory,
          ".fleet/plugins",
          binding.bindingId,
          "native-effects.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      effects.filter((effect) => effect.command === "prompt").length,
      1
    );
    const headers = {
      "content-type": "application/json",
      "x-tidy-client-contract": "2",
      "x-tidy-binding-revision": binding.bindingRevision,
    };
    const attachment = {
      mediaType: "text/plain",
      name: "notes.txt",
      data: Buffer.from("Artifact 🦋 contents").toString("base64"),
    };
    const sendAttachment = () =>
      request("/api/bots/pi/message", {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationId: "with-file",
          clientMessageId: "with-file",
          conversationId: binding.conversationId,
          text: "Inspect this file",
          images: [attachment],
        }),
      });
    assert.equal((await sendAttachment()).status, 202);
    await until(
      async () =>
        (await request("/api/bots/pi/operations/with-file")).body.execution ===
        "ended"
    );
    assert.equal((await sendAttachment()).status, 202);
    const attachmentEffects = (
      await readFile(
        join(
          f.directory,
          ".fleet/plugins",
          binding.bindingId,
          "native-effects.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      attachmentEffects.filter((effect) => effect.command === "prompt").length,
      2
    );
    const delivered = attachmentEffects.find((effect) =>
      effect.text?.includes("Artifact 🦋 contents")
    );
    assert.ok(
      delivered,
      "native Pi prompt must contain the actual attachment bytes"
    );
    const require = createRequire(import.meta.url);
    const pixel = {
      width: 1,
      height: 1,
      data: Buffer.from([0, 128, 255, 255]),
    };
    const imageUploads = [
      {
        mediaType: "image/png",
        data: require("pngjs").PNG.sync.write(pixel).toString("base64"),
      },
      {
        mediaType: "image/jpeg",
        data: require("jpeg-js").encode(pixel, 80).data.toString("base64"),
      },
    ];
    for (const [index, image] of imageUploads.entries()) {
      const sendImage = () =>
        request("/api/bots/pi/message", {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: `image-${index}`,
            clientMessageId: `image-${index}`,
            conversationId: binding.conversationId,
            text: "Describe image",
            images: [image],
          }),
        });
      assert.equal((await sendImage()).status, 202);
      const entries = (await request("/api/bots/pi/transcript")).body
        .transcript;
      const entry = entries.find(
        (value: JsonObject) =>
          value.operationId === `image-${index}` && value.role === "user"
      );
      assert.equal(entry.attachments, undefined);
      assert.equal(entry.images.length, 1);
      const file = entry.images[0].path.split("/").at(-1);
      const imageUrl: string = `${handle!.url}/api/images/pi/${file}`;
      assert.equal((await fetch(imageUrl)).status, 401);
      assert.equal(
        (await fetch(`${imageUrl}?token=pi-fixture-token`)).status,
        401
      );
      const downloaded = await fetch(imageUrl, {
        headers: { authorization: "Bearer pi-fixture-token" },
      });
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get("content-type"), image.mediaType);
      assert.equal(
        downloaded.headers.get("cache-control"),
        "private, no-store"
      );
      assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(
        Buffer.from(await downloaded.arrayBuffer()),
        Buffer.from(image.data, "base64")
      );
      assert.equal((await request(`/api/images/unknown/${file}`)).status, 404);
      assert.equal((await request(`/api/images/pi/%2F${file}`)).status, 404);
      await until(
        async () =>
          (await request(`/api/bots/pi/operations/image-${index}`)).body
            .execution === "ended"
      );
      assert.equal((await sendImage()).status, 202);
    }
    const imageEffects = (
      await readFile(
        join(
          f.directory,
          ".fleet/plugins",
          binding.bindingId,
          "native-effects.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((effect) => effect.images);
    assert.equal(imageEffects.length, 2);
    for (const [index, effect] of imageEffects.entries())
      assert.deepEqual(effect.images, [
        {
          type: "image",
          data: imageUploads[index].data,
          mimeType: imageUploads[index].mediaType,
        },
      ]);
    const invalid = await request("/api/bots/pi/message", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: "invalid-image",
        clientMessageId: "invalid-image",
        conversationId: binding.conversationId,
        text: "bad",
        images: [
          {
            mediaType: "image/png",
            data: Buffer.from("not an image").toString("base64"),
          },
        ],
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await request("/api/bots/pi/operations/invalid-image")).status,
      404
    );

    assert.equal(
      (
        await request("/api/bots/pi/message", {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "held",
            clientMessageId: "held",
            conversationId: binding.conversationId,
            text: "[hold]",
          }),
        })
      ).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/held")).body.execution ===
        "running"
    );
    const queuedSetting = await request("/api/bots/pi/thinking", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        kind: "thinking",
        operationId: "queued-thinking",
        conversationId: binding.conversationId,
        thinking: "low",
      }),
    });
    assert.equal(queuedSetting.status, 202);
    assert.equal(
      (await request("/api/bots/pi/operations/queued-thinking")).body.delivery,
      "queued"
    );
    const cancel = () =>
      request("/api/bots/pi/operations/held/cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "cancel",
          operationId: "cancel-held",
          targetOperationId: "held",
          conversationId: binding.conversationId,
        }),
      });
    assert.equal((await cancel()).status, 202);
    await until(
      async () =>
        (await request("/api/bots/pi/operations/held")).body.execution ===
        "cancelled"
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/cancel-held")).body.result
          ?.status === "requested"
    );
    assert.equal((await cancel()).body.result.status, "requested");
    await until(
      async () =>
        (await request("/api/bots/pi/operations/queued-thinking")).body.result
          ?.status === "applied"
    );
    assert.deepEqual((await request("/api/bots/pi/thinking")).body, {
      thinking: "low",
    });
    const configure = (
      kind: "model" | "thinking",
      value: string,
      id: string,
      revision = binding.bindingRevision
    ) =>
      request(`/api/bots/pi/${kind}`, {
        method: "PUT",
        headers: { ...headers, "x-tidy-binding-revision": revision },
        body: JSON.stringify({
          kind,
          operationId: id,
          conversationId: binding.conversationId,
          [kind]: value,
        }),
      });
    assert.equal(
      (await configure("model", "fixture/next/model", "stale-model", "old"))
        .status,
      409
    );
    assert.equal(
      (await request("/api/bots/pi/operations/stale-model")).status,
      404
    );
    assert.equal(
      (await configure("model", "fixture/next/model", "set-model")).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/set-model")).body.result
          ?.status === "applied"
    );
    const modelReceipt = (
      await configure("model", "fixture/next/model", "set-model")
    ).body;
    assert.equal(modelReceipt.kind, "model");
    assert.equal(modelReceipt.delivery, "accepted");
    assert.equal(modelReceipt.execution, "ended");
    assert.equal(modelReceipt.observation, "complete");
    assert.equal(
      (await configure("model", "fixture/saved-model", "set-model")).status,
      409
    );
    assert.deepEqual((await request("/api/bots/pi/model")).body, {
      model: "fixture/next/model",
    });
    assert.equal(
      (await configure("thinking", "high", "set-thinking")).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/set-thinking")).body.result
          ?.status === "applied"
    );
    assert.deepEqual((await request("/api/bots/pi/thinking")).body, {
      thinking: "high",
    });
    assert.equal(
      (await configure("thinking", "xhigh", "unsupported-thinking")).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/unsupported-thinking")).body
          .delivery === "rejected"
    );
    assert.deepEqual((await request("/api/bots/pi/thinking")).body, {
      thinking: "high",
    });
    const finalEffects = (
      await readFile(
        join(
          f.directory,
          ".fleet/plugins",
          binding.bindingId,
          "native-effects.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      finalEffects.filter((effect) => effect.command === "abort").length,
      1
    );
    assert.equal(
      finalEffects.filter((effect) => effect.command === "set_model").length,
      1
    );
    assert.equal(
      finalEffects.filter((effect) => effect.command === "set_thinking_level")
        .length,
      2
    );
    assert.ok(
      finalEffects.findIndex(
        (effect) => effect.command === "set_thinking_level"
      ) > finalEffects.findIndex((effect) => effect.command === "abort")
    );
    const beforeRestart = (await request("/api/bots/pi/transcript")).body
      .transcript;
    await handle.stop();
    handle = await startFleet({
      dir: f.directory,
      port: 0,
      token: "pi-fixture-token",
      log() {},
    });
    const restoredBinding = (await request("/api/bots/pi/capabilities")).body;
    assert.equal(restoredBinding.bindingId, binding.bindingId);
    assert.equal(restoredBinding.conversationId, binding.conversationId);
    assert.equal(restoredBinding.capabilities.sessions.load, true);
    assert.equal((await request("/api/fleet")).body.bots[0].online, true);
    assert.deepEqual(
      (await request("/api/bots/pi/transcript")).body.transcript,
      beforeRestart
    );
    assert.deepEqual((await request("/api/bots/pi/model")).body, {
      model: "fixture/next/model",
    });
    assert.deepEqual((await request("/api/bots/pi/thinking")).body, {
      thinking: "high",
    });
    const restartReceipt = (
      await configure(
        "model",
        "fixture/next/model",
        "set-model",
        restoredBinding.bindingRevision
      )
    ).body;
    assert.equal(restartReceipt.result.status, "applied");
    assert.equal(restartReceipt.operationId, "set-model");
    const effectsFile = join(
      f.directory,
      ".fleet/plugins",
      binding.bindingId,
      "native-effects.jsonl"
    );
    const effectsAfter = (await readFile(effectsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      effectsAfter.filter((effect) => effect.command === "prompt").length,
      finalEffects.filter((effect) => effect.command === "prompt").length
    );
    assert.equal(effectsAfter.filter((effect) => effect.launch).length, 2);
    assert.equal(
      effectsAfter.filter((effect) => effect.command === "set_model").length,
      1
    );
    assert.equal(
      effectsAfter.filter((effect) => effect.command === "set_thinking_level")
        .length,
      2
    );
    const afterRestartImage = beforeRestart.find(
      (entry: any) => entry.images?.length
    )?.images[0];
    const download = await fetch(
      `${handle.url}/api/images/pi/${afterRestartImage.path.split("/").at(-1)}`,
      { headers: { authorization: "Bearer pi-fixture-token" } }
    );
    assert.equal(download.status, 200);
    assert.deepEqual(
      Buffer.from(await download.arrayBuffer()),
      Buffer.from(imageUploads[0].data, "base64")
    );
    assert.equal(
      (
        await request("/api/bots/pi/message", {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "after-gateway-restart",
            clientMessageId: "after-gateway-restart",
            conversationId: binding.conversationId,
            text: "after restart",
          }),
        })
      ).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/after-gateway-restart")).body
          .execution === "ended"
    );
    await handle.stop();
    const seed = (unknown = false) => {
      const journal = new GatewayJournal(
        join(f.directory, ".fleet", "gateway.sqlite")
      );
      const lease = journal.acquireWriterLease("fixture-seed");
      try {
        const saved = journal.listConversations()[0];
        if (unknown) {
          journal.admit(lease, {
            ...saved,
            operationId: "uncertain-before-restart",
            payload: { text: "uncertain" },
            publicBotName: "pi",
          });
          journal.reserveNext(lease, saved);
          journal.recordDisposition(
            lease,
            { ...saved, operationId: "uncertain-before-restart" },
            {
              delivery: "unknown",
              execution: "unknown",
              observation: "reconciliation_required",
            }
          );
        }
        journal.admit(lease, {
          ...saved,
          operationId: unknown ? "blocked-queued" : "retained-queued",
          payload: { text: "retained queued intent" },
          publicBotName: "pi",
        });
        if (!unknown)
          journal.admit(lease, {
            ...saved,
            operationId: "stale-queued-load",
            kind: "session_open",
            payload: { mode: "load", nativeReference: "pi:fixture-session" },
          });
      } finally {
        journal.releaseWriterLease(lease, { ownershipReconciled: true });
        journal.close();
      }
    };
    seed();
    handle = await startFleet({
      dir: f.directory,
      port: 0,
      token: "pi-fixture-token",
      log() {},
    });
    await until(
      async () =>
        (await request("/api/bots/pi/operations/retained-queued")).body
          .execution === "ended"
    );
    await handle.stop();
    const inspect = new GatewayJournal(
      join(f.directory, ".fleet", "gateway.sqlite")
    );
    try {
      assert.equal(
        inspect.getOperation({
          ...inspect.listConversations()[0],
          operationId: "stale-queued-load",
        })?.execution,
        "cancelled"
      );
    } finally {
      inspect.close();
    }
    const beforeUncertain = (await readFile(effectsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    seed(true);
    handle = await startFleet({
      dir: f.directory,
      port: 0,
      token: "pi-fixture-token",
      log() {},
    });
    assert.equal((await request("/api/fleet")).body.bots[0].online, false);
    assert.equal(
      (await request("/api/bots/pi/operations/uncertain-before-restart")).body
        .delivery,
      "unknown"
    );
    assert.equal(
      (await request("/api/bots/pi/operations/blocked-queued")).body.delivery,
      "queued"
    );
    assert.deepEqual(
      (await readFile(effectsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      beforeUncertain
    );
  } finally {
    await handle?.stop();
    await f.cleanup();
  }
});

test("Pi snapshots preserve split Unicode, corrections, multiple messages and native error outcomes", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    for (const [index, text] of ["unicode", "[multi]", "[error]"].entries()) {
      const id = `operation-${index}`;
      assert.deepEqual(await f.submit(host, text, id), {
        disposition: "accepted",
      });
      await until(() =>
        f.events.some((e) => e.operationId === id && e.type === "turn.terminal")
      );
      assert.deepEqual(await f.submit(host, text, id), {
        disposition: "accepted",
      });
    }
    const finals = f.events.filter((e) => e.type === "message.finished");
    assert.equal(finals.length, 4);
    assert.deepEqual(
      finals.map((e) => (e.payload.blocks as JsonObject[])[0].text),
      [
        "Hello 🦋\u2028world",
        "First corrected",
        "second",
        "Hello 🦋\u2028world",
      ]
    );
    assert.equal(new Set(finals.map((e) => e.messageId)).size, 4);
    assert.ok(!JSON.stringify(f.events).includes("PRIVATE_REASONING_CANARY"));
    assert.equal(
      f.events.find(
        (e) => e.operationId === "operation-2" && e.type === "turn.terminal"
      )!.payload.execution,
      "failed"
    );
    assert.equal(
      (await f.effects()).filter((e) => e.command === "prompt").length,
      3
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi native compaction admits on start, persists an inspected checkpoint, and emits no chat", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    await f.submit(host, "before compact");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    const before = f.events.length;
    assert.deepEqual(await f.compact(host), { disposition: "accepted" });
    await until(() =>
      f.events.some(
        (event) =>
          event.operationId === "compact-one" && event.type === "turn.terminal"
      )
    );
    const compactEvents = f.events
      .slice(before)
      .filter((event) => event.operationId === "compact-one");
    assert.deepEqual(
      compactEvents.map((event) => event.type),
      ["operation.disposition", "turn.started", "turn.terminal"]
    );
    assert.deepEqual(compactEvents.at(-1)!.payload, {
      execution: "ended",
      observation: "complete",
      result: { status: "applied" },
      evidence: "native_compaction_history_verified",
    });
    const checkpoint = JSON.parse(
      await readFile(join(f.dataDir, "pi-history.json"), "utf8")
    );
    assert.ok(checkpoint.history.size > 0);
    assert.ok(
      (await readFile(checkpoint.history.file, "utf8")).includes("compaction")
    );
    assert.equal(
      (await f.effects()).filter((effect) => effect.command === "compact")
        .length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

for (const [mode, execution] of [
  ["[compact-fail]", "failed"],
  ["[compact-hold]", "cancelled"],
] as const) {
  test(`Pi native compaction ${execution} keeps the settled context unchanged`, async () => {
    const f = await setup();
    try {
      const host = await f.start();
      await f.open(host);
      await f.submit(host, mode);
      await until(() =>
        f.events.some((event) => event.type === "turn.terminal")
      );
      const before = JSON.parse(
        await readFile(join(f.dataDir, "pi-history.json"), "utf8")
      );
      assert.deepEqual(await f.compact(host, `compact-${execution}`), {
        disposition: "accepted",
      });
      if (execution === "cancelled")
        assert.deepEqual(
          await host.request("operation.cancel", {
            operationId: "cancel-compact",
            targetOperationId: "compact-cancelled",
            payloadDigest: "cancel-compact",
            conversationId: "conversation",
          }),
          { status: "requested" }
        );
      await until(() =>
        f.events.some(
          (event) =>
            event.operationId === `compact-${execution}` &&
            event.type === "turn.terminal"
        )
      );
      const terminal = f.events.find(
        (event) =>
          event.operationId === `compact-${execution}` &&
          event.type === "turn.terminal"
      )!;
      assert.equal(terminal.payload.execution, execution);
      assert.deepEqual(terminal.payload.result, { status: execution });
      assert.deepEqual(
        JSON.parse(await readFile(join(f.dataDir, "pi-history.json"), "utf8")),
        before
      );
    } finally {
      await f.cleanup();
    }
  });
}

for (const mode of [
  "[compact-missing-evidence]",
  "[compact-history-mismatch]",
]) {
  test(`Pi ${mode} records an observation gap instead of a compaction result`, async () => {
    const f = await setup();
    try {
      const host = await f.start();
      await f.open(host);
      await f.submit(host, mode);
      await until(() =>
        f.events.some((event) => event.type === "turn.terminal")
      );
      assert.deepEqual(await f.compact(host, `compact-${mode}`), {
        disposition: "accepted",
      });
      await until(() =>
        f.events.some((event) => event.type === "observation.gap")
      );
      assert.equal(
        f.events.some(
          (event) =>
            event.operationId === `compact-${mode}` &&
            event.type === "turn.terminal"
        ),
        false
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("Pi refusal is distinct from acceptance and exact cancellation does not target another turn", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    assert.deepEqual(await f.submit(host, "[reject]", "reject"), {
      disposition: "rejected",
    });
    assert.deepEqual(await f.submit(host, "[hold]", "hold"), {
      disposition: "accepted",
    });
    const control = {
      operationId: "wrong-cancel",
      targetOperationId: "other",
      payloadDigest: "wrong",
      conversationId: "conversation",
    };
    assert.deepEqual(await host.request("operation.cancel", control), {
      status: "unknown",
    });
    assert.equal(
      (await f.effects()).filter((e) => e.command === "abort").length,
      0
    );
    const cancel = {
      ...control,
      operationId: "cancel",
      targetOperationId: "hold",
      payloadDigest: "cancel",
    };
    assert.deepEqual(await host.request("operation.cancel", cancel), {
      status: "requested",
    });
    assert.deepEqual(await host.request("operation.cancel", cancel), {
      status: "requested",
    });
    await until(() => f.events.some((e) => e.type === "turn.terminal"));
    assert.equal(
      f.events.find((e) => e.type === "turn.terminal")!.payload.execution,
      "cancelled"
    );
    assert.equal(
      (await f.effects()).filter((e) => e.command === "abort").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

for (const text of [
  "[malformed]",
  "[oversize]",
  "[invalid-utf8]",
  "[tool]",
  "[fleet-unsettled]",
  "[fleet-no-events]",
]) {
  test(`Pi ${text} records observation loss and closes owned native execution`, async () => {
    const f = await setup();
    try {
      const host = await f.start();
      await f.open(host);
      await f.submit(host, text).catch(() => {});
      await until(() => f.events.some((e) => e.type === "observation.gap"));
      await host.closed;
      assert.ok(!f.events.some((e) => e.type === "turn.terminal"));
      assert.equal(
        (await f.effects()).filter((e) => e.command === "prompt").length,
        1
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("Pi uncertain submission survives adapter restart without opening or prompting again", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    await f.submit(host, "[unknown]").catch(() => {});
    await host.close();
    const recovered = await f.start({}, 2);
    assert.deepEqual(await f.submit(recovered, "[unknown]"), {
      disposition: "unknown",
    });
    const result = (await recovered.request("operation.inspect", {
      operationId: "operation-one",
    })) as JsonObject;
    assert.equal(result.disposition, "unknown");
    assert.equal((await f.effects()).filter((e) => e.launch).length, 1);
    assert.equal(
      (await f.effects()).filter((e) => e.command === "prompt").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi cold load restores exact checkpoint across process replacement without replaying prompts", async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const opened = (await f.open(first)) as JsonObject;
    await f.submit(first, "before restart");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    const checkpoint = JSON.parse(
      await readFile(join(f.dataDir, "pi-history.json"), "utf8")
    );
    assert.equal(checkpoint.messageCount, 1);
    assert.deepEqual(checkpoint.settings, {
      provider: "fixture",
      modelId: "saved-model",
      thinkingLevel: "medium",
    });
    assert.equal(checkpoint.conversationId, "conversation");
    await first.close();
    const second = await f.start({ model: "startup-override" }, 2);
    const load = {
      openId: "load-two",
      payloadDigest: "load-two",
      conversationId: "conversation",
      mode: "load",
      cwd: f.directory,
      nativeReference: opened.nativeReference,
    };
    const restored = (await second.request("session.open", load)) as JsonObject;
    assert.equal(restored.continuity, "verified");
    assert.equal(restored.nativeReference, opened.nativeReference);
    assert.deepEqual(await second.request("session.open", load), restored);
    let effects = await f.effects();
    assert.equal(
      effects.filter((effect) => effect.command === "prompt").length,
      1
    );
    const launches = effects.filter((effect) => effect.launch);
    assert.equal(launches.length, 2);
    const argv = launches[1].argv as string[];
    assert.equal(argv.includes("--continue"), false);
    assert.equal(argv.includes("--model"), false);
    assert.equal(argv[argv.indexOf("--session") + 1], checkpoint.history.file);
    await f.submit(second, "after restart", "operation-two");
    await until(() =>
      f.events.some(
        (event) =>
          event.type === "turn.terminal" &&
          event.operationId === "operation-two"
      )
    );
    effects = await f.effects();
    assert.equal(
      effects.filter((effect) => effect.command === "prompt").length,
      2
    );
    assert.equal(
      JSON.parse(await readFile(join(f.dataDir, "pi-history.json"), "utf8"))
        .messageCount,
      2
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi cold load refuses changed history before launching a replacement native process", async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const opened = (await f.open(first)) as JsonObject;
    await f.submit(first, "before restart");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    await first.close();
    const checkpoint = JSON.parse(
      await readFile(join(f.dataDir, "pi-history.json"), "utf8")
    );
    await writeFile(checkpoint.history.file, "");
    const second = await f.start({}, 2);
    await assert.rejects(
      second.request("session.open", {
        openId: "load-two",
        payloadDigest: "load-two",
        conversationId: "conversation",
        mode: "load",
        cwd: f.directory,
        nativeReference: opened.nativeReference,
      }),
      { code: "continuity_unverified" }
    );
    assert.equal(
      (await f.effects()).filter((effect) => effect.launch).length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi checkpoint write failure cannot publish a complete terminal receipt", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    await mkdir(join(f.dataDir, "pi-history.json"));
    await f.submit(host, "checkpoint failure");
    await until(() =>
      f.events.some((event) => event.type === "observation.gap")
    );
    assert.equal(
      f.events.some((event) => event.type === "turn.terminal"),
      false
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi load refuses a native message-count mismatch without sending another prompt", async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const opened = (await f.open(first)) as JsonObject;
    await f.submit(first, "before restart");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    await first.close();
    const executable = join(f.directory, "native", "native.mjs");
    const original = await readFile(executable, "utf8");
    assert.ok(original.includes("      messageCount,"));
    await writeFile(
      executable,
      original.replace(
        "      messageCount,",
        "      messageCount: messageCount + 1,"
      )
    );
    const second = await f.start({}, 2);
    await assert.rejects(
      second.request("session.open", {
        openId: "load-two",
        payloadDigest: "load-two",
        conversationId: "conversation",
        mode: "load",
        cwd: f.directory,
        nativeReference: opened.nativeReference,
      }),
      { code: "continuity_unverified" }
    );
    assert.equal(
      (await f.effects()).filter((effect) => effect.command === "prompt")
        .length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi cold load rejects changed effective model or thinking level", async () => {
  for (const [before, after] of [
    ['id: "saved-model"', 'id: "other-model"'],
    ['thinkingLevel: "medium"', 'thinkingLevel: "low"'],
    ['provider: "fixture"', 'provider: "other"'],
    ['thinkingLevel: "medium"', "thinkingLevel: undefined"],
    ['id: "saved-model"', "id: undefined"],
  ]) {
    const f = await setup();
    try {
      const first = await f.start();
      const opened = (await f.open(first)) as JsonObject;
      await f.submit(first, "before restart");
      await until(() =>
        f.events.some((event) => event.type === "turn.terminal")
      );
      await first.close();
      const executable = join(f.directory, "native", "native.mjs");
      const original = await readFile(executable, "utf8");
      assert.ok(original.includes(before));
      await writeFile(executable, original.replace(before, after));
      const second = await f.start({}, 2);
      await assert.rejects(
        second.request("session.open", {
          openId: "load-two",
          payloadDigest: "load-two",
          conversationId: "conversation",
          mode: "load",
          cwd: f.directory,
          nativeReference: opened.nativeReference,
        }),
        { code: "continuity_unverified" }
      );
      assert.equal(
        (await f.effects()).filter((effect) => effect.command === "prompt")
          .length,
        1
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("Pi configuration and cold-load failures cannot start native execution", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.start({ executable: "pi" }));
    await assert.rejects(f.start({ environment_keys: ["TIDY_TEST_SECRET"] }));
    assert.deepEqual(await f.effects(), []);
  } finally {
    await f.cleanup();
  }
  const fresh = await setup();
  try {
    const host = await fresh.start();
    await assert.rejects(
      host.request("session.open", {
        openId: "load",
        payloadDigest: "load",
        mode: "load",
        conversationId: "conversation",
        cwd: fresh.directory,
        nativeReference: "missing",
      })
    );
    assert.deepEqual(await fresh.effects(), []);
  } finally {
    await fresh.cleanup();
  }
});

test("Pi parent pipe loss reaps the owned native child without resubmitting held work", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    await f.submit(host, "[hold]");
    const pid = Number(
      (await f.effects()).find((effect) => effect.launch)!.launch
    );
    process.kill(pid, 0);
    (host as unknown as { child: { stdin: Writable } }).child.stdin.end();
    await host.closed;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const recovered = await f.start({}, 2);
    const inspection = (await recovered.request("operation.inspect", {
      operationId: "operation-one",
    })) as JsonObject;
    assert.equal(inspection.disposition, "accepted");
    assert.equal(inspection.execution, "unknown");
    assert.equal(
      (await f.effects()).filter((effect) => effect.command === "prompt")
        .length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi new-session admission refuses existing native storage instead of adopting it", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    const storage = join(f.dataDir, "native-sessions");
    await mkdir(storage);
    await writeFile(join(storage, "retained.jsonl"), "retained history\n");
    await assert.rejects(f.open(host));
    assert.deepEqual(await f.effects(), []);
    assert.equal(
      await readFile(join(storage, "retained.jsonl"), "utf8"),
      "retained history\n"
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi unsupported runtime metadata fails negotiation before any native execution", async () => {
  const f = await setup();
  try {
    await writeFile(
      f.metadata,
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.0.0",
        bin: { pi: "native.mjs" },
      })
    );
    await assert.rejects(f.start());
    assert.deepEqual(await f.effects(), []);
  } finally {
    await f.cleanup();
  }
});

test("Pi settings controls read back native state, dedupe and survive process replacement", async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const opened = (await f.open(first)) as JsonObject;
    const snapshot = () =>
      first.request("session.snapshot", {
        conversationId: "conversation",
      }) as Promise<JsonObject>;
    assert.deepEqual((await snapshot()).thinkingLevels, [
      "off",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual((await snapshot()).settings, {
      model: "fixture/saved-model",
      thinking: "medium",
    });
    const thinking = {
      operationId: "thinking-one",
      payloadDigest: "thinking-one",
      conversationId: "conversation",
      kind: "thinking",
      thinking: "high",
    };
    assert.equal(
      ((await first.request("session.configure", thinking)) as JsonObject)
        .status,
      "applied"
    );
    await f.submit(first, "retain history");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    const model = {
      operationId: "model-one",
      payloadDigest: "model-one",
      conversationId: "conversation",
      kind: "model",
      model: "fixture/next/model",
    };
    const applied = await first.request("session.configure", model);
    assert.deepEqual(applied, {
      disposition: "accepted",
      status: "applied",
      settings: { model: "fixture/next/model", thinking: "high" },
    });
    assert.deepEqual(await first.request("session.configure", model), applied);
    await assert.rejects(
      first.request("session.configure", {
        ...model,
        model: "fixture/saved-model",
      }),
      { code: "payload_conflict" }
    );
    assert.deepEqual(
      (await snapshot()).settings,
      (applied as JsonObject).settings
    );
    await first.close();
    const second = await f.start({}, 2);
    await second.request("session.open", {
      openId: "restore-settings",
      payloadDigest: "restore-settings",
      conversationId: "conversation",
      mode: "load",
      cwd: f.directory,
      nativeReference: opened.nativeReference,
    });
    assert.deepEqual(
      (
        (await second.request("session.snapshot", {
          conversationId: "conversation",
        })) as JsonObject
      ).settings,
      (applied as JsonObject).settings
    );
    assert.deepEqual(await second.request("session.configure", model), applied);
    const effects = await f.effects();
    assert.equal(
      effects.filter((effect) => effect.command === "set_model").length,
      1
    );
    assert.equal(
      effects.filter((effect) => effect.command === "set_thinking_level")
        .length,
      1
    );
    assert.equal(
      effects.filter((effect) => effect.command === "prompt").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi settings reject invalid or busy changes before native mutation", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    let index = 0;
    const configure = (args: JsonObject) =>
      host.request("session.configure", {
        operationId: `invalid-${++index}`,
        payloadDigest: `invalid-${index}`,
        conversationId: "conversation",
        ...args,
      });
    for (const args of [
      { kind: "model", model: "not-a-model" },
      { kind: "thinking", thinking: "yolo" },
      { kind: "thinking", thinking: "xhigh" },
      { kind: "thinking", thinking: ["high"] },
      { kind: ["thinking"], thinking: "high" },
      { kind: "model", model: "fixture/saved-model", conversationId: "other" },
    ]) {
      assert.deepEqual(await configure(args), {
        disposition: "rejected",
        status: "failed",
      });
    }
    await f.submit(host, "[hold]");
    assert.deepEqual(
      await configure({ kind: "model", model: "fixture/next/model" }),
      { disposition: "rejected", status: "failed" }
    );
    assert.equal(
      (await f.effects()).filter((effect) =>
        ["set_model", "set_thinking_level"].includes(String(effect.command))
      ).length,
      0
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi lost configuration response cannot claim application or replay the mutation", async () => {
  const f = await setup();
  try {
    const executable = join(f.directory, "native", "native.mjs");
    const original = await readFile(executable, "utf8");
    const before =
      '    response(request);\n  } else if (request.type === "set_thinking_level")';
    assert.ok(original.includes(before));
    await writeFile(
      executable,
      original.replace(
        before,
        '    /* lose response after native write */\n  } else if (request.type === "set_thinking_level")'
      )
    );
    const first = await f.start();
    const opened = (await f.open(first)) as JsonObject;
    await f.submit(first, "retain history");
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    const model = {
      operationId: "lost-model",
      payloadDigest: "lost-model",
      conversationId: "conversation",
      kind: "model",
      model: "fixture/next/model",
    };
    const result = (await first
      .request("session.configure", model)
      .catch(() => ({ status: "unknown" }))) as JsonObject;
    assert.notEqual(result.status, "applied");
    await until(() =>
      f.events.some((event) => event.type === "observation.gap")
    );
    await first.close();
    const second = await f.start({}, 2);
    const retained = (await second.request(
      "session.configure",
      model
    )) as JsonObject;
    assert.notEqual(retained.status, "applied");
    await assert.rejects(
      second.request("session.open", {
        openId: "restore-lost",
        payloadDigest: "restore-lost",
        conversationId: "conversation",
        mode: "load",
        cwd: f.directory,
        nativeReference: opened.nativeReference,
      }),
      { code: "observation_gap" }
    );
    assert.equal(
      (await f.effects()).filter((effect) => effect.command === "set_model")
        .length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Pi configuration readback and checkpoint failures leave uncertainty", async () => {
  for (const failure of ["readback", "checkpoint"]) {
    const f = await setup();
    try {
      if (failure === "readback") {
        const executable = join(f.directory, "native", "native.mjs");
        const original = await readFile(executable, "utf8");
        assert.ok(original.includes("settings.thinkingLevel = request.level;"));
        await writeFile(
          executable,
          original.replace(
            "settings.thinkingLevel = request.level;",
            'settings.thinkingLevel = "off";'
          )
        );
      }
      const host = await f.start();
      await f.open(host);
      await f.submit(host, "retain history");
      await until(() =>
        f.events.some((event) => event.type === "turn.terminal")
      );
      if (failure === "checkpoint") {
        await rm(join(f.dataDir, "pi-history.json"));
        await mkdir(join(f.dataDir, "pi-history.json"));
      }
      const result = (await host
        .request("session.configure", {
          operationId: "uncertain-thinking",
          payloadDigest: "uncertain-thinking",
          conversationId: "conversation",
          kind: "thinking",
          thinking: "high",
        })
        .catch(() => ({ status: "unknown" }))) as JsonObject;
      assert.notEqual(result.status, "applied");
      await until(() =>
        f.events.some((event) => event.type === "observation.gap")
      );
      assert.equal(
        (await f.effects()).filter(
          (effect) => effect.command === "set_thinking_level"
        ).length,
        1
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("Pi generic UI response is one bridge write, remains consumption-unconfirmed, and permits the next turn", async () => {
  const f = await setup();
  try {
    const host = await f.start();
    await f.open(host);
    assert.equal(host.capabilities.interactions.permissions, "none");
    assert.equal(host.capabilities.interactions.questions, true);
    assert.deepEqual(await f.submit(host, "[ui-select]", "ui-target"), {
      disposition: "accepted",
    });
    await until(() =>
      f.events.some(
        (event) =>
          event.type === "interaction.requested" ||
          event.type === "observation.gap"
      )
    );
    assert.ok(
      f.events.some((event) => event.type === "interaction.requested"),
      JSON.stringify(f.events)
    );
    const descriptor = f.events.find(
      (event) => event.type === "interaction.requested"
    )!.payload as JsonObject;
    assert.equal(descriptor.kind, "question");
    assert.equal(descriptor.method, "select");
    assert.deepEqual(descriptor.options, ["Morning", "Evening"]);
    const answer = {
      kind: "question",
      operationId: "ui-answer",
      conversationId: "conversation",
      bindingId: descriptor.bindingId,
      instanceId: descriptor.instanceId,
      targetOperationId: descriptor.operationId,
      turnId: descriptor.turnId,
      interactionId: descriptor.interactionId,
      optionsDigest: descriptor.optionsDigest,
      revision: descriptor.revision,
      value: "Evening",
      payloadDigest: "ui-answer-digest",
      policyRevision: "policy",
    };
    assert.deepEqual(await host.request("interaction.respond", answer), {
      status: "unknown",
      transport: "submitted",
      consumption: "unconfirmed",
    });
    await until(() => f.events.some((event) => event.type === "turn.terminal"));
    assert.equal(
      (await f.effects()).filter((e) => e.command === "extension_ui_response")
        .length,
      1
    );
    assert.deepEqual(await f.submit(host, "after question", "after-question"), {
      disposition: "accepted",
    });
    await until(
      () =>
        f.events.filter((event) => event.type === "turn.terminal").length === 2
    );
  } finally {
    await f.cleanup();
  }
});

test("startFleet admits Pi questions through exact HTTP controls without certifying native consumption", async () => {
  const f = await setup();
  let handle: FleetHandle | undefined;
  try {
    await writeFile(
      join(f.directory, "AGENTS.md"),
      "Disposable Pi UI HTTP fixture.\n"
    );
    await writeFile(
      join(f.directory, "bots.toml"),
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
        ...Object.entries(f.config).map(
          ([key, value]) => `${key} = ${JSON.stringify(value)}`
        ),
        "",
      ].join("\n")
    );
    handle = await startFleet({
      dir: f.directory,
      port: 0,
      token: "pi-ui-token",
      log() {},
    });
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(handle!.url + path, {
        ...options,
        headers: { authorization: "Bearer pi-ui-token", ...options.headers },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    };
    const binding = (await request("/api/bots/pi/capabilities")).body;
    assert.equal(binding.capabilities.interactions.questions, true);
    assert.equal(binding.capabilities.interactions.permissions, "none");
    const headers = {
      "content-type": "application/json",
      "x-tidy-client-contract": "2",
      "x-tidy-binding-revision": binding.bindingRevision,
    };
    const submit = (operationId: string, text: string) =>
      request("/api/bots/pi/message", {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationId,
          clientMessageId: operationId,
          conversationId: binding.conversationId,
          text,
        }),
      });
    const initial = await submit("ui-http-target", "[ask-user]");
    assert.equal(initial.status, 202, JSON.stringify(initial.body));
    await until(async () =>
      Boolean(
        (
          (await request("/api/bots/pi/transcript")).body
            .transcript as JsonObject[]
        ).find((entry) => entry.question)?.question
      )
    );
    const question = questionForOperation(
      (await request("/api/bots/pi/transcript")).body
        .transcript as JsonObject[],
      "ui-http-target"
    )!;
    const answer = {
      kind: "question",
      operationId: "ui-http-answer",
      conversationId: binding.conversationId,
      bindingId: question.bindingId,
      instanceId: question.instanceId,
      targetOperationId: question.operationId,
      turnId: question.turnId,
      interactionId: question.interactionId,
      optionsDigest: question.optionsDigest,
      revision: question.revision,
      value: "Evening",
    };
    const decide = (body = answer) =>
      request(
        `/api/bots/pi/questions/${encodeURIComponent(String(question.interactionId))}`,
        { method: "POST", headers, body: JSON.stringify(body) }
      );
    assert.equal((await decide()).status, 202);
    await until(
      async () =>
        (await request("/api/bots/pi/operations/ui-http-answer")).body
          .execution === "ended"
    );
    const decision = (await request("/api/bots/pi/operations/ui-http-answer"))
      .body;
    assert.deepEqual(decision.result, {
      status: "unknown",
      transport: "submitted",
      consumption: "unconfirmed",
    });
    assert.deepEqual((await decide()).body, decision);
    assert.equal((await decide({ ...answer, value: "Morning" })).status, 409);
    await until(
      async () =>
        (await request("/api/bots/pi/operations/ui-http-target")).body
          .execution === "ended"
    );
    assert.equal(
      (await submit("ui-http-followup", "after HTTP question")).status,
      202
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      (await request("/api/bots/pi/operations/ui-http-followup")).body
        .execution,
      "ended",
      JSON.stringify(
        (await request("/api/bots/pi/operations/ui-http-followup")).body
      )
    );
    for (const [mode, response] of [
      ["[ui-confirm]", { confirmed: true }],
      ["[ui-input]", { value: "alpha" }],
      ["[ui-editor]", { value: "notes" }],
    ] as const) {
      const target = `http-${mode.slice(4, -1)}`;
      assert.equal((await submit(target, mode)).status, 202);
      await until(async () =>
        Boolean(
          ((await request("/api/bots/pi/transcript")).body
            .transcript as JsonObject[]) &&
          questionForOperation(
            (await request("/api/bots/pi/transcript")).body
              .transcript as JsonObject[],
            target
          )
        )
      );
      const q = questionForOperation(
        (await request("/api/bots/pi/transcript")).body
          .transcript as JsonObject[],
        target
      )!;
      if (mode === "[ui-editor]") assert.equal(q.prefill, "Initial notes");
      const body = {
        kind: "question",
        operationId: `${target}-answer`,
        conversationId: binding.conversationId,
        bindingId: q.bindingId,
        instanceId: q.instanceId,
        targetOperationId: q.operationId,
        turnId: q.turnId,
        interactionId: q.interactionId,
        optionsDigest: q.optionsDigest,
        revision: q.revision,
        ...response,
      };
      assert.equal(
        (
          await request(
            `/api/bots/pi/questions/${encodeURIComponent(String(q.interactionId))}`,
            { method: "POST", headers, body: JSON.stringify(body) }
          )
        ).status,
        202
      );
      await until(
        async () =>
          (await request(`/api/bots/pi/operations/${target}`)).body
            .execution === "ended"
      );
    }

    const effectsBeforeTimeout = (await f.effects()).filter(
      (effect) => effect.command === "extension_ui_response"
    ).length;
    assert.equal(
      (await submit("ui-timeout-target", "[ui-timeout]")).status,
      202
    );
    await until(async () =>
      Boolean(
        ((await request("/api/bots/pi/transcript")).body
          .transcript as JsonObject[]) &&
        questionForOperation(
          (await request("/api/bots/pi/transcript")).body
            .transcript as JsonObject[],
          "ui-timeout-target"
        )
      )
    );
    const timed = questionForOperation(
      (await request("/api/bots/pi/transcript")).body
        .transcript as JsonObject[],
      "ui-timeout-target"
    )!;
    assert.equal(typeof timed.expiresAt, "string");
    await until(
      async () =>
        (await request("/api/bots/pi/operations/ui-timeout-target")).body
          .execution === "ended"
    );
    const late = {
      kind: "question",
      operationId: "ui-timeout-late",
      conversationId: binding.conversationId,
      bindingId: timed.bindingId,
      instanceId: timed.instanceId,
      targetOperationId: timed.operationId,
      turnId: timed.turnId,
      interactionId: timed.interactionId,
      optionsDigest: timed.optionsDigest,
      revision: timed.revision,
      expiresAt: timed.expiresAt,
      value: "Only",
    };
    assert.equal(
      (
        await request(
          `/api/bots/pi/questions/${encodeURIComponent(String(timed.interactionId))}`,
          { method: "POST", headers, body: JSON.stringify(late) }
        )
      ).status,
      410
    );
    assert.equal(
      (await f.effects()).filter(
        (effect) => effect.command === "extension_ui_response"
      ).length,
      effectsBeforeTimeout
    );
  } finally {
    await handle?.stop();
    await f.cleanup();
  }
});

test("startFleet fences persisted Pi questions across daemon replacement without replaying native responses", async () => {
  const f = await setup();
  let handle: FleetHandle | undefined;
  try {
    await writeFile(
      join(f.directory, "AGENTS.md"),
      "Disposable Pi question recovery fixture.\n"
    );
    await writeFile(
      join(f.directory, "bots.toml"),
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
        ...Object.entries(f.config).map(
          ([key, value]) => `${key} = ${JSON.stringify(value)}`
        ),
        "",
      ].join("\n")
    );
    const boot = async () =>
      (handle = await startFleet({
        dir: f.directory,
        port: 0,
        token: "pi-question-recovery-token",
        log() {},
      }));
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(handle!.url + path, {
        ...options,
        headers: {
          authorization: "Bearer pi-question-recovery-token",
          ...options.headers,
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    };
    const headers = (binding: Record<string, any>) => ({
      "content-type": "application/json",
      "x-tidy-client-contract": "2",
      "x-tidy-binding-revision": binding.bindingRevision,
    });
    const ready = () =>
      until(async () =>
        Boolean((await request("/api/fleet")).body.bots?.[0]?.online)
      );
    const submit = (
      binding: Record<string, any>,
      operationId: string,
      text: string
    ) =>
      request("/api/bots/pi/message", {
        method: "POST",
        headers: headers(binding),
        body: JSON.stringify({
          operationId,
          clientMessageId: operationId,
          conversationId: binding.conversationId,
          text,
        }),
      });
    const questionFor = async (operationId: string) => {
      await until(async () =>
        Boolean(
          ((await request("/api/bots/pi/transcript")).body
            .transcript as JsonObject[]) &&
          questionForOperation(
            (await request("/api/bots/pi/transcript")).body
              .transcript as JsonObject[],
            operationId
          )
        )
      );
      return questionForOperation(
        (await request("/api/bots/pi/transcript")).body
          .transcript as JsonObject[],
        operationId
      )!;
    };
    const answerFor = (
      binding: Record<string, any>,
      question: Record<string, any>,
      operationId: string
    ) => ({
      kind: "question",
      operationId,
      conversationId: binding.conversationId,
      bindingId: question.bindingId,
      instanceId: question.instanceId,
      targetOperationId: question.operationId,
      turnId: question.turnId,
      interactionId: question.interactionId,
      optionsDigest: question.optionsDigest,
      revision: question.revision,
      value: "Evening",
    });
    const respond = (
      binding: Record<string, any>,
      question: Record<string, any>,
      body: Record<string, any>
    ) =>
      request(
        `/api/bots/pi/questions/${encodeURIComponent(String(question.interactionId))}`,
        {
          method: "POST",
          headers: headers(binding),
          body: JSON.stringify(body),
        }
      );

    await boot();
    await ready();
    let binding = (await request("/api/bots/pi/capabilities")).body;
    // A fully settled target produces Pi's inspected checkpoint, so the next
    // daemon can launch a replacement native session from verified history.
    assert.equal(
      (await submit(binding, "restart-submitted", "[ui-select]")).status,
      202
    );
    const submittedQuestion = await questionFor("restart-submitted");
    const submittedAnswer = answerFor(
      binding,
      submittedQuestion,
      "restart-submitted-answer"
    );
    assert.equal(
      (await respond(binding, submittedQuestion, submittedAnswer)).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/restart-submitted")).body
          .execution === "ended"
    );
    const canonical = (
      await request("/api/bots/pi/operations/restart-submitted-answer")
    ).body;
    assert.deepEqual(canonical.result, {
      status: "unknown",
      transport: "submitted",
      consumption: "unconfirmed",
    });
    const writesBeforeSubmittedRestart = (await f.effects()).filter(
      (effect) => effect.command === "extension_ui_response"
    ).length;
    await handle!.stop();
    await boot();
    await ready();
    binding = (await request("/api/bots/pi/capabilities")).body;
    const retried = await respond(binding, submittedQuestion, submittedAnswer);
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.deepEqual(retried.body, canonical);
    assert.equal(
      (await f.effects()).filter(
        (effect) => effect.command === "extension_ui_response"
      ).length,
      writesBeforeSubmittedRestart,
      "a persisted submitted answer retry must not replay the native response"
    );
    assert.equal(
      (
        await submit(
          binding,
          "restart-after-submitted",
          "after submitted restart"
        )
      ).status,
      202
    );
    await until(
      async () =>
        (await request("/api/bots/pi/operations/restart-after-submitted")).body
          .execution === "ended"
    );

    // An unfinished native turn deliberately has no checkpoint. Replacement
    // therefore refuses readiness; the old question is never targeted at a
    // different native instance and the journal cannot replay its answer.
    assert.equal(
      (await submit(binding, "restart-pending", "[ui-select]")).status,
      202
    );
    const pending = await questionFor("restart-pending");
    const writesBeforePendingRestart = (await f.effects()).filter(
      (effect) => effect.command === "extension_ui_response"
    ).length;
    await handle!.stop();
    await boot();
    await until(
      async () => (await request("/api/fleet")).body.bots?.[0]?.online === false
    );
    const stale = await respond(
      binding,
      pending,
      answerFor(binding, pending, "restart-pending-answer")
    );
    assert.equal(stale.status, 503, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "session_unavailable");
    assert.equal(
      (await f.effects()).filter(
        (effect) => effect.command === "extension_ui_response"
      ).length,
      writesBeforePendingRestart,
      "an old pending question must never write after replacement refusal"
    );
    const pendingReceipt = (
      await request("/api/bots/pi/operations/restart-pending")
    ).body;
    assert.equal(
      pendingReceipt.execution,
      "unknown",
      JSON.stringify(pendingReceipt)
    );
    assert.equal(pendingReceipt.observation, "reconciliation_required");
    assert.equal(pendingReceipt.result, undefined);
  } finally {
    await handle?.stop();
    await f.cleanup();
  }
});

test("owned ask_user_question bridge settles after a generic UI response", async () => {
  const f = await setup();
  try {
    const h = await f.start();
    await f.open(h);
    await f.submit(h, "[ask-user]", "ask-debug");
    await until(() => f.events.some((e) => e.type === "interaction.requested"));
    const d = f.events.find((e) => e.type === "interaction.requested")!
      .payload as JsonObject;
    await h.request("interaction.respond", {
      kind: "question",
      operationId: "ask-debug-answer",
      payloadDigest: "x",
      policyRevision: "p",
      conversationId: "conversation",
      bindingId: d.bindingId,
      instanceId: d.instanceId,
      targetOperationId: d.operationId,
      turnId: d.turnId,
      interactionId: d.interactionId,
      optionsDigest: d.optionsDigest,
      revision: d.revision,
      value: "Evening",
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      f.events.some((e) => e.type === "turn.terminal"),
      JSON.stringify(f.events)
    );
  } finally {
    await f.cleanup();
  }
});
