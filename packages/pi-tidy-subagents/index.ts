import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
 buildDefaultRoutingConfig,
 clearRoutingConfig,
 formatRoutingGuidance,
 listAuthenticatedModels,
 loadRoutingConfig,
 saveRoutingConfig,
 STANDARD_TASK_CLASSES,
 type RoutingConfig,
 type RoutingSelection,
} from "./config.js";
import { buildEnvelope } from "./envelope.js";
import { SnapshotComponent } from "./render.js";
import { launchRuntime, runChild, type SharedLaunchContext } from "./runner.js";
import { resolveBatchRuntime, wrapPiRegistry, type ModelAuthRegistry } from "./runtime.js";
import { concurrencyCap, Scheduler } from "./scheduler.js";
import { createRunStore, saveRun } from "./store.js";
import type { ChildState, RunDetails, ThinkingLevel } from "./types.js";
import { THINKING_LEVELS } from "./types.js";

export { buildEnvelope } from "./envelope.js";
export { concurrencyCap, Scheduler } from "./scheduler.js";
export { renderLines } from "./render.js";
export { buildChildArgs, launchRuntime } from "./runner.js";
export { inheritRuntimePlan, isThinkingLevel, THINKING_LEVELS } from "./types.js";
export { parseExactModelRef, resolveBatchRuntime, wrapPiRegistry, RuntimeResolutionError } from "./runtime.js";
export {
 buildDefaultRoutingConfig,
 clearRoutingConfig,
 defaultThinkingForTask,
 formatRoutingGuidance,
 listAuthenticatedModels,
 loadRoutingConfig,
 resolveTaskSelection,
 routingConfigPath,
 saveRoutingConfig,
 STANDARD_TASK_CLASSES,
 ROUTING_CONFIG_VERSION,
} from "./config.js";
export type { ChildRuntimePlan, RuntimeProvenance, ThinkingAdjustment, ThinkingLevel } from "./types.js";
export type { ModelAuthRegistry, ThinkingCapableModel } from "./runtime.js";
export type { AuthModelRef, RoutingConfig, RoutingSelection, TaskClass } from "./config.js";

/** Short, stable model field guidance (exact IDs; omit inherits; no fuzzy). */
export const MODEL_FIELD_DESCRIPTION =
 "Exact registered provider/model-id (split at first '/'). Omit inherits parent. No aliases, profiles, or fuzzy patterns. Prefer inherit; optional task→model map via /tidy-subagents-routing.";

/** Short, stable thinking field guidance (closed levels; inheritance default; brief task shapes). */
export const THINKING_FIELD_DESCRIPTION =
 "Pi thinking level: off|minimal|low|medium|high|xhigh|max. Omit inherits parent. Primary per-child control: minimal/low for bounded or mechanical work; medium for ordinary review; high+ for architecture, concurrency, hard diagnosis. Explicit unsupported fails preflight; inherited clamps.";

function publicDetails(details: RunDetails): RunDetails {
 return {
  ...details,
  children: details.children.map((child) => ({
   ...child,
   prompt: "",
   response: "",
   activities: [...child.activities],
   activeTools: child.activeTools.map((tool) => ({ ...tool })),
   // Independent snapshot of the child-owned plan (never share the live object).
   ...(child.runtimePlan ? {
    runtimePlan: {
     ...child.runtimePlan,
     ...(child.runtimePlan.thinkingAdjustment ? { thinkingAdjustment: { ...child.runtimePlan.thinkingAdjustment } } : {}),
     ...(child.runtimePlan.observed ? { observed: { ...child.runtimePlan.observed } } : {}),
    },
   } : {}),
  })),
 };
}

function registryFromContext(ctx: { modelRegistry?: { find(provider: string, modelId: string): { provider: string; id: string } | undefined | null; hasConfiguredAuth(model: { provider: string; id: string }): boolean } }): ModelAuthRegistry | undefined {
 if (!ctx.modelRegistry) return undefined;
 return wrapPiRegistry(ctx.modelRegistry);
}

