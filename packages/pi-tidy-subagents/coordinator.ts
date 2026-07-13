import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEnvelope } from "./envelope.js";
import { runChild, type ChildControlHandle, type SharedLaunchContext } from "./runner.js";
import { Scheduler } from "./scheduler.js";
import { saveLegacyState, saveRun } from "./store.js";
import type { ChildState, DeliveryPolicy, RunDetails } from "./types.js";
import { BackgroundWidgetComponent, type BackgroundStampData } from "./ui.js";

const ACTIVE = new Set(["queued", "starting", "running"]);
const terminal = (child: ChildState): boolean => !ACTIVE.has(child.status);
const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bounded = (value: string, limit = 4 * 1024): string => {
 let result = "";
 for (const character of value) {
  if (Buffer.byteLength(result + character, "utf8") > limit) return `${result}…`;
  result += character;
 }
 return result;
};

export interface CoordinatorContext {
 mode: "tui" | "rpc" | "json" | "print";
 ui?: {
  setWidget(key: string, value: any, options?: any): void;
  getToolsExpanded?(): boolean;
  custom?<T>(factory: any, options?: any): Promise<T | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
 };
}

interface ChildRecord {
 child: ChildState;
 details: RunDetails;
 batchKey?: string;
 shared: SharedLaunchContext;
 mode: CoordinatorContext["mode"];
 controller: AbortController;
 handle?: ChildControlHandle;
 foregroundDone: Promise<void>;
 releaseForeground: () => void;
 runPromise?: Promise<ChildState>;
 mutation: Promise<unknown>;
 settledCommitted: boolean;
 completionQueued: boolean;
 shutdownCancellation: boolean;
 fatalError?: Error;
 widgetSnapshot: ChildState;
 onChanged: (immediate?: boolean) => void;
}

export interface ControlResponse {
 content: Array<{ type: "text"; text: string }>;
 details: Record<string, any>;
}

export function publicChild(child: ChildState): ChildState {
 return {
  ...child,
  prompt: "",
  response: "",
  activities: [...(child.activities ?? [])],
  activeTools: (child.activeTools ?? []).map((tool) => ({ ...tool })),
  ...(child.controlHistory ? { controlHistory: child.controlHistory.map((item) => ({ ...item })) } : {}),
  ...(child.runtimePlan ? {
   runtimePlan: {
    ...child.runtimePlan,
    ...(child.runtimePlan.thinkingAdjustment ? { thinkingAdjustment: { ...child.runtimePlan.thinkingAdjustment } } : {}),
    ...(child.runtimePlan.observed ? { observed: { ...child.runtimePlan.observed } } : {}),
   },
  } : {}),
 };
}

export function backgroundAcknowledgement(child: ChildState): string {
 return `<background_ack index="${child.index}" target="${xml(child.target ?? child.id)}" label="${xml(child.label)}" state="${child.status}" ownership="background" delivery="${child.deliveryPolicy ?? "auto"}" artifact="${xml(child.artifactPath)}"/>`;
}

export function buildMixedEnvelope(children: ChildState[]): string {
 const limit = 50 * 1024;
 const empty = children.map((child) => child.ownership === "background"
  ? backgroundAcknowledgement(child)
  : buildEnvelope([{ ...child, response: "", error: undefined }]));
 const baseBytes = empty.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), Math.max(0, children.length - 1));
 if (baseBytes > limit) {
  const marker = `<subagent_results_truncated total="${children.length}" artifacts="${xml(children[0] ? dirname(children[0].artifactPath) : "")}"/>`;
  return Buffer.byteLength(marker, "utf8") <= limit ? marker : `<subagent_results_truncated total="${children.length}"/>`;
 }
 let remaining = limit - baseBytes;
 return children.map((child, index) => {
  if (child.ownership === "background") return empty[index]!;
  const base = Buffer.byteLength(empty[index]!, "utf8");
  const result = buildEnvelope([child], base + remaining);
  remaining -= Math.max(0, Buffer.byteLength(result, "utf8") - base);
  return result;
 }).join("\n");
}

