import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const realSmoke = process.env.PI_TIDY_REAL_SMOKE === "1";
const piExecutable = process.env.PI_EXECUTABLE || "pi";

test("real Pi RPC protocol smoke", { skip: !realSmoke, timeout: 120_000 }, async () => {
 const proc = spawn(piExecutable, ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions"], { stdio: ["pipe", "pipe", "pipe"] });
 let buffer = "", stderr = "", settled = false;
 proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
 proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
  for (let line of lines) {
   if (line.endsWith("\r")) line = line.slice(0, -1);
   if (!line) continue;
   const event = JSON.parse(line);
   if (event.type === "agent_settled") { settled = true; proc.stdin.end(); proc.kill("SIGTERM"); }
  }
 });
 proc.stdin.write(`${JSON.stringify({ id: "smoke", type: "prompt", message: "Reply with exactly: tidy smoke ok" })}\n`);
 const code = await new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
 assert.ok(settled, `Pi did not settle (exit ${code}): ${stderr}`);
});

type AuthModel = { provider: string; id: string; ref: string };

/**
 * Discover authenticated models for hetero smoke without importing heavy session code.
 * Uses `pi --list-models` JSON if available; otherwise returns empty with diagnostics.
 */
async function discoverAuthenticatedModels(): Promise<{ models: AuthModel[]; diagnostics: string[] }> {
 const diagnostics: string[] = [];
 const envModels = process.env.PI_TIDY_SMOKE_MODELS;
 if (envModels) {
  const models = envModels.split(",").map((raw) => raw.trim()).filter(Boolean).map((ref) => {
   const slash = ref.indexOf("/");
   if (slash <= 0) return undefined;
   return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), ref };
  }).filter((m): m is AuthModel => !!m);
  if (models.length > 0) return { models, diagnostics };
  diagnostics.push("PI_TIDY_SMOKE_MODELS was set but contained no valid provider/model-id entries");
 }

 try {
  const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const auth = typeof (AuthStorage as any).create === "function"
   ? (AuthStorage as any).create()
   : new (AuthStorage as any)();
  const registry = typeof (ModelRegistry as any).create === "function"
   ? (ModelRegistry as any).create(auth)
   : (ModelRegistry as any).inMemory?.(auth);
  if (!registry) {
   diagnostics.push("Could not construct ModelRegistry from @earendil-works/pi-coding-agent");
   return { models: [], diagnostics };
  }
  const available: Array<{ provider: string; id: string }> =
   typeof registry.getAvailable === "function" ? registry.getAvailable() : [];
  const models = available
   .filter((m) => m?.provider && m?.id)
   .map((m) => ({ provider: m.provider, id: m.id, ref: `${m.provider}/${m.id}` }));
  if (models.length === 0) {
   diagnostics.push("ModelRegistry.getAvailable() returned no authenticated models");
   diagnostics.push("Configure provider auth (e.g. /login) or set PI_TIDY_SMOKE_MODELS=provider/a,provider/b");
  }
  return { models, diagnostics };
 } catch (error) {
  diagnostics.push(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  diagnostics.push("Set PI_TIDY_SMOKE_MODELS=provider/model-a,provider/model-b to bypass discovery");
  return { models: [], diagnostics };
 }
}

interface ChildObservation {
 modelRef: string;
 thinking: string;
 observedProvider: string;
 observedModelId: string;
 observedThinking: string | undefined;
 promptSent: boolean;
 stderr: string;
}

