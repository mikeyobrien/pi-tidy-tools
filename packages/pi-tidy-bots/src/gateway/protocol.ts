import { TextDecoder } from "node:util";

export const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  maxUnacknowledgedEvents: 256,
  maxSpoolBytes: 16 * 1024 * 1024,
  maxPendingRequests: 256,
  initializeTimeoutMs: 10_000,
  inspectTimeoutMs: 10_000,
  commandTimeoutMs: 15_000,
  shutdownTimeoutMs: 10_000,
});
export type ProtocolLimits = { [K in keyof typeof DEFAULT_LIMITS]: number };
export type JsonObject = Record<string, unknown>;
export type RpcMessage = {
  jsonrpc: "2.0";
  id?: string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProtocolError";
  }
}
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function validateLimits(
  limits: Partial<ProtocolLimits> = {}
): ProtocolLimits {
  const output = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(output)) {
    if (
      !(key in DEFAULT_LIMITS) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_LIMITS[key as keyof ProtocolLimits]
    )
      throw new ProtocolError(
        "invalid_config",
        `Invalid negotiated limit ${key}`
      );
  }
  return output;
}
export function parseRpc(value: unknown): RpcMessage {
  if (!object(value) || value.jsonrpc !== "2.0")
    throw new ProtocolError(
      "invalid_frame",
      "Expected a JSON-RPC 2.0 object; batches are unsupported"
    );
  const has = (key: string) => Object.hasOwn(value, key);
  if (has("id") && typeof value.id !== "string")
    throw new ProtocolError("invalid_frame", "RPC IDs must be strings");
  if (has("method")) {
    if (
      !nonempty(value.method) ||
      has("result") ||
      has("error") ||
      (has("params") && !object(value.params))
    )
      throw new ProtocolError("invalid_frame", "Invalid RPC request");
  } else {
    if (!has("id") || has("params") || has("result") === has("error"))
      throw new ProtocolError("invalid_frame", "Invalid RPC response");
    if (
      has("error") &&
      (!object(value.error) ||
        !Number.isInteger(value.error.code) ||
        typeof value.error.message !== "string")
    )
      throw new ProtocolError("invalid_frame", "Invalid RPC error");
  }
  return value as RpcMessage;
}
/** Counts the complete encoded envelope, including its LF, before any pipe write. */
export function encodeFrame(
  message: RpcMessage,
  maxBytes: number = DEFAULT_LIMITS.maxFrameBytes
): Buffer {
  parseRpc(message);
  const frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  if (frame.length > maxBytes)
    throw new ProtocolError(
      "resource_limit",
      "Complete protocol frame exceeds negotiated byte limit"
    );
  return frame;
}
/** A bounded byte parser: LF alone terminates a frame, never Unicode separators. */
export class FrameDecoder {
  readonly maxBytes: number;
  private readonly buffer: Buffer;
  private size = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(maxBytes: number = DEFAULT_LIMITS.maxFrameBytes) {
    this.maxBytes = maxBytes;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > DEFAULT_LIMITS.maxFrameBytes
    )
      throw new ProtocolError("invalid_config", "Invalid frame byte limit");
    this.buffer = Buffer.allocUnsafe(maxBytes - 1);
  }
  push(chunk: Buffer, receive: (message: RpcMessage) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end === -1 ? chunk.length : end;
      const slice = chunk.subarray(offset, stop);
      // Reserve the mandatory LF even while it has not arrived.
      if (this.size + slice.length + 1 > this.maxBytes)
        throw new ProtocolError(
          "resource_limit",
          "Plugin frame exceeds negotiated byte limit"
        );
      if (slice.length) {
        slice.copy(this.buffer, this.size);
        this.size += slice.length;
      }
      if (end === -1) return;
      const bytes = this.buffer.subarray(0, this.size);
      this.size = 0;
      let value: unknown;
      try {
        value = JSON.parse(this.decoder.decode(bytes));
      } catch {
        throw new ProtocolError(
          "invalid_frame",
          "Plugin emitted malformed JSON or UTF-8"
        );
      }
      receive(parseRpc(value));
      offset = end + 1;
    }
  }
  finish(): void {
    if (this.size)
      throw new ProtocolError(
        "invalid_frame",
        "Plugin exited with an unterminated frame"
      );
  }
}