export class SessionCoordinator {
 private readonly records = new Map<string, ChildRecord>();
 private readonly persistQueues = new Map<string, Promise<void>>();
 private readonly legacyRunIds = new Set<string>();
 private registrationWaiters = new Map<string, Set<() => void>>();
 private context?: CoordinatorContext;
 private shuttingDown = false;

 constructor(private readonly pi: ExtensionAPI, private readonly scheduler: Scheduler) {}

 attachContext(ctx: CoordinatorContext): void {
  this.context = ctx;
  if (ctx.mode === "tui") this.refreshWidget();
 }

 async launchRun(details: RunDetails, shared: SharedLaunchContext, mode: CoordinatorContext["mode"], onChanged: (immediate?: boolean) => void, batchKey?: string): Promise<ChildRecord[]> {
  const records: ChildRecord[] = [];
  for (const child of details.children) {
   let releaseForeground!: () => void;
   const foregroundDone = new Promise<void>((resolve) => { releaseForeground = resolve; });
   const record: ChildRecord = {
    child, details, batchKey, shared, mode, controller: new AbortController(), foregroundDone, releaseForeground,
    mutation: Promise.resolve(), settledCommitted: false, completionQueued: false, shutdownCancellation: false, widgetSnapshot: publicChild(child), onChanged,
   };
   this.records.set(child.target!, record);
   records.push(record);
   if (child.ownership === "background") releaseForeground();
  }
  const directBackground = records.filter((record) => record.child.ownership === "background");
  this.notifyRegistration(batchKey);
  await this.persist(details);
  for (const record of directBackground) this.appendStamp(record, "handoff");
  this.refreshWidget();
  for (const record of records) {
   if (terminal(record.child)) record.runPromise = this.commitSettlement(record).then(() => record.child);
   else this.start(record);
  }
  return records;
 }

 async waitForForeground(records: ChildRecord[]): Promise<void> {
  await Promise.all(records.map((record) => record.foregroundDone));
 }

 foregroundFatalError(records: ChildRecord[]): Error | undefined {
  return records.find((record) => record.child.ownership === "foreground" && record.fatalError)?.fatalError;
 }

 cancelForeground(records: ChildRecord[]): void {
  for (const record of records) {
   if (record.child.ownership === "foreground" && !terminal(record.child)) void this.cancelRecord(record, false).catch(() => undefined);
  }
 }

 async control(action: string, target?: string, message?: string, delivery?: DeliveryPolicy, source: "agent" | "user" = "agent", batchKey?: string): Promise<ControlResponse> {
  if (action === "status") return this.status();
  if (!target?.trim()) throw new Error(`${action} requires a target`);
  const record = await this.resolve(target.trim(), action, batchKey);
  switch (action) {
   case "background": return this.background(record, source);
   case "steer": return this.steer(record, message ?? "");
   case "cancel": return this.cancel(record);
   case "inspect": return this.inspect(record);
   case "set_delivery": return this.setDelivery(record, delivery);
   case "collect": return this.collect(record, source === "user");
   default: throw new Error(`Unknown subagent control action: ${action}`);
  }
 }

 async shutdown(): Promise<void> {
  if (this.shuttingDown) {
   await Promise.allSettled([...this.records.values()].map((record) => record.runPromise).filter(Boolean) as Promise<ChildState>[]);
   return;
  }
  this.shuttingDown = true;
  const active = [...this.records.values()].filter((record) => !terminal(record.child));
  this.scheduler.shutdown();
  for (const record of active) {
   record.shutdownCancellation = true;
   this.recordControl(record.child, "shutdown", "accepted");
   record.controller.abort();
  }
  await Promise.allSettled(active.map((record) => record.runPromise).filter(Boolean) as Promise<ChildState>[]);
  this.refreshWidget(true);
 }

