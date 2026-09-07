import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  GatewayJournal,
  GatewayJournalError,
  GATEWAY_SQLITE_VERSION,
  canonicalJson,
  payloadDigest,
  type AdmitOperation,
  type ConversationBinding,
  type PluginSourceEvent,
  type WriterLease,
  type JsonObject,
} from "../src/gateway/journal.ts";

const binding: ConversationBinding = {
  botId: "bot-researcher-1",
  conversationId: "conv-researcher-1",
  bindingId: "binding-researcher-1",
  bindingRevision: "binding-researcher-1:cap-3",
  policyRevision: "policy-1",
};
const intent = (
  operationId = "op-example-42",
  overrides: Partial<AdmitOperation> = {}
): AdmitOperation => ({
  ...binding,
  operationId,
  payload: { text: "Inspect the failing test." },
  ...overrides,
});
const key = (operationId = "op-example-42") => ({
  botId: binding.botId,
  conversationId: binding.conversationId,
  operationId,
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "tidy-gateway-journal-"));
  const path = join(dir, "gateway.sqlite");
  const opened: GatewayJournal[] = [];
  const clock = { value: 1_000 };
  function open(fleetId: string | undefined = "fleet-example-1") {
    const db = new GatewayJournal(path, { fleetId, now: () => clock.value });
    opened.push(db);
    return db;
  }
  t.after(() => {
    for (const db of opened) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const journal = open();
  const lease = journal.acquireWriterLease("writer-1", { ttlMs: 100 });
  journal.ensureConversation(lease, binding);
  return { dir, path, journal, lease, open, clock };
}
function code(work: () => unknown, expected: string): void {
  assert.throws(
    work,
    (error: unknown) =>
      error instanceof GatewayJournalError && error.code === expected
  );
}
function sql(path: string, statements: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
}
function source(
  lease: WriterLease,
  n = 1,
  overrides: Partial<PluginSourceEvent> = {}
): PluginSourceEvent {
  return {
    bindingId: binding.bindingId,
    leaseGeneration: lease.generation,
    sourceSequence: n,
    eventId: `event-${n}`,
    type: "text.snapshot",
    operationId: "op-example-42",
    payload: { text: "Response", revision: n },
    ...overrides,
  };
}
function accepted(journal: GatewayJournal, lease: WriterLease): void {
  journal.admit(lease, intent());
  journal.reserveNext(lease, binding);
  journal.recordDisposition(lease, key(), {
    delivery: "accepted",
    execution: "running",
  });
}

test("fleet dispatch atomically retains one target admission across lost replies and restart", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const target = {
    ...binding,
    botId: "target",
    conversationId: "target-conversation",
    bindingId: "target-binding",
    bindingRevision: "target-revision",
  };
  f.journal.ensureConversation(f.lease, target);
  const input = {
    origin: { ...binding, operationId: key().operationId },
    target,
    toolCallId: "native-call-1",
    actionId: "action-1",
    text: "Review the fixture",
    publicBotName: "target",
  };
  const first = f.journal.admitFleetDispatch(f.lease, input);
  assert.equal(first.created, true);
  assert.equal(first.receipt.operationId, first.dispatchId);
  assert.deepEqual(f.journal.admitFleetDispatch(f.lease, input), {
    ...first,
    created: false,
  });
  const transcript = f.journal.readTranscript(target);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].origin, "fleet");
  assert.equal(transcript[0].from, binding.botId);
  assert.equal(transcript[0].dispatchId, first.dispatchId);
  assert.equal(
    f.journal.readEvents().filter((event) => event.event.bot === "target")
      .length,
    1
  );
  code(
    () =>
      f.journal.admitFleetDispatch(f.lease, {
        ...input,
        text: "Changed intent",
      }),
    "action_conflict"
  );
  f.journal.recordDisposition(f.lease, key(), {
    execution: "ended",
    evidence: "fixture_native_ended",
  });
  assert.deepEqual(f.journal.admitFleetDispatch(f.lease, input), {
    ...first,
    created: false,
  });
  code(
    () =>
      f.journal.admitFleetDispatch(f.lease, {
        ...input,
        actionId: "new-action-after-terminal",
      }),
    "invalid_origin"
  );
  f.journal.close();
  const restored = f.open();
  assert.deepEqual(restored.admitFleetDispatch(f.lease, input), {
    ...first,
    created: false,
  });
  assert.equal(restored.listOperationRecords(target).length, 1);
});

test("fleet dispatch rolls back target operation and append if the action ledger fails", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const target = {
    ...binding,
    botId: "target",
    conversationId: "target-conversation",
    bindingId: "target-binding",
    bindingRevision: "target-revision",
  };
  f.journal.ensureConversation(f.lease, target);
  const input = {
    origin: { ...binding, operationId: key().operationId },
    target,
    toolCallId: "native-call-1",
    actionId: "action-1",
    text: "Review the fixture",
    publicBotName: "target",
  };
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(
      "CREATE TRIGGER reject_dispatch BEFORE INSERT ON gateway_meta WHEN NEW.key LIKE 'fleet_dispatch_v1:%' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END"
    );
    assert.throws(() => f.journal.admitFleetDispatch(f.lease, input));
    assert.equal(f.journal.listOperationRecords(target).length, 0);
    assert.equal(f.journal.readTranscript(target).length, 0);
    assert.equal(
      f.journal.readEvents().filter((event) => event.event.bot === "target")
        .length,
      0
    );
    sql.exec("DROP TRIGGER reject_dispatch");
    assert.equal(f.journal.admitFleetDispatch(f.lease, input).created, true);
  } finally {
    sql.close();
  }
});

test("queued origin cannot admit a target and corrupt dispatch history cannot be replayed", (t) => {
  const f = fixture(t);
  f.journal.admit(f.lease, intent());
  const input = {
    origin: { ...binding, operationId: key().operationId },
    target: binding,
    toolCallId: "tool",
    actionId: "action",
    text: "Task",
  };
  code(() => f.journal.admitFleetDispatch(f.lease, input), "invalid_origin");
  assert.equal(f.journal.listOperationRecords(binding).length, 1);
  f.journal.reserveNext(f.lease, binding);
  const admitted = f.journal.admitFleetDispatch(f.lease, input);
  const sql = new DatabaseSync(f.path);
  try {
    sql
      .prepare("UPDATE gateway_meta SET value='null' WHERE key=?")
      .run(`fleet_dispatch_v1:${admitted.dispatchId}`);
    code(() => f.journal.admitFleetDispatch(f.lease, input), "corrupt_storage");
    assert.equal(f.journal.listOperationRecords(binding).length, 2);
  } finally {
    sql.close();
  }
});

test("completion admission and outbox acknowledgement roll back and replay together", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const target = {
    ...binding,
    botId: "target",
    conversationId: "target-conversation",
    bindingId: "target-binding",
    bindingRevision: "target-revision",
  };
  f.journal.ensureConversation(f.lease, target);
  const dispatched = f.journal.admitFleetDispatch(f.lease, {
    origin: { ...binding, operationId: key().operationId },
    target,
    toolCallId: "tool",
    actionId: "action",
    text: "Task",
  });
  f.journal.reserveNext(f.lease, target);
  f.journal.commitPluginEvent(
    f.lease,
    {
      bindingId: target.bindingId,
      leaseGeneration: f.lease.generation,
      sourceSequence: 1,
      eventId: "target-end",
      type: "turn.terminal",
      operationId: dispatched.dispatchId,
      payload: { execution: "ended" },
    },
    {
      operation: {
        delivery: "accepted",
        execution: "ended",
        evidence: "native_terminal",
      },
      completion: {
        dispatchId: dispatched.dispatchId,
        originBotId: binding.botId,
        payload: {
          originConversationId: binding.conversationId,
          originBindingId: binding.bindingId,
          depth: 1,
          text: "Result",
          execution: "ended",
          observation: "complete",
        },
      },
    }
  );
  const item = f.journal.readOutbox()[0];
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(
      "CREATE TRIGGER reject_completion_ack BEFORE UPDATE ON completion_outbox WHEN NEW.delivered=1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    );
    assert.throws(() =>
      f.journal.admitCompletion(f.lease, item.id, binding, "origin")
    );
    assert.equal(f.journal.listOperationRecords(binding).length, 1);
    assert.equal(f.journal.readOutbox().length, 1);
    sql.exec("DROP TRIGGER reject_completion_ack");
    const result = f.journal.admitCompletion(
      f.lease,
      item.id,
      binding,
      "origin"
    );
    assert.equal(result.created, true);
    assert.deepEqual(
      f.journal.admitCompletion(f.lease, item.id, binding, "origin"),
      { ...result, created: false }
    );
    assert.equal(f.journal.readOutbox().length, 0);
    assert.equal(
      f.journal.getOperationRecord(result.receipt)!.payload!.dispatch,
      undefined
    );
  } finally {
    sql.close();
  }
});

