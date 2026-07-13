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
import { buildMixedEnvelope, publicChild, SessionCoordinator } from "./coordinator.js";
import { ToolSnapshotComponent } from "./render.js";
import { resolveBatchRuntime, wrapPiRegistry, type ModelAuthRegistry } from "./runtime.js";
import { concurrencyCap, Scheduler } from "./scheduler.js";
import { createRunStore } from "./store.js";
import type { ChildState, DeliveryPolicy, RunDetails, ThinkingLevel } from "./types.js";
import { BackgroundStampComponent, ManagementOverlay, managementItems } from "./ui.js";
import { THINKING_LEVELS } from "./types.js";

export { buildEnvelope } from "./envelope.js";
export { concurrencyCap, Scheduler } from "./scheduler.js";
export { renderLines, renderBackgroundAcknowledgementLines, ToolSnapshotComponent } from "./render.js";
export { BackgroundStampComponent, BackgroundWidgetComponent, ManagementOverlay, managementActions, managementItems, renderBackgroundWidgetLines, renderManagementLines } from "./ui.js";
export { SessionCoordinator, backgroundAcknowledgement, buildMixedEnvelope } from "./coordinator.js";
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
 return { ...details, children: details.children.map(publicChild) };
}

function registryFromContext(ctx: { modelRegistry?: { find(provider: string, modelId: string): { provider: string; id: string } | undefined | null; hasConfiguredAuth(model: { provider: string; id: string }): boolean } }): ModelAuthRegistry | undefined {
 if (!ctx.modelRegistry) return undefined;
 return wrapPiRegistry(ctx.modelRegistry);
}

function parentBatchKey(ctx: { sessionManager?: { getLeafId?(): unknown } }): string | undefined {
 const leafId = ctx.sessionManager?.getLeafId?.();
 return typeof leafId === "string" && leafId.length > 0 ? leafId : undefined;
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

const ExecutionEnum = Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
 description: "Ownership mode. Omit for synchronous foreground execution; background returns after durable registration.",
});
const Parameters = Type.Object({ agents: Type.Array(Type.Object({
 label: Type.Optional(Type.String({ description: "Short display label; defaults to agent" })),
 reason: Type.String({ description: "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)" }),
 prompt: Type.String({ description: "Full context, skills, objective, and output expectations sent verbatim to the child" }),
 model: Type.Optional(Type.String({
  description: MODEL_FIELD_DESCRIPTION,
 })),
 thinking: Type.Optional(ThinkingEnum),
 execution: Type.Optional(ExecutionEnum),
}), { minItems: 1 }) });

const ControlActionEnum = Type.Union([
 Type.Literal("background"), Type.Literal("steer"), Type.Literal("cancel"), Type.Literal("inspect"),
 Type.Literal("status"), Type.Literal("set_delivery"), Type.Literal("collect"),
]);
const DeliveryEnum = Type.Union([Type.Literal("auto"), Type.Literal("manual")]);
const ControlParameters = Type.Object({
 action: ControlActionEnum,
 target: Type.Optional(Type.String({ description: "Canonical <run-id>:<child-id> target or one unambiguous eligible label" })),
 message: Type.Optional(Type.String({ description: "Non-empty native Pi steering instruction; valid only for steer" })),
 delivery: Type.Optional(DeliveryEnum),
});

function validateControlInput(params: { action: string; target?: string; message?: string; delivery?: DeliveryPolicy }): void {
 const fields = [params.target !== undefined ? "target" : "", params.message !== undefined ? "message" : "", params.delivery !== undefined ? "delivery" : ""].filter(Boolean);
 const allowed = params.action === "status" ? [] : params.action === "steer" ? ["target", "message"] : params.action === "set_delivery" ? ["target", "delivery"] : ["target"];
 const irrelevant = fields.filter((field) => !allowed.includes(field));
 if (irrelevant.length) throw new Error(`${params.action} does not accept ${irrelevant.join(", ")}`);
 if (params.action !== "status" && !params.target?.trim()) throw new Error(`${params.action} requires target`);
 if (params.action === "steer" && !params.message?.trim()) throw new Error("steer requires a non-empty message");
 if (params.action === "set_delivery" && !params.delivery) throw new Error("set_delivery requires delivery=auto or delivery=manual");
}

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

/** One-line startup diagnostic when registration is intentionally skipped in a child RPC process. */
export const CHILD_SKIP_DIAGNOSTIC =
 "pi-tidy-subagents: skipping registration in child RPC process (nested subagents disabled)";

