import type { ChildRuntimePlan, RuntimeProvenance } from "./types.js";

/** Minimal registry+auth surface used for exact model preflight. */
export interface ModelAuthRegistry {
 find(provider: string, modelId: string): { provider: string; id: string } | undefined;
 hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface ParentRuntimeSnapshot {
 provider: string;
 modelId: string;
 thinking: string;
}

export interface AgentRuntimeRequest {
 label?: string;
 model?: string;
}

/** One child diagnostic line identifying the offender and requested model. */
export interface RuntimeDiagnostic {
 index: number;
 label: string;
 requestedModel?: string;
 message: string;
}

export class RuntimeResolutionError extends Error {
 readonly diagnostics: RuntimeDiagnostic[];
 constructor(diagnostics: RuntimeDiagnostic[]) {
  super(formatDiagnostics(diagnostics));
  this.name = "RuntimeResolutionError";
  this.diagnostics = diagnostics;
 }
}

export function formatDiagnostics(diagnostics: RuntimeDiagnostic[]): string {
 return diagnostics.map((d) => {
  const who = `child[${d.index}] label=${JSON.stringify(d.label)}`;
  const model = d.requestedModel !== undefined ? ` model=${JSON.stringify(d.requestedModel)}` : "";
  return `${who}${model}: ${d.message}`;
 }).join("\n");
}

/**
 * Parse an exact provider/model-id reference at the first separator so model IDs may contain more.
 * Rejects empty parts and references without a separator (no bare ids, aliases, or fuzzy tokens).
 */
export function parseExactModelRef(reference: string): { provider: string; modelId: string } | undefined {
 const trimmed = reference.trim();
 if (!trimmed) return undefined;
 const separator = trimmed.indexOf("/");
 if (separator <= 0 || separator === trimmed.length - 1) return undefined;
 const provider = trimmed.slice(0, separator).trim();
 const modelId = trimmed.slice(separator + 1).trim();
 if (!provider || !modelId) return undefined;
 return { provider, modelId };
}

/** Wrap Pi's ModelRegistry (or any duck-typed registry) as the injectable lookup seam. */
export function wrapPiRegistry(registry: {
 find(provider: string, modelId: string): { provider: string; id: string } | undefined | null;
 hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}): ModelAuthRegistry {
 return {
  find(provider, modelId) {
   const found = registry.find(provider, modelId);
   return found ? { provider: found.provider, id: found.id } : undefined;
  },
  hasConfiguredAuth(model) {
   return registry.hasConfiguredAuth(model);
  },
 };
}

function childLabel(request: AgentRuntimeRequest, index: number): string {
 return request.label || "agent";
}

function diagnostic(index: number, label: string, requestedModel: string | undefined, message: string): RuntimeDiagnostic {
 return { index, label, requestedModel, message };
}

/**
 * Resolve and validate the complete ordered batch before any child launches.
 * Omitted model inherits the parent exactly. Explicit models must be exact registered
 * provider/model-id references with configured authentication.
 */
export function resolveBatchRuntime(
 agents: AgentRuntimeRequest[],
 parent: ParentRuntimeSnapshot,
 registry: ModelAuthRegistry | undefined,
): ChildRuntimePlan[] {
 const diagnostics: RuntimeDiagnostic[] = [];
 const plans: ChildRuntimePlan[] = [];

 for (let index = 0; index < agents.length; index++) {
  const request = agents[index]!;
  const label = childLabel(request, index);
  const requested = request.model;

  if (requested === undefined || requested === "") {
   // Omission (or empty) preserves parent-model inheritance exactly.
   plans.push({
    provider: parent.provider,
    modelId: parent.modelId,
    model: `${parent.provider}/${parent.modelId}`,
    thinking: parent.thinking,
    provenance: "parent" satisfies RuntimeProvenance,
   });
   continue;
  }

  if (typeof requested !== "string") {
   diagnostics.push(diagnostic(index, label, String(requested), "model must be an exact provider/model-id string"));
   continue;
  }

  const parsed = parseExactModelRef(requested);
  if (!parsed) {
   diagnostics.push(diagnostic(
    index,
    label,
    requested,
    "model must be an exact registered provider/model-id (parsed at the first '/'; fuzzy patterns, aliases, and profiles are rejected)",
   ));
   continue;
  }

  if (!registry) {
   diagnostics.push(diagnostic(index, label, requested, "model registry is unavailable; cannot validate explicit model selection"));
   continue;
  }

  const found = registry.find(parsed.provider, parsed.modelId);
  if (!found) {
   diagnostics.push(diagnostic(index, label, requested, `unknown model ${JSON.stringify(requested)}; exact registry match required`));
   continue;
  }

  // Ensure identity is the exact registered provider/id (no alias remapping).
  if (found.provider !== parsed.provider || found.id !== parsed.modelId) {
   diagnostics.push(diagnostic(index, label, requested, `model ${JSON.stringify(requested)} is not an exact registered identity`));
   continue;
  }

  if (!registry.hasConfiguredAuth(found)) {
   diagnostics.push(diagnostic(
    index,
    label,
    requested,
    `model ${JSON.stringify(requested)} has no configured authentication`,
   ));
   continue;
  }

  plans.push({
   provider: found.provider,
   modelId: found.id,
   model: `${found.provider}/${found.id}`,
   thinking: parent.thinking,
   provenance: "request",
   requestedModel: requested,
  });
 }

 if (diagnostics.length > 0) throw new RuntimeResolutionError(diagnostics);
 return plans;
}
