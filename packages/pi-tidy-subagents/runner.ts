import { spawn } from "node:child_process";
import { buildToolActivityBlock } from "./vendor/pi-tidy-core/index.js";
import { appendEvent } from "./store.js";
import type { ChildRuntimePlan, ChildState, NormalizedEvent } from "./types.js";

/** Shared launch context that remains identical across siblings. */
export interface SharedLaunchContext { cwd: string; tools: string[]; runDir: string; approved: boolean }
/** Per-child launch runtime: model/thinking come from the child-owned plan. */
export interface Runtime extends SharedLaunchContext { model: string; thinking: string }
type Changed = (immediate?: boolean) => void;
/** Derive spawn runtime from a child-owned plan plus shared working context. */
export function launchRuntime(plan: Pick<ChildRuntimePlan, "model" | "thinking">, shared: SharedLaunchContext): Runtime {
 return { ...shared, model: plan.model, thinking: plan.thinking };
}
export function buildChildArgs(runtime: Pick<Runtime, "model" | "thinking" | "tools"> & { approved?: boolean }): string[] {
 const toolArgs = runtime.tools.length > 0 ? ["--tools", runtime.tools.join(",")] : ["--no-tools"];
 return ["--mode", "rpc", "--no-session", ...(runtime.approved ? ["--approve"] : []), "--model", runtime.model, "--thinking", runtime.thinking, ...toolArgs];
}
const messageText = (message: any): string => Array.isArray(message?.content)
 ? message.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("") : "";
const usageComponents = (usage: any) => ({
 input: Number(usage?.input) || 0,
 output: Number(usage?.output) || 0,
 cacheRead: Number(usage?.cacheRead ?? usage?.cache_read) || 0,
 cacheWrite: Number(usage?.cacheWrite ?? usage?.cache_write) || 0,
});

function applyObservedRuntime(child: ChildState, provider: string, modelId: string, thinkingLevel: string | undefined): void {
 const observed = {
  provider,
  modelId,
  model: `${provider}/${modelId}`,
  ...(thinkingLevel !== undefined ? { thinking: thinkingLevel } : {}),
 };
 if (child.runtimePlan) {
  let thinkingAdjustment = child.runtimePlan.thinkingAdjustment;
  let effectiveThinking = child.runtimePlan.thinking;
  if (thinkingLevel !== undefined) {
   const resolved = child.runtimePlan.resolvedThinking ?? child.runtimePlan.thinking;
   // Observed thinking becomes effective truth even when it differs from preflight resolution.
   if (thinkingLevel !== resolved) {
    thinkingAdjustment = { from: resolved, to: thinkingLevel, reason: "observed" };
   }
   effectiveThinking = thinkingLevel;
   child.thinking = thinkingLevel;
  }
  child.runtimePlan = {
   ...child.runtimePlan,
   thinking: effectiveThinking,
   ...(thinkingAdjustment ? { thinkingAdjustment } : {}),
   observed,
  };
 } else if (thinkingLevel !== undefined) {
  child.thinking = thinkingLevel;
 }
 // Compact display uses observed model identity once known.
 child.model = modelId;
}