test("fleet route budgets refuse new work but never invalidate retained receipts", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const input = {
    origin: { ...binding, operationId: key().operationId },
    target: binding,
    toolCallId: "tool",
    actionId: "action",
    text: "Task",
  };
  code(
    () =>
      f.journal.admitFleetDispatch(f.lease, {
        ...input,
        text: "x".repeat(65537),
      }),
    "resource_limit"
  );
  const first = f.journal.admitFleetDispatch(f.lease, input);
  for (let index = 1; index < 32; index++)
    f.journal.admitFleetDispatch(f.lease, {
      ...input,
      actionId: `action-${index}`,
    });
  code(
    () =>
      f.journal.admitFleetDispatch(f.lease, {
        ...input,
        actionId: "over-budget",
      }),
    "route_limit"
  );
  assert.deepEqual(f.journal.admitFleetDispatch(f.lease, input), {
    ...first,
    created: false,
  });
});

test("fleet dispatch depth follows retained native causation rather than caller arguments", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  let operationId = key().operationId;
  for (let depth = 1; depth <= 8; depth++) {
    const next = f.journal.admitFleetDispatch(f.lease, {
      origin: { ...binding, operationId },
      target: binding,
      toolCallId: "tool",
      actionId: "action",
      text: "Next task",
    });
    f.journal.recordDisposition(
      f.lease,
      { ...binding, operationId },
      { delivery: "accepted", execution: "ended", evidence: "native_terminal" }
    );
    operationId = next.dispatchId;
    assert.equal(
      (
        f.journal.getOperationRecord(next.receipt)!.payload!
          .dispatch as JsonObject
      ).depth,
      depth
    );
    assert.equal(
      f.journal.reserveNext(f.lease, binding)!.receipt.operationId,
      operationId
    );
  }
  code(
    () =>
      f.journal.admitFleetDispatch(f.lease, {
        origin: { ...binding, operationId },
        target: binding,
        toolCallId: "tool",
        actionId: "action",
        text: "Too deep",
      }),
    "route_limit"
  );
});

function permissionFixture(t: TestContext) {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const turnId = f.journal.getOperationRecord(key())!.turnId!;
  const descriptor: JsonObject = {
    bindingId: binding.bindingId,
    instanceId: "instance-1",
    operationId: key().operationId,
    turnId,
    interactionId: "permission-1",
    optionsDigest: "sha256:original-options",
    revision: "request-1",
    expiresAt: new Date(1050).toISOString(),
    options: [
      { id: "yes-17", label: "Allow once", kind: "allow-once" },
      { id: "no-17", label: "Deny", kind: "deny" },
    ],
  };
  const event = source(f.lease, 1, {
    type: "interaction.requested",
    turnId,
    payload: descriptor,
  });
  f.journal.commitPluginEvent(f.lease, event, {
    permission: { request: descriptor },
  });
  const decision = intent("decision-1", {
    kind: "permission",
    payload: {
      ...descriptor,
      kind: "permission",
      operationId: "decision-1",
      targetOperationId: descriptor.operationId,
      optionId: "yes-17",
    },
  });
  return { ...f, descriptor, decision, event, turnId };
}

test("permission admission retains one exact choice across expiry and reopen", (t) => {
  const f = permissionFixture(t);
  const first = f.journal.admitPermission(f.lease, f.decision, "instance-1");
  assert.equal(first.created, true);
  code(
    () =>
      f.journal.admitPermission(
        f.lease,
        {
          ...f.decision,
          operationId: "decision-2",
        },
        "instance-1"
      ),
    "operation_conflict"
  );
  code(
    () =>
      f.journal.admitPermission(
        f.lease,
        {
          ...f.decision,
          payload: { ...f.decision.payload, optionId: "no-17" },
        },
        "instance-1"
      ),
    "operation_conflict"
  );
  f.clock.value = 1060;
  const reopened = f.open();
  assert.deepEqual(
    reopened.admitPermission(f.lease, f.decision, "replacement"),
    {
      receipt: first.receipt,
      created: false,
    }
  );
  assert.equal(
    reopened.getPermission(f.descriptor)?.decisionOperationId,
    "decision-1"
  );
});

test("permission interrupt bypasses queued text and resolves unknown delivery atomically", (t) => {
  const f = permissionFixture(t);
  f.journal.admit(f.lease, intent("next-message"));
  f.journal.admitPermission(f.lease, f.decision, "instance-1");
  const reserved = f.journal.reserveNext(f.lease, binding, {
    interruptKinds: ["permission"],
  });
  assert.equal(reserved?.receipt.operationId, "decision-1");
  f.journal.recordDisposition(f.lease, key("decision-1"), {
    delivery: "unknown",
    execution: "unknown",
    observation: "reconciliation_required",
  });
  const resolution = { ...f.descriptor, status: "applied", optionId: "no-17" };
  const event = source(f.lease, 2, {
    type: "interaction.resolved",
    turnId: f.turnId,
    payload: resolution,
  });
  code(
    () =>
      f.journal.commitPluginEvent(f.lease, event, {
        permission: { resolution },
      }),
    "permission_conflict"
  );
  assert.equal(f.journal.sourceAck(binding.bindingId), 1);
  assert.equal(f.journal.getPermission(f.descriptor)?.resolution, undefined);
  resolution.optionId = "yes-17";
  assert.equal(
    f.journal.commitPluginEvent(
      f.lease,
      {
        ...event,
        payload: resolution,
      },
      { permission: { resolution } }
    ).ack,
    2
  );
  const receipt = f.journal.getOperation(key("decision-1"))!;
  assert.equal(receipt.delivery, "accepted");
  assert.equal(receipt.execution, "ended");
  assert.deepEqual(receipt.result, { status: "applied" });
  code(
    () => f.journal.expireOperation(f.lease, key("decision-1")),
    "operation_retained"
  );
  assert.ok(f.journal.getOperationRecord(key("decision-1"))!.payload);
});

test("permission descriptor conflicts and expired decisions leave no admitted operation", (t) => {
  const f = permissionFixture(t);
  code(
    () =>
      f.journal.commitPluginEvent(
        f.lease,
        {
          ...f.event,
          eventId: "changed-request",
          sourceSequence: 2,
        },
        { permission: { request: { ...f.descriptor, revision: "changed" } } }
      ),
    "permission_conflict"
  );
  assert.equal(f.journal.sourceAck(binding.bindingId), 1);
  f.clock.value = 1050;
  code(
    () => f.journal.admitPermission(f.lease, f.decision, "instance-1"),
    "interaction_expired"
  );
  assert.equal(f.journal.getOperation(key("decision-1")), null);
});

test("lost permission instances expire queued decisions and preserve ambiguous dispatched choices", (t) => {
  const f = permissionFixture(t);
  f.journal.admitPermission(f.lease, f.decision, "instance-1");
  f.journal.closePermissions(f.lease, binding, "renamed-bot", "instance-1");
  assert.equal(f.journal.getPermission(f.descriptor)?.resolution, undefined);
  f.journal.closePermissions(f.lease, binding, "renamed-bot", "replacement");
  assert.equal(
    f.journal.getPermission(f.descriptor)?.resolution?.status,
    "expired"
  );
  assert.equal(f.journal.getOperation(key("decision-1"))?.delivery, "rejected");
  const transcript = f.journal.readTranscript(binding);
  assert.equal(
    transcript.filter((entry) => entry.permissionResolved).length,
    1
  );
  f.journal.closePermissions(f.lease, binding, "renamed-bot");
  assert.deepEqual(f.journal.readTranscript(binding), transcript);

  const g = permissionFixture(t);
  g.journal.admitPermission(g.lease, g.decision, "instance-1");
  g.journal.reserveNext(g.lease, binding, { interruptKinds: ["permission"] });
  g.journal.closePermissions(g.lease, binding, "fixture");
  assert.equal(
    g.journal.getPermission(g.descriptor)?.resolution?.status,
    "unknown"
  );
  // Losing the future is not proof the chosen native response was consumed.
  assert.equal(
    g.journal.getOperation(key("decision-1"))?.delivery,
    "dispatching"
  );
  assert.equal(
    g.journal.admitPermission(g.lease, g.decision, "replacement").created,
    false
  );
});

test("gateway storage pins the real engine, WAL and FULL synchronous durability", (t) => {
  const { journal, path } = fixture(t);
  assert.equal(journal.sqliteVersion, GATEWAY_SQLITE_VERSION);
  assert.equal(GATEWAY_SQLITE_VERSION, "3.53.4");
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(
      (inspect.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
      "wal"
    );
    // FULL is SQLite's durable connection default; the journal also explicitly sets it.
    assert.equal(
      (inspect.prepare("PRAGMA synchronous").get() as { synchronous: number })
        .synchronous,
      2
    );
  } finally {
    inspect.close();
  }
  code(() => new GatewayJournal(":memory:"), "storage_not_durable");
});

test("fleet and bot identities persist; rename preserves the identity and bindings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tidy-gateway-fleet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  let db = new GatewayJournal(path);
  const fleetId = db.fleetId;
  let lease = db.acquireWriterLease("one");
  const bot = db.ensureBot(lease, "researcher");
  assert.deepEqual(db.ensureBot(lease, "researcher"), bot);
  db.ensureConversation(lease, { ...binding, botId: bot.botId });
  db.renameBot(lease, bot.botId, "investigator");
  db.releaseWriterLease(lease, { ownershipReconciled: true });
  db.close();
  db = new GatewayJournal(path);
  try {
    assert.equal(db.fleetId, fleetId);
    assert.equal(db.botByName("researcher"), null);
    assert.equal(db.botByName("investigator")?.botId, bot.botId);
    assert.equal(db.listConversations()[0].botId, bot.botId);
    lease = db.acquireWriterLease("two");
    assert.equal(lease.generation, 2);
    assert.equal(db.ensureBot(lease, "investigator").botId, bot.botId);
    code(
      () => new GatewayJournal(path, { fleetId: "different-fleet" }),
      "fleet_mismatch"
    );
  } finally {
    db.close();
  }
});