const ThinkingEnum = Type.Union([
 Type.Literal("off"),
 Type.Literal("minimal"),
 Type.Literal("low"),
 Type.Literal("medium"),
 Type.Literal("high"),
 Type.Literal("xhigh"),
 Type.Literal("max"),
], {
 description: THINKING_FIELD_DESCRIPTION,
});

const Parameters = Type.Object({ agents: Type.Array(Type.Object({
 label: Type.Optional(Type.String({ description: "Short display label; defaults to agent" })),
 reason: Type.String({ description: "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)" }),
 prompt: Type.String({ description: "Full context, skills, objective, and output expectations sent verbatim to the child" }),
 model: Type.Optional(Type.String({
  description: MODEL_FIELD_DESCRIPTION,
 })),
 thinking: Type.Optional(ThinkingEnum),
}), { minItems: 1 }) });

function basePromptGuidelines(routing: RoutingConfig | undefined): string[] {
 return [
  "Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives.",
  "Thinking is the primary per-child control. Prefer omit thinking to inherit parent; otherwise pick a closed Pi level for the task shape.",
  "Prefer omit model (inherit parent). Pass an exact registered provider/model-id only when capability or cost warrants. No aliases, profiles, or fuzzy patterns.",
  // Documentary override hierarchy only — extension does not parse AGENTS.md or auto-inject routing.
  "Optional model/thinking precedence (most specific wins): (1) explicit per-child model/thinking request fields on the tool call; (2) user turn instructions; (3) AGENTS.md / project agent instructions; (4) optional structured agent-dir routing map from /tidy-subagents-routing; (5) extension short schema defaults / promptGuidelines; (6) parent inheritance when fields remain omitted. Extension does not parse AGENTS.md or auto-inject routing.",
  ...formatRoutingGuidance(routing),
 ];
}

function formatConfigSummary(config: RoutingConfig): string {
 const lines = formatRoutingGuidance(config);
 return lines.join("\n");
}

