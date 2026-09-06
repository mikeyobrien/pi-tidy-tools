import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  PluginHost,
  type PluginHostOptions,
} from "../src/gateway/plugin-host.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";
import {
  processIdentity,
  ownedGroupHasExited,
} from "../src/gateway/process-ownership.ts";
import { digestArtifact, PluginRegistry } from "../src/gateway/registry.ts";
import {
  DEFAULT_LIMITS,
  FrameDecoder,
  type GatewayPluginEvent,
  type ProtocolLimits,
  type RpcMessage,
} from "../src/gateway/protocol.ts";

async function fixture(nativeProfile = false) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-sdk-runtime-"));
  const artifact = join(dir, "artifact");
  await mkdir(artifact);
  const script = (
    await readFile(
      new URL("./fixtures/plugin-sdk/backend.mjs", import.meta.url),
      "utf8"
    )
  ).replace(
    "SDK_INDEX_URL",
    new URL("../src/plugin-sdk/index.ts", import.meta.url).href
  );
  await writeFile(
    join(artifact, "backend.mjs"),
    nativeProfile
      ? script.replace("fleetTools: true", "fleetTools: false")
      : script
  );
  await chmod(join(artifact, "backend.mjs"), 0o755);
  await writeFile(
    join(artifact, "backend.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "org.example.sdk-fixture",
      version: "1.0.0",
      protocol: { major: 1, minMinor: 0, maxMinor: 0 },
      entrypoint: { path: "backend.mjs", args: [] },
      configSchema: "config.schema.json",
      runtime: {
        name: "sdk-native-fixture",
        testedVersion: "1.0.0",
        transport: "stdio",
      },
      requestedAccess: {
        workspace: "none",
        nativeProfile,
        network: false,
        gatewayTools: ["fleet.send"],
      },
    })
  );
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      type: "object",
      properties: { mode: { type: "string" } },
      additionalProperties: false,
    })
  );
  const registryPath = join(dir, "registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.sdk-fixture",
          version: "1.0.0",
          artifactPath: artifact,
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
      ],
    })
  );
  const installation = (
    await PluginRegistry.load(registryPath, {
      policy: { gatewayTools: ["fleet.send"], nativeProfile },
    })
  ).resolve("org.example.sdk-fixture");
  const hosts: PluginHost[] = [];
  const events: GatewayPluginEvent[] = [];
  const dataDir = join(dir, "data");
  const rawChildren: ReturnType<typeof spawn>[] = [];
  return {
    dir,
    dataDir,
    events,
    async raw(mode?: string, limits: Partial<ProtocolLimits> = {}) {
      await mkdir(dataDir, { recursive: true });
      const child = spawn(process.execPath, [join(artifact, "backend.mjs")], {
        env: { PATH: dirname(process.execPath), TIDY_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      rawChildren.push(child);
      const messages: RpcMessage[] = [];
      const pending = new Map<
        string,
        {
          resolve(value: unknown): void;
          reject(error: unknown): void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      let nextId = 0;
      const parser = new FrameDecoder();
      child.stdout!.on("data", (bytes) =>
        parser.push(bytes, (message) => {
          messages.push(message);
          const call = message.id ? pending.get(message.id) : undefined;
          if (call) {
            pending.delete(message.id!);
            clearTimeout(call.timer);
            if (message.error) call.reject(message.error);
            else call.resolve(message.result);
          }
        })
      );
      child.stderr!.resume();
      const closed = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) =>
        child.once("close", (code, signal) => {
          for (const call of pending.values()) {
            clearTimeout(call.timer);
            call.reject(new Error("SDK process exited"));
          }
          pending.clear();
          resolve({ code, signal });
        })
      );
      const request = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<unknown>((resolve, reject) => {
          const id = `raw-${++nextId}`;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Raw SDK request timed out"));
          }, 3000);
          pending.set(id, { resolve, reject, timer });
          child.stdin!.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params: {
                bindingId: "sdk-binding",
                leaseGeneration: 1,
                ...params,
              },
            }) + "\n"
          );
        });
      const initialize = () =>
        request("initialize", {
          protocol: { major: 1, minMinor: 0, maxMinor: 0 },
          expectedPlugin: { id: "org.example.sdk-fixture", version: "1.0.0" },
          instanceId: "raw-instance",
          config: mode ? { mode } : {},
          workspace: dir,
          dataDir,
          limits: { ...DEFAULT_LIMITS, ...limits },
        });
      return { child, messages, request, initialize, closed };
    },
    async start(
      overrides: {
        lease?: number;
        mode?: string;
        limits?: Partial<ProtocolLimits>;
        event?: (event: GatewayPluginEvent) => Promise<number>;
        hostCall?: () => Promise<unknown>;
        ownership?: string;
        lifecycle?: Pick<
          PluginHostOptions,
          "onLaunchPrepared" | "onLaunchRecorded" | "onLaunchStopped"
        >;
      } = {}
    ) {
      const host = await PluginHost.start({
        installation,
        bindingId: "sdk-binding",
        leaseGeneration: overrides.lease ?? 1,
        config: overrides.mode ? { mode: overrides.mode } : {},
        workspace: dir,
        dataDir,
        allowedEnv: {
          PATH: dirname(process.execPath),
          ...(overrides.ownership
            ? { FIXTURE_OWNERSHIP: overrides.ownership }
            : {}),
        },
        limits: overrides.limits,
        onEvent:
          overrides.event ??
          (async (event) => {
            events.push(event);
            return event.sourceSequence;
          }),
        onHostCall:
          overrides.hostCall ?? (async () => ({ disposition: "accepted" })),
        ...overrides.lifecycle,
      });
      hosts.push(host);
      return host;
    },
    async effects(): Promise<Record<string, unknown>[]> {
      try {
        return (await readFile(join(dataDir, "native-effects.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async cleanup() {
      await Promise.all(hosts.map((host) => host.close()));
      await Promise.all(
        rawChildren.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.stdin!.end();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        })
      );
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const open = {
  openId: "open-one",
  operationId: "open-one",
  payloadDigest: "caller-open",
  conversationId: "conversation",
  mode: "new",
  cwd: "/fixture",
  policyRevision: "policy",
};
const submit = (text = "hello", id = "op-one") => ({
  operationId: id,
  payloadDigest: "caller-prompt",
  conversationId: "conversation",
  turnId: `turn:${id}`,
  policyRevision: "policy",
  input: [{ type: "text", text }],
});
async function until(probe: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (!(await probe())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("SDK ownership service records a real detached launcher before execution and reconciles it on shutdown", async () => {
  const f = await fixture(true);
  await mkdir(f.dataDir, { recursive: true });
  await writeFile(
    join(f.dataDir, "preload.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(join(f.dataDir, "preload-effect"))}, 'unsafe bootstrap');`
  );
  const journal = new GatewayJournal(join(f.dir, "ownership.sqlite"), {
    fleetId: "ownership-sdk",
  });
  const lease = journal.acquireWriterLease("test-owner", {
    ownerProcess: await processIdentity(process.pid),
  });
  let rootId: string | undefined;
  let childId: string | undefined;
  try {
    const host = await f.start({
      mode: "registered-child",
      lease: lease.generation,
      lifecycle: {
        onLaunchPrepared: (launchId, parentLaunchId) => {
          journal.prepareOwnedLaunch(lease, {
            launchId,
            bindingId: "sdk-binding",
            ...(parentLaunchId ? { parentLaunchId } : {}),
          });
          if (parentLaunchId) {
            assert.equal(parentLaunchId, rootId);
            childId = launchId;
          } else rootId = launchId;
        },
        onLaunchRecorded: async (launchId, identity) => {
          if (launchId === childId)
            await assert.rejects(readFile(join(f.dataDir, "child-effect")), {
              code: "ENOENT",
            });
          journal.recordOwnedLaunch(lease, launchId, identity);
        },
        onLaunchStopped: (launchId) => {
          journal.completeOwnedLaunch(lease, launchId);
        },
      },
    });
    assert.equal(host.capabilities.fleetTools, false);
    assert.equal(
      ((await host.request("session.open", open)) as any).status,
      "opened"
    );
    await until(async () => {
      try {
        return (
          (await readFile(join(f.dataDir, "child-effect"), "utf8")) ===
          "started"
        );
      } catch {
        return false;
      }
    });
    const inspected = (await host.request("session.snapshot", {})) as any;
    await assert.rejects(readFile(join(f.dataDir, "preload-effect")), {
      code: "ENOENT",
    });
    assert.equal(inspected.launchId, childId);
    assert.equal(inspected.state, "started");
    assert.equal(journal.getSupervisorRecord()!.launches.length, 2);
    assert.throws(() => journal.completeOwnedLaunch(lease, rootId!), {
      code: "ownership_unreconciled",
    });
    await host.close();
    assert.ok(
      journal
        .getSupervisorRecord()!
        .launches.every((launch) => launch.state === "stopped")
    );
    assert.equal(await ownedGroupHasExited(inspected.identity.pid), true);
    journal.releaseWriterLease(lease, { ownershipReconciled: true });
  } finally {
    await f.cleanup();
    journal.close();
  }
});

test("SDK cannot activate a child when durable registration fails", async () => {
  const f = await fixture(true);
  const childIds = new Set<string>();
  const stopped = new Set<string>();
  try {
    const host = await f.start({
      mode: "registered-child",
      lifecycle: {
        onLaunchPrepared: (id, parent) => {
          if (parent) childIds.add(id);
        },
        onLaunchRecorded: (id) => {
          if (childIds.has(id))
            throw new Error("simulated durable write failure");
        },
        onLaunchStopped: (id) => {
          stopped.add(id);
        },
      },
    });
    await assert.rejects(host.request("session.open", open), {
      code: "host_failure",
    });
    assert.equal(childIds.size, 1);
    await host.close();
    await assert.rejects(readFile(join(f.dataDir, "child-effect")), {
      code: "ENOENT",
    });
    assert.ok([...childIds].every((id) => stopped.has(id)));
  } finally {
    await f.cleanup();
  }
});

test("SDK ownership calls without a native-profile grant stop before spawning", async () => {
  const f = await fixture();
  try {
    const host = await f.start({ mode: "registered-child" });
    await assert.rejects(host.request("session.open", open), {
      code: "capability_unavailable",
    });
    await assert.rejects(readFile(join(f.dataDir, "child-effect")), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("SDK real process reserves opens, prompts and controls, preserves immutable conflicts and streams canonical events", async () => {
  const f = await fixture();
  try {
    const host = await f.start();
    const created = await host.request("session.open", open);
    assert.deepEqual(await host.request("session.open", open), created);
    await assert.rejects(
      host.request("session.open", { ...open, cwd: "/changed" }),
      { code: "payload_conflict" }
    );
    await assert.rejects(
      host.request("session.open", { ...open, openId: "other", mode: "load" }),
      { code: "continuity_unverified" }
    );
    assert.deepEqual(await host.request("operation.submit", submit()), {
      disposition: "accepted",
    });
    await until(() => f.events.length === 5);
    assert.deepEqual(await host.request("operation.submit", submit()), {
      disposition: "accepted",
    });
    await assert.rejects(host.request("operation.submit", submit("changed")), {
      code: "payload_conflict",
    });
    const control = {
      operationId: "configure-one",
      payloadDigest: "same",
      model: "fixture/model",
    };
    await host.request("session.configure", control);
    await host.request("session.configure", control);
    await assert.rejects(
      host.request("operation.cancel", {
        ...control,
        targetOperationId: "op-one",
      }),
      { code: "payload_conflict" }
    );
    assert.equal(
      (await f.effects()).filter((entry) => entry.method === "session.open")
        .length,
      1
    );
    assert.equal(
      (await f.effects()).filter((entry) => entry.method === "operation.submit")
        .length,
      1
    );
    assert.equal(
      (await f.effects()).filter(
        (entry) => entry.method === "session.configure"
      ).length,
      1
    );
    assert.deepEqual(
      await host.request("operation.inspect", { operationId: "op-one" }),
      { disposition: "accepted", execution: "ended", observation: "complete" }
    );
  } finally {
    await f.cleanup();
  }
});

for (const mutation of ["open", "submit"])
  test(`crash after native ${mutation} effect returns persisted unknown after process replacement without replay`, async () => {
    const f = await fixture();
    try {
      let host = await f.start({
        mode: mutation === "open" ? "crash-open" : undefined,
      });
      if (mutation === "submit") await host.request("session.open", open);
      await assert.rejects(
        host.request(
          mutation === "open" ? "session.open" : "operation.submit",
          mutation === "open" ? open : submit("[crash]")
        )
      );
      await host.closed;
      host = await f.start({ lease: 2 });
      const result = await host.request(
        mutation === "open" ? "session.open" : "operation.submit",
        mutation === "open" ? open : submit("[crash]")
      );
      assert.deepEqual(
        result,
        mutation === "open"
          ? { status: "creation_unknown" }
          : {
              disposition: "unknown",
              execution: "unknown",
              observation: "reconciliation_required",
            }
      );
      assert.equal(
        (await f.effects()).filter(
          (entry) =>
            entry.method ===
              `session.${mutation === "open" ? "open" : "unused"}` ||
            (mutation === "submit" && entry.method === "operation.submit")
        ).length,
        1
      );
    } finally {
      await f.cleanup();
    }
  });

test("durable spool replays same source IDs through a replacement host after lost ACK", async () => {
  const f = await fixture();
  const seen: GatewayPluginEvent[] = [];
  try {
    const first = await f.start({
      event: async (event) => {
        seen.push(event);
        return 0;
      },
    });
    await first.request("session.open", open);
    await first.request("operation.submit", submit());
    await until(() => seen.length === 5);
    await first.close();
    const replay: GatewayPluginEvent[] = [];
    const second = await f.start({
      lease: 2,
      event: async (event) => {
        replay.push(event);
        return event.sourceSequence;
      },
    });
    await until(() => replay.length === 5);
    assert.deepEqual(
      replay.map((event) => [event.sourceSequence, event.eventId]),
      seen.map((event) => [event.sourceSequence, event.eventId])
    );
    assert.ok(replay.every((event) => event.leaseGeneration === 2));
    assert.deepEqual(await second.request("operation.submit", submit()), {
      disposition: "accepted",
    });
    assert.equal(
      (await f.effects()).filter((entry) => entry.method === "operation.submit")
        .length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("reverse mutating calls persist one action before transport and duplicate intent never repeats a host side effect", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const host = await f.start({
      hostCall: async () => {
        calls++;
        return { disposition: "accepted", dispatchId: "dispatch-one" };
      },
    });
    await host.request("session.open", open);
    await host.request("operation.submit", submit("[host-action]"));
    assert.equal(calls, 1);
    assert.ok(
      (await f.effects()).some((entry) => entry.actionResultsEqual === true)
    );
  } finally {
    await f.cleanup();
  }
});

test("shutdown distinguishes attached service uncertainty and waits the bounded cleanup hook", async () => {
  const f = await fixture();
  try {
    const host = await f.start({ ownership: "attached" });
    const result = (await host.request("session.close", {
      mode: "drain",
    })) as Record<string, unknown>;
    assert.equal(result.nativeOutcome, "unknown");
    assert.equal(result.ownership, "attached");
    await host.closed;
    assert.ok(
      (await f.effects()).some(
        (entry) =>
          entry.close === "session_close" && entry.ownership === "attached"
      )
    );
  } finally {
    await f.cleanup();
  }
});

test("drain finishes entered native callbacks before cancellation and storage close", async () => {
  const f = await fixture();
  try {
    const host = await f.start();
    await host.request("session.open", open);
    const submitted = host.request("operation.submit", submit("[slow]"));
    await until(async () =>
      (await f.effects()).some((entry) => entry.method === "operation.submit")
    );
    const closed = host.request("session.close", { mode: "drain" });
    assert.deepEqual(await submitted, { disposition: "accepted" });
    assert.equal(
      ((await closed) as Record<string, unknown>).cleanup,
      "complete"
    );
    await host.closed;
    assert.ok(
      (await f.effects()).some((entry) => entry.drainedWithoutAbort === true)
    );
    assert.ok(
      (await f.effects()).some(
        (entry) =>
          entry.close === "session_close" &&
          entry.mode === "drain" &&
          entry.signalAborted === false
      )
    );
  } finally {
    await f.cleanup();
  }
});

for (const stop of ["eof", "signal"])
  test(`real SDK ${stop} invokes cleanup and reaps its owned child`, async () => {
    const f = await fixture();
    try {
      const raw = await f.raw("owned-child", { shutdownTimeoutMs: 1000 });
      await raw.initialize();
      const child = (await f.effects()).find(
        (entry) => typeof entry.childPid === "number"
      )!.childPid as number;
      if (stop === "eof") raw.child.stdin!.end();
      else raw.child.kill("SIGTERM");
      assert.deepEqual(await raw.closed, { code: 0, signal: null });
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
      assert.ok(
        (await f.effects()).some(
          (entry) =>
            entry.close === (stop === "eof" ? "parent_eof" : "signal_sigterm")
        )
      );
    } finally {
      await f.cleanup();
    }
  });

test("cleanup deadline records unknown without leaving the SDK process alive", async () => {
  const f = await fixture();
  try {
    const raw = await f.raw("stuck-cleanup", { shutdownTimeoutMs: 40 });
    await raw.initialize();
    raw.child.stdin!.end();
    assert.deepEqual(await raw.closed, { code: 2, signal: null });
    assert.ok(
      (await f.effects()).some(
        (entry) =>
          (entry.done as Record<string, unknown>)?.cleanup === "unknown"
      )
    );
  } finally {
    await f.cleanup();
  }
});

test("event credits bound unacknowledged frames and exact ACK releases the durable spool", async () => {
  const f = await fixture();
  try {
    const raw = await f.raw(undefined, { maxUnacknowledgedEvents: 1 });
    await raw.initialize();
    await raw.request("session.open", open);
    await raw.request("operation.submit", submit());
    assert.equal(
      raw.messages.filter((message) => message.method === "event").length,
      1
    );
    for (let sequence = 1; sequence <= 5; sequence++) {
      raw.child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "events.ack",
          params: {
            bindingId: "sdk-binding",
            leaseGeneration: 1,
            sourceSequence: sequence,
          },
        }) + "\n"
      );
      await raw.request("health");
      assert.equal(
        raw.messages.filter((message) => message.method === "event").length,
        Math.min(5, sequence + 1)
      );
    }
    const replay = (await raw.request("events.replay", {
      afterSourceSequence: 0,
    })) as Record<string, unknown>;
    assert.equal(replay.gap, true);
    assert.equal(replay.acknowledged, 5);
  } finally {
    await f.cleanup();
  }
});

test("native command deadline preserves unknown and prevents a duplicate or new native effect", async () => {
  const f = await fixture();
  try {
    const raw = await f.raw(undefined, {
      commandTimeoutMs: 30,
      shutdownTimeoutMs: 40,
    });
    await raw.initialize();
    await raw.request("session.open", open);
    const unknown = {
      disposition: "unknown",
      execution: "unknown",
      observation: "reconciliation_required",
    };
    assert.deepEqual(
      await raw.request("operation.submit", submit("[hang]")),
      unknown
    );
    assert.deepEqual(
      await raw.request("operation.submit", submit("[hang]")),
      unknown
    );
    await assert.rejects(
      raw.request("operation.submit", submit("hello", "another")),
      (error: any) => error.data.code === "busy"
    );
    assert.equal(
      (await f.effects()).filter((entry) => entry.method === "operation.submit")
        .length,
      1
    );
    raw.child.stdin!.end();
    assert.equal((await raw.closed).code, 2);
  } finally {
    await f.cleanup();
  }
});

test("incoming negotiated frame limit counts whitespace before any native invocation", async () => {
  const f = await fixture();
  try {
    const raw = await f.raw(undefined, {
      maxFrameBytes: 2048,
      shutdownTimeoutMs: 100,
    });
    await raw.initialize();
    raw.child.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "oversized",
        method: "session.open",
        params: { bindingId: "sdk-binding", leaseGeneration: 1, ...open },
      }) +
        " ".repeat(2048) +
        "\n"
    );
    await raw.closed;
    assert.equal(
      (await f.effects()).filter((entry) => entry.method === "session.open")
        .length,
      0
    );
    assert.ok(
      (await f.effects()).some((entry) => entry.close === "invalid_protocol")
    );
  } finally {
    await f.cleanup();
  }
});

test("permission decisions fence the exact current instance and immutable offered option", async () => {
  const f = await fixture();
  try {
    const raw = await f.raw();
    await raw.initialize();
    const stale = {
      operationId: "decision-old",
      targetOperationId: "op-one",
      payloadDigest: "fixed",
      instanceId: "prior-instance",
      interactionId: "permission-one",
      optionId: "allow-once",
      revision: "1",
    };
    assert.deepEqual(await raw.request("interaction.respond", stale), {
      status: "stale",
    });
    assert.deepEqual(await raw.request("interaction.respond", stale), {
      status: "stale",
    });
    const current = {
      ...stale,
      operationId: "decision-current",
      instanceId: "raw-instance",
    };
    assert.deepEqual(await raw.request("interaction.respond", current), {
      status: "applied",
    });
    assert.deepEqual(await raw.request("interaction.respond", current), {
      status: "applied",
    });
    await assert.rejects(
      raw.request("interaction.respond", { ...current, optionId: "deny" }),
      (error: any) => error.data.code === "payload_conflict"
    );
    await assert.rejects(
      raw.request("operation.cancel", {
        operationId: "cancel",
        payloadDigest: "fixed",
      }),
      (error: any) => error.data.code === "invalid_request"
    );
    assert.equal(
      (await f.effects()).filter(
        (entry) => entry.method === "interaction.respond"
      ).length,
      1
    );
  } finally {
    await f.cleanup();
  }
});
