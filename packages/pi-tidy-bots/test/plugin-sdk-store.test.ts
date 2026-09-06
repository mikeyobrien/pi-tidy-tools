import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { PluginStore } from "../src/plugin-sdk/store.ts";
import { DEFAULT_LIMITS, encodeFrame } from "../src/gateway/protocol.ts";

const options = (leaseGeneration = 1) => ({
  bindingId: "binding-one",
  instanceId: `instance-${leaseGeneration}`,
  leaseGeneration,
});
const params = (text = "hello", leaseGeneration = 1) => ({
  bindingId: "binding-one",
  leaseGeneration,
  operationId: "one",
  conversationId: "conversation",
  turnId: "turn",
  input: [{ type: "text", text }],
  payloadDigest: "caller-digest",
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tidy-sdk-store-"));
  return {
    dir,
    path: join(dir, "plugin.sqlite"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("reservation persists unknown and independently rejects a changed payload even with the same caller digest", () => {
  const f = fixture();
  let store = new PluginStore(f.path, options());
  try {
    assert.equal(
      store.reserve(
        "operation:one",
        "operation.submit",
        "caller-digest",
        params()
      ).created,
      true
    );
    assert.throws(
      () =>
        store.reserve(
          "operation:one",
          "operation.submit",
          "caller-digest",
          params("changed")
        ),
      { code: "payload_conflict" }
    );
    store.close();
    store = new PluginStore(f.path, options(2));
    const recovered = store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params("hello", 2)
    );
    assert.equal(recovered.created, false);
    assert.equal(recovered.settled, false);
    assert.deepEqual(recovered.result, {
      disposition: "unknown",
      execution: "unknown",
      observation: "reconciliation_required",
    });
    assert.throws(
      () =>
        store.reserve("operation:two", "operation.submit", "different", {
          ...params(),
          operationId: "two",
        }),
      { code: "busy" }
    );
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    const db = new DatabaseSync(f.path);
    assert.equal(
      (db.prepare("PRAGMA journal_mode").get() as any).journal_mode,
      "wal"
    );
    db.close();
  } finally {
    store.close();
    f.remove();
  }
});

test("open and controls keep immutable method/target/exact-interaction identity", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options());
  try {
    const open = {
      openId: "open-1",
      mode: "new",
      cwd: "/fixture",
      payloadDigest: "fixed",
    };
    store.reserve("open:open-1", "session.open", "fixed", open);
    store.settle("open:open-1", {
      status: "opened",
      nativeReference: "native-1",
    });
    assert.deepEqual(
      store.reserve("open:open-1", "session.open", "fixed", open).result,
      { status: "opened", nativeReference: "native-1" }
    );
    assert.throws(
      () =>
        store.reserve("open:open-1", "session.open", "fixed", {
          ...open,
          mode: "load",
        }),
      { code: "payload_conflict" }
    );
    const decision = {
      operationId: "decision-1",
      targetOperationId: "turn-1",
      interactionId: "request-1",
      instanceId: "native-instance-1",
      optionId: "allow-once",
      revision: "1",
      payloadDigest: "fixed",
    };
    store.reserve(
      "operation:decision-1",
      "interaction.respond",
      "fixed",
      decision
    );
    assert.throws(
      () =>
        store.reserve("operation:decision-1", "interaction.respond", "fixed", {
          ...decision,
          instanceId: "native-instance-2",
        }),
      { code: "payload_conflict" }
    );
    assert.throws(
      () =>
        store.reserve(
          "operation:decision-1",
          "operation.cancel",
          "fixed",
          decision
        ),
      { code: "payload_conflict" }
    );
  } finally {
    store.close();
    f.remove();
  }
});

test("event spool survives restart, re-envelopes current lease, and retains event-ID tombstones after ACK", () => {
  const f = fixture();
  let store = new PluginStore(f.path, options());
  try {
    const input = {
      eventId: "event-fixed",
      type: "session.state",
      payload: { availability: "ready" },
    };
    const original = store.append(input);
    store.markSent(1);
    store.close();
    store = new PluginStore(f.path, options(2));
    const replay = store.pending()[0];
    assert.equal(replay.sourceSequence, 1);
    assert.equal(replay.eventId, original.eventId);
    assert.equal(replay.leaseGeneration, 2);
    store.acknowledge(1);
    assert.deepEqual(store.pending(), []);
    assert.equal(store.replay(0).gap, true);
    assert.equal(store.append(input).sourceSequence, 1);
    assert.equal(store.watermark, 1);
    assert.throws(
      () =>
        store.append({ ...input, payload: { availability: "unavailable" } }),
      { code: "payload_conflict" }
    );
    const second = store.append({
      type: "session.state",
      payload: { availability: "ready" },
    });
    assert.equal(second.sourceSequence, 2);
  } finally {
    store.close();
    f.remove();
  }
});

test("lost prior ACK can acknowledge a previously sent durable prefix on a replacement pipe", () => {
  const f = fixture();
  let store = new PluginStore(f.path, options());
  try {
    for (let i = 0; i < 3; i++) {
      const event = store.append({ type: "session.state", payload: {} });
      store.markSent(event.sourceSequence);
    }
    store.close();
    store = new PluginStore(f.path, options(2));
    store.markSent(1); // New pipe has only re-sent one duplicate when host proves all three committed.
    store.acknowledge(3);
    assert.equal(store.highestSent, 3);
    assert.equal(store.acknowledged, 3);
    assert.throws(() => store.acknowledge(4), { code: "invalid_ack" });
  } finally {
    store.close();
    f.remove();
  }
});

test("spool overflow records a sticky gap, keeps prior reliable events, and blocks new native admission", () => {
  const f = fixture();
  const store = new PluginStore(f.path, {
    ...options(),
    limits: { ...DEFAULT_LIMITS, maxSpoolBytes: 2048 },
  });
  try {
    store.append({
      type: "session.state",
      payload: { text: "a".repeat(1000) },
    });
    assert.throws(
      () =>
        store.append({
          type: "session.state",
          payload: { text: "b".repeat(1000) },
        }),
      { code: "observation_gap" }
    );
    assert.equal(store.watermark, 1);
    const gap = store.appendGap();
    assert.equal(gap?.type, "observation.gap");
    assert.equal(store.pending()[0].payload.text, "a".repeat(1000));
    assert.throws(
      () =>
        store.reserve("operation:one", "operation.submit", "digest", params()),
      { code: "observation_gap" }
    );
  } finally {
    store.close();
    f.remove();
  }
});

test("oversize event frame records observation loss without silently truncating", () => {
  const f = fixture();
  const store = new PluginStore(f.path, {
    ...options(),
    limits: { ...DEFAULT_LIMITS, maxFrameBytes: 1024 },
  });
  try {
    assert.throws(
      () =>
        store.append({
          type: "session.state",
          payload: { text: "x".repeat(1100) },
        }),
      { code: "observation_gap" }
    );
    assert.equal(store.watermark, 0);
    assert.equal(store.observationGap, "frame_capacity_exhausted");
  } finally {
    store.close();
    f.remove();
  }
});

test("a concurrent owner and stale replacement are fenced before reservations", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options(2));
  try {
    assert.throws(
      () => new PluginStore(f.path, { ...options(3), instanceId: "other" }),
      { code: "busy" }
    );
    assert.throws(() => new PluginStore(f.path, options(1)), {
      code: "stale_binding",
    });
  } finally {
    store.close();
    f.remove();
  }
});