export async function runChild(child: ChildState, runtime: Runtime, signal: AbortSignal | undefined, changed: Changed): Promise<ChildState> {
 child.status = "starting"; child.startedAt = Date.now(); changed(true);
 const executable = process.env.PI_TIDY_SUBAGENT_EXECUTABLE || (process.argv[1] ? process.execPath : "pi");
 // Base prefix is either the test fake-rpc path or the parent entry script; always append resolved launch args.
 const prefix = process.env.PI_TIDY_SUBAGENT_ARGS
  ? JSON.parse(process.env.PI_TIDY_SUBAGENT_ARGS) as string[]
  : [...(process.argv[1] && !process.env.PI_TIDY_SUBAGENT_EXECUTABLE ? [process.argv[1]] : [])];
 const args = [...prefix, ...buildChildArgs(runtime)];
 const proc = spawn(executable, args, { cwd: runtime.cwd, env: { ...process.env, PI_TIDY_SUBAGENT_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"] });
 let stderr = "", buffer = "", settled = false, cancelled = false, promptFailure = "", sawTextDelta = false, parseFailure: unknown;
 let writes = Promise.resolve();
 let promptSent = false;
 const expectedProvider = child.runtimePlan?.provider ?? runtime.model.split("/")[0] ?? "";
 const expectedModelId = child.runtimePlan?.modelId ?? runtime.model.slice(runtime.model.indexOf("/") + 1);
 type PendingResponse = { resolve: (data: unknown) => void; reject: (error: Error) => void };
 const pendingResponses = new Map<string, PendingResponse>();
 const toolArgs = new Map<string, Record<string, unknown>>();
 const toolStartedAt = new Map<string, number>();
 const appendActivities = (...lines: string[]) => {
  child.activities.push(...lines);
  while (child.activities.length > 15) {
   child.activities.shift();
   for (const tool of child.activeTools) tool.activityIndex--;
  }
 };
 const abort = () => {
  cancelled = true; child.status = "cancelled"; changed(true);
  if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
  setTimeout(() => proc.kill("SIGTERM"), 500).unref();
  setTimeout(() => proc.kill("SIGKILL"), 1250).unref();
 };
 signal?.addEventListener("abort", abort, { once: true });
 const started = new Promise<void>((resolve, reject) => {
  proc.once("spawn", resolve);
  proc.once("error", reject);
 });
 try { await started; } catch (error) {
  signal?.removeEventListener("abort", abort);
  child.status = "failed"; child.endedAt = Date.now(); child.error = `Could not start Pi RPC: ${error instanceof Error ? error.message : String(error)}`; changed(true);
  throw new Error(child.error);
 }
 if (signal?.aborted) abort();
 else { child.status = "running"; changed(true); }

 const processEvent = async (raw: any): Promise<void> => {
  const event: NormalizedEvent = { schemaVersion: 1, sequence: ++child.eventCount, timestamp: new Date().toISOString(), type: String(raw.type ?? "unknown"), payload: raw };
  await appendEvent(runtime.runDir, child.id, event);
  if (raw.type === "response" && raw.id != null && pendingResponses.has(String(raw.id))) {
   const pending = pendingResponses.get(String(raw.id))!;
   pendingResponses.delete(String(raw.id));
   if (raw.success === false) pending.reject(new Error(String(raw.error ?? `RPC ${raw.command ?? "command"} failed`)));
   else pending.resolve(raw.data);
   return;
  }
  if (raw.type === "response" && raw.command === "prompt" && raw.success === false) {
   promptFailure = String(raw.error ?? "Pi RPC rejected the prompt");
   proc.stdin.end(); proc.kill("SIGTERM");
  } else if (raw.type === "tool_execution_start") {
   if (child.streamingLine?.trim()) appendActivities(child.streamingLine); child.streamingLine = undefined;
   const id = String(raw.toolCallId); const name = String(raw.toolName ?? "tool"); const args = raw.args ?? {};
   toolArgs.set(id, args); toolStartedAt.set(id, Date.now()); child.toolCount++;
   appendActivities(...buildToolActivityBlock(name, args, "running"));
   child.activeTools.push({ id, name, activityIndex: Math.max(0, child.activities.length - 2) }); changed(true);
  } else if (raw.type === "tool_execution_end") {
   const id = String(raw.toolCallId); const active = child.activeTools.find((tool) => tool.id === id);
   const block = buildToolActivityBlock(raw.toolName ?? "tool", toolArgs.get(id) ?? {}, raw.isError ? "error" : "success", raw.result, Date.now() - (toolStartedAt.get(id) ?? Date.now()));
   if (active && active.activityIndex >= 0) child.activities.splice(active.activityIndex, 2, ...block);
   else appendActivities(...block);
   child.activeTools = child.activeTools.filter((tool) => tool.id !== id);
   toolArgs.delete(id); toolStartedAt.delete(id); changed(true);
  } else if (raw.type === "message_update" && raw.assistantMessageEvent?.type === "text_delta") {
   sawTextDelta = true;
   const combined = `${child.streamingLine ?? ""}${String(raw.assistantMessageEvent.delta ?? "")}`;
   const lines = combined.split("\n"); child.streamingLine = lines.pop() ?? "";
   for (const line of lines) if (line.trim()) appendActivities(line);
   changed(false);
  } else if (raw.type === "message_end" && raw.message?.role === "assistant") {
   const text = messageText(raw.message); child.response = text;
   if (sawTextDelta) {
    if (child.streamingLine?.trim()) appendActivities(child.streamingLine);
   } else if (text) {
    for (const line of text.split("\n")) if (line.trim()) appendActivities(line);
   }
   child.streamingLine = undefined; sawTextDelta = false;
   const usage = usageComponents(raw.message.usage);
   child.input += usage.input; child.output += usage.output;
   child.cacheRead += usage.cacheRead; child.cacheWrite += usage.cacheWrite;
   child.providerTraffic += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
   child.tokens = child.providerTraffic; changed(true);
  } else if (raw.type === "agent_settled") {
   settled = true; changed(true);
   proc.stdin.end(); proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 750).unref();
  }
 };
 proc.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
  for (let line of lines) {
   if (line.endsWith("\r")) line = line.slice(0, -1);
   if (!line) continue;
   writes = writes.then(async () => { try { await processEvent(JSON.parse(line)); } catch (error) { parseFailure = error; proc.kill("SIGTERM"); } });
  }
 });
 proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

 const closePromise = new Promise<number | null>((resolve) => proc.once("close", resolve));

 // Observe child RPC state before sending the prompt (AC-009 / AC-010).
 if (!cancelled && !signal?.aborted) {
  const stateId = `${child.id}:get_state`;
  try {
   const stateData = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
     pendingResponses.delete(stateId);
     reject(new Error("Timed out waiting for child RPC get_state"));
    }, 15_000);
    timer.unref?.();
    pendingResponses.set(stateId, {
     resolve: (data) => { clearTimeout(timer); resolve(data); },
     reject: (error) => { clearTimeout(timer); reject(error); },
    });
    closePromise.then((code) => {
     if (pendingResponses.has(stateId)) {
      pendingResponses.delete(stateId);
      clearTimeout(timer);
      reject(new Error(stderr.trim() || `Pi RPC exited ${code ?? "by signal"} before reporting state`));
     }
    });
    if (!proc.stdin.writable) {
     pendingResponses.delete(stateId);
     clearTimeout(timer);
     reject(new Error("Pi RPC stdin closed before get_state"));
     return;
    }
    proc.stdin.write(`${JSON.stringify({ id: stateId, type: "get_state" })}\n`);
   });
   await writes;
   const model = stateData?.model;
   const provider = model?.provider;
   const modelId = model?.id;
   if (typeof provider !== "string" || !provider || typeof modelId !== "string" || !modelId) {
    throw new Error("Child RPC state missing model provider/id");
   }
   if (provider !== expectedProvider || modelId !== expectedModelId) {
    throw new Error(`Child startup model mismatch: observed ${provider}/${modelId}, expected ${expectedProvider}/${expectedModelId}`);
   }
   const thinkingLevel = typeof stateData?.thinkingLevel === "string" ? stateData.thinkingLevel : undefined;
   applyObservedRuntime(child, provider, modelId, thinkingLevel);
   changed(true);
  } catch (error) {
   if (!cancelled) {
    child.status = "failed";
    child.error = error instanceof Error ? error.message : String(error);
    child.endedAt = Date.now();
    if (proc.stdin.writable) proc.stdin.end();
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 750).unref();
    await closePromise; await writes;
    signal?.removeEventListener("abort", abort);
    changed(true);
    return child;
   }
  }
 }

 if (!cancelled && !signal?.aborted && child.status === "running") {
  promptSent = true;
  proc.stdin.write(`${JSON.stringify({ id: child.id, type: "prompt", message: child.prompt })}\n`);
 }

 const code = await closePromise;
 await writes; signal?.removeEventListener("abort", abort);
 child.endedAt = Date.now();
 if (parseFailure) throw new Error(`Could not maintain durable child event stream: ${parseFailure instanceof Error ? parseFailure.message : String(parseFailure)}`);
 // Startup observation failures return early after setting status/error.
 if (cancelled) child.error = "Cancelled";
 else if (promptFailure) { child.status = "failed"; child.error = promptFailure; }
 else if (!promptSent) { child.status = "failed"; child.error = child.error || "Child failed before prompt"; }
 else if (!settled) { child.status = "failed"; child.error = stderr.trim() || `Pi RPC exited ${code ?? "by signal"} before settling`; }
 else if (!child.response.trim()) { child.status = "warning"; child.error = "Child completed without assistant output"; }
 else child.status = "completed";
 changed(true); return child;
}
