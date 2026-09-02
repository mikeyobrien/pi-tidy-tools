/**
 * Machine-readable wire contract for native clients (TypeBox schemas) and the
 * /api/version payload. Schemas describe the daemon's actual emissions — keep
 * them in sync with daemon.ts when the wire changes.
 */
import { Type } from "typebox";
import { createRequire } from "node:module";
import { DAEMON_REVISION } from "./revision.ts";

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
  "turn-parts",
  "compaction",
  "model-swap-hardening",
] as const;

export const VersionResponseSchema = Type.Object({
  version: Type.String(),
  capabilities: Type.Array(Type.String()),
  commit: Type.Optional(Type.String()),
  commitFull: Type.Optional(Type.String()),
  fleetName: Type.Optional(Type.String()),
  fleetDir: Type.Optional(Type.String()),
});

export function versionPayload(): {
  version: string;
  capabilities: string[];
  commit?: string;
  commitFull?: string;
} {
  return {
    version: DAEMON_VERSION,
    capabilities: [...CAPABILITIES],
    ...(DAEMON_REVISION
      ? { commit: DAEMON_REVISION.short, commitFull: DAEMON_REVISION.full }
      : {}),
  };
}

// ── Transcript entries ─────────────────────────────────
export const TranscriptStepSchema = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  duration: Type.Optional(Type.Number()),
});

export const TranscriptEntrySchema = Type.Object({
  id: Type.String(),
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("system"),
  ]),
  origin: Type.Union([
    Type.Literal("operator"),
    Type.Literal("bot"),
    Type.Literal("routine"),
    Type.Literal("system"),
  ]),
  originFrom: Type.Optional(Type.String()),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("handoff"),
      Type.Literal("handoff-receipt"),
      Type.Literal("completion"),
    ])
  ),
  receipt: Type.Optional(
    Type.Object({
      name: Type.String(),
      avatar: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    })
  ),
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.Optional(Type.String()),
        mediaType: Type.String(),
      })
    )
  ),
  text: Type.String(),
  ts: Type.String(),
  delivering: Type.Optional(Type.Boolean()),
  deliveryError: Type.Optional(Type.String()),
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
  queue: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        text: Type.String(),
        hasImage: Type.Boolean(),
        filename: Type.Optional(Type.String()),
      })
    )
  ),
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

export const TextPartSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

export const ToolPartSchema = Type.Object({
  type: Type.Literal("tool"),
  toolCallId: Type.String(),
  tool: Type.String(),
  label: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("ok"),
    Type.Literal("error"),
  ]),
  duration: Type.Optional(Type.Number()),
  output: Type.Optional(Type.String()),
});

export const TurnPartSchema = Type.Union([TextPartSchema, ToolPartSchema]);

export const BubblePayloadSchema = Type.Object({
  type: Type.Literal("bubble"),
  bot: Type.String(),
  turnId: Type.Union([Type.String(), Type.Null()]),
  phase: Type.Union([
    Type.Literal("working"),
    Type.Literal("steps"),
    Type.Literal("parts"),
    Type.Literal("delta"),
    Type.Literal("final"),
  ]),
  text: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(TranscriptStepSchema)),
  parts: Type.Optional(Type.Array(TurnPartSchema)),
});

export const ConfigPayloadSchema = Type.Object({
  type: Type.Literal("config"),
  toolOutput: Type.Union([
    Type.Literal("off"),
    Type.Literal("reasons"),
    Type.Literal("full"),
  ]),
});

export const ConfigErrorPayloadSchema = Type.Object({
  type: Type.Literal("config-error"),
  error: Type.String(),
});

export const WsEventSchema = Type.Union([
  HelloPayloadSchema,
  RosterPayloadSchema,
  AppendPayloadSchema,
  BubblePayloadSchema,
  ConfigPayloadSchema,
  ConfigErrorPayloadSchema,
]);
