import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildEnvelope } from "./envelope.js";
import { SnapshotComponent } from "./render.js";
import { launchRuntime, runChild, type SharedLaunchContext } from "./runner.js";
import { resolveBatchRuntime, wrapPiRegistry, type ModelAuthRegistry } from "./runtime.js";
import { concurrencyCap, Scheduler } from "./scheduler.js";
import { createRunStore, saveRun } from "./store.js";
import type { ChildState, RunDetails } from "./types.js";

export { buildEnvelope } from "./envelope.js";
export { concurrencyCap, Scheduler } from "./scheduler.js";
export { renderLines } from "./render.js";
export { buildChildArgs, launchRuntime } from "./runner.js";
export { inheritRuntimePlan } from "./types.js";
export { parseExactModelRef, resolveBatchRuntime, wrapPiRegistry, RuntimeResolutionError } from "./runtime.js";
export type { ChildRuntimePlan, RuntimeProvenance } from "./types.js";
export type { ModelAuthRegistry } from "./runtime.js";

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

const Parameters = Type.Object({ agents: Type.Array(Type.Object({
 label: Type.Optional(Type.String({ description: "Short display label; defaults to agent" })),
 reason: Type.String({ description: "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)" }),
 prompt: Type.String({ description: "Full context, skills, objective, and output expectations sent verbatim to the child" }),
 model: Type.Optional(Type.String({
  description: "Optional exact registered provider/model-id for this child (parsed at the first '/'; model IDs may contain additional separators). Omission inherits the parent model. Fuzzy patterns, aliases, and profiles are rejected.",
 })),
}), { minItems: 1 }) });

export default function extension(pi: ExtensionAPI): void {
 if (process.env.PI_TIDY_SUBAGENT_CHILD === "1") return;
 const scheduler = new Scheduler(concurrencyCap());
 const activeCalls = new Set<AbortController>();
 pi.on("session_shutdown", () => {
  scheduler.shutdown(); for (const controller of activeCalls) controller.abort(); activeCalls.clear();
 });
 pi.registerTool({
  name: "subagent", label: "subagent", renderShell: "self", executionMode: "parallel",
  description: "Run an ordered synchronous fan-out of isolated child Pi agents. Every agent needs a short reason and verbatim prompt. Children share the working tree; assign non-overlapping writes. Optional per-child model selects an exact registered provider/model-id; omission inherits the parent.",
  promptGuidelines: ["Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives.", "When selecting a child model, pass an exact registered provider/model-id. Omit model to inherit the parent."],
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

   // Resolve and validate the complete ordered batch BEFORE run artifacts or spawning (AC-007).
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
