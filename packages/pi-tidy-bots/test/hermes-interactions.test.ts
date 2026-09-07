import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesInteractions } from "../backends/hermes/interactions.ts";
import { PluginStore } from "../src/plugin-sdk/store.ts";
import type { PluginContext } from "../src/plugin-sdk/runtime.ts";
import { DEFAULT_LIMITS, type JsonObject } from "../src/gateway/protocol.ts";
import {
  permissionRequest,
  permissionResolution,
} from "../src/gateway/permissions.ts";

async function fixture(timeoutMs = 1000) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-permission-"));
  const store = new PluginStore(join(dir, "sdk.sqlite"), {
    bindingId: "b",
    instanceId: "i",
    leaseGeneration: 1,
  });
  store.reserve("operation:target", "operation.submit", "target-intent", {
    operationId: "target",
    turnId: "turn",
    conversationId: "c",
  });
  const abort = new AbortController();
  const nativeAbort = new AbortController();
  const events: any[] = [],
    failures: unknown[] = [];
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
    emit(event) {
      store.append(event);
      events.push(event);
    },
    async hostCall() {
      throw new Error("Unexpected host service");
    },
    async reconcileHostAction() {
      throw new Error("Unexpected host reconciliation");
    },
    async ownedProcess() {
      throw new Error("Unexpected process service");
    },
  };
  const interactions = new HermesInteractions(ctx, {
    timeoutMs,
    onFailure: (error) => {
      failures.push(error);
    },
  });
  const nativeParams = {
    _meta: { tidy: { permissionId: "permission-1" } },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  };
  const turn = { operationId: "target", turnId: "turn" };
  const native = interactions.onPermission(
    nativeParams,
    17,
    turn,
    nativeAbort.signal
  );
  const descriptor = events[0].payload;
  const decision = {
    ...descriptor,
    operationId: "control",
    targetOperationId: "target",
    optionId: "allow_once",
    payloadDigest: "control-intent",
  };
  const reserve = (params: JsonObject = decision) =>
    store.reserve(
      `operation:${params.operationId}`,
      "interaction.respond",
      String(params.payloadDigest),
      params
    );
  const receipt = {
    ...turn,
    permissionId: "permission-1",
    optionId: "allow_once",
  };
  return {
    ctx,
    store,
    abort,
    nativeAbort,
    native,
    interactions,
    events,
    failures,
    descriptor,
    decision,
    reserve,
    receipt,
    async cleanup() {
      interactions.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Hermes permission controls require the exact immutable SDK reservation before native selection", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.interactions.respond(f.decision), {
      code: "durability_required",
    });
    f.reserve();
    await assert.rejects(
      f.interactions.respond({ ...f.decision, optionId: "deny" }),
      { code: "payload_conflict" }
    );
    assert.equal(f.events.length, 1);
    f.interactions.close();
    assert.deepEqual(await f.native, { outcome: { outcome: "cancelled" } });
    assert.equal(f.events[1].payload.status, "cancelled");
  } finally {
    await f.cleanup();
  }
});

test("Hermes applied control result follows durable exact receipt and does not duplicate native dispatch or events", async () => {
  const f = await fixture();
  try {
    const descriptor = permissionRequest(f.descriptor);
    f.reserve();
    let settled = false;
    const response = f.interactions.respond(f.decision).then((value) => {
      settled = true;
      return value;
    });
    assert.deepEqual(await f.native, {
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    assert.equal(settled, false);
    const duplicate = f.interactions.respond(f.decision);
    const secondControl = { ...f.decision, operationId: "other-control" };
    f.reserve(secondControl);
    await assert.rejects(f.interactions.respond(secondControl), {
      code: "payload_conflict",
    });
    f.interactions.onPermissionConsumed(f.receipt);
    assert.deepEqual(await response, { status: "applied" });
    assert.deepEqual(await duplicate, { status: "applied" });
    assert.equal(
      permissionResolution(f.events[1].payload, descriptor).status,
      "applied"
    );
    f.interactions.onPermissionConsumed(f.receipt);
    assert.equal(f.events.length, 2);
    f.store.settle("operation:control", { status: "applied" });
    assert.deepEqual(await f.interactions.respond(f.decision), {
      status: "applied",
    });
  } finally {
    await f.cleanup();
  }
});

test("failed durable receipt append leaves the control unknown despite native consumption", async () => {
  const f = await fixture();
  try {
    f.reserve();
    const response = f.interactions.respond(f.decision);
    await f.native;
    const emit = f.ctx.emit;
    f.ctx.emit = (event) => {
      if (event.type === "interaction.resolved")
        throw new Error("simulated storage failure");
      emit(event);
    };
    assert.throws(
      () => f.interactions.onPermissionConsumed(f.receipt),
      /storage failure/
    );
    assert.deepEqual(await response, { status: "unknown" });
    assert.equal(f.events.length, 1);
    assert.throws(() => f.interactions.onPermissionConsumed(f.receipt), {
      code: "interaction_expired",
    });
  } finally {
    await f.cleanup();
  }
});

test("aborted selected permission remains unknown and cannot be answered by a replacement coordinator", async () => {
  const f = await fixture();
  try {
    f.reserve();
    const response = f.interactions.respond(f.decision);
    await f.native;
    f.nativeAbort.abort();
    const result = await response;
    assert.deepEqual(result, { status: "unknown" });
    assert.equal(f.events[1].payload.status, "unknown");
    f.store.settle("operation:control", result);
    f.interactions.close();
    const replacement = new HermesInteractions(f.ctx, { onFailure() {} });
    try {
      assert.deepEqual(await replacement.respond(f.decision), result);
      const changed = { ...f.decision, operationId: "replacement-control" };
      f.reserve(changed);
      assert.deepEqual(await replacement.respond(changed), {
        status: "expired",
      });
    } finally {
      replacement.close();
    }
    assert.equal(f.events.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("unanswered native permission expires once without manufacturing a deny selection", async () => {
  const f = await fixture(10);
  try {
    assert.deepEqual(await f.native, { outcome: { outcome: "cancelled" } });
    assert.equal(f.events[1].payload.status, "expired");
    assert.equal(f.events[1].payload.optionId, undefined);
    f.reserve();
    assert.deepEqual(await f.interactions.respond(f.decision), {
      status: "expired",
    });
    f.interactions.close();
    assert.equal(f.events.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("mismatched native receipt never resolves the reserved permission", async () => {
  const f = await fixture();
  try {
    f.reserve();
    const response = f.interactions.respond(f.decision);
    await f.native;
    for (const key of ["permissionId", "operationId", "turnId", "optionId"])
      assert.throws(
        () =>
          f.interactions.onPermissionConsumed({
            ...f.receipt,
            [key]: "changed",
          }),
        { code: "invalid_permission" }
      );
    assert.equal(f.events.length, 1);
    f.abort.abort();
    assert.deepEqual(await response, { status: "unknown" });
    assert.deepEqual(f.failures, []);
  } finally {
    await f.cleanup();
  }
});
