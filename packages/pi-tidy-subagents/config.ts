import { promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "./types.js";

/** Versioned structured routing map under the Pi agent directory. */
export const ROUTING_CONFIG_VERSION = 1 as const;
export const ROUTING_CONFIG_RELATIVE = join("pi-tidy-subagents", "routing.json");

/**
 * Standard task classes used by routing guidance and observational evals.
 * Thinking is the primary per-child control; model overrides are optional exact IDs.
 */
export const STANDARD_TASK_CLASSES = [
 "bounded-lookup",
 "mechanical-implementation",
 "ordinary-review",
 "architectural-judgment",
 "concurrency-analysis",
 "cost-sensitive",
 "similarly-named-models",
 "cross-provider",
] as const;

export type TaskClass = (typeof STANDARD_TASK_CLASSES)[number];

export interface RoutingSelection {
 /** Exact registered provider/model-id. Omitted means inherit parent model. */
 model?: string;
 /** Closed Pi thinking level. Omitted means inherit parent thinking. */
 thinking?: ThinkingLevel;
}

export interface RoutingConfig {
 version: typeof ROUTING_CONFIG_VERSION;
 /** Optional global defaults applied when a task class omits a field. */
 defaults?: RoutingSelection;
 /** Per-task-class structured map. Unknown keys are preserved but not required. */
 taskClasses: Partial<Record<string, RoutingSelection>>;
}

export interface AuthModelRef {
 provider: string;
 id: string;
 /** Canonical exact reference: provider/id */
 ref: string;
}

/** Absolute path to the agent-dir routing map. */
export function routingConfigPath(agentDir: string = getAgentDir()): string {
 return join(agentDir, ROUTING_CONFIG_RELATIVE);
}

/** Thinking-primary short defaults: prefer inherit model; set thinking by task shape. */
export function defaultThinkingForTask(taskClass: string): ThinkingLevel | undefined {
 switch (taskClass) {
  case "bounded-lookup":
  case "cost-sensitive":
   return "minimal";
  case "mechanical-implementation":
   return "low";
  case "ordinary-review":
   return "medium";
  case "architectural-judgment":
  case "concurrency-analysis":
   return "high";
  case "similarly-named-models":
  case "cross-provider":
   // Model-identity tasks: thinking inherits; model is user-mapped.
   return undefined;
  default:
   return undefined;
 }
}

/** Build a thinking-primary map. Model overrides only when the caller supplies them. */
export function buildDefaultRoutingConfig(
 modelOverrides: Partial<Record<string, string>> = {},
): RoutingConfig {
 const taskClasses: RoutingConfig["taskClasses"] = {};
 for (const taskClass of STANDARD_TASK_CLASSES) {
  const thinking = defaultThinkingForTask(taskClass);
  const model = modelOverrides[taskClass];
  const selection: RoutingSelection = {};
  if (thinking !== undefined) selection.thinking = thinking;
  if (model !== undefined && model !== "") selection.model = model;
  if (Object.keys(selection).length > 0) taskClasses[taskClass] = selection;
 }
 return { version: ROUTING_CONFIG_VERSION, taskClasses };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelection(value: unknown): RoutingSelection | undefined {
 if (!isPlainObject(value)) return undefined;
 const selection: RoutingSelection = {};
 if (typeof value.model === "string" && value.model.trim()) {
  selection.model = value.model.trim();
 }
 if (typeof value.thinking === "string" && isThinkingLevel(value.thinking)) {
  selection.thinking = value.thinking;
 }
 return Object.keys(selection).length > 0 ? selection : {};
}

/** Load routing map from agent dir. Missing/malformed → undefined. */
export function loadRoutingConfig(agentDir: string = getAgentDir()): RoutingConfig | undefined {
 const path = routingConfigPath(agentDir);
 try {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isPlainObject(raw)) return undefined;
  if (raw.version !== ROUTING_CONFIG_VERSION) return undefined;
  const taskClasses: RoutingConfig["taskClasses"] = {};
  if (isPlainObject(raw.taskClasses)) {
   for (const [key, value] of Object.entries(raw.taskClasses)) {
    const selection = parseSelection(value);
    if (selection) taskClasses[key] = selection;
   }
  }
  const defaults = raw.defaults !== undefined ? parseSelection(raw.defaults) : undefined;
  return {
   version: ROUTING_CONFIG_VERSION,
   ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
   taskClasses,
  };
 } catch {
  return undefined;
 }
}

/** Atomic write of the structured routing map under the agent directory. */
export async function saveRoutingConfig(
 config: RoutingConfig,
 agentDir: string = getAgentDir(),
): Promise<string> {
 const path = routingConfigPath(agentDir);
 const directory = dirname(path);
 const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
 const payload: RoutingConfig = {
  version: ROUTING_CONFIG_VERSION,
  ...(config.defaults && Object.keys(config.defaults).length > 0 ? { defaults: config.defaults } : {}),
  taskClasses: config.taskClasses ?? {},
 };
 await fs.mkdir(directory, { recursive: true });
 try {
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, path);
 } catch (error) {
  await fs.rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
 }
 return path;
}

