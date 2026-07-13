export type ChildStatus = "queued" | "starting" | "running" | "completed" | "warning" | "failed" | "cancelled" | "not-started";
export type ExecutionMode = "foreground" | "background";
export type DeliveryPolicy = "auto" | "manual";
export type DeliveryState = "none" | "pending" | "manual" | "accepted" | "collected";
export type RuntimeProvenance = "parent" | "request";

/** Pi's native thinking-level vocabulary. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
 return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface AgentRequest {
 label?: string;
 reason: string;
 prompt: string;
 model?: string;
 /** Optional closed thinking level; omission inherits the parent. */
 thinking?: ThinkingLevel;
 /** Omission preserves the historical synchronous foreground contract. */
 execution?: ExecutionMode;
}

export interface NormalizedEvent {
 schemaVersion: 1;
 sequence: number;
 timestamp: string;
 type: string;
 payload: Record<string, unknown>;
}

export interface ActiveTool {
 id: string;
 name: string;
 activityIndex: number;
}

/** Observed model + thinking from child RPC get_state. */
export interface ObservedRuntime {
 provider: string;
 modelId: string;
 model: string;
 thinking?: string;
}

/** Records a thinking-level clamp (inherited capability or observed mismatch). */
export interface ThinkingAdjustment {
 from: string;
 to: string;
 reason: "inherited-clamp" | "non-reasoning" | "observed";
}

/**
 * Per-child owned runtime plan.
 * Model and thinking may be inherited from the parent or selected on the request.
 * Requested / resolved / observed thinking are distinct; `thinking` is the effective display value.
 */
export interface ChildRuntimePlan {
 provider: string;
 modelId: string;
 model: string;
 /** Effective thinking level (resolved preflight, then observed after get_state). */
 thinking: string;
 /** Model selection provenance. */
 provenance: RuntimeProvenance;
 /** Exact request model string when the child selected a model. */
 requestedModel?: string;
 /** Thinking selection provenance. */
 thinkingProvenance: RuntimeProvenance;
 /** Explicit request thinking when the child selected a level; omitted on inheritance. */
 requestedThinking?: string;
 /** Thinking after parent-side inheritance validation / canonical clamp. */
 resolvedThinking: string;
 /** Present when resolved or observed thinking differs from the preference/resolution. */
 thinkingAdjustment?: ThinkingAdjustment;
 /** Populated after RPC get_state observation succeeds. */
 observed?: ObservedRuntime;
}

export function inheritRuntimePlan(parent: { provider: string; modelId: string; thinking: string }): ChildRuntimePlan {
 return {
  provider: parent.provider,
  modelId: parent.modelId,
  model: `${parent.provider}/${parent.modelId}`,
  thinking: parent.thinking,
  provenance: "parent",
  thinkingProvenance: "parent",
  resolvedThinking: parent.thinking,
 };
}

export interface ChildState {
 index: number; id: string; label: string; reason: string; prompt: string; status: ChildStatus;
 /** Globally unique session control identity: <run-id>:<child-id>. Optional only on legacy details. */
 target?: string;
 /** Requested mode and current visual/wait ownership. Missing ownership means legacy foreground. */
 requestedExecution?: ExecutionMode;
 ownership?: ExecutionMode;
 ownershipChangedAt?: number;
 ownershipReason?: "direct-launch" | "agent-control" | "user-control";
 terminalOwnership?: ExecutionMode;
 deliveryPolicy?: DeliveryPolicy;
 deliveryState?: DeliveryState;
 followUpAcceptedAt?: number;
 deliveryError?: string;
 collectionCount?: number;
 firstCollectedAt?: number;
 lastCollectedAt?: number;
 pendingSteering?: number;
 controlHistory?: Array<{ action: "background" | "steer" | "cancel" | "set_delivery" | "collect" | "shutdown"; outcome: "accepted" | "repeated"; timestamp: number }>;
 /** Compact display model id — observed when available, otherwise resolved. */
 model: string;
 /** Compact display thinking — observed when available, otherwise resolved. */
 thinking: string;
 startedAt?: number; endedAt?: number; toolCount: number;
 input: number; output: number; cacheRead: number; cacheWrite: number; providerTraffic: number; tokens: number;
 activities: string[]; streamingLine?: string; activeTools: ActiveTool[]; eventCount: number;
 response: string; error?: string; artifactPath: string;
 /** Child-owned resolved runtime with model/thinking provenance (schema v2+). */
 runtimePlan?: ChildRuntimePlan;
}

export interface ResolvedRuntime {
 provider: string; modelId: string; model: string; thinking: string; activeTools: string[]; projectTrusted: boolean;
}

export interface RunDetails {
 schemaVersion: 1 | 2 | 3;
 runId: string; runDir: string; cwd: string; createdAt: string; cap: number; runtime: ResolvedRuntime; children: ChildState[];
}