 private start(record: ChildRecord): void {
  const { child } = record;
  const plan = child.runtimePlan;
  if (!plan) {
   child.status = "failed"; child.error = `child ${child.id} missing runtime plan`; child.endedAt = Date.now();
   record.runPromise = this.commitSettlement(record).then(() => child);
   return;
  }
  const runtime = { ...record.shared, model: plan.model, thinking: plan.thinking };
  record.runPromise = this.scheduler.schedule(child.target!, () => runChild(
   child,
   runtime,
   record.controller.signal,
   (immediate) => {
    record.onChanged(immediate);
    if (!terminal(child)) record.widgetSnapshot = publicChild(child);
    this.refreshWidget();
    if (immediate) void this.persist(record.details);
   },
   (handle) => { record.handle = handle; record.widgetSnapshot = publicChild(child); this.refreshWidget(); },
  )).catch((error) => {
   const failure = error instanceof Error ? error : new Error(String(error));
   if (/Could not (start Pi RPC|maintain durable)/.test(failure.message)) record.fatalError = failure;
   if (!terminal(child)) {
    if (record.controller.signal.aborted) {
     child.status = "cancelled"; child.error = record.shutdownCancellation ? "Cancelled during session shutdown" : "Cancelled";
    } else {
     child.status = "failed"; child.error = failure.message;
    }
    child.endedAt = Date.now(); record.onChanged(true);
   }
   return child;
  }).then(async (settled) => { await this.commitSettlement(record); return settled; });
 }

 private serialize<T>(record: ChildRecord, operation: () => Promise<T> | T): Promise<T> {
  const next = record.mutation.then(operation, operation);
  record.mutation = next.then(() => undefined, () => undefined);
  return next;
 }

 private async commitSettlement(record: ChildRecord): Promise<void> {
  await this.serialize(record, async () => {
   if (record.settledCommitted) return;
   const { child } = record;
   if (!terminal(child)) return;
   child.terminalOwnership = child.ownership ?? "foreground";
   if (child.ownership === "background" && child.deliveryPolicy === "manual") child.deliveryState = "manual";
   // Durable process truth precedes both transcript history and model-context completion delivery.
   await this.persist(record.details);
   if (child.ownership === "background") {
    this.appendStamp(record, "terminal");
    if (!this.shuttingDown && child.deliveryPolicy !== "manual") await this.queueCompletion(record, "automatic");
   }
   record.settledCommitted = true;
   record.releaseForeground();
   record.onChanged(true);
   this.refreshWidget();
  });
 }

 private async background(record: ChildRecord, source: "agent" | "user"): Promise<ControlResponse> {
  return this.serialize(record, async () => {
   const { child } = record;
   if (child.ownership === "background") throw new Error(`${child.target} is already background-owned; backgrounding is one-way`);
   if (terminal(child)) throw new Error(`${child.target} is terminal (${child.status}) and cannot be backgrounded`);
   if (record.mode === "print") throw new Error("Print mode cannot own background subagents");
   child.ownership = "background";
   child.ownershipChangedAt = Date.now();
   child.ownershipReason = source === "user" ? "user-control" : "agent-control";
   child.deliveryPolicy = "auto";
   child.deliveryState = "pending";
   this.recordControl(child, "background", "accepted");
   await this.persist(record.details);
   record.releaseForeground();
   record.widgetSnapshot = publicChild(child);
   this.appendStamp(record, "handoff");
   record.onChanged(true);
   this.refreshWidget();
   return this.response(`Backgrounded ${child.label} (${child.target}) in state ${child.status}. Artifact: ${child.artifactPath}`, { accepted: true, child: publicChild(child) });
  });
 }

 private async steer(record: ChildRecord, message: string): Promise<ControlResponse> {
  if (!message.trim()) throw new Error("steer requires a non-empty message");
  return this.serialize(record, async () => {
   const { child } = record;
   if (child.ownership !== "background") throw new Error(`${child.target} is not background-owned`);
   if (child.status !== "running" || !record.handle) throw new Error(`${child.target} is ${child.status}; steering is not ready yet, retry when running`);
   const acknowledgement = await record.handle.steer(message.trim());
   this.recordControl(child, "steer", "accepted");
   await this.persist(record.details);
   this.refreshWidget();
   return this.response(`Steering accepted for ${child.label} (${child.target}) by Pi's native queue.`, { ...acknowledgement, child: publicChild(child) });
  });
 }