test("unknown schema and foreign databases are refused without erasing them", (t) => {
  const { path, journal } = fixture(t);
  journal.close();
  sql(path, "PRAGMA user_version=42");
  code(() => new GatewayJournal(path), "incompatible_storage");
  const foreign = join(
    tmpdir(),
    `tidy-foreign-${process.pid}-${Date.now()}.db`
  );
  t.after(() => rmSync(foreign, { force: true }));
  sql(
    foreign,
    "CREATE TABLE important(value TEXT); INSERT INTO important VALUES('keep')"
  );
  code(() => new GatewayJournal(foreign), "incompatible_storage");
  const inspect = new DatabaseSync(foreign);
  try {
    assert.equal(
      (
        inspect.prepare("SELECT value FROM important").get() as {
          value: string;
        }
      ).value,
      "keep"
    );
  } finally {
    inspect.close();
  }
});

test("missing journal tables and fleet identity fail recovery rather than synthesizing empty state", (t) => {
  const { path, journal } = fixture(t);
  journal.close();
  sql(path, "DROP TABLE source_events");
  code(() => new GatewayJournal(path), "corrupt_storage");
  const otherDir = mkdtempSync(join(tmpdir(), "tidy-gateway-corrupt-"));
  t.after(() => rmSync(otherDir, { recursive: true, force: true }));
  const otherPath = join(otherDir, "state.db");
  new GatewayJournal(otherPath).close();
  sql(otherPath, "DELETE FROM gateway_meta WHERE key='fleet_id'");
  code(() => new GatewayJournal(otherPath), "corrupt_storage");
});

test("admission durably commits the flat client receipt and one canonical user entry", (t) => {
  const { journal, lease, open } = fixture(t);
  const result = journal.admit(lease, intent());
  assert.equal(result.created, true);
  const expected = JSON.parse(
    readFileSync(
      new URL("./fixtures/gateway-journal/receipt.json", import.meta.url),
      "utf8"
    )
  );
  assert.deepEqual(result.receipt, {
    ...expected,
    userEntryId: result.receipt.userEntryId,
  });
  const entry = journal.readTranscript(binding)[0];
  assert.equal(entry.id, result.receipt.userEntryId);
  assert.equal(entry.operationId, result.receipt.operationId);
  assert.equal(entry.role, "user");
  assert.equal(entry.origin, "operator");
  assert.equal(entry.text, intent().payload.text);
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.getOperation(key()), result.receipt);
  assert.deepEqual(reopened.readTranscript(binding), [entry]);
  assert.match(
    reopened.getOperationRecord(key())!.payloadDigest,
    /^sha256:[a-f0-9]{64}$/
  );
});

test("an identical immutable key survives retries and object key order; every changed intent conflicts", (t) => {
  const { journal, lease } = fixture(t);
  const original = journal.admit(
    lease,
    intent("same", { payload: { text: "Inspect", details: { a: 1, b: 2 } } })
  );
  assert.deepEqual(
    journal.admit(
      lease,
      intent("same", { payload: { details: { b: 2, a: 1 }, text: "Inspect" } })
    ),
    { receipt: original.receipt, created: false }
  );
  code(
    () =>
      journal.admit(lease, intent("same", { payload: { text: "Changed" } })),
    "operation_conflict"
  );
  code(
    () =>
      journal.admit(
        lease,
        intent("same", {
          actorId: "someone-else",
          payload: { text: "Inspect", details: { a: 1, b: 2 } },
        })
      ),
    "operation_conflict"
  );
  code(
    () =>
      journal.admit(
        lease,
        intent("same", {
          kind: "compact",
          payload: { text: "Inspect", details: { a: 1, b: 2 } },
        })
      ),
    "operation_conflict"
  );
  code(
    () => journal.admit(lease, intent("same", { bindingRevision: "old" })),
    "binding_conflict"
  );
  journal.admit(
    lease,
    intent("another", { payload: { text: "Inspect", details: { a: 1, b: 2 } } })
  );
  assert.equal(journal.readTranscript(binding).length, 2);
});

test("canonical digest refuses silent JSON coercions and preserves meaningful array/text order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.notEqual(payloadDigest(["a", "b"]), payloadDigest(["b", "a"]));
  for (const value of [
    NaN,
    Infinity,
    undefined,
    BigInt(1),
    new Date(),
    [undefined],
    new Array(1),
    { omitted: undefined },
  ])
    code(() => canonicalJson(value), "invalid_payload");
  const cycle: unknown[] = [];
  cycle.push(cycle);
  code(() => canonicalJson(cycle), "invalid_payload");
});

test("a failed canonical-entry transaction cannot acknowledge or retain a ghost operation", (t) => {
  const { journal, lease, path } = fixture(t);
  sql(
    path,
    "CREATE TRIGGER reject_entry BEFORE INSERT ON transcript_entries BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END"
  );
  assert.throws(
    () => journal.admit(lease, intent()),
    /simulated storage failure/
  );
  assert.equal(journal.getOperation(key()), null);
  assert.deepEqual(journal.readTranscript(binding), []);
  sql(path, "DROP TRIGGER reject_entry");
  assert.equal(journal.admit(lease, intent()).created, true);
});

test("public admission append commits with the receipt and rolls back with any append failure", (t) => {
  const { journal, lease, path } = fixture(t);
  sql(
    path,
    "CREATE TRIGGER reject_public BEFORE INSERT ON public_events BEGIN SELECT RAISE(ABORT, 'public write failed'); END"
  );
  assert.throws(
    () =>
      journal.admit(
        lease,
        intent("op-example-42", { publicBotName: "researcher" })
      ),
    /public write failed/
  );
  assert.equal(journal.getOperation(key()), null);
  assert.equal(journal.readTranscript(binding).length, 0);
  sql(path, "DROP TRIGGER reject_public");
  const admitted = journal.admit(
    lease,
    intent("op-example-42", { publicBotName: "researcher" })
  );
  assert.equal(journal.readEvents()[0].event.type, "append");
  assert.equal(
    (journal.readEvents()[0].event.entry as { id: string }).id,
    admitted.receipt.userEntryId
  );
  assert.equal(
    journal.admit(lease, intent("op-example-42", { publicBotName: "renamed" }))
      .created,
    false
  );
  assert.equal(journal.publicSequence, 1);
});

test("competing connections, expiry and stale global generations fence every mutation", (t) => {
  const { journal, lease, open, clock } = fixture(t);
  const other = open();
  code(() => other.acquireWriterLease("writer-2"), "writer_busy");
  clock.value += 101;
  code(() => journal.admit(lease, intent()), "stale_writer");
  code(() => other.acquireWriterLease("writer-2"), "ownership_unreconciled");
  const replacement = other.acquireWriterLease("writer-2", {
    previousOwnerReconciled: true,
  });
  assert.equal(replacement.generation, lease.generation + 1);
  code(() => journal.ensureBot(lease, "stale"), "stale_writer");
  code(() => journal.admit(lease, intent()), "stale_writer");
  code(
    () => journal.releaseWriterLease(lease, { ownershipReconciled: true }),
    "stale_writer"
  );
  assert.equal(other.admit(replacement, intent()).created, true);
  code(
    () => other.commitPluginEvent(replacement, source(lease)),
    "stale_plugin"
  );
  const renewed = other.renewWriterLease(replacement, 50_000);
  assert.equal(renewed.generation, replacement.generation);
  assert.equal(renewed.expiresAt, clock.value + 50_000);
});

test("releasing a lease is not proof its native process stopped", (t) => {
  const { journal, lease } = fixture(t);
  journal.releaseWriterLease(lease);
  code(() => journal.acquireWriterLease("next"), "ownership_unreconciled");
  const next = journal.acquireWriterLease("next", {
    previousOwnerReconciled: true,
  });
  journal.releaseWriterLease(next, { ownershipReconciled: true });
  assert.equal(journal.acquireWriterLease("third").generation, 3);
});

function ownedFixture(t: TestContext) {
  const f = fixture(t);
  f.journal.releaseWriterLease(f.lease, { ownershipReconciled: true });
  const ownerProcess = { pid: 1001, startedAt: "boot-1:owner-birth-1" };
  const lease = f.journal.acquireWriterLease("tracked-writer", {
    ttlMs: 100,
    ownerProcess,
  });
  return { ...f, lease, ownerProcess };
}

test("legacy writer state remains readable without fabricating supervisor proof", (t) => {
  const { journal, lease } = fixture(t);
  assert.equal(journal.getSupervisorRecord(), null);
  assert.deepEqual(journal.getWriterState(), { ...lease, reconciled: false });
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "launch-1",
        bindingId: binding.bindingId,
      }),
    "ownership_missing"
  );
  assert.equal(journal.getSupervisorRecord(), null);
});

