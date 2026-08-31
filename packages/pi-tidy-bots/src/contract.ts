/**
 * Machine-readable wire contract for native clients (TypeBox schemas) and the
 * /api/version payload. Schemas describe the daemon's actual emissions — keep
 * them in sync with daemon.ts when the wire changes.
 */
import { Type } from "typebox";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const DAEMON_VERSION = pkg.version;

/** Feature-detection list for GET /api/version. */
export const CAPABILITIES = [
  "messages",
  "images",
  "bus",
  "routines",
  "presence",
  "queue-depth",
  "ui-cards",
  "steer",
  "followUp",
  "ws-auth-bearer",
] as const;

export const VersionResponseSchema = Type.Object({
  version: Type.String(),
  capabilities: Type.Array(Type.String()),
});

export function versionPayload(): {
  version: string;
  capabilities: string[];
} {
  return { version: DAEMON_VERSION, capabilities: [...CAPABILITIES] };
}

// ── Transcript entries ─────────────────────────────────
export const TranscriptStepSchema = Type.Object({
  name: Type.String(),
  duration: Type.Optional(Type.Number()),
});

export const TranscriptEntrySchema = Type.Object({
  id: Type.String(),
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("system"),
  ]),
  source: Type.Optional(Type.String()),
  text: Type.String(),
  ts: Type.String(),
  delivering: Type.Optional(Type.Boolean()),
  steps: Type.Optional(Type.Array(TranscriptStepSchema)),
});

// ── WS events (roster/append/bubble/hello/config) ──────
export const RosterBotSchema = Type.Object({
  name: Type.String(),
  title: Type.Optional(Type.String()),
  avatar: Type.String(),
  online: Type.Boolean(),
  active: Type.Boolean(),
  lastActive: Type.String(),
  queued: Type.Number(),
});

export const RosterPayloadSchema = Type.Object({
  type: Type.Literal("roster"),
  bots: Type.Array(RosterBotSchema),
  counts: Type.Object({ total: Type.Number(), active: Type.Number() }),
});

export const HelloPayloadSchema = Type.Object({
  type: Type.Literal("hello"),
  fleet: Type.String(),
  bootId: Type.String(),
  seq: Type.Number(),
});

export const AppendPayloadSchema = Type.Object({
  type: Type.Literal("append"),
  bot: Type.String(),
  entry: TranscriptEntrySchema,
});

export const BubblePayloadSchema = Type.Object({
  type: Type.Literal("bubble"),
  bot: Type.String(),
  turnId: Type.Union([Type.String(), Type.Null()]),
  phase: Type.Union([
    Type.Literal("working"),
    Type.Literal("steps"),
    Type.Literal("delta"),
    Type.Literal("final"),
  ]),
  text: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(TranscriptStepSchema)),
});

export const ConfigPayloadSchema = Type.Object({
  type: Type.Literal("config"),
  toolOutput: Type.Union([
    Type.Literal("off"),
    Type.Literal("reasons"),
    Type.Literal("full"),
  ]),
});

export const WsEventSchema = Type.Union([
  HelloPayloadSchema,
  RosterPayloadSchema,
  AppendPayloadSchema,
  BubblePayloadSchema,
  ConfigPayloadSchema,
]);
