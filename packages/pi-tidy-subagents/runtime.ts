import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
 ChildRuntimePlan,
 RuntimeProvenance,
 ThinkingAdjustment,
} from "./types.js";
import { isThinkingLevel } from "./types.js";

/**
 * Minimal registry+auth+capability surface used for exact model preflight
 * and Pi-canonical thinking support/clamp. Registry models should expose
 * `reasoning` and optional `thinkingLevelMap` the way pi-ai expects.
 */
export interface ThinkingCapableModel {
 provider: string;
 id: string;
 reasoning: boolean;
 thinkingLevelMap?: Model<any>["thinkingLevelMap"];
}

export interface ModelAuthRegistry {
 find(provider: string, modelId: string): ThinkingCapableModel | undefined;
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
 thinking?: string;
}

/** One child diagnostic line identifying the offender and requested runtime. */
export interface RuntimeDiagnostic {
 index: number;
 label: string;
 requestedModel?: string;
 requestedThinking?: string;
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
  const thinking = d.requestedThinking !== undefined ? ` thinking=${JSON.stringify(d.requestedThinking)}` : "";
  return `${who}${model}${thinking}: ${d.message}`;
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
 find(provider: string, modelId: string): {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<any>["thinkingLevelMap"];
 } | undefined | null;
 hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}): ModelAuthRegistry {
 return {
  find(provider, modelId) {
   const found = registry.find(provider, modelId);
   if (!found) return undefined;
   return {
    provider: found.provider,
    id: found.id,
    // Real Pi models always set reasoning; default true keeps incomplete stubs permissive for model-only tests.
    reasoning: found.reasoning ?? true,
    thinkingLevelMap: found.thinkingLevelMap,
   };
  },
  hasConfiguredAuth(model) {
   return registry.hasConfiguredAuth(model);
  },
 };
}

function childLabel(request: AgentRuntimeRequest, _index: number): string {
 return request.label || "agent";
}

function diagnostic(
 index: number,
 label: string,
 fields: { requestedModel?: string; requestedThinking?: string },
 message: string,
): RuntimeDiagnostic {
 return { index, label, ...fields, message };
}

/** Build a minimal pi-ai Model duck for canonical support/clamp helpers. */
function asPiModel(model: ThinkingCapableModel): Model<any> {
 return {
  id: model.id,
  name: model.id,
  api: "openai-completions",
  provider: model.provider,
  baseUrl: "",
  reasoning: model.reasoning,
  thinkingLevelMap: model.thinkingLevelMap,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
 };
}

function supportedLevels(model: ThinkingCapableModel): ModelThinkingLevel[] {
 return getSupportedThinkingLevels(asPiModel(model));
}

function clampLevel(model: ThinkingCapableModel, level: ModelThinkingLevel): ModelThinkingLevel {
 return clampThinkingLevel(asPiModel(model), level);
}

function formatAlternatives(levels: readonly string[]): string {
 return levels.length > 0 ? levels.join(", ") : "(none)";
}

/**
 * Resolve thinking for one child after its model identity is known.
 * Explicit thinking is intent (reject unsupported). Inherited is preference (clamp).
 */
function resolveThinking(
 index: number,
 label: string,
 requestedThinking: string | undefined,
 parentThinking: string,
 model: ThinkingCapableModel | undefined,
 modelRef: string,
 requestedModel: string | undefined,
 diagnostics: RuntimeDiagnostic[],
): {
 thinking: string;
 resolvedThinking: string;
 thinkingProvenance: RuntimeProvenance;
 requestedThinking?: string;
 thinkingAdjustment?: ThinkingAdjustment;
} | undefined {
 const explicit = requestedThinking !== undefined && requestedThinking !== "";

 if (explicit) {
  if (typeof requestedThinking !== "string" || !isThinkingLevel(requestedThinking)) {
   diagnostics.push(diagnostic(index, label, { requestedModel, requestedThinking: String(requestedThinking) },
    `thinking must be one of Pi's native levels: ${formatAlternatives(["off", "minimal", "low", "medium", "high", "xhigh", "max"])}`));
   return undefined;
  }

  if (!model) {
   diagnostics.push(diagnostic(index, label, { requestedModel, requestedThinking },
    "model capability surface is unavailable; cannot validate explicit thinking selection"));
   return undefined;
  }

  const supported = supportedLevels(model);
  if (!supported.includes(requestedThinking)) {
   diagnostics.push(diagnostic(index, label, { requestedModel: requestedModel ?? modelRef, requestedThinking },
    `thinking ${JSON.stringify(requestedThinking)} is not supported by ${JSON.stringify(modelRef)}; supported: ${formatAlternatives(supported)}`));
   return undefined;
  }

  return {
   thinking: requestedThinking,
   resolvedThinking: requestedThinking,
   thinkingProvenance: "request",
   requestedThinking,
  };
 }

 // Omitted thinking inherits the parent preference, then canonically clamps to the selected model.
 const preference = parentThinking;
 if (!model) {
  // No capability surface (e.g. pure inheritance without registry): preserve parent level exactly.
  return {
   thinking: preference,
   resolvedThinking: preference,
   thinkingProvenance: "parent",
  };
 }

 const preferenceLevel: ModelThinkingLevel = isThinkingLevel(preference) ? preference : "off";
 const resolved = clampLevel(model, preferenceLevel);
 let thinkingAdjustment: ThinkingAdjustment | undefined;
 if (resolved !== preference) {
  thinkingAdjustment = {
   from: preference,
   to: resolved,
   reason: !model.reasoning ? "non-reasoning" : "inherited-clamp",
  };
 }

 return {
  thinking: resolved,
  resolvedThinking: resolved,
  thinkingProvenance: "parent",
  thinkingAdjustment,
 };
}