test("process ownership and prepared/started/stopped launch boundaries persist across reopen", (t) => {
  const { journal, lease, ownerProcess, open } = ownedFixture(t);
  assert.deepEqual(journal.getSupervisorRecord(), {
    version: 1,
    generation: lease.generation,
    ownerProcess,
    launches: [],
  });
  const prepared = journal.prepareOwnedLaunch(lease, {
    launchId: "launch-1",
    bindingId: binding.bindingId,
  });
  assert.equal(prepared.state, "prepared");
  assert.deepEqual(
    journal.prepareOwnedLaunch(lease, {
      launchId: "launch-1",
      bindingId: binding.bindingId,
    }),
    prepared
  );
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.getSupervisorRecord()!.launches, [prepared]);
  const process = {
    pid: 2002,
    startedAt: "boot-1:wrapper-birth-1",
    token: "unguessable-launch-token",
  };
  const started = reopened.recordOwnedLaunch(lease, "launch-1", process);
  assert.deepEqual(
    reopened.recordOwnedLaunch(lease, "launch-1", process),
    started
  );
  code(
    () => reopened.releaseWriterLease(lease, { ownershipReconciled: true }),
    "ownership_unreconciled"
  );
  reopened.close();
  const again = open();
  assert.deepEqual(again.getSupervisorRecord()!.launches, [started]);
  const stopped = again.completeOwnedLaunch(lease, "launch-1");
  assert.deepEqual(stopped, { ...started, state: "stopped" });
  assert.deepEqual(again.completeOwnedLaunch(lease, "launch-1"), stopped);
  again.releaseWriterLease(lease, { ownershipReconciled: true });
  assert.equal(again.getWriterState()!.reconciled, true);
  assert.deepEqual(again.getSupervisorRecord()!.launches, [stopped]);
});

test("launch identities cannot change, revive, or concurrently own one binding", (t) => {
  const { journal, lease } = ownedFixture(t);
  code(
    () =>
      journal.recordOwnedLaunch(lease, "absent", {
        pid: 2002,
        startedAt: "birth",
        token: "token",
      }),
    "launch_not_prepared"
  );
  journal.prepareOwnedLaunch(lease, {
    launchId: "one",
    bindingId: binding.bindingId,
  });
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "two",
        bindingId: binding.bindingId,
      }),
    "binding_owned"
  );
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "one",
        bindingId: "different-binding",
      }),
    "launch_conflict"
  );
  journal.recordOwnedLaunch(lease, "one", {
    pid: 2002,
    startedAt: "birth",
    token: "token",
  });
  for (const changed of [
    { pid: 2003, startedAt: "birth", token: "token" },
    { pid: 2002, startedAt: "reused-pid-birth", token: "token" },
    { pid: 2002, startedAt: "birth", token: "new-token" },
  ])
    code(
      () => journal.recordOwnedLaunch(lease, "one", changed),
      "launch_conflict"
    );
  journal.completeOwnedLaunch(lease, "one");
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "one",
        bindingId: binding.bindingId,
      }),
    "launch_conflict"
  );
  code(
    () =>
      journal.recordOwnedLaunch(lease, "one", {
        pid: 2002,
        startedAt: "birth",
        token: "token",
      }),
    "launch_conflict"
  );
  journal.prepareOwnedLaunch(lease, {
    launchId: "two",
    bindingId: binding.bindingId,
  });
  // A wrapper that never activated may be completed after the supervisor proves its absence.
  assert.equal(journal.completeOwnedLaunch(lease, "two").state, "stopped");
});

test("independent child groups retain ancestry and prevent premature parent reconciliation", (t) => {
  const { journal, lease, open } = ownedFixture(t);
  journal.prepareOwnedLaunch(lease, {
    launchId: "root",
    bindingId: binding.bindingId,
  });
  const child = {
    launchId: "worker",
    bindingId: binding.bindingId,
    parentLaunchId: "root",
  };
  code(() => journal.prepareOwnedLaunch(lease, child), "parent_not_owned");
  const identity = {
    pid: 2002,
    startedAt: "parent-birth",
    token: "parent-token",
  };
  journal.recordOwnedLaunch(lease, "root", identity);
  journal.prepareOwnedLaunch(lease, child);
  code(
    () => journal.completeOwnedLaunch(lease, "root"),
    "ownership_unreconciled"
  );
  code(
    () => journal.recordOwnedLaunch(lease, "worker", identity),
    "launch_conflict"
  );
  code(
    () =>
      journal.recordOwnedLaunch(lease, "worker", { ...identity, pid: 2003 }),
    "launch_conflict"
  );
  journal.recordOwnedLaunch(lease, "worker", {
    pid: 2003,
    startedAt: "child-birth",
    token: "child-token",
  });
  journal.close();
  const reopened = open();
  assert.equal(
    reopened.getSupervisorRecord()!.launches[1].parentLaunchId,
    "root"
  );
  code(
    () => reopened.completeOwnedLaunch(lease, "root"),
    "ownership_unreconciled"
  );
  code(
    () => reopened.releaseWriterLease(lease, { ownershipReconciled: true }),
    "ownership_unreconciled"
  );
  reopened.completeOwnedLaunch(lease, "worker");
  reopened.completeOwnedLaunch(lease, "root");
  reopened.releaseWriterLease(lease, { ownershipReconciled: true });
  assert.equal(reopened.getWriterState()!.reconciled, true);
});

test("child launch identity cannot change parent or bind to another bot", (t) => {
  const { journal, lease } = ownedFixture(t);
  for (const [launchId, bindingId, pid] of [
    ["root", binding.bindingId, 2001],
    ["other", "other-binding", 2002],
  ] as const) {
    journal.prepareOwnedLaunch(lease, { launchId, bindingId });
    journal.recordOwnedLaunch(lease, launchId, {
      pid,
      startedAt: "birth",
      token: `token-${pid}`,
    });
  }
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "child",
        bindingId: binding.bindingId,
        parentLaunchId: "other",
      }),
    "parent_not_owned"
  );
  journal.prepareOwnedLaunch(lease, {
    launchId: "child",
    bindingId: binding.bindingId,
    parentLaunchId: "root",
  });
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "child",
        bindingId: binding.bindingId,
      }),
    "launch_conflict"
  );
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "child",
        bindingId: binding.bindingId,
        parentLaunchId: "child",
      }),
    "launch_conflict"
  );
  assert.equal(journal.getSupervisorRecord()!.launches.length, 3);
});

test("child ancestry validation refuses orphaned, cyclic and falsely stopped evidence on reopen", (t) => {
  const { journal, lease, path } = ownedFixture(t);
  journal.prepareOwnedLaunch(lease, {
    launchId: "root",
    bindingId: binding.bindingId,
  });
  journal.recordOwnedLaunch(lease, "root", {
    pid: 2001,
    startedAt: "birth",
    token: "root-token",
  });
  journal.prepareOwnedLaunch(lease, {
    launchId: "child",
    bindingId: binding.bindingId,
    parentLaunchId: "root",
  });
  journal.recordOwnedLaunch(lease, "child", {
    pid: 2002,
    startedAt: "birth",
    token: "child-token",
  });
  const valid = journal.getSupervisorRecord()!;
  for (const mutate of [
    (v: typeof valid) => {
      v.launches[1].parentLaunchId = "missing";
    },
    (v: typeof valid) => {
      v.launches[0].parentLaunchId = "child";
    },
    (v: typeof valid) => {
      v.launches[0] = { ...v.launches[0], state: "stopped" };
    },
    (v: typeof valid) => {
      v.launches[1].bindingId = "other-binding";
    },
    (v: typeof valid) => {
      v.launches[1] = {
        ...v.launches[1],
        state: "started",
        pid: 2001,
        startedAt: "birth",
        token: "child-token",
      };
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE gateway_meta SET value=? WHERE key='supervisor_ownership_v1'"
    ).run(JSON.stringify(invalid));
    db.close();
    code(() => journal.getSupervisorRecord(), "invalid_ownership");
  }
});

test("ownership depth exhaustion refuses admission without corrupting retained ancestry", (t) => {
  const { journal, lease } = ownedFixture(t);
  for (let depth = 0; depth < 64; depth++) {
    const launchId = `node-${depth}`;
    journal.prepareOwnedLaunch(lease, {
      launchId,
      bindingId: binding.bindingId,
      ...(depth ? { parentLaunchId: `node-${depth - 1}` } : {}),
    });
    journal.recordOwnedLaunch(lease, launchId, {
      pid: 2000 + depth,
      startedAt: "birth",
      token: `token-${depth}`,
    });
  }
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "overflow",
        bindingId: binding.bindingId,
        parentLaunchId: "node-63",
      }),
    "resource_limit"
  );
  assert.equal(journal.getSupervisorRecord()!.launches.length, 64);
});

