import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseRpc,
  sessionOpenEvidenceMatches,
  validateCapabilities,
  validateEvent,
  validateLimits,
} from "../src/gateway/protocol.ts";

const capabilities = () => ({
  input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
  sessions: { load: false, import: false, continuity: "unverified" },
  output: { text: "final-only", tools: false, usage: "unknown" },
  operations: {
    nativeDedupe: "none",
    nativeReplay: "none",
    cancel: "unsupported",
    steer: false,
  },
  interactions: { permissions: "none", questions: false },
  configuration: { model: false, thinking: false, compact: false },
  fleetTools: false,
});

test("LF framing preserves escaped newlines, Unicode separators and split multibyte input", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: "00001",
    method: "echo",
    params: { text: "line\nnext\u2028other\u2029🙂" },
  };
  const bytes = encodeFrame(message);
  const frames: unknown[] = [];
  const parser = new FrameDecoder();
  for (const byte of bytes)
    parser.push(Buffer.from([byte]), (frame) => frames.push(frame));
  parser.finish();
  assert.deepEqual(frames, [message]);
});

test("complete frame limit includes UTF-8 envelope escaping and terminal LF", () => {
  const message = {
    jsonrpc: "2.0" as const,
    method: "x",
    params: { text: '🙂\n"' },
  };
  const bytes = encodeFrame(message);
  assert.equal(encodeFrame(message, bytes.length).length, bytes.length);
  assert.throws(() => encodeFrame(message, bytes.length - 1), {
    code: "resource_limit",
  });
  assert.throws(
    () => new FrameDecoder(16).push(Buffer.alloc(16, 120), () => {}),
    { code: "resource_limit" }
  );
  const parser = new FrameDecoder(bytes.length);
  const result: unknown[] = [];
  parser.push(bytes, (frame) => result.push(frame));
  assert.deepEqual(result, [message]);
});

test("protocol rejects batches, numeric/null IDs, malformed requests, invalid UTF-8 and truncated frames", () => {
  for (const value of [
    [],
    null,
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: null, result: {} },
    { jsonrpc: "2.0", id: "1", result: {}, error: {} },
    { jsonrpc: "2.0", method: "x", params: [] },
    { jsonrpc: "2.0", id: "1" },
  ])
    assert.throws(() => parseRpc(value), { code: "invalid_frame" });
  assert.throws(
    () => new FrameDecoder().push(Buffer.from([0xc0, 0x80, 10]), () => {}),
    { code: "invalid_frame" }
  );
  assert.throws(() => new FrameDecoder().push(Buffer.from("log\n"), () => {}), {
    code: "invalid_frame",
  });
  const parser = new FrameDecoder();
  parser.push(Buffer.from("{}"), () => {});
  assert.throws(() => parser.finish(), { code: "invalid_frame" });
});

test("limits may only narrow defaults", () => {
  assert.equal(validateLimits({ maxFrameBytes: 2000 }).maxFrameBytes, 2000);
  assert.throws(
    () => validateLimits({ maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes + 1 }),
    { code: "invalid_config" }
  );
  assert.throws(() => validateLimits({ commandTimeoutMs: 0 }), {
    code: "invalid_config",
  });
});

test("optional new_context is distinct from compact and rejects a non-boolean", () => {
  assert.equal(
    validateCapabilities(capabilities()).configuration.new_context,
    undefined
  );
  assert.equal(
    validateCapabilities({
      ...capabilities(),
      configuration: {
        ...capabilities().configuration,
        new_context: true,
      },
    }).configuration.new_context,
    true
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        configuration: {
          ...capabilities().configuration,
          new_context: "yes",
        },
      }),
    { code: "invalid_capabilities" }
  );
});

test("capabilities reject unbacked guarantees and unknown required extensions", () => {
  assert.equal(validateCapabilities(capabilities()).output.usage, "unknown");
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        operations: { ...capabilities().operations, nativeDedupe: "durable" },
      }),
    { code: "invalid_capabilities" }
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        operations: {
          ...capabilities().operations,
          nativeReplay: "cursor",
          nativeReplayRetentionMs: 1000,
        },
      }),
    { code: "invalid_capabilities" }
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        sessions: { ...capabilities().sessions, load: true },
      }),
    { code: "invalid_capabilities" }
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        sessions: {
          load: true,
          import: false,
          continuity: "verified",
        },
      }),
    { code: "invalid_capabilities" }
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        sessions: {
          load: true,
          import: false,
          continuity: "verified",
          proof: "none",
          emptySeat: "non-restorable",
        },
      }),
    { code: "invalid_capabilities" }
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        sessions: {
          ...capabilities().sessions,
          proof: "identity-only",
        },
      }),
    { code: "invalid_capabilities" }
  );
  assert.deepEqual(
    validateCapabilities({
      ...capabilities(),
      sessions: {
        load: true,
        import: false,
        continuity: "verified",
        proof: "identity-only",
        emptySeat: "non-restorable",
      },
    }).sessions,
    {
      load: true,
      import: false,
      continuity: "verified",
      proof: "identity-only",
      emptySeat: "non-restorable",
    }
  );
  assert.equal(
    validateCapabilities({
      ...capabilities(),
      sessions: {
        load: true,
        import: false,
        continuity: "verified",
        proof: "retained-history",
        emptySeat: "non-restorable",
      },
    }).sessions.proof,
    "retained-history"
  );
  assert.throws(
    () =>
      validateCapabilities({
        ...capabilities(),
        "org.example.feature": { required: true },
      }),
    { code: "invalid_capabilities" }
  );
  assert.deepEqual(
    validateCapabilities({
      ...capabilities(),
      "org.example.feature": { required: false },
    })["org.example.feature"],
    { required: false }
  );
});