async function runRoutingSetupCommand(
 args: string,
 ctx: {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void; select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
  // Duck-typed so Pi's ModelRegistry (Model-typed hasConfiguredAuth) remains assignable.
  modelRegistry?: {
   getAvailable?: () => Array<{ provider: string; id: string }>;
   getAll?: () => Array<{ provider: string; id: string }>;
   hasConfiguredAuth?: (model: any) => boolean;
  };
  // Deliberately unused — parent session model/thinking must never be mutated by setup.
  setModel?: unknown;
  setThinkingLevel?: unknown;
 },
 agentDir: string = getAgentDir(),
): Promise<void> {
 const action = args.trim().toLowerCase() || "setup";

 if (action === "status") {
  const config = loadRoutingConfig(agentDir);
  if (!config) {
   ctx.ui.notify("No routing map at agent-dir pi-tidy-subagents/routing.json. Run /tidy-subagents-routing setup.", "info");
   return;
  }
  ctx.ui.notify(formatConfigSummary(config), "info");
  return;
 }

 if (action === "clear") {
  const removed = await clearRoutingConfig(agentDir);
  ctx.ui.notify(removed ? "Cleared agent-dir routing map." : "No routing map to clear.", "info");
  return;
 }

 if (action === "defaults") {
  const config = buildDefaultRoutingConfig();
  const path = await saveRoutingConfig(config, agentDir);
  ctx.ui.notify(`Wrote thinking-primary defaults (model=inherit) to ${path}.\n${formatConfigSummary(config)}`, "info");
  return;
 }

 if (action !== "setup" && action !== "") {
  ctx.ui.notify("Usage: /tidy-subagents-routing [setup|defaults|status|clear]", "warning");
  return;
 }

 // Interactive / agentic setup from authenticated models. Never mutates parent model/thinking.
 const authModels = listAuthenticatedModels(ctx.modelRegistry);
 if (authModels.length === 0) {
  ctx.ui.notify(
   "No authenticated models available. Configure provider auth, then re-run /tidy-subagents-routing setup.",
   "warning",
  );
  return;
 }

 const modelChoices = ["inherit (parent)", ...authModels.map((m) => m.ref)];
 const thinkingChoices = ["inherit (parent)", ...THINKING_LEVELS];
 const taskClasses: RoutingConfig["taskClasses"] = {};

 for (const taskClass of STANDARD_TASK_CLASSES) {
  const defaultThinking = buildDefaultRoutingConfig().taskClasses[taskClass]?.thinking;
  const thinkingPick = await ctx.ui.select(
   `${taskClass}: thinking (primary)`,
   thinkingChoices.map((level) => (defaultThinking && level === defaultThinking ? `${level} (suggested)` : level)),
  );
  if (thinkingPick === undefined) {
   ctx.ui.notify("Routing setup cancelled.", "warning");
   return;
  }
  const thinkingRaw = thinkingPick.replace(/ \(suggested\)$/, "");
  const modelPick = await ctx.ui.select(`${taskClass}: model (optional override)`, modelChoices);
  if (modelPick === undefined) {
   ctx.ui.notify("Routing setup cancelled.", "warning");
   return;
  }

  const selection: RoutingSelection = {};
  if (thinkingRaw !== "inherit (parent)" && (THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
   selection.thinking = thinkingRaw as ThinkingLevel;
  }
  if (modelPick !== "inherit (parent)") {
   selection.model = modelPick;
  }
  if (Object.keys(selection).length > 0) taskClasses[taskClass] = selection;
 }

 const config: RoutingConfig = { version: 1, taskClasses };
 const path = await saveRoutingConfig(config, agentDir);
 ctx.ui.notify(`Saved routing map to ${path}. Parent session model/thinking unchanged.\n${formatConfigSummary(config)}`, "info");
}

/** Exported for hermetic command-handler tests. */
export { runRoutingSetupCommand };

export default function extension(pi: ExtensionAPI): void {
 if (process.env.PI_TIDY_SUBAGENT_CHILD === "1") return;
 const scheduler = new Scheduler(concurrencyCap());
 const activeCalls = new Set<AbortController>();
 const routingAtLoad = loadRoutingConfig(getAgentDir());

 pi.on("session_shutdown", () => {
  scheduler.shutdown(); for (const controller of activeCalls) controller.abort(); activeCalls.clear();
 });

 pi.registerCommand("tidy-subagents-routing", {
  description: "Set up structured subagent routing map (task→thinking/model) from authenticated models into agent-dir config",
  getArgumentCompletions: (prefix) => {
   const values = ["setup", "defaults", "status", "clear"];
   return values.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
  },
  handler: async (args, ctx) => {
   await runRoutingSetupCommand(args, ctx, getAgentDir());
  },
 });

 pi.registerTool({
  name: "subagent", label: "subagent", renderShell: "self", executionMode: "parallel",
  description: "Run an ordered synchronous fan-out of isolated child Pi agents. Every agent needs a short reason and verbatim prompt. Children share the working tree; assign non-overlapping writes. Optional per-child model selects an exact registered provider/model-id; optional thinking selects a Pi level (primary control). Omission inherits the parent runtime. Use /tidy-subagents-routing for a user task map.",
  promptGuidelines: basePromptGuidelines(routingAtLoad),
  parameters: Parameters,
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
   if (!ctx.model) throw new Error("subagent requires a resolved parent model");
   // Snapshot parent runtime once; never mutate parent model/thinking APIs.
   const parentProvider = ctx.model.provider;
   const parentModelId = ctx.model.id;
   const parentThinking = pi.getThinkingLevel();
   const parentModel = `${parentProvider}/${parentModelId}`;
   const activeTools = pi.getActiveTools().filter((name) => name !== "subagent");
   const projectTrusted = ctx.isProjectTrusted();

   // Resolve and validate the complete ordered batch BEFORE run artifacts or spawning.
   const plans = resolveBatchRuntime(
    params.agents,
    { provider: parentProvider, modelId: parentModelId, thinking: parentThinking },
    registryFromContext(ctx),
   );

   const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
   const runDir = await createRunStore(getAgentDir(), runId);
   const shared: SharedLaunchContext = { cwd: ctx.cwd, tools: activeTools, runDir, approved: projectTrusted };
   const children: ChildState[] = params.agents.map((request, index) => {
    const id = `child-${String(index + 1).padStart(3, "0")}`;
    const runtimePlan = plans[index]!;
    return {
     index, id, label: request.label || "agent", reason: request.reason, prompt: request.prompt, status: "queued",
     model: runtimePlan.modelId, thinking: runtimePlan.thinking, runtimePlan,
     toolCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, providerTraffic: 0, tokens: 0,
     activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: join(runDir, `${id}.md`),
    };
   });
   const details: RunDetails = {
    schemaVersion: 2, runId, runDir, cwd: ctx.cwd, createdAt: new Date().toISOString(), cap: scheduler.cap,
    runtime: { provider: parentProvider, modelId: parentModelId, model: parentModel, thinking: parentThinking, activeTools, projectTrusted }, children,
   };
   await saveRun(details, false);
   let updateTimer: ReturnType<typeof setTimeout> | undefined;
   const emit = () => { if (updateTimer) clearTimeout(updateTimer); updateTimer = undefined; onUpdate?.({ content: [{ type: "text", text: "Subagents running" }], details: publicDetails(details) }); };
   const changed = (immediate = false) => {
    if (immediate) emit();
    else if (!updateTimer) { updateTimer = setTimeout(emit, 100); updateTimer.unref?.(); }
   };
   emit();
   const callController = new AbortController(); activeCalls.add(callController);
   const abort = () => { scheduler.cancel(toolCallId); callController.abort(); };
   signal?.addEventListener("abort", abort, { once: true });
   if (signal?.aborted) abort();
   const outcomes = children.map(async (child) => {
    if (callController.signal.aborted) {
     child.status = "not-started"; child.error = "Cancelled before start"; child.endedAt = Date.now(); changed(true); return child;
    }
    try {
     const plan = child.runtimePlan;
     if (!plan) throw new Error(`child ${child.id} missing runtime plan`);
     // Launch args come from this child's owned plan, not a shared closed-over model/thinking pair.
     return await scheduler.schedule(toolCallId, () => runChild(child, launchRuntime(plan, shared), callController.signal, changed));
    }
    catch (error) {
     if (/Could not (start Pi RPC|maintain durable)/.test(error instanceof Error ? error.message : String(error))) { abort(); throw error; }
     child.status = callController.signal.aborted ? "not-started" : "failed"; child.error = error instanceof Error ? error.message : String(error); child.endedAt = Date.now(); changed(true); return child;
    }
   });
   try {
    await Promise.all(outcomes);
    await saveRun(details);
    emit();
   } catch (error) {
    abort(); await Promise.allSettled(outcomes);
    throw error;
   } finally {
    if (updateTimer) clearTimeout(updateTimer);
    signal?.removeEventListener("abort", abort); activeCalls.delete(callController);
   }
   const content = buildEnvelope(children);
   return { content: [{ type: "text", text: content }], details: publicDetails(details) };
  },
  renderCall: () => new Container(),
  renderResult: (result, options, theme) => {
   const details = result.details as RunDetails | undefined;
   const hasFailure = details?.children.some((child) => ["failed", "cancelled", "not-started"].includes(child.status)) ?? false;
   const background = options.isPartial ? "toolPendingBg" : hasFailure ? "toolErrorBg" : "toolSuccessBg";
   return new SnapshotComponent(details, options.expanded, (text) => theme.bg(background, text));
  },
 });
}