test("ownership metadata failure rolls back lease acquisition and preserves a closed activation gate", (t) => {
  const { journal, lease, path } = fixture(t);
  journal.releaseWriterLease(lease, { ownershipReconciled: true });
  const before = journal.getWriterState();
  sql(
    path,
    "CREATE TRIGGER reject_ownership BEFORE INSERT ON gateway_meta WHEN NEW.key='supervisor_ownership_v1' BEGIN SELECT RAISE(ABORT, 'ownership storage failed'); END"
  );
  assert.throws(
    () =>
      journal.acquireWriterLease("tracked", {
        ownerProcess: { pid: 1001, startedAt: "birth" },
      }),
    /ownership storage failed/
  );
  assert.deepEqual(journal.getWriterState(), before);
  assert.equal(journal.getSupervisorRecord(), null);
  sql(path, "DROP TRIGGER reject_ownership");
  const tracked = journal.acquireWriterLease("tracked", {
    ownerProcess: { pid: 1001, startedAt: "birth" },
  });
  journal.prepareOwnedLaunch(tracked, {
    launchId: "launch",
    bindingId: binding.bindingId,
  });
  sql(
    path,
    "CREATE TRIGGER reject_recording BEFORE UPDATE ON gateway_meta WHEN NEW.key='supervisor_ownership_v1' BEGIN SELECT RAISE(ABORT, 'recording unavailable'); END"
  );
  assert.throws(
    () =>
      journal.recordOwnedLaunch(tracked, "launch", {
        pid: 2002,
        startedAt: "wrapper-birth",
        token: "token",
      }),
    /recording unavailable/
  );
  assert.equal(journal.getSupervisorRecord()!.launches[0].state, "prepared");
});

test("replacement ownership proof is bound to the inspected generation and stale launch writers are fenced", (t) => {
  const { journal, lease, clock } = ownedFixture(t);
  journal.prepareOwnedLaunch(lease, {
    launchId: "old",
    bindingId: binding.bindingId,
  });
  journal.recordOwnedLaunch(lease, "old", {
    pid: 2002,
    startedAt: "birth",
    token: "token",
  });
  clock.value += 101;
  const ownerProcess = { pid: 3003, startedAt: "boot-1:replacement-birth" };
  code(
    () =>
      journal.acquireWriterLease("replacement", {
        ownerProcess,
        previousGeneration: lease.generation,
      }),
    "ownership_unreconciled"
  );
  const replacement = journal.acquireWriterLease("replacement", {
    ownerProcess,
    previousOwnerReconciled: true,
    previousGeneration: lease.generation,
  });
  assert.deepEqual(journal.getSupervisorRecord(), {
    version: 1,
    generation: replacement.generation,
    ownerProcess,
    launches: [],
  });
  code(
    () =>
      journal.acquireWriterLease("third", {
        ownerProcess,
        previousOwnerReconciled: true,
        previousGeneration: lease.generation,
      }),
    "ownership_changed"
  );
  code(() => journal.completeOwnedLaunch(lease, "old"), "stale_writer");
  code(
    () =>
      journal.prepareOwnedLaunch(lease, {
        launchId: "stale",
        bindingId: binding.bindingId,
      }),
    "stale_writer"
  );
  code(
    () =>
      journal.acquireWriterLease("replacement", {
        ownerProcess: { ...ownerProcess, pid: 4004 },
      }),
    "owner_process_conflict"
  );
});

test("malformed, duplicate and mismatched ownership metadata never become empty recovery evidence", (t) => {
  const { journal, lease, ownerProcess, path } = ownedFixture(t);
  const valid = {
    version: 1,
    generation: lease.generation,
    ownerProcess,
    launches: [],
  };
  function replace(value: unknown) {
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE gateway_meta SET value=? WHERE key='supervisor_ownership_v1'"
      ).run(JSON.stringify(value));
    } finally {
      db.close();
    }
  }
  const launch = {
    launchId: "one",
    bindingId: binding.bindingId,
    state: "prepared",
  };
  for (const invalid of [
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, ownerProcess: { pid: 0, startedAt: "birth" } },
    { ...valid, launches: [launch, launch] },
    { ...valid, launches: [{ ...launch, state: "started" }] },
    {
      ...valid,
      launches: [{ ...launch, pid: 20, startedAt: "birth", token: "token" }],
    },
  ]) {
    replace(invalid);
    code(() => journal.getSupervisorRecord(), "invalid_ownership");
  }
  replace({ ...valid, generation: lease.generation + 1 });
  code(() => journal.getSupervisorRecord(), "ownership_changed");
  code(
    () => journal.acquireWriterLease("same", { previousOwnerReconciled: true }),
    "writer_busy"
  );
  replace(valid);
  assert.deepEqual(journal.getSupervisorRecord(), valid);
});

test("FIFO reservation precedes native dispatch; unknown blocks the conversation without retries", (t) => {
  const { journal, lease } = fixture(t);
  journal.admit(lease, intent("first"));
  journal.admit(lease, intent("second"));
  code(
    () =>
      journal.recordDisposition(lease, key("first"), { delivery: "accepted" }),
    "unreserved_dispatch"
  );
  const reserved = journal.reserveNext(lease, binding)!;
  assert.equal(reserved.receipt.operationId, "first");
  assert.equal(reserved.receipt.delivery, "dispatching");
  assert.equal(reserved.leaseGeneration, lease.generation);
  assert.equal(journal.reserveNext(lease, binding), null);
  assert.equal(journal.recoverInterrupted(lease), 1);
  const unknown = journal.getOperation(key("first"))!;
  assert.equal(unknown.delivery, "unknown");
  assert.equal(unknown.execution, "unknown");
  assert.equal(unknown.observation, "reconciliation_required");
  assert.equal(journal.reserveNext(lease, binding), null);
  code(
    () =>
      journal.recordDisposition(lease, key("first"), { delivery: "queued" }),
    "unsafe_retry"
  );
  code(
    () =>
      journal.recordDisposition(lease, key("first"), {
        delivery: "accepted",
        execution: "ended",
        observation: "complete",
      }),
    "evidence_required"
  );
  journal.recordDisposition(lease, key("first"), {
    delivery: "accepted",
    execution: "ended",
    observation: "complete",
    evidence: "native turn receipt turn-123",
  });
  assert.equal(
    journal.reserveNext(lease, binding)!.receipt.operationId,
    "second"
  );
});

test("terminal output with an observation gap still blocks subsequent work", (t) => {
  const { journal, lease } = fixture(t);
  accepted(journal, lease);
  journal.admit(lease, intent("second"));
  journal.recordDisposition(lease, key(), {
    execution: "ended",
    observation: "live_gap",
  });
  assert.equal(journal.reserveNext(lease, binding), null);
  code(
    () => journal.recordDisposition(lease, key(), { observation: "complete" }),
    "evidence_required"
  );
  code(
    () => journal.recordDisposition(lease, key(), { execution: "running" }),
    "invalid_transition"
  );
  journal.recordDisposition(lease, key(), {
    observation: "complete",
    evidence: "complete native history with watermark",
  });
  assert.equal(
    journal.reserveNext(lease, binding)!.receipt.operationId,
    "second"
  );
});

test("host crash preserves a durable native acceptance while execution and observation become unknown", (t) => {
  const { journal, lease, open } = fixture(t);
  accepted(journal, lease);
  journal.admit(lease, intent("next"));
  assert.equal(journal.recoverInterrupted(lease), 1);
  const recovered = journal.getOperation(key())!;
  assert.equal(recovered.delivery, "accepted");
  assert.equal(recovered.execution, "unknown");
  assert.equal(recovered.observation, "reconciliation_required");
  assert.equal(journal.reserveNext(lease, binding), null);
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.getOperation(key()), recovered);
  assert.equal(reopened.admit(lease, intent()).receipt.delivery, "accepted");
  assert.equal(reopened.reserveNext(lease, binding), null);
});

test("queue cancellation requires proof dispatch never started", (t) => {
  const { journal, lease } = fixture(t);
  journal.admit(lease, intent("queued"));
  const cancelled = journal.cancelQueued(lease, key("queued"));
  assert.equal(cancelled.delivery, "rejected");
  assert.equal(cancelled.execution, "cancelled");
  journal.admit(lease, intent());
  journal.reserveNext(lease, binding);
  code(() => journal.cancelQueued(lease, key()), "already_dispatched");
  assert.equal(journal.getOperation(key())!.delivery, "dispatching");
});

test("controls and session creation share durable reservations without user entries", (t) => {
  const { journal, lease, open } = fixture(t);
  const request = intent("open-1", {
    kind: "session_open",
    payload: {
      mode: "new",
      cwd: "/tmp/fake-workspace",
      policyRevision: "policy-1",
    },
  });
  const receipt = journal.admit(lease, request).receipt;
  assert.equal(receipt.kind, "session_open");
  assert.equal(receipt.userEntryId, undefined);
  assert.deepEqual(journal.readTranscript(binding), []);
  const reservation = journal.reserveNext(lease, binding)!;
  journal.recordDisposition(
    lease,
    { ...key(), operationId: "open-1" },
    {
      delivery: "accepted",
      execution: "ended",
      result: { status: "applied", nativeReference: "native-session-1" },
    }
  );
  journal.close();
  const reopened = open();
  assert.equal(reopened.listOperationRecords()[0].turnId, reservation.turnId);
  assert.deepEqual(reopened.listOperationRecords()[0].receipt.result, {
    nativeReference: "native-session-1",
    status: "applied",
  });
  assert.deepEqual(reopened.readTranscript(binding), []);
});

