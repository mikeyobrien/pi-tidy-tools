import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildEnvelope } from "./envelope.js";
import { SnapshotComponent } from "./render.js";
import { runChild } from "./runner.js";
import { concurrencyCap, Scheduler } from "./scheduler.js";
import { createRunStore, saveRun } from "./store.js";
import type { ChildState, RunDetails } from "./types.js";

export { buildEnvelope } from "./envelope.js";
export { concurrencyCap, Scheduler } from "./scheduler.js";
export { renderLines } from "./render.js";

function publicDetails(details: RunDetails): RunDetails {
 return {
  ...details,
  children: details.children.map((child) => ({ ...child, prompt: "", response: "", activities: [...child.activities], activeTools: child.activeTools.map((tool) => ({ ...tool })) })),
 };
}

const Parameters = Type.Object({ agents: Type.Array(Type.Object({
 label: Type.Optional(Type.String({ description: "Short display label; defaults to agent" })),
 reason: Type.String({ description: "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)" }),
 prompt: Type.String({ description: "Full context, skills, objective, and output expectations sent verbatim to the child" }),
}), { minItems: 1 }) });

export default function extension(pi: ExtensionAPI): void {
 if (process.env.PI_TIDY_SUBAGENT_CHILD === "1") return;
 const scheduler = new Scheduler(concurrencyCap());
 const activeCalls = new Set<AbortController>();
 const renderTimers = new Set<ReturnType<typeof setInterval>>();
 pi.on("session_shutdown", () => {
  scheduler.shutdown(); for (const controller of activeCalls) controller.abort(); activeCalls.clear();
  for (const timer of renderTimers) clearInterval(timer); renderTimers.clear();
 });
 pi.registerTool({
  name: "subagent", label: "subagent", renderShell: "self", executionMode: "parallel",
  description: "Run an ordered synchronous fan-out of isolated child Pi agents. Every agent needs a short reason and verbatim prompt. Children share the working tree; assign non-overlapping writes.",
  promptGuidelines: ["Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives."],
  parameters: Parameters,
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
   if (!ctx.model) throw new Error("subagent requires a resolved parent model");
   const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
   const runDir = await createRunStore(getAgentDir(), runId);
   const model = `${ctx.model.provider}/${ctx.model.id}`;
   const thinking = pi.getThinkingLevel();
   const activeTools = pi.getActiveTools().filter((name) => name !== "subagent");
   const projectTrusted = ctx.isProjectTrusted();
   const children: ChildState[] = params.agents.map((request, index) => {
    const id = `child-${String(index + 1).padStart(3, "0")}`;
    return { index, id, label: request.label || "agent", reason: request.reason, prompt: request.prompt, status: "queued", model: ctx.model!.id, thinking, toolCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, providerTraffic: 0, tokens: 0, activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: join(runDir, `${id}.md`) };
   });
   const details: RunDetails = {
    schemaVersion: 1, runId, runDir, cwd: ctx.cwd, createdAt: new Date().toISOString(), cap: scheduler.cap,
    runtime: { provider: ctx.model.provider, modelId: ctx.model.id, model, thinking, activeTools, projectTrusted }, children,
   };
   await saveRun(details, false);
   let updateTimer: ReturnType<typeof setTimeout> | undefined;
   const emit = () => { if (updateTimer) clearTimeout(updateTimer); updateTimer = undefined; onUpdate?.({ content: [{ type: "text", text: "Subagents running" }], details: publicDetails(details) }); };
   const changed = (immediate = false) => {
    if (immediate) emit();
    else if (!updateTimer) { updateTimer = setTimeout(emit, 100); updateTimer.unref?.(); }
   };
   emit();
   const elapsedTimer = setInterval(() => changed(true), 1000); elapsedTimer.unref?.();
   const callController = new AbortController(); activeCalls.add(callController);
   const abort = () => { scheduler.cancel(toolCallId); callController.abort(); };
   signal?.addEventListener("abort", abort, { once: true });
   if (signal?.aborted) abort();
   const outcomes = children.map(async (child) => {
    if (callController.signal.aborted) {
     child.status = "not-started"; child.error = "Cancelled before start"; child.endedAt = Date.now(); changed(true); return child;
    }
    try { return await scheduler.schedule(toolCallId, () => runChild(child, { cwd: ctx.cwd, model, thinking, tools: activeTools, runDir, approved: projectTrusted }, callController.signal, changed)); }
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
    clearInterval(elapsedTimer); if (updateTimer) clearTimeout(updateTimer);
    signal?.removeEventListener("abort", abort); activeCalls.delete(callController);
   }
   const content = buildEnvelope(children);
   return { content: [{ type: "text", text: content }], details: publicDetails(details) };
  },
  renderCall: () => new Container(),
  renderResult: (result, options, theme, context) => {
   const details = result.details as RunDetails | undefined;
   const renderState = context.state as { spinnerTimer?: ReturnType<typeof setInterval> };
   const isRunning = options.isPartial && (details?.children.some((child) => child.status === "starting" || child.status === "running") ?? false);
   if (isRunning && !renderState.spinnerTimer) {
    const timer = setInterval(() => context.invalidate(), 120); timer.unref?.();
    renderState.spinnerTimer = timer; renderTimers.add(timer);
   } else if (!isRunning && renderState.spinnerTimer) {
    clearInterval(renderState.spinnerTimer); renderTimers.delete(renderState.spinnerTimer); renderState.spinnerTimer = undefined;
   }
   const hasFailure = details?.children.some((child) => ["failed", "cancelled", "not-started"].includes(child.status)) ?? false;
   const background = options.isPartial ? "toolPendingBg" : hasFailure ? "toolErrorBg" : "toolSuccessBg";
   return new SnapshotComponent(details, options.expanded, (text) => theme.bg(background, text));
  },
 });
}