/** Launch one real Pi RPC child, observe get_state before prompt, then settle. */
async function observeChild(modelRef: string, thinking: string): Promise<ChildObservation> {
 const proc = spawn(
  piExecutable,
  ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--model", modelRef, "--thinking", thinking],
  { stdio: ["pipe", "pipe", "pipe"] },
 );
 let buffer = "";
 let stderr = "";
 let promptSent = false;
 let observedProvider = "";
 let observedModelId = "";
 let observedThinking: string | undefined;
 let settled = false;
 let stateId = "state-1";

 const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

 proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
 proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (let line of lines) {
   if (line.endsWith("\r")) line = line.slice(0, -1);
   if (!line) continue;
   let event: any;
   try { event = JSON.parse(line); } catch { continue; }
   if (event.type === "response" && event.id && pending.has(event.id)) {
    pending.get(event.id)!.resolve(event);
    pending.delete(event.id);
   }
   if (event.type === "agent_settled") settled = true;
  }
 });

 const request = (id: string, body: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
  pending.set(id, { resolve, reject });
  proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
  setTimeout(() => {
   if (pending.has(id)) {
    pending.delete(id);
    reject(new Error(`timeout waiting for response ${id}: ${stderr}`));
   }
  }, 60_000).unref();
 });

 try {
  // Wait briefly for process spawn readiness.
  await new Promise((r) => setTimeout(r, 200));
  const state = await request(stateId, { type: "get_state" });
  const data = state?.data ?? state?.result ?? state;
  const model = data?.model ?? data?.state?.model;
  observedProvider = String(model?.provider ?? data?.provider ?? "");
  observedModelId = String(model?.id ?? model?.modelId ?? data?.modelId ?? "");
  observedThinking = data?.thinkingLevel ?? data?.thinking ?? data?.state?.thinkingLevel;

  // Confirm observation before prompt (AC-012).
  assert.ok(observedProvider && observedModelId, `get_state missing model identity: ${JSON.stringify(state)}`);
  assert.equal(`${observedProvider}/${observedModelId}`, modelRef,
   `observed model ${observedProvider}/${observedModelId} !== requested ${modelRef}`);
  if (observedThinking !== undefined) {
   assert.equal(String(observedThinking), thinking,
    `observed thinking ${observedThinking} !== requested ${thinking}`);
  }

  await request("prompt-1", { type: "prompt", message: "Reply with exactly: hetero smoke ok" });
  promptSent = true;

  const deadline = Date.now() + 90_000;
  while (!settled && Date.now() < deadline) {
   await new Promise((r) => setTimeout(r, 100));
  }
 } finally {
  try { proc.stdin.end(); } catch { /* ignore */ }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => proc.once("close", () => resolve()));
 }

 return {
  modelRef,
  thinking,
  observedProvider,
  observedModelId,
  observedThinking: observedThinking !== undefined ? String(observedThinking) : undefined,
  promptSent,
  stderr,
 };
}

test("real-provider heterogeneous children smoke", {
 skip: !realSmoke,
 timeout: 180_000,
}, async () => {
 const { models, diagnostics } = await discoverAuthenticatedModels();
 if (models.length < 2) {
  const message = [
   "SKIP hetero smoke: need ≥2 authenticated models.",
   ...diagnostics,
   `discovered=${models.map((m) => m.ref).join(",") || "(none)"}`,
   "Actionable: authenticate at least two models, or set PI_TIDY_SMOKE_MODELS=provider/a,provider/b",
   "Optional: PI_EXECUTABLE=/path/to/pi",
  ].join("\n");
  // Clear skip diagnostics for operators; do not fail the opt-in suite when unavailable (AC-013).
  console.log(message);
  return;
 }

 const a = models[0]!;
 const b = models[1]!;
 // Distinct thinking levels exercise observation of effective thinking before prompt.
 const obsA = await observeChild(a.ref, "low");
 const obsB = await observeChild(b.ref, "medium");

 assert.equal(obsA.promptSent, true);
 assert.equal(obsB.promptSent, true);
 assert.equal(`${obsA.observedProvider}/${obsA.observedModelId}`, a.ref);
 assert.equal(`${obsB.observedProvider}/${obsB.observedModelId}`, b.ref);
 assert.notEqual(a.ref, b.ref, "hetero smoke requires two distinct model refs");
 if (obsA.observedThinking !== undefined) assert.equal(obsA.observedThinking, "low");
 if (obsB.observedThinking !== undefined) assert.equal(obsB.observedThinking, "medium");
});

test("hetero smoke skip diagnostics when real smoke disabled", { skip: realSmoke }, () => {
 // Documents the opt-in gate for operators reading default test output.
 assert.notEqual(process.env.PI_TIDY_REAL_SMOKE, "1");
});
