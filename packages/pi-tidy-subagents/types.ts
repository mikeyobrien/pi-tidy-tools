export type ChildStatus = "queued" | "starting" | "running" | "completed" | "warning" | "failed" | "cancelled" | "not-started";
export interface AgentRequest { label?: string; reason: string; prompt: string }
export interface NormalizedEvent { schemaVersion: 1; sequence: number; timestamp: string; type: string; payload: Record<string, unknown> }
export interface ActiveTool { id: string; name: string; activityIndex: number }
export interface ChildState {
 index: number; id: string; label: string; reason: string; prompt: string; status: ChildStatus;
 model: string; thinking: string; startedAt?: number; endedAt?: number; toolCount: number;
 input: number; output: number; cacheRead: number; cacheWrite: number; providerTraffic: number; tokens: number;
 activities: string[]; streamingLine?: string; activeTools: ActiveTool[]; eventCount: number;
 response: string; error?: string; artifactPath: string;
}
export interface ResolvedRuntime {
 provider: string; modelId: string; model: string; thinking: string; activeTools: string[]; projectTrusted: boolean;
}
export interface RunDetails { schemaVersion: 1; runId: string; runDir: string; cwd: string; createdAt: string; cap: number; runtime: ResolvedRuntime; children: ChildState[] }
