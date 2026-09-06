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
import type {
  GatewayPluginEvent,
  JsonObject,
} from "../src/gateway/protocol.ts";

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
    assert.equal(checkpoint.conversationId, "conversation");
    await first.close();
    const second = await f.start({}, 2);
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