test("session open evidence distinguishes identity-only from retained-history", () => {
  const identity = {
    continuity: "verified",
    proof: "identity-only",
    evidence: {
      provenance: "codex-thread-identity",
      expectedHome: true,
      threadId: "thr-1",
    },
  };
  const history = {
    continuity: "verified",
    proof: "retained-history",
    evidence: {
      provenance: "pi-history-checkpoint",
      messageCount: 1,
    },
  };
  assert.equal(sessionOpenEvidenceMatches(identity, "identity-only"), true);
  assert.equal(sessionOpenEvidenceMatches(identity, "retained-history"), false);
  assert.equal(sessionOpenEvidenceMatches(history, "retained-history"), true);
  assert.equal(sessionOpenEvidenceMatches(history, "identity-only"), false);
  assert.equal(
    sessionOpenEvidenceMatches(
      { continuity: "verified", proof: "identity-only" },
      "identity-only"
    ),
    false
  );
  assert.equal(
    sessionOpenEvidenceMatches(
      {
        continuity: "verified",
        proof: "retained-history",
        evidence: { provenance: "codex-thread-identity" },
      },
      "retained-history"
    ),
    false
  );
});

test("canonical events require operation, turn, block and exact request correlation", () => {
  const event = {
    bindingId: "binding",
    leaseGeneration: 1,
    sourceSequence: 1,
    eventId: "event",
    type: "text.snapshot",
    operationId: "operation",
    turnId: "turn",
    messageId: "message",
    blockId: "block",
    payload: { revision: 1, text: "hello" },
  };
  assert.deepEqual(validateEvent(event), event);
  for (const [key, value] of [
    ["operationId", undefined],
    ["turnId", undefined],
    ["blockId", undefined],
    ["payload", { revision: -1, text: "x" }],
    ["sourceSequence", 0],
  ])
    assert.throws(() => validateEvent({ ...event, [key as string]: value }), {
      code: "invalid_event",
    });
  assert.throws(
    () => validateEvent({ ...event, type: "interaction.requested" }),
    { code: "invalid_event" }
  );
});

test("published schemas compile strictly and agree with required capability and canonical event checks", () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const name of [
    "capabilities",
    "event",
    "manifest",
    "protocol",
    "receipt",
    "registry",
  ])
    validators.set(
      name,
      ajv.compile(
        JSON.parse(
          readFileSync(
            new URL(
              `../src/gateway/schema/${name}.schema.json`,
              import.meta.url
            ),
            "utf8"
          )
        )
      )
    );
  const check = validators.get("capabilities")!;
  assert.equal(check(capabilities()), true);
  assert.equal(
    check({
      ...capabilities(),
      operations: { ...capabilities().operations, nativeDedupe: "durable" },
    }),
    false
  );
  assert.equal(
    check({
      ...capabilities(),
      sessions: { load: true, import: false, continuity: "verified" },
    }),
    false
  );
  assert.equal(
    check({
      ...capabilities(),
      sessions: {
        load: true,
        import: false,
        continuity: "verified",
        proof: "identity-only",
        emptySeat: "non-restorable",
      },
    }),
    true
  );
  const terminal = {
    bindingId: "b",
    leaseGeneration: 1,
    sourceSequence: 1,
    eventId: "e",
    type: "turn.terminal",
    operationId: "o",
    turnId: "t",
    payload: { execution: "ended", observation: "complete" },
  };
  assert.equal(validators.get("event")!(terminal), true);
  assert.deepEqual(validateEvent(terminal), terminal);
  assert.equal(
    validators.get("event")!({
      ...terminal,
      payload: { execution: "success" },
    }),
    false
  );
  assert.throws(
    () => validateEvent({ ...terminal, payload: { execution: "success" } }),
    { code: "invalid_event" }
  );
  const budgeted = {
    ...terminal,
    type: "usage.updated",
    payload: {
      contextBudget: {
        remainingTokens: 12,
        source: "adapter",
        windowTokens: 32,
      },
    },
  };
  assert.equal(validators.get("event")!(budgeted), true);
  assert.deepEqual(validateEvent(budgeted), budgeted);
  assert.equal(
    validators.get("event")!({
      ...budgeted,
      payload: { contextBudget: { remainingTokens: -1, source: "adapter" } },
    }),
    false
  );
  assert.throws(
    () =>
      validateEvent({
        ...budgeted,
        payload: { contextBudget: { remainingTokens: 1, source: "guess" } },
      }),
    { code: "invalid_event" }
  );
  const reset = {
    fleetId: "fleet",
    botId: "bot",
    conversationId: "conv",
    bindingId: "binding",
    bindingRevision: "binding:1",
    operationId: "reset-1",
    kind: "new_context",
    delivery: "accepted",
    execution: "ended",
    observation: "complete",
    result: {
      status: "applied",
      checkpoint: "no-summary",
      contextGeneration: 1,
    },
  };
  assert.equal(validators.get("receipt")!(reset), true);
  assert.equal(
    validators.get("receipt")!({
      ...reset,
      result: { status: "applied", checkpoint: "summary" },
    }),
    false
  );
  assert.equal(
    validators.get("protocol")!({ jsonrpc: "2.0", id: "01", result: {} }),
    true
  );
  assert.equal(
    validators.get("protocol")!({ jsonrpc: "2.0", id: 1, result: {} }),
    false
  );
});
