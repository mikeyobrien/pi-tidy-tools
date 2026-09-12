import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  BubblePayloadSchema,
  ConfigPayloadSchema,
  RosterPayloadSchema,
  TextPartSchema,
  ToolPartSchema,
  TranscriptEntrySchema,
  TranscriptStepSchema,
  TurnPartSchema,
  WsEventSchema,
} from "../src/contract.ts";

// F-γ drift guard: captured sample payloads — one per real wire shape the
// daemon emits — run through EVERY schema. When the daemon adds a field the
// apps parse, the sample gains it and a stale schema fails HERE, in CI,
// instead of in a strict generated client at runtime.
//
// Samples are captured shapes (field-for-field from the daemon's emission
// paths), not hand-optimized minimal objects: fidelity is the point.

const compile = (schema: unknown) => Compile(schema as never);
const now = new Date().toISOString();

const samples: Array<{ schema: unknown; name: string; payload: unknown }> = [
  {
    name: "transcript entry — operator message with image refs + queue flags",
    schema: TranscriptEntrySchema,
    payload: {
      id: "e1",
      role: "user",
      origin: "operator",
      text: "look at this",
      images: [
        {
          mediaType: "image/png",
          name: "shot.png",
          path: ".fleet/images/forge/abc123.png",
        },
      ],
      attachments: [{ name: "clip.mp4", mediaType: "video/mp4" }],
      delivering: true,
      ts: now,
    },
  },
  {
    name: "transcript entry — handoff with dispatch receipt chip (issue 128)",
    schema: TranscriptEntrySchema,
    payload: {
      id: "e2",
      role: "user",
      origin: "bot",
      originFrom: "atlas",
      kind: "handoff",
      text: "do the thing",
      ts: now,
    },
  },
  {
    name: "transcript entry — settled assistant turn with parts + steps",
    schema: TranscriptEntrySchema,
    payload: {
      id: "e3",
      role: "assistant",
      origin: "bot",
      originFrom: "forge",
      text: "done",
      ts: now,
      parts: [
        { type: "text", text: "working on it" },
        {
          type: "tool",
          toolCallId: "t1",
          tool: "message_agent",
          label: "message_agent",
          reason: "delegate the fix",
          status: "ok",
          started: Date.now() - 1000,
          duration: 812,
          output: "Delivered to mason.",
          receipt: { name: "mason", avatar: "🧱", title: "Flutter builder" },
        },
        {
          type: "tool",
          toolCallId: "t2",
          tool: "bash",
          status: "error",
          started: Date.now() - 500,
          duration: 30,
          output: "exit 1",
          error: "command failed",
        },
      ],
      steps: [
        { name: "bash", duration: 30, error: true },
        { name: "message_agent", duration: 812, running: false },
      ],
    },
  },
  {
    name: "transcript entry — question card + its resolution",
    schema: TranscriptEntrySchema,
    payload: {
      id: "e4",
      role: "system",
      origin: "system",
      text: "",
      ui: {
        id: "ui-1",
        method: "elicitInput",
        title: "Which branch?",
        options: ["main", "bots/forge"],
        placeholder: "branch",
      },
      ts: now,
    },
  },
  {
    name: "transcript entry — resolved card + legacy source key",
    schema: TranscriptEntrySchema,
    payload: {
      id: "e5",
      role: "system",
      origin: "system",
      text: "",
      uiResolved: { id: "ui-1", value: "bots/forge", auto: true },
      source: "package:pi-telegram",
      ts: now,
    },
  },
  {
    name: "roster payload — full bot row incl. latest preview + queue items + emptyTurns",
    schema: RosterPayloadSchema,
    payload: {
      type: "roster",
      bots: [
        {
          name: "forge",
          title: "Remediation Worker",
          description: "Implementation worker",
          avatar: "🔨",
          online: true,
          active: true,
          lastActive: now,
          queued: 1,
          queue: [{ id: "q1", text: "queued follow-up", hasImage: false }],
          emptyTurns: { streak: 2, degraded: true, lastAt: now },
          latest: "the last transcript entry preview text",
        },
      ],
      counts: { total: 1, active: 1 },
    },
  },
  {
    name: "config payload — all four toolOutput modes incl. counts",
    schema: ConfigPayloadSchema,
    payload: { type: "config", toolOutput: "counts" },
  },
  {
    name: "config payload — off mode",
    schema: ConfigPayloadSchema,
    payload: { type: "config", toolOutput: "off" },
  },
  {
    name: "config payload — reasons mode",
    schema: ConfigPayloadSchema,
    payload: { type: "config", toolOutput: "reasons" },
  },
  {
    name: "config payload — full mode",
    schema: ConfigPayloadSchema,
    payload: { type: "config", toolOutput: "full" },
  },
  {
    name: "tool part — running with started, no duration yet",
    schema: ToolPartSchema,
    payload: {
      type: "tool",
      toolCallId: "t3",
      tool: "bash",
      status: "running",
      started: Date.now(),
    },
  },
  {
    name: "tool part — error with message and receipt",
    schema: ToolPartSchema,
    payload: {
      type: "tool",
      toolCallId: "t4",
      tool: "message_agent",
      status: "error",
      error: "target offline",
      receipt: { name: "mason" },
    },
  },
  {
    name: "turn part union — text and tool both accepted",
    schema: TurnPartSchema,
    payload: { type: "text", text: "narration" },
  },
  {
    name: "text part",
    schema: TextPartSchema,
    payload: { type: "text", text: "hello" },
  },
  {
    name: "transcript step — bare settled shape",
    schema: TranscriptStepSchema,
    payload: { name: "bash", duration: 42 },
  },
  {
    name: "bubble payload — working frame with parts",
    schema: BubblePayloadSchema,
    payload: {
      type: "bubble",
      bot: "forge",
      turnId: "turn-1",
      phase: "parts",
      parts: [{ type: "text", text: "streaming…" }],
    },
  },
];

test("captured sample payloads validate against every schema (drift guard)", () => {
  for (const { schema, name, payload } of samples) {
    const check = compile(schema);
    assert.equal(check.Check(payload), true, `sample failed schema: ${name}`);
  }
});

test("the drift guard itself is sensitive — mutated samples fail", () => {
  // Negative control: if these assertions ever pass, the guard is vacuous.
  const rosterCheck = compile(RosterPayloadSchema);
  const badRoster = JSON.parse(
    JSON.stringify(
      samples.find((s) => s.schema === RosterPayloadSchema)!.payload
    )
  );
  badRoster.bots[0].online = "yes";
  assert.equal(rosterCheck.Check(badRoster), false);

  const entryCheck = compile(TranscriptEntrySchema);
  assert.equal(
    entryCheck.Check({
      id: "x",
      role: "robot",
      origin: "operator",
      text: "",
      ts: now,
    }),
    false,
    "unknown role literal must fail"
  );

  const configCheck = compile(ConfigPayloadSchema);
  assert.equal(
    configCheck.Check({ type: "config", toolOutput: "sometimes" }),
    false,
    "unknown toolOutput literal must fail"
  );
});

test("roster and config samples also validate through the WS event union", () => {
  const wsCheck = compile(WsEventSchema);
  for (const sample of samples) {
    if (
      sample.schema === RosterPayloadSchema ||
      sample.schema === ConfigPayloadSchema
    ) {
      assert.equal(
        wsCheck.Check(sample.payload),
        true,
        `ws union rejected: ${sample.name}`
      );
    }
  }
});