export interface CapabilityDescriptor {
  input: { text: true; mediaTypes: string[]; maxMediaBytes: number };
  sessions: {
    load: boolean;
    import: boolean;
    continuity: "verified" | "unverified";
  };
  output: {
    text: "final-only" | "snapshots";
    tools: boolean;
    usage: "reported" | "estimated" | "unknown";
  };
  operations: {
    nativeDedupe: "durable" | "none";
    nativeDedupeRetentionMs?: number;
    nativeReplay: "cursor" | "none";
    nativeReplayRetentionMs?: number;
    nativeReplayGapSemantics?: "explicit-gap";
    cancel: "cooperative" | "process-termination" | "unsupported";
    steer: boolean;
  };
  interactions: { permissions: "exact-request" | "none"; questions: boolean };
  configuration: { model: boolean; thinking: boolean; compact: boolean };
  fleetTools: boolean;
  [extension: string]: unknown;
}
export const CORE_METHODS = [
  "health",
  "session.open",
  "session.snapshot",
  "operation.submit",
  "operation.inspect",
  "operation.cancel",
  "interaction.respond",
  "events.ack",
  "events.replay",
  "session.close",
  "shutdown",
] as const;
export const EVENT_TYPES = new Set([
  "session.state",
  "operation.disposition",
  "turn.started",
  "message.started",
  "text.snapshot",
  "tool.started",
  "tool.updated",
  "tool.finished",
  "message.finished",
  "interaction.requested",
  "interaction.resolved",
  "usage.updated",
  "turn.terminal",
  "observation.gap",
]);
export interface GatewayPluginEvent extends JsonObject {
  bindingId: string;
  leaseGeneration: number;
  sourceSequence: number;
  eventId: string;
  type: string;
  payload: JsonObject;
  operationId?: string;
  turnId?: string;
}
export function validateEvent(value: unknown): GatewayPluginEvent {
  if (
    !object(value) ||
    !nonempty(value.bindingId) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    Number(value.leaseGeneration) < 1 ||
    !Number.isSafeInteger(value.sourceSequence) ||
    Number(value.sourceSequence) < 1 ||
    !nonempty(value.eventId) ||
    typeof value.type !== "string" ||
    !EVENT_TYPES.has(value.type) ||
    !object(value.payload)
  )
    throw new ProtocolError(
      "invalid_event",
      "Malformed canonical plugin event"
    );
  for (const key of [
    "operationId",
    "turnId",
    "messageId",
    "blockId",
    "toolCallId",
    "interactionId",
  ])
    if (Object.hasOwn(value, key) && !nonempty(value[key]))
      throw new ProtocolError("invalid_event", `Invalid ${key}`);
  if (
    value.type !== "session.state" &&
    value.type !== "observation.gap" &&
    (!nonempty(value.operationId) || !nonempty(value.turnId))
  )
    throw new ProtocolError(
      "invalid_event",
      "Turn event requires operation and turn identity"
    );
  if (
    (value.type.startsWith("message.") || value.type === "text.snapshot") &&
    !nonempty(value.messageId)
  )
    throw new ProtocolError(
      "invalid_event",
      "Message event requires message identity"
    );
  if (
    value.type === "text.snapshot" &&
    (!nonempty(value.blockId) ||
      !Number.isSafeInteger(value.payload.revision) ||
      Number(value.payload.revision) < 0 ||
      typeof value.payload.text !== "string")
  )
    throw new ProtocolError(
      "invalid_event",
      "Snapshot requires block, revision and text"
    );
  if (value.type.startsWith("tool.") && !nonempty(value.toolCallId))
    throw new ProtocolError(
      "invalid_event",
      "Tool event requires tool identity"
    );
  if (value.type.startsWith("interaction.") && !nonempty(value.interactionId))
    throw new ProtocolError(
      "invalid_event",
      "Interaction event requires exact request identity"
    );
  const payload = value.payload;
  if (
    value.type === "operation.disposition" &&
    !["accepted", "rejected", "unknown"].includes(String(payload.disposition))
  )
    throw new ProtocolError(
      "invalid_event",
      "Invalid native delivery disposition"
    );
  if (
    value.type === "message.started" &&
    (!["assistant", "user", "tool", "system"].includes(String(payload.role)) ||
      !Number.isSafeInteger(payload.order) ||
      Number(payload.order) < 0)
  )
    throw new ProtocolError(
      "invalid_event",
      "Message start requires role and stable order"
    );
  if (value.type === "message.finished") {
    if (!Array.isArray(payload.blocks))
      throw new ProtocolError(
        "invalid_event",
        "Final message requires authoritative blocks"
      );
    for (const block of payload.blocks) {
      if (
        !object(block) ||
        !nonempty(block.blockId) ||
        !Number.isSafeInteger(block.revision) ||
        Number(block.revision) < 0 ||
        (block.type === "text"
          ? typeof block.text !== "string"
          : block.type === "artifact"
            ? !nonempty(block.artifactId) || !nonempty(block.mediaType)
            : true)
      )
        throw new ProtocolError(
          "invalid_event",
          "Malformed canonical final block"
        );
    }
  }
  if (
    value.type === "turn.terminal" &&
    (!["ended", "failed", "cancelled", "interrupted"].includes(
      String(payload.execution)
    ) ||
      !["complete", "live_gap", "reconciliation_required"].includes(
        String(payload.observation)
      ))
  )
    throw new ProtocolError(
      "invalid_event",
      "Terminal event requires explicit execution and observation state"
    );
  return value as GatewayPluginEvent;
}
export function validateCapabilities(value: unknown): CapabilityDescriptor {
  const fail = (message: string): never => {
    throw new ProtocolError("invalid_capabilities", message);
  };
  if (!object(value)) return fail("Missing capabilities");
  const sections: Record<string, string[]> = {
    input: ["text", "mediaTypes", "maxMediaBytes"],
    sessions: ["load", "import", "continuity"],
    output: ["text", "tools", "usage"],
    operations: [
      "nativeDedupe",
      "nativeDedupeRetentionMs",
      "nativeReplay",
      "nativeReplayRetentionMs",
      "nativeReplayGapSemantics",
      "cancel",
      "steer",
    ],
    interactions: ["permissions", "questions"],
    configuration: ["model", "thinking", "compact"],
  };
  for (const [name, keys] of Object.entries(sections)) {
    const section = value[name];
    if (!object(section)) return fail(`Missing ${name} capabilities`);
    for (const key of Object.keys(section)) {
      if (
        !keys.includes(key) &&
        (!key.includes(".") ||
          (object(section[key]) && section[key].required === true))
      )
        return fail(`Unknown required capability ${name}.${key}`);
    }
  }
  for (const key of Object.keys(value))
    if (
      !(key in sections) &&
      key !== "fleetTools" &&
      (!key.includes(".") ||
        (object(value[key]) && value[key].required === true))
    )
      return fail(`Unknown required capability ${key}`);
  const descriptor = value as unknown as CapabilityDescriptor;
  if (
    descriptor.input.text !== true ||
    !Array.isArray(descriptor.input.mediaTypes) ||
    !descriptor.input.mediaTypes.every(nonempty) ||
    !Number.isSafeInteger(descriptor.input.maxMediaBytes) ||
    descriptor.input.maxMediaBytes < 0
  )
    return fail("Invalid text/media input contract");
  const booleans = [
    descriptor.sessions.load,
    descriptor.sessions.import,
    descriptor.output.tools,
    descriptor.operations.steer,
    descriptor.interactions.questions,
    descriptor.configuration.model,
    descriptor.configuration.thinking,
    descriptor.configuration.compact,
    descriptor.fleetTools,
  ];
  if (!booleans.every((entry) => typeof entry === "boolean"))
    return fail("Missing boolean capability");
  const enums: [unknown, string[]][] = [
    [descriptor.sessions.continuity, ["verified", "unverified"]],
    [descriptor.output.text, ["final-only", "snapshots"]],
    [descriptor.output.usage, ["reported", "estimated", "unknown"]],
    [descriptor.operations.nativeDedupe, ["durable", "none"]],
    [descriptor.operations.nativeReplay, ["cursor", "none"]],
    [
      descriptor.operations.cancel,
      ["cooperative", "process-termination", "unsupported"],
    ],
    [descriptor.interactions.permissions, ["exact-request", "none"]],
  ];
  if (enums.some(([entry, allowed]) => !allowed.includes(String(entry))))
    return fail("Unknown capability value");
  const positive = (entry: unknown) =>
    Number.isSafeInteger(entry) && Number(entry) > 0;
  if (
    descriptor.operations.nativeDedupe === "durable" &&
    !positive(descriptor.operations.nativeDedupeRetentionMs)
  )
    return fail("Durable dedupe requires a retention window");
  if (
    descriptor.operations.nativeReplay === "cursor" &&
    (!positive(descriptor.operations.nativeReplayRetentionMs) ||
      descriptor.operations.nativeReplayGapSemantics !== "explicit-gap")
  )
    return fail("Cursor replay requires retention and explicit gap semantics");
  if (
    (descriptor.sessions.load || descriptor.sessions.import) &&
    descriptor.sessions.continuity !== "verified"
  )
    return fail("Session restoration requires verified continuity");
  return descriptor;
}