test("incomplete terminal observation and late handler rejection never reopen native admission", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options());
  try {
    store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params()
    );
    assert.throws(
      () =>
        store.append({
          type: "turn.started",
          operationId: "wrong",
          turnId: "turn",
          payload: {},
        }),
      { code: "invalid_event" }
    );
    assert.throws(
      () =>
        store.append({
          type: "turn.started",
          operationId: "one",
          turnId: "wrong",
          payload: {},
        }),
      { code: "invalid_event" }
    );
    store.append({
      type: "turn.terminal",
      operationId: "one",
      turnId: "turn",
      payload: { execution: "ended", observation: "live_gap" },
    });
    assert.throws(
      () => store.settle("operation:one", { disposition: "rejected" }),
      { code: "native_outcome_conflict" }
    );
    store.settle("operation:one", { disposition: "unknown" });
    assert.deepEqual(store.inspect("one"), {
      disposition: "accepted",
      execution: "ended",
      observation: "live_gap",
    });
    assert.throws(
      () =>
        store.append({
          type: "turn.started",
          operationId: "one",
          turnId: "turn",
          payload: {},
        }),
      { code: "invalid_event" }
    );
    assert.throws(
      () =>
        store.reserve("operation:two", "operation.submit", "other", {
          ...params(),
          operationId: "two",
        }),
      { code: "busy" }
    );
    store.append({
      type: "operation.disposition",
      operationId: "one",
      turnId: "turn",
      payload: { disposition: "unknown" },
    });
    assert.equal(store.inspect("one").disposition, "accepted");
    store.append({
      type: "turn.terminal",
      operationId: "one",
      turnId: "turn",
      payload: { execution: "ended", observation: "complete" },
    });
    assert.equal(
      store.reserve("operation:two", "operation.submit", "other", {
        ...params(),
        operationId: "two",
      }).created,
      true
    );
  } finally {
    store.close();
    f.remove();
  }
});

