export type ChildStatus = "queued" | "starting" | "running" | "completed" | "warning" | "failed" | "cancelled" | "not-started";
export type RuntimeProvenance = "parent" | "request";
export interface AgentRequest { label?: string; reason: string; prompt: string; model?: string }
export interface NormalizedEvent { schemaVersion: 1; sequence: number; timestamp: string; type: string; payload: Record<string, unknown> }
export interface ActiveTool { id: string; name: string; activityIndex: number }
export interface ObservedModel { provider: string; modelId: string; model: string }
/**
 * Per-child owned runtime plan.
 * Model may be inherited from the parent or selected exactly on the request.
 * Thinking remains parent-inherited for this ticket (no request field).
 */
export interface ChildRuntimePlan {
 provider: string;
 modelId: string;
 model: string;
 thinking: string;
 provenance: RuntimeProvenance;
 /** Exact request string when the child selected a model; omitted on inheritance. */
 requestedModel?: string;
 /** Populated after RPC get_state observation succeeds. */
 observed?: ObservedModel;
}
export function inheritRuntimePlan(parent: { provider: string; modelId: string; thinking: string }): ChildRuntimePlan {
 return { provider: parent.provider, modelId: parent.modelId, model: `${parent.provider}/${parent.modelId}`, thinking: parent.thinking, provenance: "parent" };
}
export interface ChildState {
 index: number; id: string; label: string; reason: string; prompt: string; status: ChildStatus;
 /** Compact display model id — observed when available, otherwise resolved. */
 model: string; thinking: string; startedAt?: number; endedAt?: number; toolCount: number;
 input: number; output: number; cacheRead: number; cacheWrite: number; providerTraffic: number; tokens: number;
 activities: string[]; streamingLine?: string; activeTools: ActiveTool[]; eventCount: number;
 response: string; error?: string; artifactPath: string;
 /** Child-owned resolved runtime with model provenance (schema v2). */
 runtimePlan?: ChildRuntimePlan;
}
export interface ResolvedRuntime {
 provider: string; modelId: string; model: string; thinking: string; activeTools: string[]; projectTrusted: boolean;
}
export interface RunDetails {
 schemaVersion: 1 | 2;
 runId: string; runDir: string; cwd: string; createdAt: string; cap: number; runtime: ResolvedRuntime; children: ChildState[];
}