/** Remove the routing map if present. Returns true when a file was removed. */
export async function clearRoutingConfig(agentDir: string = getAgentDir()): Promise<boolean> {
 const path = routingConfigPath(agentDir);
 try {
  await fs.rm(path, { force: false });
  return true;
 } catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return false;
  throw error;
 }
}

/**
 * List authenticated models from a Pi ModelRegistry-shaped object.
 * Prefers getAvailable(); falls back to getAll()+hasConfiguredAuth.
 */
export function listAuthenticatedModels(registry: {
 getAvailable?: () => Array<{ provider: string; id: string }>;
 getAll?: () => Array<{ provider: string; id: string }>;
 // Accept Pi Model-typed callbacks without forcing structural Model fields here.
 hasConfiguredAuth?: (model: any) => boolean;
} | undefined | null): AuthModelRef[] {
 if (!registry) return [];
 const seen = new Set<string>();
 const out: AuthModelRef[] = [];
 const push = (provider: string, id: string) => {
  const ref = `${provider}/${id}`;
  if (seen.has(ref)) return;
  seen.add(ref);
  out.push({ provider, id, ref });
 };

 if (typeof registry.getAvailable === "function") {
  for (const model of registry.getAvailable()) {
   if (model?.provider && model?.id) push(model.provider, model.id);
  }
  if (out.length > 0) return out;
 }

 if (typeof registry.getAll === "function") {
  for (const model of registry.getAll()) {
   if (!model?.provider || !model?.id) continue;
   if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) continue;
   push(model.provider, model.id);
  }
 }
 return out;
}

/** Compact multi-line guidance for promptGuidelines when a map is present. */
export function formatRoutingGuidance(config: RoutingConfig | undefined): string[] {
 if (!config || Object.keys(config.taskClasses).length === 0) {
  return [
   "No agent-dir routing map yet. Run /tidy-subagents-routing to build a task→{thinking,model?} map from authenticated models (thinking-primary; model omit=inherit).",
  ];
 }
 const lines: string[] = [
  "User routing map (agent-dir pi-tidy-subagents/routing.json). Thinking is primary; model omit inherits parent. Exact provider/model-id only — no aliases/profiles/fuzzy.",
 ];
 if (config.defaults && (config.defaults.model || config.defaults.thinking)) {
  const parts: string[] = [];
  if (config.defaults.thinking) parts.push(`thinking=${config.defaults.thinking}`);
  if (config.defaults.model) parts.push(`model=${config.defaults.model}`);
  lines.push(`defaults: ${parts.join(" ")}`);
 }
 for (const taskClass of STANDARD_TASK_CLASSES) {
  const selection = config.taskClasses[taskClass];
  if (!selection) continue;
  const parts: string[] = [];
  if (selection.thinking) parts.push(`thinking=${selection.thinking}`);
  if (selection.model) parts.push(`model=${selection.model}`);
  else parts.push("model=inherit");
  lines.push(`${taskClass}: ${parts.join(" ")}`);
 }
 // Preserve any non-standard keys compactly.
 for (const [taskClass, selection] of Object.entries(config.taskClasses)) {
  if ((STANDARD_TASK_CLASSES as readonly string[]).includes(taskClass)) continue;
  if (!selection) continue;
  const parts: string[] = [];
  if (selection.thinking) parts.push(`thinking=${selection.thinking}`);
  if (selection.model) parts.push(`model=${selection.model}`);
  else parts.push("model=inherit");
  lines.push(`${taskClass}: ${parts.join(" ")}`);
 }
 return lines;
}

/** Resolve effective selection for a task class (task entry over defaults). */
export function resolveTaskSelection(
 config: RoutingConfig | undefined,
 taskClass: string,
): RoutingSelection {
 if (!config) return {};
 const defaults = config.defaults ?? {};
 const entry = config.taskClasses[taskClass] ?? {};
 return {
  ...(defaults.model ? { model: defaults.model } : {}),
  ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
  ...(entry.model ? { model: entry.model } : {}),
  ...(entry.thinking ? { thinking: entry.thinking } : {}),
 };
}

export { THINKING_LEVELS, isThinkingLevel };