test("public model receipt matches the shared client fixture and requires an explicit applied result", (t) => {
  const { journal, lease } = fixture(t);
  const modelBinding = {
    ...binding,
    botId: "bot-builder-1",
    conversationId: "conv-builder-1",
    bindingId: "binding-builder-1",
    bindingRevision: "binding-builder-1:cap-7",
  };
  journal.ensureConversation(lease, modelBinding);
  journal.admit(lease, {
    ...modelBinding,
    operationId: "op-model-example-43",
    kind: "model",
    payload: { model: "test-model" },
  });
  journal.reserveNext(lease, modelBinding);
  const controlKey = { ...modelBinding, operationId: "op-model-example-43" };
  const ended = journal.recordDisposition(lease, controlKey, {
    delivery: "accepted",
    execution: "ended",
  });
  assert.equal(ended.result, undefined);
  journal.admit(lease, {
    ...modelBinding,
    operationId: "next-message",
    payload: { text: "Uses the new model" },
  });
  assert.equal(journal.reserveNext(lease, modelBinding), null);
  code(
    () => journal.expireOperation(lease, controlKey),
    "operation_unresolved"
  );
  const applied = journal.recordDisposition(lease, controlKey, {
    result: { status: "applied" },
  });
  const expected = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/gateway-journal/control-receipt.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assert.deepEqual(applied, expected);
  assert.equal(
    journal.reserveNext(lease, modelBinding)!.receipt.operationId,
    "next-message"
  );
  code(
    () =>
      journal.recordDisposition(lease, controlKey, {
        result: { status: "requested" },
      }),
    "result_conflict"
  );
});

test("only explicitly enabled exact-target controls can interrupt known active work", (t) => {
  const { journal, lease } = fixture(t);
  accepted(journal, lease);
  journal.recordDisposition(lease, key(), { execution: "waiting_for_input" });
  journal.admit(lease, intent("ordinary-next"));
  journal.admit(
    lease,
    intent("wrong-target", {
      kind: "permission",
      payload: { targetOperationId: "other" },
    })
  );
  journal.admit(
    lease,
    intent("decision", {
      kind: "permission",
      payload: { targetOperationId: "op-example-42", optionId: "deny-once" },
    })
  );
  assert.equal(journal.reserveNext(lease, binding), null);
  const decision = journal.reserveNext(lease, binding, {
    interruptKinds: ["permission"],
  })!;
  assert.equal(decision.receipt.operationId, "decision");
  assert.equal(
    journal.reserveNext(lease, binding, { interruptKinds: ["permission"] }),
    null
  );
  journal.recordDisposition(lease, key("decision"), {
    delivery: "unknown",
    execution: "unknown",
    observation: "reconciliation_required",
  });
  journal.admit(
    lease,
    intent("cancel", {
      kind: "cancel",
      payload: { targetOperationId: "op-example-42" },
    })
  );
  assert.equal(
    journal.reserveNext(lease, binding, { interruptKinds: ["cancel"] }),
    null
  );
});

test("out-of-order source events wait for a contiguous durable ack and public ordering", (t) => {
  const { journal, lease, open } = fixture(t);
  accepted(journal, lease);
  const second = source(lease, 2, { type: "operation.ended" });
  const held = journal.commitPluginEvent(lease, second, {
    operation: { execution: "ended" },
    entries: [{ id: "assistant-1", role: "assistant", text: "Done" }],
  });
  assert.deepEqual(held, { duplicate: false, ack: 0, publicEvents: [] });
  assert.equal(journal.maxSourceSequence(binding.bindingId), 2);
  assert.equal(journal.sourceAck(binding.bindingId), 0);
  assert.equal(journal.readTranscript(binding).length, 1);
  const first = journal.commitPluginEvent(lease, source(lease));
  assert.equal(first.ack, 2);
  assert.deepEqual(
    first.publicEvents.map((item) => item.seq),
    [1, 2]
  );
  assert.deepEqual(
    journal
      .readSourceEvents(binding.bindingId)
      .map((event) => event.sourceSequence),
    [1, 2]
  );
  assert.equal(journal.readTranscript(binding).length, 2);
  assert.equal(journal.getOperation(key())!.execution, "ended");
  journal.close();
  const reopened = open();
  assert.equal(reopened.sourceAck(binding.bindingId), 2);
  assert.equal(reopened.publicSequence, 2);
  assert.equal(reopened.readEvents(1)[0].event.type, "operation.ended");
});

test("lost event ack, new lease re-envelope and duplicate canonical entries cannot duplicate output", (t) => {
  const { journal, lease, open, clock } = fixture(t);
  accepted(journal, lease);
  const entry = { id: "assistant-1", role: "assistant", text: "Answer" };
  journal.commitPluginEvent(lease, source(lease), { entries: [entry] });
  assert.deepEqual(journal.commitPluginEvent(lease, source(lease)), {
    duplicate: true,
    ack: 1,
    publicEvents: [],
  });
  journal.commitPluginEvent(lease, source(lease, 2), { entries: [entry] });
  assert.equal(journal.readTranscript(binding).length, 2);
  clock.value += 101;
  const replacement = open();
  const nextLease = replacement.acquireWriterLease("replacement", {
    previousOwnerReconciled: true,
  });
  assert.equal(
    replacement.commitPluginEvent(nextLease, source(nextLease)).duplicate,
    true
  );
  assert.equal(replacement.publicSequence, 2);
  code(
    () =>
      replacement.commitPluginEvent(
        nextLease,
        source(nextLease, 1, { payload: { text: "different" } })
      ),
    "event_conflict"
  );
  code(
    () =>
      replacement.commitPluginEvent(
        nextLease,
        source(nextLease, 3, { eventId: "event-1" })
      ),
    "event_conflict"
  );
  code(
    () =>
      replacement.commitPluginEvent(nextLease, source(nextLease, 3), {
        entries: [{ ...entry, text: "changed" }],
      }),
    "entry_conflict"
  );
  assert.equal(replacement.sourceAck(binding.bindingId), 2);
});

test("terminal receipt, canonical entry, source ack, public event and completion outbox commit atomically", (t) => {
  const { journal, lease, path, open } = fixture(t);
  accepted(journal, lease);
  const event = source(lease, 1, { type: "operation.ended" });
  const projection = {
    operation: { execution: "ended" as const },
    entries: [{ id: "assistant-result", role: "assistant", text: "Complete" }],
    completion: {
      dispatchId: "dispatch-1",
      originBotId: "origin-1",
      payload: { text: "Complete", isCompletion: true },
    },
  };
  sql(
    path,
    "CREATE TRIGGER reject_outbox BEFORE INSERT ON completion_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END"
  );
  assert.throws(
    () => journal.commitPluginEvent(lease, event, projection),
    /outbox unavailable/
  );
  assert.equal(journal.getOperation(key())!.execution, "running");
  assert.equal(journal.readTranscript(binding).length, 1);
  assert.equal(journal.maxSourceSequence(binding.bindingId), 0);
  assert.equal(journal.publicSequence, 0);
  assert.equal(journal.readOutbox().length, 0);
  sql(path, "DROP TRIGGER reject_outbox");
  assert.equal(journal.commitPluginEvent(lease, event, projection).ack, 1);
  const delivery = journal.readOutbox()[0];
  assert.equal(delivery.dispatchId, "dispatch-1");
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.readOutbox(), [delivery]);
  assert.equal(
    reopened.commitPluginEvent(lease, event, projection).duplicate,
    true
  );
  assert.equal(reopened.readOutbox().length, 1);
  reopened.ackOutbox(lease, delivery.id);
  assert.deepEqual(reopened.readOutbox(), []);
  // A distinct source event reporting the same terminal completion cannot enqueue it again.
  reopened.commitPluginEvent(
    lease,
    source(lease, 2, { type: "operation.ended" }),
    projection
  );
  assert.deepEqual(reopened.readOutbox(), []);
});

test("public sequence remains durable across synthetic reconnect snapshots", (t) => {
  const { journal, lease, open } = fixture(t);
  const helloSeq = journal.publicSequence;
  const snapshots = journal.appendPublicEvents(lease, binding.bindingId, [
    { type: "bubble", bot: "researcher", text: "Recovered active turn" },
  ]);
  assert.ok(snapshots[0].seq > helloSeq);
  journal.close();
  const reopened = open();
  const next = reopened.appendPublicEvents(lease, binding.bindingId, [
    { type: "state", state: "busy" },
  ]);
  assert.equal(next[0].seq, snapshots[0].seq + 1);
  assert.deepEqual(
    reopened.readEvents(helloSeq).map((event) => event.seq),
    [1, 2]
  );
});

test("expired operation bodies and deleted conversations retain immutable identity tombstones", (t) => {
  const { journal, lease, open } = fixture(t);
  journal.admit(lease, intent());
  code(() => journal.expireOperation(lease, key()), "operation_unresolved");
  code(
    () => journal.tombstoneConversation(lease, binding),
    "conversation_unresolved"
  );
  journal.cancelQueued(lease, key());
  journal.expireOperation(lease, key());
  assert.equal(journal.getOperationRecord(key())!.payload, null);
  assert.equal(journal.getOperationRecord(key())!.expired, true);
  code(() => journal.admit(lease, intent()), "operation_expired");
  code(
    () =>
      journal.admit(
        lease,
        intent("op-example-42", { payload: { text: "Different" } })
      ),
    "operation_conflict"
  );
  journal.tombstoneConversation(lease, binding);
  assert.deepEqual(journal.listConversations(), []);
  journal.close();
  const reopened = open();
  code(
    () => reopened.ensureConversation(lease, binding),
    "conversation_deleted"
  );
  code(() => reopened.admit(lease, intent("new-id")), "conversation_deleted");
  assert.equal(reopened.getOperation(key())!.delivery, "rejected");
});