for (const corrupt of [
  "DELETE FROM reservations",
  "UPDATE reservations SET params_json='{}'",
])
  test(`damaged immutable reservation refuses startup: ${corrupt}`, () => {
    const f = fixture();
    const store = new PluginStore(f.path, options());
    store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params()
    );
    store.close();
    try {
      const db = new DatabaseSync(f.path);
      db.exec(corrupt);
      db.close();
      assert.throws(() => new PluginStore(f.path, options(2)), {
        code: "corrupt_storage",
      });
    } finally {
      f.remove();
    }
  });

test("retained events reserve maximum lease envelope space and refuse incompatible lower limits", () => {
  const f = fixture();
  let store = new PluginStore(f.path, {
    ...options(),
    limits: { ...DEFAULT_LIMITS, maxFrameBytes: 1024 },
  });
  try {
    const input = {
      eventId: "fixed",
      type: "session.state",
      payload: { text: "x".repeat(500) },
    };
    const event = store.append(input);
    const frame = encodeFrame({
      jsonrpc: "2.0",
      method: "event",
      params: { ...event, leaseGeneration: Number.MAX_SAFE_INTEGER },
    });
    store.close();
    assert.throws(
      () =>
        new PluginStore(f.path, {
          ...options(2),
          limits: { ...DEFAULT_LIMITS, maxFrameBytes: frame.length - 1 },
        }),
      { code: "resource_limit" }
    );
    store = new PluginStore(f.path, {
      ...options(Number.MAX_SAFE_INTEGER),
      limits: { ...DEFAULT_LIMITS, maxFrameBytes: frame.length },
    });
    assert.equal(
      encodeFrame({
        jsonrpc: "2.0",
        method: "event",
        params: store.pending()[0],
      }).length,
      frame.length
    );
  } finally {
    store.close();
    f.remove();
  }
});

for (const corrupt of [
  "UPDATE meta SET value='NaN' WHERE key='ack'",
  "DELETE FROM meta WHERE key='sequence'",
  "DROP TABLE event_ids",
])
  test(`corrupt durable state refuses startup: ${corrupt}`, () => {
    const f = fixture();
    const store = new PluginStore(f.path, options());
    store.close();
    try {
      const db = new DatabaseSync(f.path);
      db.exec(corrupt);
      db.close();
      assert.throws(() => new PluginStore(f.path, options(2)), {
        code: "corrupt_storage",
      });
    } finally {
      f.remove();
    }
  });

test("missing database or namespace marker cannot recreate previously reserved native work", () => {
  for (const remove of ["database", "marker"]) {
    const f = fixture();
    const store = new PluginStore(f.path, options());
    store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params()
    );
    store.close();
    try {
      rmSync(remove === "database" ? f.path : `${f.path}.namespace`);
      assert.throws(() => new PluginStore(f.path, options(2)), {
        code: "corrupt_storage",
      });
    } finally {
      f.remove();
    }
  }
});

test("changed retained event content cannot be replayed as authoritative native evidence", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options());
  store.append({
    type: "session.state",
    payload: { availability: "unavailable" },
  });
  store.close();
  try {
    const db = new DatabaseSync(f.path);
    const row = db.prepare("SELECT event_json FROM events").get() as Record<
      string,
      unknown
    >;
    const event = JSON.parse(String(row.event_json));
    event.payload.availability = "ready";
    db.prepare("UPDATE events SET event_json=?").run(JSON.stringify(event));
    db.close();
    assert.throws(() => new PluginStore(f.path, options(2)), {
      code: "corrupt_storage",
    });
  } finally {
    f.remove();
  }
});