/**
 * True only for processes this package spawned as Pi RPC children.
 * Ambient `PI_TIDY_SUBAGENT_CHILD=1` alone must not disable parent sessions.
 */
export function isChildRpcProcess(
 env: NodeJS.ProcessEnv = process.env,
 argv: readonly string[] = process.argv,
): boolean {
 if (env.PI_TIDY_SUBAGENT_CHILD !== "1") return false;
 for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === "--mode" && argv[i + 1] === "rpc") return true;
 }
 return false;
}

export default function extension(pi: ExtensionAPI): void {
 // Nested fan-out is disabled only in true child RPC processes (env + --mode rpc).
 if (isChildRpcProcess()) {
  console.warn(CHILD_SKIP_DIAGNOSTIC);
  delete process.env.PI_TIDY_SUBAGENT_CHILD;
  return;
 }
 const scheduler = new Scheduler(concurrencyCap());
 const coordinator = new SessionCoordinator(pi, scheduler);
 const routingAtLoad = loadRoutingConfig(getAgentDir());

 pi.on("session_start", (_event, ctx) => coordinator.attachContext(ctx as any));
 pi.on("session_shutdown", async () => coordinator.shutdown());
 pi.registerEntryRenderer?.("pi-tidy-subagent-stamp", (entry, options, theme) => new BackgroundStampComponent(entry.data as any, options.expanded, theme));

 pi.registerCommand("tidy-subagents-routing", {
  description: "Set up structured subagent routing map (task→thinking/model) from authenticated models into agent-dir config",
  getArgumentCompletions: (prefix) => {
   const values = ["setup", "defaults", "status", "clear"];
   return values.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
  },
  handler: async (args, ctx) => { await runRoutingSetupCommand(args, ctx, getAgentDir()); },
 });

 const openManagement = async (ctx: any): Promise<void> => {
  coordinator.attachContext(ctx);
  if (ctx.mode !== "tui") { ctx.ui.notify("/subagents management overlay is available in TUI mode; use subagent_control in headless modes.", "warning"); return; }
  const status = await coordinator.control("status");
  const items = managementItems(status.details as any);
  const choice = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => new ManagementOverlay(items, theme, done, () => tui.requestRender()), {
   overlay: true,
   overlayOptions: { anchor: "right-center", width: "70%", minWidth: 54, maxHeight: "80%", margin: 1 },
  });
  if (!choice) return;
  let message: string | undefined;
  let delivery: DeliveryPolicy | undefined;
  if (choice.action === "steer") {
   message = await ctx.ui.editor(`Steer ${choice.target}`, "");
   if (!message?.trim()) return;
  }
  if (choice.action === "set_delivery") {
   const selected = items.find((item) => item.child.target === choice.target)?.child;
   delivery = selected?.deliveryPolicy === "manual" ? "auto" : "manual";
  }
  try {
   const result = await coordinator.control(choice.action, choice.target, message, delivery, "user");
   ctx.ui.notify(result.content[0]?.text ?? "Subagent action accepted", "info");
  } catch (error) {
   ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
 };
 pi.registerCommand("subagents", { description: "Manage active and completed session subagents", handler: async (_args, ctx) => openManagement(ctx) });
 pi.registerShortcut?.("ctrl+shift+b", { description: "Manage session subagents", handler: async (ctx) => openManagement(ctx) });

 pi.registerTool({
  name: "subagent", label: "subagent", renderShell: "self", executionMode: "parallel",
  description: "Launch ordered foreground and background child Pi agents. Omitted execution remains synchronous foreground. Background children are session-scoped, share the same scheduler and working tree, and return durable acknowledgements rather than partial output.",
  promptGuidelines: [
   ...basePromptGuidelines(routingAtLoad),
   "Use subagent execution=background only when the parent can proceed without the result; omission stays foreground and synchronous.",
   "Use subagent_control to inspect, background, steer, cancel, change delivery, or collect one session child by canonical target or unambiguous label.",
  ],
  parameters: Parameters,
  execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
   if (!ctx.model) throw new Error("subagent requires a resolved parent model");
   coordinator.attachContext(ctx as any);
   const parentProvider = ctx.model.provider;
   const parentModelId = ctx.model.id;
   const parentThinking = pi.getThinkingLevel();
   const parentModel = `${parentProvider}/${parentModelId}`;
   const activeTools = pi.getActiveTools().filter((name) => name !== "subagent" && name !== "subagent_control");
   const projectTrusted = ctx.isProjectTrusted();
   // Complete preflight remains before mode rejection, run artifacts, or child execution.
   const plans = resolveBatchRuntime(params.agents, { provider: parentProvider, modelId: parentModelId, thinking: parentThinking }, registryFromContext(ctx));
   if (ctx.mode === "print" && params.agents.some((request) => request.execution === "background")) {
    throw new Error("Print mode cannot launch background subagents because no session owner remains");
   }
   const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
   const runDir = await createRunStore(getAgentDir(), runId);
   const shared = { cwd: ctx.cwd, tools: activeTools, runDir, approved: projectTrusted };
   const children: ChildState[] = params.agents.map((request, index) => {
    const id = `child-${String(index + 1).padStart(3, "0")}`;
    const runtimePlan = plans[index]!;
    const ownership = request.execution ?? "foreground";
    return {
     index, id, target: `${runId}:${id}`, label: request.label || "agent", reason: request.reason, prompt: request.prompt,
     status: signal?.aborted && ownership === "foreground" ? "not-started" : "queued",
     ...(signal?.aborted && ownership === "foreground" ? { error: "Cancelled before start", endedAt: Date.now() } : {}),
     requestedExecution: ownership, ownership, ownershipChangedAt: Date.now(), ownershipReason: "direct-launch",
     deliveryPolicy: ownership === "background" ? "auto" : undefined,
     deliveryState: ownership === "background" ? "pending" : "none",
     model: runtimePlan.modelId, thinking: runtimePlan.thinking, runtimePlan,
     toolCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, providerTraffic: 0, tokens: 0,
     activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: join(runDir, `${id}.md`),
    };
   });
   const details: RunDetails = {
    schemaVersion: 3, runId, runDir, cwd: ctx.cwd, createdAt: new Date().toISOString(), cap: scheduler.cap,
    runtime: { provider: parentProvider, modelId: parentModelId, model: parentModel, thinking: parentThinking, activeTools, projectTrusted }, children,
   };
   let updateTimer: ReturnType<typeof setTimeout> | undefined;
   let callActive = true;
   const emit = () => {
    if (!callActive) return;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    onUpdate?.({ content: [{ type: "text", text: "Subagents running" }], details: publicDetails(details) });
   };
   const changed = (immediate = false) => {
    if (!callActive) return;
    if (immediate) emit();
    else if (!updateTimer) { updateTimer = setTimeout(emit, 100); updateTimer.unref?.(); }
   };
   emit();
   const records = await coordinator.launchRun(details, shared, ctx.mode, changed, parentBatchKey(ctx));
   const abort = () => coordinator.cancelForeground(records);
   signal?.addEventListener("abort", abort, { once: true });
   if (signal?.aborted) abort();
   try {
    await coordinator.waitForForeground(records);
    const fatal = coordinator.foregroundFatalError(records);
    if (fatal) throw fatal;
   } finally {
    callActive = false;
    if (updateTimer) clearTimeout(updateTimer);
    signal?.removeEventListener("abort", abort);
   }
   return { content: [{ type: "text", text: buildMixedEnvelope(children) }], details: publicDetails(details) };
  },
  renderCall: () => new Container(),
  renderResult: (result, options, theme) => {
   const details = result.details as RunDetails | undefined;
   const hasFailure = details?.children.some((child) => child.ownership !== "background" && ["failed", "cancelled", "not-started"].includes(child.status)) ?? false;
   const background = options.isPartial ? "toolPendingBg" : hasFailure ? "toolErrorBg" : "toolSuccessBg";
   return new ToolSnapshotComponent(details, options.expanded, (text) => theme.bg(background, text));
  },
 });

 pi.registerTool({
  name: "subagent_control", label: "subagent control", executionMode: "parallel",
  description: "Control one session-scoped child: background, steer through Pi's native queue, cancel, inspect, list status, set automatic/manual delivery, or collect a bounded terminal result.",
  promptGuidelines: ["Use subagent_control canonical targets when labels may be ambiguous. Background ownership is one-way and print mode cannot own background work."],
  parameters: ControlParameters,
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
   coordinator.attachContext(ctx as any);
   validateControlInput(params);
   return coordinator.control(params.action, params.target, params.message, params.delivery, "agent", parentBatchKey(ctx));
  },
 });
}
