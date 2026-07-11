export type ChildStatus = "queued" | "starting" | "running" | "completed" | "warning" | "failed" | "cancelled" | "not-started";
export type RuntimeProvenance = "parent";
export interface AgentRequest { label?: string; reason: string; prompt: string }
export interface NormalizedEvent { schemaVersion: 1; sequence: number; timestamp: string; type: string; payload: Record<string, unknown> }
export interface ActiveTool { id: string; name: string; activityIndex: number }
/** Per-child owned runtime plan. Inheritance is the only provenance in this prefactor. */
export interface ChildRuntimePlan {
 provider: string; modelId: string; model: string; thinking: string; provenance: RuntimeProvenance;
}
export function inheritRuntimePlan(parent: { provider: string; modelId: string; thinking: string }): ChildRuntimePlan {
 return { provider: parent.provider, modelId: parent.modelId, model: `${parent.provider}/${parent.modelId}`, thinking: parent.thinking, provenance: "parent" };
}
export interface ChildState {
 index: number; id: string; label: string; reason: string; prompt: string; status: ChildStatus;
 model: string; thinking: string; startedAt?: number; endedAt?: number; toolCount: number;
 input: number; output: number; cacheRead: number; cacheWrite: number; providerTraffic: number; tokens: number;
 activities: string[]; streamingLine?: string; activeTools: ActiveTool[]; eventCount: number;
 response: string; error?: string; artifactPath: string;
 /** Child-owned resolved runtime; snapshotted in public details, omitted from schema v1 manifests. */
 runtimePlan?: ChildRuntimePlan;
}
export interface ResolvedRuntime {
 provider: string; modelId: string; model: string; thinking: string; activeTools: string[]; projectTrusted: boolean;
}
export interface RunDetails { schemaVersion: 1; runId: string; runDir: string; cwd: string; createdAt: string; cap: number; runtime: ResolvedRuntime; children: ChildState[] }