 private async cancel(record: ChildRecord): Promise<ControlResponse> {
  const acknowledgement = await this.serialize(record, async () => {
   if (terminal(record.child)) {
    this.recordControl(record.child, "cancel", "repeated");
    await this.persist(record.details);
    return { accepted: true as const, repeated: true };
   }
   const accepted = await this.cancelRecord(record, false);
   this.recordControl(record.child, "cancel", "accepted");
   return { ...accepted, repeated: false };
  });
  if (!acknowledgement.repeated) await record.runPromise;
  const child = publicChild(record.child);
  return acknowledgement.repeated
   ? this.response(`${child.target} is already terminal (${child.status}); cancellation is idempotent.`, { ...acknowledgement, child })
   : this.response(`Cancellation accepted for ${child.label} (${child.target}).`, { ...acknowledgement, child });
 }

 private async cancelRecord(record: ChildRecord, shutdown: boolean): Promise<{ accepted: true }> {
  const { child } = record;
  record.shutdownCancellation ||= shutdown;
  if (child.status === "queued") {
   record.controller.abort();
   this.scheduler.cancel(child.target);
   return { accepted: true };
  }
  if (record.handle) return record.handle.abort();
  record.controller.abort();
  return { accepted: true };
 }

 private inspect(record: ChildRecord): ControlResponse {
  const activity = record.child.streamingLine?.trim() || record.child.activities?.at(-1) || record.child.error || "no activity yet";
  return this.response(`${record.child.label} (${record.child.target}) is ${record.child.status}/${record.child.ownership ?? "foreground"}; activity: ${activity}; delivery ${record.child.deliveryPolicy ?? "none"}; artifact ${record.child.artifactPath}`, { child: publicChild(record.child), controlReady: Boolean(record.handle) && !terminal(record.child) });
 }

 private status(): ControlResponse {
  const values = [...this.records.values()].map((record) => publicChild(record.child));
  const activeForeground = values.filter((child) => !terminal(child) && (child.ownership ?? "foreground") === "foreground");
  const activeBackground = values.filter((child) => !terminal(child) && child.ownership === "background");
  const terminalUncollected = values.filter((child) => terminal(child) && child.ownership === "background" && !(child.collectionCount ?? 0));
  const lines = [
   `Active foreground: ${activeForeground.length}`,
   ...activeForeground.map((child) => `- ${child.label} ${child.target} ${child.status}`),
   `Active background: ${activeBackground.length}`,
   ...activeBackground.map((child) => `- ${child.label} ${child.target} ${child.status} delivery=${child.deliveryPolicy}`),
   `Terminal uncollected: ${terminalUncollected.length}`,
   ...terminalUncollected.map((child) => `- ${child.label} ${child.target} ${child.status} age=${this.age(child)} artifact=${child.artifactPath}`),
  ];
  return this.response(lines.join("\n"), { activeForeground, activeBackground, terminalUncollected });
 }

 private async setDelivery(record: ChildRecord, delivery?: DeliveryPolicy): Promise<ControlResponse> {
  if (delivery !== "auto" && delivery !== "manual") throw new Error("set_delivery requires delivery=auto or delivery=manual");
  return this.serialize(record, async () => {
   const { child } = record;
   if (child.ownership !== "background") throw new Error(`${child.target} has no background completion-delivery contract`);
   if (child.followUpAcceptedAt !== undefined) {
    if (delivery === "manual") throw new Error(`${child.target} completion follow-up was already accepted by Pi and cannot be retracted`);
    return this.response(`${child.label} (${child.target}) delivery is already auto and accepted.`, { accepted: true, repeated: true, child: publicChild(child) });
   }
   child.deliveryPolicy = delivery;
   child.deliveryState = delivery === "manual" ? "manual" : "pending";
   this.recordControl(child, "set_delivery", "accepted");
   await this.persist(record.details);
   if (delivery === "auto" && terminal(child) && !record.completionQueued && !this.shuttingDown) await this.queueCompletion(record, "delivery-change");
   this.refreshWidget();
   return this.response(`${child.label} (${child.target}) delivery is now ${delivery}.`, { accepted: true, child: publicChild(child) });
  });
 }