test("malformed native creation result preserves unknown and an active submit blocks a new open", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options());
  try {
    const open = {
      openId: "open",
      conversationId: "conversation",
      mode: "new",
      payloadDigest: "open",
    };
    store.reserve("open:open", "session.open", "open", open);
    for (const result of [
      {},
      { status: "opened" },
      { status: "creation_unknown_typo" },
    ])
      assert.throws(() => store.settle("open:open", result), {
        code: "invalid_native_result",
      });
    assert.deepEqual(
      store.reserve("open:open", "session.open", "open", open).result,
      { status: "creation_unknown" }
    );
    assert.throws(
      () =>
        store.reserve("open:other", "session.open", "open", {
          ...open,
          openId: "other",
        }),
      { code: "busy" }
    );
    store.settle("open:open", { status: "opened", nativeReference: "native" });
    store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params()
    );
    store.settle("operation:one", { disposition: "accepted" });
    assert.throws(
      () =>
        store.reserve("open:other", "session.open", "open", {
          ...open,
          openId: "other",
        }),
      { code: "busy" }
    );
  } finally {
    store.close();
    f.remove();
  }
});

test("explicit native observation gap durably stops new admission", () => {
  const f = fixture();
  let store = new PluginStore(f.path, options());
  try {
    store.append({
      type: "observation.gap",
      payload: { reason: "native_cursor_lost" },
    });
    store.close();
    store = new PluginStore(f.path, options(2));
    assert.equal(store.observationGap, "native_cursor_lost");
    assert.throws(
      () =>
        store.reserve(
          "operation:one",
          "operation.submit",
          "caller-digest",
          params()
        ),
      { code: "observation_gap" }
    );
  } finally {
    store.close();
    f.remove();
  }
});

for (const mode of ["clean", "unclean"])
  test(`${mode} process replacement demotes nonterminal execution while preserving accepted and terminal evidence`, () => {
    const f = fixture();
    let store = new PluginStore(f.path, options());
    try {
      store.reserve(
        "operation:one",
        "operation.submit",
        "caller-digest",
        params()
      );
      store.append({
        type: "turn.started",
        operationId: "one",
        turnId: "turn",
        payload: {},
      });
      store.settle("operation:one", { disposition: "accepted" });
      store.reserve("operation:two", "operation.submit", "other", {
        ...params(),
        conversationId: "other",
        operationId: "two",
        turnId: "turn-two",
      });
      store.append({
        type: "turn.terminal",
        operationId: "two",
        turnId: "turn-two",
        payload: { execution: "ended", observation: "complete" },
      });
      store.settle("operation:two", { disposition: "accepted" });
      store.close();
      if (mode === "unclean") {
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { PluginStore } from ${JSON.stringify(new URL("../src/plugin-sdk/store.ts", import.meta.url).href)}; const store = new PluginStore(${JSON.stringify(f.path)}, ${JSON.stringify(options(2))}); store.append({type:'turn.started',operationId:'one',turnId:'turn',payload:{}}); process.exit(9);`,
          ],
          { encoding: "utf8" }
        );
        assert.equal(child.status, 9, child.stderr);
      }
      store = new PluginStore(f.path, options(3));
      assert.deepEqual(store.inspect("one"), {
        disposition: "accepted",
        execution: "unknown",
        observation: "reconciliation_required",
      });
      assert.deepEqual(store.inspect("two"), {
        disposition: "accepted",
        execution: "ended",
        observation: "complete",
      });
      assert.equal(
        store.reserve(
          "operation:one",
          "operation.submit",
          "caller-digest",
          params("hello", 3)
        ).created,
        false
      );
    } finally {
      store.close();
      f.remove();
    }
  });

test("definite rejection cannot turn into fresh accepted execution evidence", () => {
  const f = fixture();
  const store = new PluginStore(f.path, options());
  try {
    store.reserve(
      "operation:one",
      "operation.submit",
      "caller-digest",
      params()
    );
    store.settle("operation:one", { disposition: "rejected" });
    for (const input of [
      {
        type: "turn.terminal",
        payload: { execution: "ended", observation: "complete" },
      },
      { type: "operation.disposition", payload: { disposition: "accepted" } },
    ])
      assert.throws(
        () => store.append({ ...input, operationId: "one", turnId: "turn" }),
        { code: "invalid_event" }
      );
    store.append({
      type: "operation.disposition",
      operationId: "one",
      turnId: "turn",
      payload: { disposition: "rejected" },
    });
    assert.equal(store.inspect("one").disposition, "rejected");
  } finally {
    store.close();
    f.remove();
  }
});