for (const crashPoint of ["queued", "reserved"] as const) {
  test(`real SIGKILL after ${crashPoint} commit reopens without losing accepted intent or retrying an ambiguous native boundary`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "tidy-gateway-kill-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "crash.db");
    const script = `
      import { GatewayJournal } from ${JSON.stringify(new URL("../src/gateway/journal.ts", import.meta.url).href)};
      const db = new GatewayJournal(${JSON.stringify(path)}, {fleetId: 'fleet-example-1', now: () => 1});
      const lease = db.acquireWriterLease('doomed', {ttlMs: 10});
      db.ensureConversation(lease, ${JSON.stringify(binding)});
      db.admit(lease, ${JSON.stringify(intent())});
      ${crashPoint === "reserved" ? `db.reserveNext(lease, ${JSON.stringify(binding)});` : ""}
      process.kill(process.pid, 'SIGKILL');
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" }
    );
    assert.equal(result.signal, "SIGKILL", result.stderr);
    const db = new GatewayJournal(path, { now: () => 100 });
    try {
      const lease = db.acquireWriterLease("recovered", {
        previousOwnerReconciled: true,
      });
      assert.equal(db.readTranscript(binding).length, 1);
      assert.equal(
        db.getOperation(key())!.delivery,
        crashPoint === "queued" ? "queued" : "dispatching"
      );
      db.recoverInterrupted(lease);
      if (crashPoint === "queued")
        assert.equal(
          db.reserveNext(lease, binding)!.receipt.operationId,
          "op-example-42"
        );
      else {
        assert.equal(db.getOperation(key())!.delivery, "unknown");
        assert.equal(db.reserveNext(lease, binding), null);
        assert.equal(db.admit(lease, intent()).created, false);
        assert.equal(db.reserveNext(lease, binding), null);
      }
    } finally {
      db.close();
    }
  });
}

test("cancel admission atomically settles queued work and retains its receipt across restart", (t) => {
  const { journal, lease, open } = fixture(t);
  journal.admit(lease, intent("target"));
  const cancel = intent("cancel", {
    kind: "cancel",
    payload: { targetOperationId: "target" },
  });
  const admitted = journal.admitCancellation(lease, cancel);
  assert.equal(admitted.receipt.result?.status, "cancelled");
  assert.equal(journal.getOperation(key("target"))!.execution, "cancelled");
  assert.equal(journal.reserveNext(lease, binding), null);
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.admitCancellation(lease, cancel), {
    ...admitted,
    created: false,
  });
  code(
    () =>
      reopened.admitCancellation(lease, {
        ...cancel,
        payload: { targetOperationId: "different" },
      }),
    "operation_conflict"
  );
});

test("cancel admission never locally settles dispatched work", (t) => {
  const { journal, lease } = fixture(t);
  accepted(journal, lease);
  const cancel = intent("cancel", {
    kind: "cancel",
    payload: { targetOperationId: "op-example-42" },
  });
  assert.equal(
    journal.admitCancellation(lease, cancel).receipt.delivery,
    "queued"
  );
  assert.equal(journal.getOperation(key())!.delivery, "accepted");
  assert.equal(
    journal.reserveNext(lease, binding, { interruptKinds: ["cancel"] })!.receipt
      .operationId,
    "cancel"
  );
});

test("cancel admission rolls back both receipt and target when settlement storage fails", (t) => {
  const { journal, lease, path } = fixture(t);
  journal.admit(lease, intent("target"));
  const cancel = intent("cancel", {
    kind: "cancel",
    payload: { targetOperationId: "target" },
  });
  sql(
    path,
    "CREATE TRIGGER fail_cancel BEFORE UPDATE ON operations WHEN NEW.operation_id='cancel' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
  );
  assert.throws(() => journal.admitCancellation(lease, cancel));
  assert.equal(journal.getOperation(key("cancel")), null);
  assert.equal(journal.getOperation(key("target"))!.delivery, "queued");
  sql(path, "DROP TRIGGER fail_cancel;");
  assert.equal(
    journal.admitCancellation(lease, cancel).receipt.result?.status,
    "cancelled"
  );
});

test("queued fleet cancellation retains one completion atomically with cancellation", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const target = {
    ...binding,
    botId: "target",
    conversationId: "target-conversation",
    bindingId: "target-binding",
    bindingRevision: "target-revision",
  };
  f.journal.ensureConversation(f.lease, target);
  const dispatched = f.journal.admitFleetDispatch(f.lease, {
    origin: { ...binding, operationId: key().operationId },
    target,
    toolCallId: "tool",
    actionId: "action",
    text: "Task",
  });
  const cancel: AdmitOperation = {
    ...target,
    kind: "cancel",
    operationId: "cancel-target",
    payload: { targetOperationId: dispatched.dispatchId },
  };
  sql(
    f.path,
    "CREATE TRIGGER fail_completion BEFORE INSERT ON completion_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END;"
  );
  assert.throws(() => f.journal.admitCancellation(f.lease, cancel));
  assert.equal(
    f.journal.getOperation({ ...target, operationId: dispatched.dispatchId })!
      .delivery,
    "queued"
  );
  assert.equal(f.journal.getOperation(cancel), null);
  sql(f.path, "DROP TRIGGER fail_completion;");
  f.journal.admitCancellation(f.lease, cancel);
  f.journal.admitCancellation(f.lease, cancel);
  const deliveries = f.journal.readOutbox();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].payload.execution, "cancelled");
  assert.equal(deliveries[0].payload.originBindingId, binding.bindingId);
});

test("startup session load precedes queued messages but cannot bypass uncertain native work", (t) => {
  const f = fixture(t);
  f.journal.admit(f.lease, intent("message"));
  f.journal.admit(
    f.lease,
    intent("restore", {
      kind: "session_open",
      payload: { mode: "load", nativeReference: "native:one" },
    })
  );
  assert.equal(
    f.journal.reserveNext(f.lease, binding, { sessionLoadId: "message" }),
    null
  );
  assert.equal(
    f.journal.reserveNext(f.lease, binding, { sessionLoadId: "restore" })
      ?.receipt.operationId,
    "restore"
  );
  assert.equal(f.journal.getOperation(key("message"))?.delivery, "queued");
  assert.equal(f.journal.reserveNext(f.lease, binding), null);
  f.journal.recordDisposition(f.lease, key("restore"), {
    delivery: "accepted",
    execution: "ended",
    result: { status: "opened", nativeReference: "native:one" },
  });
  assert.equal(
    f.journal.reserveNext(f.lease, binding)?.receipt.operationId,
    "message"
  );
  f.journal.recordDisposition(f.lease, key("message"), {
    delivery: "unknown",
    execution: "unknown",
    observation: "reconciliation_required",
  });
  f.journal.admit(
    f.lease,
    intent("restore-again", {
      kind: "session_open",
      payload: { mode: "load", nativeReference: "native:one" },
    })
  );
  assert.equal(
    f.journal.reserveNext(f.lease, binding, { sessionLoadId: "restore-again" }),
    null
  );
  assert.equal(
    f.journal.getOperation(key("restore-again"))?.delivery,
    "queued"
  );
});

test("artifact bytes commit with intent and survive restart with exact scoped reads", (t) => {
  const f = fixture(t);
  const uploads = [
    {
      name: "note.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("hello world"),
    },
  ];
  const first = f.journal.admitMessageArtifacts(f.lease, intent(), uploads);
  const descriptor = (
    f.journal.getOperationRecord(key())!.payload!.artifacts as JsonObject[]
  )[0];
  const scope = { ...key(), bindingId: binding.bindingId };
  const part = f.journal.readArtifact(
    scope,
    String(descriptor.artifactId),
    0,
    5
  );
  assert.equal(Buffer.from(part.bytes).toString(), "hello");
  assert.equal(part.nextOffset, 5);
  code(
    () =>
      f.journal.readArtifact(
        { ...scope, bindingId: "other" },
        String(descriptor.artifactId)
      ),
    "artifact_unavailable"
  );
  f.journal.admit(f.lease, intent("other"));
  code(
    () =>
      f.journal.readArtifact(
        { ...scope, operationId: "other" },
        String(descriptor.artifactId)
      ),
    "artifact_unavailable"
  );
  f.journal.close();
  const reopened = f.open();
  assert.deepEqual(reopened.admitMessageArtifacts(f.lease, intent(), uploads), {
    ...first,
    created: false,
  });
  assert.equal(
    Buffer.from(
      reopened.readArtifact(scope, String(descriptor.artifactId), 5).bytes
    ).toString(),
    " world"
  );
  code(
    () =>
      reopened.admitMessageArtifacts(f.lease, intent(), [
        { ...uploads[0], bytes: Buffer.from("changed") },
      ]),
    "operation_conflict"
  );
});

test("public images retain scoped byte access across restart and refuse expired or corrupt storage", (t) => {
  const f = fixture(t);
  // Journal tests use synthetic bytes; raster validation belongs to HTTP admission.
  const bytes = Buffer.alloc(130000, 7);
  f.journal.admitMessageArtifacts(
    f.lease,
    intent(undefined, { publicBotName: "researcher" }),
    [
      { name: "photo.png", mediaType: "image/png", bytes },
      { name: "note.txt", mediaType: "text/plain", bytes: Buffer.from("note") },
    ]
  );
  const entry = f.journal.readTranscript(binding)[0];
  const images = entry.images as JsonObject[];
  assert.equal(images.length, 1);
  assert.equal((entry.attachments as JsonObject[]).length, 1);
  assert.match(
    String(images[0].path),
    /^\.fleet\/images\/researcher\/[a-f0-9]{64}\.png$/
  );
  const file = String(images[0].path).split("/").at(-1)!;
  assert.deepEqual(f.journal.readImage(binding, file), {
    mediaType: "image/png",
    bytes,
  });
  for (const invalid of [
    "../" + file,
    file.replace(".png", ".jpg"),
    "photo.png",
    file + "/extra",
  ])
    code(() => f.journal.readImage(binding, invalid), "artifact_unavailable");
  code(
    () => f.journal.readImage({ ...binding, bindingId: "another" }, file),
    "artifact_unavailable"
  );
  const other = {
    ...binding,
    botId: "another",
    conversationId: "another-conversation",
    bindingId: "another-binding",
  };
  f.journal.ensureConversation(f.lease, other);
  code(() => f.journal.readImage(other, file), "artifact_unavailable");
  f.journal.cancelQueued(f.lease, key());
  f.journal.close();
  const reopened = f.open();
  assert.deepEqual(reopened.readImage(binding, file).bytes, bytes);
  sql(
    f.path,
    "UPDATE gateway_meta SET value=json_set(value,'$.data','YmFk') WHERE substr(key,1,12)='artifact_v1:';"
  );
  code(() => reopened.readImage(binding, file), "corrupt_storage");
  reopened.expireOperation(f.lease, key());
  code(() => reopened.readImage(binding, file), "artifact_unavailable");
});

test("artifact storage failure rolls back intent and corruption refuses both access and retry", (t) => {
  const f = fixture(t);
  const uploads = [
    { name: "note.txt", mediaType: "text/plain", bytes: Buffer.from("hello") },
  ];
  sql(
    f.path,
    "CREATE TRIGGER fail_artifact BEFORE INSERT ON gateway_meta WHEN substr(NEW.key,1,12)='artifact_v1:' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
  );
  assert.throws(() =>
    f.journal.admitMessageArtifacts(f.lease, intent(), uploads)
  );
  assert.equal(f.journal.getOperation(key()), null);
  assert.equal(f.journal.readTranscript(binding).length, 0);
  sql(f.path, "DROP TRIGGER fail_artifact;");
  f.journal.admitMessageArtifacts(f.lease, intent(), uploads);
  const descriptor = (
    f.journal.getOperationRecord(key())!.payload!.artifacts as JsonObject[]
  )[0];
  sql(
    f.path,
    "UPDATE gateway_meta SET value=json_set(value,'$.data','YmFk') WHERE substr(key,1,12)='artifact_v1:';"
  );
  code(
    () =>
      f.journal.readArtifact(
        { ...key(), bindingId: binding.bindingId },
        String(descriptor.artifactId)
      ),
    "corrupt_storage"
  );
  code(
    () => f.journal.admitMessageArtifacts(f.lease, intent(), uploads),
    "corrupt_storage"
  );
});

test("artifact bytes expire with bodies while retained operation identity rejects reuse", (t) => {
  const f = fixture(t);
  const uploads = [
    {
      name: "note.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("private bytes"),
    },
  ];
  f.journal.admitMessageArtifacts(f.lease, intent(), uploads);
  f.journal.cancelQueued(f.lease, key());
  f.journal.expireOperation(f.lease, key());
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM gateway_meta WHERE substr(key,1,12)='artifact_v1:'"
          )
          .get() as { n: number }
      ).n,
      0
    );
  } finally {
    db.close();
  }
  code(
    () => f.journal.admitMessageArtifacts(f.lease, intent(), uploads),
    "operation_expired"
  );
});

test("generic question admission is immutable, instance-fenced, and never stores applied consumption", (t) => {
  const f = fixture(t);
  accepted(f.journal, f.lease);
  const turnId = f.journal.getOperationRecord(key())!.turnId!;
  const descriptor: JsonObject = {
    bindingId: binding.bindingId,
    instanceId: "question-instance",
    operationId: key().operationId,
    turnId,
    interactionId: "ui-1",
    optionsDigest: "sha256:question-options",
    revision: "1",
    kind: "question",
    method: "select",
    title: "Choose",
    options: ["A", "B"],
    expiresAt: new Date(1050).toISOString(),
  };
  f.journal.commitPluginEvent(
    f.lease,
    source(f.lease, 1, {
      type: "interaction.requested",
      turnId,
      interactionId: "ui-1",
      payload: descriptor,
    }),
    { question: { request: descriptor } }
  );
  const decision = intent("question-answer", {
    kind: "question",
    payload: {
      ...descriptor,
      operationId: "question-answer",
      targetOperationId: descriptor.operationId,
      value: "B",
    },
  });
  const first = f.journal.admitQuestion(f.lease, decision, "question-instance");
  assert.equal(first.created, true);
  assert.deepEqual(
    f.journal.admitQuestion(f.lease, decision, "question-instance"),
    { receipt: first.receipt, created: false }
  );
  code(
    () =>
      f.journal.admitQuestion(
        f.lease,
        { ...decision, payload: { ...decision.payload, value: "A" } },
        "question-instance"
      ),
    "operation_conflict"
  );
  code(
    () =>
      f.journal.admitQuestion(
        f.lease,
        { ...decision, operationId: "wrong-instance" },
        "different-instance"
      ),
    "operation_conflict"
  );
  assert.equal(f.journal.getQuestion(descriptor)?.resolution, undefined);
});

test("routine admission binds one stable fire to one canonical operation and owner generation", (t) => {
  const f = fixture(t);
  const schedule = f.journal.registerRoutineSchedule(
    f.lease,
    "scribe:nightly",
    "legacy-gateway"
  );
  const input = {
    scheduleId: schedule.scheduleId,
    occurrence: "2026-08-31T10:05:00-05:00",
    owner: schedule.owner,
    ownerGeneration: schedule.generation,
    binding,
    payload: { text: "scheduled status" },
  };
  const first = f.journal.admitRoutineFire(f.lease, input);
  assert.equal(first.created, true);
  assert.equal(first.receipt.delivery, "queued");
  assert.deepEqual(f.journal.admitRoutineFire(f.lease, input), {
    ...first,
    created: false,
  });
  assert.equal(f.journal.listOperationRecords(binding).length, 1);
  code(
    () =>
      f.journal.admitRoutineFire(f.lease, {
        ...input,
        payload: { text: "changed scheduled status" },
      }),
    "operation_conflict"
  );
  const cutover = f.journal.cutoverRoutineSchedule(
    f.lease,
    schedule.scheduleId,
    schedule.owner,
    schedule.generation,
    "hermes"
  );
  code(
    () => f.journal.admitRoutineFire(f.lease, input),
    "schedule_owner_conflict"
  );
  const next = f.journal.admitRoutineFire(f.lease, {
    ...input,
    occurrence: "2026-08-31T10:06:00-05:00",
    owner: cutover.owner,
    ownerGeneration: cutover.generation,
  });
  assert.equal(next.created, true);
  assert.notEqual(next.fireId, first.fireId);
  assert.equal(
    f.journal.getOperation(key(first.receipt.operationId))?.delivery,
    "queued"
  );
});

test("gateway journal v1 upgrades schedule tables without erasing retained operations", (t) => {
  const f = fixture(t);
  f.journal.admit(f.lease, intent("retained-before-upgrade"));
  f.journal.close();
  sql(
    f.path,
    "DROP TABLE routine_fires; DROP TABLE schedule_owners; UPDATE writer_lease SET owner_id=NULL, expires_at=0, reconciled=1; PRAGMA user_version=1"
  );
  const upgraded = f.open();
  const lease = upgraded.acquireWriterLease("writer-upgrade", {
    previousGeneration: 1,
    previousOwnerReconciled: true,
  });
  assert.equal(
    upgraded.getOperation(key("retained-before-upgrade"))?.delivery,
    "queued"
  );
  const owner = upgraded.registerRoutineSchedule(
    lease,
    "scribe:nightly",
    "hermes"
  );
  assert.equal(owner.generation, 1);
});

test("gateway journal refuses v1 upgrade for wrong fleet without mutating storage", (t) => {
  const f = fixture(t);
  f.journal.close();
  sql(
    f.path,
    "DROP TABLE routine_fires; DROP TABLE schedule_owners; PRAGMA user_version=1"
  );
  assert.throws(
    () => f.open("different-fleet"),
    (error: unknown) =>
      error instanceof GatewayJournalError && error.code === "fleet_mismatch"
  );
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version
      ),
      1
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='routine_fires'")
        .get(),
      undefined
    );
  } finally {
    db.close();
  }
});

test("gateway journal refuses v1 upgrade while an old writer is live", (t) => {
  const f = fixture(t);
  f.journal.close();
  sql(
    f.path,
    "DROP TABLE routine_fires; DROP TABLE schedule_owners; PRAGMA user_version=1"
  );
  assert.throws(
    () => f.open(),
    (error: unknown) =>
      error instanceof GatewayJournalError &&
      error.code === "ownership_unreconciled"
  );
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version
      ),
      1
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='schedule_owners'")
        .get(),
      undefined
    );
  } finally {
    db.close();
  }
});