/**
 * Resolve and validate the complete ordered batch before any child launches.
 * Omitted model/thinking inherit the parent. Explicit models must be exact registered
 * provider/model-id references with configured authentication. Explicit thinking is
 * intent (reject unsupported with alternatives); inherited thinking is preference
 * (canonically clamp via pi-ai, non-reasoning → off).
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
  const requestedThinking = request.thinking;

  let provider: string;
  let modelId: string;
  let model: string;
  let provenance: RuntimeProvenance;
  let requestedModel: string | undefined;
  let capability: ThinkingCapableModel | undefined;

  if (requested === undefined || requested === "") {
   // Omission (or empty) preserves parent-model inheritance exactly.
   provider = parent.provider;
   modelId = parent.modelId;
   model = `${parent.provider}/${parent.modelId}`;
   provenance = "parent";
   capability = registry?.find(parent.provider, parent.modelId);
  } else {
   if (typeof requested !== "string") {
    diagnostics.push(diagnostic(index, label, { requestedModel: String(requested), requestedThinking },
     "model must be an exact provider/model-id string"));
    continue;
   }

   const parsed = parseExactModelRef(requested);
   if (!parsed) {
    diagnostics.push(diagnostic(index, label, { requestedModel: requested, requestedThinking },
     "model must be an exact registered provider/model-id (parsed at the first '/'; fuzzy patterns, aliases, and profiles are rejected)"));
    continue;
   }

   if (!registry) {
    diagnostics.push(diagnostic(index, label, { requestedModel: requested, requestedThinking },
     "model registry is unavailable; cannot validate explicit model selection"));
    continue;
   }

   const found = registry.find(parsed.provider, parsed.modelId);
   if (!found) {
    diagnostics.push(diagnostic(index, label, { requestedModel: requested, requestedThinking },
     `unknown model ${JSON.stringify(requested)}; exact registry match required`));
    continue;
   }

   // Ensure identity is the exact registered provider/id (no alias remapping).
   if (found.provider !== parsed.provider || found.id !== parsed.modelId) {
    diagnostics.push(diagnostic(index, label, { requestedModel: requested, requestedThinking },
     `model ${JSON.stringify(requested)} is not an exact registered identity`));
    continue;
   }

   if (!registry.hasConfiguredAuth(found)) {
    diagnostics.push(diagnostic(index, label, { requestedModel: requested, requestedThinking },
     `model ${JSON.stringify(requested)} has no configured authentication`));
    continue;
   }

   provider = found.provider;
   modelId = found.id;
   model = `${found.provider}/${found.id}`;
   provenance = "request";
   requestedModel = requested;
   capability = found;
  }

  // Explicit thinking without a capability surface requires a registry lookup of the selected model.
  if (requestedThinking !== undefined && requestedThinking !== "" && !capability && registry) {
   capability = registry.find(provider, modelId);
  }

  const thinking = resolveThinking(
   index,
   label,
   requestedThinking,
   parent.thinking,
   capability,
   model,
   requestedModel,
   diagnostics,
  );
  if (!thinking) continue;

  plans.push({
   provider,
   modelId,
   model,
   thinking: thinking.thinking,
   provenance,
   ...(requestedModel !== undefined ? { requestedModel } : {}),
   thinkingProvenance: thinking.thinkingProvenance,
   ...(thinking.requestedThinking !== undefined ? { requestedThinking: thinking.requestedThinking } : {}),
   resolvedThinking: thinking.resolvedThinking,
   ...(thinking.thinkingAdjustment ? { thinkingAdjustment: thinking.thinkingAdjustment } : {}),
  });
 }

 if (diagnostics.length > 0) throw new RuntimeResolutionError(diagnostics);
 return plans;
}