 private async collect(record: ChildRecord, userDelivery: boolean): Promise<ControlResponse> {
  return this.serialize(record, async () => {
   const { child } = record;
   if (!terminal(child)) throw new Error(`${child.target} is ${child.status}; collect is available after settlement`);
   const previouslyCollected = (child.collectionCount ?? 0) > 0;
   const result = buildEnvelope([child]);
   const now = Date.now();
   child.collectionCount = (child.collectionCount ?? 0) + 1;
   child.firstCollectedAt ??= now;
   child.lastCollectedAt = now;
   this.recordControl(child, "collect", previouslyCollected ? "repeated" : "accepted");
   await this.persist(record.details);
   if (userDelivery) {
    this.pi.sendMessage({ customType: "pi-tidy-subagent-completion", content: result, display: true, details: { target: child.target, label: child.label, status: child.status, collected: true, artifactPath: child.artifactPath } }, { deliverAs: "followUp", triggerTurn: true });
   }
   return this.response(result, { accepted: true, previouslyCollected, collectionCount: child.collectionCount, child: publicChild(child) });
  });
 }

 private async queueCompletion(record: ChildRecord, reason: string): Promise<void> {
  if (record.completionQueued || this.shuttingDown) return;
  const { child } = record;
  const content = buildEnvelope([child]);
  try {
   this.pi.sendMessage({
    customType: "pi-tidy-subagent-completion",
    content,
    display: true,
    details: { target: child.target, label: child.label, status: child.status, artifactPath: child.artifactPath, reason },
   }, { deliverAs: "followUp", triggerTurn: true });
   record.completionQueued = true;
   child.deliveryState = "accepted";
   child.followUpAcceptedAt = Date.now();
   child.deliveryError = undefined;
  } catch (error) {
   child.deliveryState = "pending";
   child.deliveryError = error instanceof Error ? error.message : String(error);
  }
  await this.persist(record.details);
 }

 private appendStamp(record: ChildRecord, kind: BackgroundStampData["kind"]): void {
  if (record.mode !== "tui") return;
  const child = record.child;
  this.pi.appendEntry("pi-tidy-subagent-stamp", {
   kind,
   target: child.target!,
   timestamp: Date.now(),
   child: publicChild(child),
   result: kind === "terminal" ? bounded(child.response || child.error || "") : undefined,
  } satisfies BackgroundStampData);
 }

 private refreshWidget(clear = false): void {
  const ctx = this.context;
  if (ctx?.mode !== "tui" || !ctx.ui) return;
  const active = clear ? [] : [...this.records.values()].filter((record) => record.child.ownership === "background" && !record.settledCommitted).map((record) => record.widgetSnapshot);
  if (active.length === 0) ctx.ui.setWidget("pi-tidy-subagents-background", undefined);
  else ctx.ui.setWidget("pi-tidy-subagents-background", (_tui: any, theme: any) => new BackgroundWidgetComponent(() => active.map(publicChild), theme, () => Boolean(ctx.ui?.getToolsExpanded?.())), { placement: "aboveEditor" });
 }

 private async resolve(target: string, action: string, batchKey?: string): Promise<ChildRecord> {
  const exact = this.records.get(target);
  if (exact) return exact;
  let candidates = this.candidates(target, action);
  if (candidates.length === 0 && !target.includes(":") && batchKey !== undefined) {
   await this.waitForRegistration(batchKey, 750);
   candidates = this.candidates(target, action).filter((record) => record.batchKey === batchKey);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) throw new Error(`Ambiguous subagent label "${target}". Candidates: ${candidates.map((record) => `${record.child.target} (${record.child.status}/${record.child.ownership ?? "foreground"})`).join(", ")}`);
  const legacy = target.includes(":") ? await this.loadLegacy(target) : undefined;
  if (legacy) return legacy;
  throw new Error(`No eligible subagent found for target "${target}"`);
 }

 private candidates(label: string, action: string): ChildRecord[] {
  const labeled = [...this.records.values()].filter((record) => record.child.label === label);
  if (action === "collect") return labeled.filter((record) => terminal(record.child));
  const eligible = labeled.filter((record) => {
   const child = record.child;
   if (action === "background" || action === "steer") return !terminal(child);
   if (action === "set_delivery") return child.ownership === "background";
   return true;
  });
  const active = eligible.filter((record) => !terminal(record.child));
  return active.length > 0 ? active : eligible;
 }

 private async loadLegacy(target: string): Promise<ChildRecord | undefined> {
  const separator = target.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const runId = target.slice(0, separator), childId = target.slice(separator + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..") || !/^child-[A-Za-z0-9._-]+$/.test(childId)) return undefined;
  try {
   const runDir = join(getAgentDir(), "pi-tidy-subagents", "runs", runId);
   const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
   const raw = manifest.children?.find((child: any) => child.id === childId);
   if (!raw || ACTIVE.has(raw.status)) return undefined;
   const child: ChildState = {
    ...raw,
    target,
    ownership: raw.ownership ?? "foreground",
    requestedExecution: raw.requestedExecution ?? "foreground",
    prompt: raw.prompt ?? "",
    response: await readFile(join(runDir, `${childId}.md`), "utf8").catch(() => ""),
    activeTools: raw.activeTools ?? [],
    activities: raw.activities ?? [],
    artifactPath: join(runDir, `${childId}.md`),
   };
   const details: RunDetails = { ...manifest, schemaVersion: 3, runDir, cap: manifest.concurrencyCap ?? 1, children: [child] };
   const record: ChildRecord = { child, details, shared: { cwd: manifest.cwd ?? "", tools: [], runDir, approved: true }, mode: "json", controller: new AbortController(), foregroundDone: Promise.resolve(), releaseForeground: () => {}, mutation: Promise.resolve(), settledCommitted: true, completionQueued: child.deliveryState === "accepted", shutdownCancellation: false, widgetSnapshot: publicChild(child), onChanged: () => {} };
   this.records.set(target, record);
   this.legacyRunIds.add(runId);
   return record;
  } catch { return undefined; }
 }

 private persist(details: RunDetails): Promise<void> {
  const previous = this.persistQueues.get(details.runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => this.legacyRunIds.has(details.runId)
   ? saveLegacyState(details)
   : saveRun(details, details.children.every(terminal)));
  this.persistQueues.set(details.runId, next);
  return next;
 }

 private waitForRegistration(batchKey: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
   const waiters = this.registrationWaiters.get(batchKey) ?? new Set<() => void>();
   const done = () => {
    clearTimeout(timer);
    waiters.delete(done);
    if (waiters.size === 0) this.registrationWaiters.delete(batchKey);
    resolve();
   };
   const timer = setTimeout(done, timeoutMs);
   timer.unref?.();
   waiters.add(done);
   this.registrationWaiters.set(batchKey, waiters);
  });
 }

 private notifyRegistration(batchKey?: string): void {
  if (batchKey === undefined) return;
  const waiters = [...(this.registrationWaiters.get(batchKey) ?? [])];
  this.registrationWaiters.delete(batchKey);
  for (const resolve of waiters) resolve();
 }

 private recordControl(child: ChildState, action: NonNullable<ChildState["controlHistory"]>[number]["action"], outcome: "accepted" | "repeated"): void {
  child.controlHistory ??= [];
  child.controlHistory.push({ action, outcome, timestamp: Date.now() });
 }

 private age(child: ChildState): string {
  const elapsed = Math.max(0, Date.now() - (child.endedAt ?? child.startedAt ?? child.ownershipChangedAt ?? Date.now()));
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
 }

 private response(text: string, details: Record<string, any>): ControlResponse {
  return { content: [{ type: "text", text }], details };
 }
}
