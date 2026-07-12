import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import extension, {
 buildDefaultRoutingConfig, buildEnvelope, CHILD_SKIP_DIAGNOSTIC, clearRoutingConfig, concurrencyCap,
 formatRoutingGuidance, inheritRuntimePlan, isChildRpcProcess, launchRuntime, listAuthenticatedModels,
 loadRoutingConfig, MODEL_FIELD_DESCRIPTION, parseExactModelRef, renderLines,
 resolveBatchRuntime, resolveTaskSelection, routingConfigPath, RuntimeResolutionError,
 saveRoutingConfig, Scheduler, STANDARD_TASK_CLASSES, THINKING_FIELD_DESCRIPTION,
} from "../index.js";
import { SnapshotComponent } from "../render.js";
import { buildChildArgs } from "../runner.js";

const here = dirname(fileURLToPath(import.meta.url));

type RegistryEntry = {
 provider: string;
 id: string;
 auth?: boolean;
 /** Defaults true so ordinary models support the standard thinking ladder. */
 reasoning?: boolean;
 thinkingLevelMap?: Partial<Record<string, string | null>>;
};

/** Injectable in-memory registry used by public-tool tests (zero network). */
function makeRegistry(entries: RegistryEntry[] = [
 { provider: "fake", id: "model-x" },
 { provider: "fake", id: "fast" },
 { provider: "fake", id: "deep/reasoner" },
 { provider: "other", id: "strong" },
 { provider: "other", id: "unauthed", auth: false },
 // Capability variants for thinking selection coverage.
 { provider: "fake", id: "non-reason", reasoning: false },
 { provider: "fake", id: "always-think", thinkingLevelMap: { off: null } },
 { provider: "fake", id: "sparse", thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" } },
 { provider: "fake", id: "max-only", thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: "max" } },
]) {
 const models = new Map(entries.map((e) => [`${e.provider}\0${e.id}`, e]));
 return {
  find(provider: string, modelId: string) {
   const hit = models.get(`${provider}\0${modelId}`);
   if (!hit) return undefined;
   return {
    provider: hit.provider,
    id: hit.id,
    reasoning: hit.reasoning !== false,
    thinkingLevelMap: hit.thinkingLevelMap,
   };
  },
  hasConfiguredAuth(model: { provider: string; id: string }) {
   const hit = models.get(`${model.provider}\0${model.id}`);
   return hit ? hit.auth !== false : false;
  },
 };
}

function register(registry = makeRegistry()) {
 let tool: any; const shutdown: any[] = []; const commands = new Map<string, any>();
 const pi = {
  registerTool(value: any) { tool = value; },
  registerCommand(name: string, options: any) { commands.set(name, options); },
  on(name: string, handler: any) { if (name === "session_shutdown") shutdown.push(handler); },
  getThinkingLevel: () => "medium",
  getActiveTools: () => ["read", "subagent", "mystery"],
 };
 // Parent registration must not be suppressed by a leaked child-process env from the agent host.
 const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
 delete process.env.PI_TIDY_SUBAGENT_CHILD;
 try { extension(pi as any); }
 finally {
  if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
 }
 return { tool, shutdown, registry, commands };
}
const context = (cwd: string, registry = makeRegistry()) => ({
 cwd, mode: "tui", model: { provider: "fake", id: "model-x" }, isProjectTrusted: () => true, modelRegistry: registry,
});
async function fixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
 const root = await mkdtemp(join(tmpdir(), "tidy-subagents-"));
 const old = {
  dir: process.env.PI_CODING_AGENT_DIR, exe: process.env.PI_TIDY_SUBAGENT_EXECUTABLE, args: process.env.PI_TIDY_SUBAGENT_ARGS,
  mismatch: process.env.PI_TIDY_FAKE_RPC_MISMATCH, malformed: process.env.PI_TIDY_FAKE_RPC_MALFORMED_STATE,
  stateErr: process.env.PI_TIDY_FAKE_RPC_STATE_ERROR, observed: process.env.PI_TIDY_FAKE_RPC_OBSERVED_MODEL,
  observedThinking: process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING,
 };
 process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath; process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([join(here, "fake-rpc.mjs")]);
 delete process.env.PI_TIDY_FAKE_RPC_MISMATCH;
 delete process.env.PI_TIDY_FAKE_RPC_MALFORMED_STATE;
 delete process.env.PI_TIDY_FAKE_RPC_STATE_ERROR;
 delete process.env.PI_TIDY_FAKE_RPC_OBSERVED_MODEL;
 delete process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING;
 try { return await fn(root); } finally {
  for (const [key, value] of [
   ["PI_CODING_AGENT_DIR", old.dir], ["PI_TIDY_SUBAGENT_EXECUTABLE", old.exe], ["PI_TIDY_SUBAGENT_ARGS", old.args],
   ["PI_TIDY_FAKE_RPC_MISMATCH", old.mismatch], ["PI_TIDY_FAKE_RPC_MALFORMED_STATE", old.malformed],
   ["PI_TIDY_FAKE_RPC_STATE_ERROR", old.stateErr], ["PI_TIDY_FAKE_RPC_OBSERVED_MODEL", old.observed],
   ["PI_TIDY_FAKE_RPC_OBSERVED_THINKING", old.observedThinking],
  ] as const) value === undefined ? delete process.env[key] : process.env[key] = value;
  await rm(root, { recursive: true, force: true });
 }
}

test("parseExactModelRef splits at the first separator", () => {
 assert.deepEqual(parseExactModelRef("fake/deep/reasoner"), { provider: "fake", modelId: "deep/reasoner" });
 assert.deepEqual(parseExactModelRef("other/strong"), { provider: "other", modelId: "strong" });
 assert.equal(parseExactModelRef("bare-id"), undefined);
 assert.equal(parseExactModelRef("/no-provider"), undefined);
 assert.equal(parseExactModelRef("provider/"), undefined);
 assert.equal(parseExactModelRef(""), undefined);
});

test("isChildRpcProcess requires both child env and --mode rpc", () => {
 assert.equal(isChildRpcProcess({}, ["node", "pi"]), false);
 assert.equal(isChildRpcProcess({ PI_TIDY_SUBAGENT_CHILD: "1" }, ["node", "pi"]), false);
 assert.equal(isChildRpcProcess({ PI_TIDY_SUBAGENT_CHILD: "1" }, ["node", "pi", "--mode", "json"]), false);
 assert.equal(isChildRpcProcess({}, ["node", "pi", "--mode", "rpc"]), false);
 assert.equal(isChildRpcProcess({ PI_TIDY_SUBAGENT_CHILD: "0" }, ["node", "pi", "--mode", "rpc"]), false);
 assert.equal(isChildRpcProcess({ PI_TIDY_SUBAGENT_CHILD: "1" }, ["node", "pi", "--mode", "rpc", "--no-session"]), true);
 assert.equal(isChildRpcProcess({ PI_TIDY_SUBAGENT_CHILD: "1" }, ["node", "/path/to/pi", "--no-session", "--mode", "rpc"]), true);
});

test("ambient PI_TIDY_SUBAGENT_CHILD alone still registers parent tool and routing command", () => {
 const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
 process.env.PI_TIDY_SUBAGENT_CHILD = "1";
 let tool: any;
 const commands = new Map<string, any>();
 const warnings: string[] = [];
 const originalWarn = console.warn;
 console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
 try {
  extension({
   registerTool(value: any) { tool = value; },
   registerCommand(name: string, options: any) { commands.set(name, options); },
   on() {},
   getThinkingLevel: () => "medium",
   getActiveTools: () => ["read"],
  } as any);
  assert.equal(tool?.name, "subagent");
  assert.ok(commands.has("tidy-subagents-routing"));
  assert.equal(process.env.PI_TIDY_SUBAGENT_CHILD, "1");
  assert.equal(warnings.length, 0);
 } finally {
  console.warn = originalWarn;
  if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
 }
});

test("true child RPC process skips registration and emits startup diagnostic", () => {
 const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
 const previousArgv = process.argv;
 process.env.PI_TIDY_SUBAGENT_CHILD = "1";
 process.argv = [...previousArgv, "--mode", "rpc", "--no-session"];
 let tool: any;
 const commands = new Map<string, any>();
 const warnings: string[] = [];
 const originalWarn = console.warn;
 console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
 try {
  extension({
   registerTool(value: any) { tool = value; },
   registerCommand(name: string, options: any) { commands.set(name, options); },
   on() {},
   getThinkingLevel: () => "medium",
   getActiveTools: () => ["read"],
  } as any);
  assert.equal(tool, undefined);
  assert.equal(commands.size, 0);
  assert.ok(warnings.some((line) => line.includes(CHILD_SKIP_DIAGNOSTIC)));
  // Clear ambient marker after intentional skip so non-RPC descendants are not poisoned.
  assert.equal(process.env.PI_TIDY_SUBAGENT_CHILD, undefined);
 } finally {
  console.warn = originalWarn;
  process.argv = previousArgv;
  if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
 }
});

test("two inherited children independently own equivalent runtime plans and launch from them", async () => fixture(async (root) => {
 const parent = { provider: "fake", modelId: "model-x", thinking: "medium" };
 const planA = inheritRuntimePlan(parent);
 const planB = inheritRuntimePlan(parent);
 assert.notEqual(planA, planB);
 assert.deepEqual(planA, planB);
 assert.deepEqual(planA, {
  provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium",
  provenance: "parent", thinkingProvenance: "parent", resolvedThinking: "medium",
 });
 const shared = { cwd: root, tools: ["read"], runDir: join(root, "run"), approved: true };
 const launchA = launchRuntime(planA, shared);
 const launchB = launchRuntime(planB, shared);
 assert.notEqual(launchA, launchB);
 assert.deepEqual(launchA, { ...shared, model: "fake/model-x", thinking: "medium" });
 assert.deepEqual(buildChildArgs(launchA), buildChildArgs(launchB));
 assert.deepEqual(buildChildArgs(launchA), ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/model-x", "--thinking", "medium", "--tools", "read"]);

 let thinkingReads = 0;
 let setModelCalls = 0;
 let setThinkingCalls = 0;
 let tool: any;
 const pi = {
  registerTool(value: any) { tool = value; },
  registerCommand() {},
  on() {},
  getThinkingLevel: () => { thinkingReads++; return "medium"; },
  getActiveTools: () => ["read", "subagent"],
  setModel() { setModelCalls++; },
  setThinkingLevel() { setThinkingCalls++; },
 };
 const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
 delete process.env.PI_TIDY_SUBAGENT_CHILD;
 try { extension(pi as any); }
 finally {
  if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
 }
 const result = await tool.execute("two-inherit", { agents: [
  { label: "left", reason: "inherit left", prompt: "first" },
  { label: "right", reason: "inherit right", prompt: "first" },
 ] }, undefined, undefined, context(root));
 const [left, right] = result.details.children;
 assert.equal(left.model, "model-x");
 assert.equal(right.model, "model-x");
 assert.equal(left.thinking, "medium");
 assert.equal(right.thinking, "medium");
 assert.deepEqual([left.status, right.status], ["completed", "completed"]);
 assert.ok(left.runtimePlan);
 assert.ok(right.runtimePlan);
 assert.notEqual(left.runtimePlan, right.runtimePlan);
 assert.equal(left.runtimePlan.provenance, "parent");
 assert.equal(right.runtimePlan.provenance, "parent");
 assert.deepEqual(left.runtimePlan.observed, { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium" });
 assert.deepEqual(right.runtimePlan.observed, { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium" });
 assert.equal(left.runtimePlan.thinkingProvenance, "parent");
 assert.equal(left.runtimePlan.resolvedThinking, "medium");
 assert.deepEqual(buildChildArgs(launchRuntime(left.runtimePlan, { cwd: root, tools: result.details.runtime.activeTools, runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/model-x", "--thinking", "medium", "--tools", "read"]);
 assert.deepEqual(result.details.runtime, {
  provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium", activeTools: ["read"], projectTrusted: true,
 });
 // Schema v2 manifests retain parent runtime + per-child model provenance.
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.equal(run.schemaVersion, 2);
 assert.deepEqual(run.runtime, result.details.runtime);
 for (const child of run.children) {
  assert.ok(child.runtimePlan);
  assert.equal(child.runtimePlan.provenance, "parent");
  assert.deepEqual(child.runtimePlan.observed, { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium" });
  assert.equal(child.runtimePlan.thinkingProvenance, "parent");
  assert.equal(child.runtimePlan.resolvedThinking, "medium");
  assert.equal(child.model, "model-x");
  assert.equal(child.thinking, "medium");
 }
 const rendered = renderLines(result.details).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(rendered[0], /🤖 left\[model-x\|medium\] inherit left/);
 assert.match(rendered.find((line: string) => line.includes("right")) ?? "", /🤖 right\[model-x\|medium\] inherit right/);
 assert.ok(thinkingReads >= 1);
 assert.equal(setModelCalls, 0);
 assert.equal(setThinkingCalls, 0);
 // State is observed before the prompt is sent.
 const events = (await readFile(join(result.details.runDir, "child-001.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
 const stateIdx = events.findIndex((e: any) => e.payload?.command === "get_state");
 const promptIdx = events.findIndex((e: any) => e.payload?.command === "prompt");
 assert.ok(stateIdx >= 0, "expected get_state response event");
 assert.ok(promptIdx >= 0, "expected prompt response event");
 assert.ok(stateIdx < promptIdx, "get_state must be observed before prompt");
}));

test("optional exact model selection, heterogeneous siblings, and schema v2 provenance", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("hetero", { agents: [
  { label: "inherit", reason: "keep parent", prompt: "first" },
  { label: "fast", reason: "bounded lookup", prompt: "first", model: "fake/fast" },
  { label: "nested", reason: "model id with slash", prompt: "first", model: "fake/deep/reasoner" },
  { label: "other", reason: "cross provider", prompt: "first", model: "other/strong" },
 ] }, undefined, undefined, context(root));
 assert.equal(result.details.schemaVersion, 2);
 const [inherit, fast, nested, other] = result.details.children;
 assert.deepEqual([inherit.status, fast.status, nested.status, other.status], ["completed", "completed", "completed", "completed"]);
 assert.equal(inherit.runtimePlan.provenance, "parent");
 assert.equal(inherit.runtimePlan.requestedModel, undefined);
 assert.equal(fast.runtimePlan.provenance, "request");
 assert.equal(fast.runtimePlan.requestedModel, "fake/fast");
 assert.equal(fast.runtimePlan.model, "fake/fast");
 assert.equal(nested.runtimePlan.model, "fake/deep/reasoner");
 assert.equal(nested.runtimePlan.modelId, "deep/reasoner");
 assert.equal(other.runtimePlan.model, "other/strong");
 // Observed identities match resolved selections and feed compact rendering.
 assert.equal(inherit.model, "model-x");
 assert.equal(fast.model, "fast");
 assert.equal(nested.model, "deep/reasoner");
 assert.equal(other.model, "strong");
 assert.deepEqual(fast.runtimePlan.observed, { provider: "fake", modelId: "fast", model: "fake/fast", thinking: "medium" });
 assert.deepEqual(nested.runtimePlan.observed, { provider: "fake", modelId: "deep/reasoner", model: "fake/deep/reasoner", thinking: "medium" });
 assert.equal(fast.runtimePlan.thinkingProvenance, "parent");
 assert.equal(fast.runtimePlan.resolvedThinking, "medium");
 // Launch args are heterogeneous while order is preserved.
 assert.deepEqual(buildChildArgs(launchRuntime(fast.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/fast", "--thinking", "medium", "--tools", "read"]);
 assert.deepEqual(buildChildArgs(launchRuntime(nested.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/deep/reasoner", "--thinking", "medium", "--tools", "read"]);
 const rendered = renderLines(result.details).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(rendered.find((l: string) => l.includes("inherit")) ?? "", /🤖 inherit\[model-x\|medium\]/);
 assert.match(rendered.find((l: string) => l.includes("fast")) ?? "", /🤖 fast\[fast\|medium\]/);
 assert.match(rendered.find((l: string) => l.includes("nested")) ?? "", /🤖 nested\[deep\/reasoner\|medium\]/);
 assert.match(rendered.find((l: string) => l.includes("other")) ?? "", /🤖 other\[strong\|medium\]/);
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.equal(run.schemaVersion, 2);
 assert.deepEqual(run.runtime, result.details.runtime);
 assert.equal(run.children[1].runtimePlan.requestedModel, "fake/fast");
 assert.deepEqual(run.children[1].runtimePlan.observed, { provider: "fake", modelId: "fast", model: "fake/fast", thinking: "medium" });
 assert.equal(run.children[2].runtimePlan.modelId, "deep/reasoner");
 // Shared lifecycle: thinking still inherited, tools/cwd shared at run level.
 for (const child of result.details.children) assert.equal(child.thinking, "medium");
 assert.deepEqual(result.details.runtime.activeTools, ["read", "mystery"]);
}));

test("invalid child models fail atomic preflight with diagnostics and no artifacts", async () => fixture(async (root) => {
 const { tool } = register();
 const agentDir = join(root, "agent", "pi-tidy-subagents", "runs");
 const cases: Array<{ agents: any[]; match: RegExp }> = [
  {
   agents: [
    { label: "ok", reason: "fine", prompt: "first", model: "fake/fast" },
    { label: "bad", reason: "typo", prompt: "first", model: "fake/missing" },
   ],
   match: /child\[1\] label="bad" model="fake\/missing".*unknown model/,
  },
  {
   agents: [{ label: "fuzzy", reason: "no provider", prompt: "first", model: "fast" }],
   match: /child\[0\] label="fuzzy" model="fast".*exact registered provider\/model-id/,
  },
  {
   agents: [{ label: "alias", reason: "alias form", prompt: "first", model: "profile:fast" }],
   match: /child\[0\] label="alias" model="profile:fast"/,
  },
  {
   agents: [{ label: "auth", reason: "no auth", prompt: "first", model: "other/unauthed" }],
   match: /child\[0\] label="auth" model="other\/unauthed".*no configured authentication/,
  },
 ];
 for (const testCase of cases) {
  await assert.rejects(
   () => tool.execute("preflight", { agents: testCase.agents }, undefined, undefined, context(root)),
   (error: unknown) => {
    assert.ok(error instanceof RuntimeResolutionError || (error instanceof Error && testCase.match.test(error.message)));
    assert.match(error instanceof Error ? error.message : String(error), testCase.match);
    return true;
   },
  );
 }
 // No partial run artifacts under the agent dir.
 try {
  await access(agentDir);
  const runs = await readdir(agentDir);
  assert.equal(runs.length, 0, `expected no run artifacts, found ${runs.join(",")}`);
 } catch (error: any) {
  assert.equal(error?.code, "ENOENT");
 }
}));

test("startup model mismatch and malformed state fail the child before prompting", async () => fixture(async (root) => {
 // Mismatch via env override on the fake RPC.
 process.env.PI_TIDY_FAKE_RPC_MISMATCH = "1";
 const { tool } = register();
 const mismatch = await tool.execute("mismatch", { agents: [
  { label: "left", reason: "should fail startup", prompt: "first" },
  { label: "right", reason: "also mismatch", prompt: "first" },
 ] }, undefined, undefined, context(root));
 assert.deepEqual(mismatch.details.children.map((c: any) => c.status), ["failed", "failed"]);
 for (const child of mismatch.details.children) {
  assert.match(child.error, /startup model mismatch/);
  const events = (await readFile(join(mismatch.details.runDir, `${child.id}.jsonl`), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((e: any) => e.payload?.command === "get_state"));
  assert.equal(events.some((e: any) => e.payload?.command === "prompt"), false, "prompt must not be sent on mismatch");
 }
 delete process.env.PI_TIDY_FAKE_RPC_MISMATCH;

 process.env.PI_TIDY_FAKE_RPC_MALFORMED_STATE = "1";
 const { tool: tool2 } = register();
 const malformed = await tool2.execute("malformed", { agents: [{ label: "m", reason: "bad state", prompt: "first" }] }, undefined, undefined, context(root));
 assert.equal(malformed.details.children[0].status, "failed");
 assert.match(malformed.details.children[0].error, /missing model provider\/id/);
 const malEvents = (await readFile(join(malformed.details.runDir, "child-001.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
 assert.equal(malEvents.some((e: any) => e.payload?.command === "prompt"), false);
 delete process.env.PI_TIDY_FAKE_RPC_MALFORMED_STATE;
}));

test("post-preflight provider failure remains isolated under all-settled", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("isolate", { agents: [
  { label: "ok", reason: "succeed", prompt: "first", model: "fake/fast" },
  { label: "boom", reason: "provider crash", prompt: "crash", model: "other/strong" },
  { label: "also", reason: "still works", prompt: "first" },
 ] }, undefined, undefined, context(root));
 assert.deepEqual(result.details.children.map((c: any) => c.status), ["completed", "failed", "completed"]);
 assert.equal(result.details.children[0].model, "fast");
 assert.equal(result.details.children[2].model, "model-x");
 assert.match(result.content[0].text, /status="completed"/);
 assert.match(result.content[0].text, /status="failed"/);
}));

test("resolveBatchRuntime rejects fuzzy and unknown models with child diagnostics", () => {
 const registry = makeRegistry();
 const parent = { provider: "fake", modelId: "model-x", thinking: "high" };
 assert.deepEqual(
  resolveBatchRuntime([{ label: "a" }, { label: "b", model: "fake/fast" }], parent, registry).map((p) => p.model),
  ["fake/model-x", "fake/fast"],
 );
 assert.throws(
  () => resolveBatchRuntime([{ label: "x", model: "nope" }, { label: "y", model: "fake/missing" }], parent, registry),
  (error: unknown) => {
   assert.ok(error instanceof RuntimeResolutionError);
   assert.equal(error.diagnostics.length, 2);
   assert.equal(error.diagnostics[0]!.index, 0);
   assert.equal(error.diagnostics[0]!.requestedModel, "nope");
   assert.equal(error.diagnostics[1]!.requestedModel, "fake/missing");
   return true;
  },
 );
});

test("thinking-only override, combined model/thinking, and heterogeneous thinking siblings", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("think-mix", { agents: [
  { label: "inherit", reason: "keep parent thinking", prompt: "first" },
  { label: "low", reason: "thinking only", prompt: "first", thinking: "low" },
  { label: "both", reason: "model and thinking", prompt: "first", model: "fake/fast", thinking: "high" },
  { label: "nested", reason: "slash model high", prompt: "first", model: "fake/deep/reasoner", thinking: "minimal" },
 ] }, undefined, undefined, context(root));
 assert.deepEqual(result.details.children.map((c: any) => c.status), ["completed", "completed", "completed", "completed"]);
 const [inherit, low, both, nested] = result.details.children;
 assert.equal(inherit.thinking, "medium");
 assert.equal(inherit.runtimePlan.thinkingProvenance, "parent");
 assert.equal(inherit.runtimePlan.requestedThinking, undefined);
 assert.equal(inherit.runtimePlan.resolvedThinking, "medium");
 assert.equal(low.thinking, "low");
 assert.equal(low.model, "model-x");
 assert.equal(low.runtimePlan.thinkingProvenance, "request");
 assert.equal(low.runtimePlan.requestedThinking, "low");
 assert.equal(low.runtimePlan.resolvedThinking, "low");
 assert.equal(low.runtimePlan.provenance, "parent");
 assert.equal(both.thinking, "high");
 assert.equal(both.model, "fast");
 assert.equal(both.runtimePlan.provenance, "request");
 assert.equal(both.runtimePlan.thinkingProvenance, "request");
 assert.equal(both.runtimePlan.requestedModel, "fake/fast");
 assert.equal(both.runtimePlan.requestedThinking, "high");
 assert.equal(nested.thinking, "minimal");
 assert.equal(nested.model, "deep/reasoner");
 // Launch args carry each child's resolved thinking.
 assert.deepEqual(buildChildArgs(launchRuntime(low.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/model-x", "--thinking", "low", "--tools", "read"]);
 assert.deepEqual(buildChildArgs(launchRuntime(both.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/fast", "--thinking", "high", "--tools", "read"]);
 // Compact identity shows effective thinking as [model|thinking] only.
 const plain = renderLines(result.details).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(plain.find((l: string) => l.includes("inherit[")) ?? "", /🤖 inherit\[model-x\|medium\]/);
 assert.match(plain.find((l: string) => l.includes("low[")) ?? "", /🤖 low\[model-x\|low\]/);
 assert.match(plain.find((l: string) => l.includes("both[")) ?? "", /🤖 both\[fast\|high\]/);
 for (const line of plain.filter((l: string) => l.includes("🤖"))) {
  assert.doesNotMatch(line, /🤖 \w+\[[^\]]*(clamp|adjust)/i);
 }
 // Manifest distinguishes requested/resolved/observed thinking and provenance.
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.equal(run.children[1].runtimePlan.requestedThinking, "low");
 assert.equal(run.children[1].runtimePlan.resolvedThinking, "low");
 assert.equal(run.children[1].runtimePlan.thinking, "low");
 assert.equal(run.children[1].runtimePlan.thinkingProvenance, "request");
 assert.equal(run.children[1].runtimePlan.observed.thinking, "low");
 assert.equal(run.children[2].runtimePlan.requestedThinking, "high");
 assert.equal(run.children[2].runtimePlan.observed.thinking, "high");
}));

test("inherited thinking clamps for sparse, always-thinking, and non-reasoning models", async () => fixture(async (root) => {
 const { tool } = register();
 // Parent thinking is "medium". Capability models adjust inheritance rather than reject.
 const result = await tool.execute("inherit-clamp", { agents: [
  { label: "sparse-high", reason: "sparse map keeps high", prompt: "first", model: "fake/sparse", thinking: "high" },
  { label: "sparse-inherit", reason: "sparse inherits medium", prompt: "first", model: "fake/sparse" },
  { label: "always", reason: "cannot disable thinking", prompt: "first", model: "fake/always-think" },
  { label: "plain", reason: "non-reasoning off", prompt: "first", model: "fake/non-reason" },
 ] }, undefined, undefined, context(root));
 // Explicit high is supported on sparse (standard levels except null-mapped).
 assert.equal(result.details.children[0].status, "completed");
 assert.equal(result.details.children[0].thinking, "high");
 assert.equal(result.details.children[0].runtimePlan.thinkingProvenance, "request");
 // Inherited medium is supported on sparse (off/minimal null, medium available).
 assert.equal(result.details.children[1].thinking, "medium");
 assert.equal(result.details.children[1].runtimePlan.thinkingProvenance, "parent");
 assert.equal(result.details.children[1].runtimePlan.thinkingAdjustment, undefined);
 // always-think has off:null; parent medium is still supported so no clamp needed.
 // Force a clamp case: parent high against a model that only has max beyond medium...
 // For always-think with parent medium: medium is supported → no adjustment.
 assert.equal(result.details.children[2].thinking, "medium");
 // Non-reasoning inherits → effective off with adjustment metadata.
 const plain = result.details.children[3];
 assert.equal(plain.status, "completed");
 assert.equal(plain.thinking, "off");
 assert.equal(plain.runtimePlan.resolvedThinking, "off");
 assert.equal(plain.runtimePlan.thinkingProvenance, "parent");
 assert.deepEqual(plain.runtimePlan.thinkingAdjustment, { from: "medium", to: "off", reason: "non-reasoning" });
 assert.equal(plain.runtimePlan.observed.thinking, "off");
 assert.deepEqual(buildChildArgs(launchRuntime(plain.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/non-reason", "--thinking", "off", "--tools", "read"]);
 // Compact shows effective off; identity has no adjustment annotation beyond [model|thinking].
 const rendered = renderLines(result.details).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 const plainHeader = rendered.find((l: string) => l.includes("plain[")) ?? "";
 assert.match(plainHeader, /🤖 plain\[non-reason\|off\]/);
 assert.doesNotMatch(plainHeader, /\[non-reason\|off\|/); // no extra clamp tokens in the identity bracket
 // Manifest retains adjustment diagnostics.
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.deepEqual(run.children[3].runtimePlan.thinkingAdjustment, { from: "medium", to: "off", reason: "non-reasoning" });
 assert.equal(run.children[3].runtimePlan.resolvedThinking, "off");
 assert.equal(run.children[3].thinking, "off");
}));

test("inherited clamp when parent level is unsupported by sparse or always-thinking maps", async () => fixture(async (root) => {
 // Parent thinking "off": sparse and always-think both null-map off → clamp upward.
 let tool: any;
 const pi = {
  registerTool(value: any) { tool = value; },
  registerCommand() {},
  on() {},
  getThinkingLevel: () => "off",
  getActiveTools: () => ["read", "subagent"],
 };
 const previousChild = process.env.PI_TIDY_SUBAGENT_CHILD;
 delete process.env.PI_TIDY_SUBAGENT_CHILD;
 try { extension(pi as any); }
 finally {
  if (previousChild === undefined) delete process.env.PI_TIDY_SUBAGENT_CHILD;
  else process.env.PI_TIDY_SUBAGENT_CHILD = previousChild;
 }
 const result = await tool.execute("sparse-clamp", { agents: [
  { label: "sparse", reason: "clamp off up", prompt: "first", model: "fake/sparse" },
  { label: "always", reason: "cannot disable", prompt: "first", model: "fake/always-think" },
 ] }, undefined, undefined, { ...context(root), model: { provider: "fake", id: "model-x" } });
 // sparse: off+minimal null → clamp off → low
 const sparse = result.details.children[0];
 assert.equal(sparse.status, "completed");
 assert.equal(sparse.thinking, "low");
 assert.equal(sparse.runtimePlan.resolvedThinking, "low");
 assert.equal(sparse.runtimePlan.thinkingProvenance, "parent");
 assert.deepEqual(sparse.runtimePlan.thinkingAdjustment, { from: "off", to: "low", reason: "inherited-clamp" });
 // always-think: off null → clamp to minimal
 const always = result.details.children[1];
 assert.equal(always.status, "completed");
 assert.equal(always.thinking, "minimal");
 assert.equal(always.runtimePlan.resolvedThinking, "minimal");
 assert.deepEqual(always.runtimePlan.thinkingAdjustment, { from: "off", to: "minimal", reason: "inherited-clamp" });
 assert.deepEqual(buildChildArgs(launchRuntime(always.runtimePlan, { cwd: root, tools: ["read"], runDir: result.details.runDir, approved: true })),
  ["--mode", "rpc", "--no-session", "--approve", "--model", "fake/always-think", "--thinking", "minimal", "--tools", "read"]);
}));

test("explicit unsupported thinking fails atomic preflight with alternatives and no artifacts", async () => fixture(async (root) => {
 const { tool } = register();
 const agentDir = join(root, "agent", "pi-tidy-subagents", "runs");
 const cases: Array<{ agents: any[]; match: RegExp }> = [
  {
   agents: [
    { label: "ok", reason: "fine", prompt: "first", thinking: "low" },
    { label: "bad", reason: "unsupported", prompt: "first", model: "fake/non-reason", thinking: "high" },
   ],
   match: /child\[1\] label="bad".*thinking="high".*not supported by "fake\/non-reason".*supported: off/,
  },
  {
   agents: [{ label: "xhigh", reason: "no xhigh map", prompt: "first", model: "fake/fast", thinking: "xhigh" }],
   match: /child\[0\] label="xhigh".*thinking="xhigh".*not supported by "fake\/fast".*supported:/,
  },
  {
   agents: [{ label: "off-always", reason: "cannot disable", prompt: "first", model: "fake/always-think", thinking: "off" }],
   match: /child\[0\] label="off-always".*thinking="off".*not supported by "fake\/always-think".*supported: minimal/,
  },
  {
   agents: [{ label: "vocab", reason: "bad token", prompt: "first", thinking: "turbo" }],
   match: /thinking must be one of Pi's native levels/,
  },
 ];
 for (const testCase of cases) {
  await assert.rejects(
   () => tool.execute("think-preflight", { agents: testCase.agents }, undefined, undefined, context(root)),
   (error: unknown) => {
    assert.ok(error instanceof RuntimeResolutionError || (error instanceof Error && testCase.match.test(error.message)));
    assert.match(error instanceof Error ? error.message : String(error), testCase.match);
    return true;
   },
  );
 }
 // Atomic: healthy sibling never launched; no partial run artifacts.
 try {
  await access(agentDir);
  const runs = await readdir(agentDir);
  assert.equal(runs.length, 0, `expected no run artifacts, found ${runs.join(",")}`);
 } catch (error: any) {
  assert.equal(error?.code, "ENOENT");
 }
 // Direct resolveBatchRuntime surfaces supported alternatives on the diagnostic.
 assert.throws(
  () => resolveBatchRuntime(
   [{ label: "n", model: "fake/non-reason", thinking: "medium" }],
   { provider: "fake", modelId: "model-x", thinking: "medium" },
   makeRegistry(),
  ),
  (error: unknown) => {
   assert.ok(error instanceof RuntimeResolutionError);
   assert.equal(error.diagnostics[0]!.requestedThinking, "medium");
   assert.match(error.diagnostics[0]!.message, /supported: off/);
   return true;
  },
 );
}));

test("observed thinking becomes effective truth and records adjustment when it differs", async () => fixture(async (root) => {
 process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING = "low";
 const { tool } = register();
 const result = await tool.execute("observe-think", { agents: [
  { label: "adj", reason: "observed differs", prompt: "first", thinking: "high" },
 ] }, undefined, undefined, context(root));
 const child = result.details.children[0];
 assert.equal(child.status, "completed");
 // Resolved was high (explicit request); observed low becomes effective display/persist truth.
 assert.equal(child.runtimePlan.requestedThinking, "high");
 assert.equal(child.runtimePlan.resolvedThinking, "high");
 assert.equal(child.thinking, "low");
 assert.equal(child.runtimePlan.thinking, "low");
 assert.equal(child.runtimePlan.observed.thinking, "low");
 assert.deepEqual(child.runtimePlan.thinkingAdjustment, { from: "high", to: "low", reason: "observed" });
 const plain = renderLines(result.details).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(plain[0], /🤖 adj\[model-x\|low\]/);
 // Compact identity is only [model|thinking] — no adjustment annotation in the bracket.
 assert.match(plain[0], /🤖 adj\[model-x\|low\] /);
 assert.doesNotMatch(plain[0], /🤖 adj\[[^\]]*(clamp|adjust|from)/i);
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.equal(run.children[0].runtimePlan.thinking, "low");
 assert.equal(run.children[0].runtimePlan.resolvedThinking, "high");
 assert.equal(run.children[0].runtimePlan.requestedThinking, "high");
 assert.deepEqual(run.children[0].runtimePlan.thinkingAdjustment, { from: "high", to: "low", reason: "observed" });
 // State still precedes prompt.
 const events = (await readFile(join(result.details.runDir, "child-001.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
 const stateIdx = events.findIndex((e: any) => e.payload?.command === "get_state");
 const promptIdx = events.findIndex((e: any) => e.payload?.command === "prompt");
 assert.ok(stateIdx >= 0 && promptIdx > stateIdx);
 delete process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING;
}));

test("public tool runs ordered all-settled fanout and persists full truth", async () => fixture(async (root) => {
 const { tool } = register(); const snapshots: any[] = [];
 assert.ok(tool.parameters.properties.agents);
 const agentProps = tool.parameters.properties.agents.items.properties;
 assert.deepEqual(Object.keys(agentProps).sort(), ["label", "model", "prompt", "reason", "thinking"]);
 const result = await tool.execute("call-1", { agents: [
  { label: "alpha", reason: "inspect alpha", prompt: "first" },
  { reason: "inspect empty", prompt: "empty" },
  { label: "bad", reason: "test failure", prompt: "crash" },
 ] }, undefined, (update: any) => snapshots.push(update.details), context(root));
 assert.deepEqual(result.details.children.map((c: any) => c.status), ["completed", "warning", "failed"]);
 assert.match(result.content[0].text, /index="0" label="alpha" status="completed"/);
 assert.ok(result.content[0].text.indexOf("first") < result.content[0].text.indexOf("status=\"warning\""));
 assert.match(result.content[0].text, /]]]]><!\[CDATA\[>/);
 const child = result.details.children[0];
 assert.deepEqual({ input: child.input, output: child.output, cacheRead: child.cacheRead, cacheWrite: child.cacheWrite, providerTraffic: child.providerTraffic, tokens: child.tokens }, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, providerTraffic: 14, tokens: 14 }); assert.equal(child.toolCount, 2);
 assert.equal(child.prompt, ""); assert.equal(child.response, ""); assert.equal("events" in child, false); assert.ok(child.activities.length <= 15);
 assert.deepEqual(child.activities.slice(0, 2), ["working fragments", "next line"]);
 const activityText = child.activities.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
 assert.match(activityText, /✓ 📖 read/); assert.match(activityText, /a\.ts → 1 lines/); assert.doesNotMatch(activityText, /RAW OMIT/);
 const rendered = renderLines(result.details, false).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(rendered[0], /┊ ✓ 🤖 alpha\[model-x\|medium\] inspect alpha/);
 assert.match(rendered[1], /┊   → 2 tools · ↑2 ↓3/);
 assert.deepEqual(rendered.slice(2, 4).map((line) => line.replace(/^\s*┊\s+/, "")), ["# Result", "first ]]> kept"]);
 const run = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 assert.equal(run.schemaVersion, 2); assert.equal(run.cwd, root); assert.equal(run.children.length, 3);
 assert.deepEqual(run.runtime, { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "medium", activeTools: ["read", "mystery"], projectTrusted: true });
 assert.deepEqual(result.details.runtime, run.runtime);
 const events = (await readFile(join(result.details.runDir, "child-001.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
 assert.ok(events.every((event: any, index: number) => event.schemaVersion === 1 && event.sequence === index + 1));
 assert.equal(await readFile(join(result.details.runDir, "child-001.md"), "utf8"), "# Result\n\nfirst ]]> kept");
 assert.ok(snapshots.length >= 4); assert.match(result.details.runDir, /pi-tidy-subagents\/runs\//);
}));

test("provider usage stays exact in details and artifacts while headers stay directional", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("usage", { agents: [{ label: "metered", reason: "measure provider traffic", prompt: "usage" }] }, undefined, undefined, context(root));
 const child = result.details.children[0];
 assert.deepEqual(
  { input: child.input, output: child.output, cacheRead: child.cacheRead, cacheWrite: child.cacheWrite, providerTraffic: child.providerTraffic, tokens: child.tokens },
  { input: 3_500_000, output: 169_000, cacheRead: 33_000, cacheWrite: 5_000, providerTraffic: 3_707_000, tokens: 3_707_000 },
 );
 const header = renderLines(result.details)[1].replace(/\x1b\[[0-9;]*m/g, "");
 assert.match(header, /↑3\.5M ↓169k/);
 assert.doesNotMatch(header, /tok|3\.7M/);
 const persisted = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8")).children[0];
 assert.deepEqual(
  { input: persisted.input, output: persisted.output, cacheRead: persisted.cacheRead, cacheWrite: persisted.cacheWrite, providerTraffic: persisted.providerTraffic, tokens: persisted.tokens },
  { input: 3_500_000, output: 169_000, cacheRead: 33_000, cacheWrite: 5_000, providerTraffic: 3_707_000, tokens: 3_707_000 },
 );
}));

test("public execution works in print JSON and RPC parent modes", async () => fixture(async (root) => {
 for (const mode of ["print", "json", "rpc"]) {
  const { tool } = register();
  const result = await tool.execute(`mode-${mode}`, { agents: [{ reason: `exercise ${mode}`, prompt: mode }] }, undefined, undefined, { ...context(root), mode });
  assert.equal(result.details.children[0].status, "completed");
  assert.match(result.content[0].text, new RegExp(`<subagent_result[^>]+status="completed"`));
 }
}));

test("pre-aborted calls persist not-started truth without launching children", async () => fixture(async (root) => {
 const { tool } = register(); const controller = new AbortController(); controller.abort();
 const result = await tool.execute("pre-abort", { agents: [{ reason: "never start", prompt: "first" }] }, controller.signal, undefined, context(root));
 assert.equal(result.details.children[0].status, "not-started");
 assert.equal(result.details.children[0].eventCount, 0);
 assert.equal(await readFile(join(result.details.runDir, "child-001.jsonl"), "utf8"), "");
}));

test("simultaneous public calls share the session-wide admission cap", async () => fixture(async (root) => {
 const { tool } = register(); const cap = concurrencyCap(); const total = cap + 2;
 const left = Math.ceil(total / 2); const requests = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ reason: `${prefix} ${index}`, prompt: "hang" }));
 const aController = new AbortController(), bController = new AbortController(); let aDetails: any, bDetails: any;
 const a = tool.execute("shared-a", { agents: requests(left, "left") }, aController.signal, (update: any) => { aDetails = update.details; }, context(root));
 const b = tool.execute("shared-b", { agents: requests(total - left, "right") }, bController.signal, (update: any) => { bDetails = update.details; }, context(root));
 const deadline = Date.now() + 5_000;
 while (Date.now() < deadline) {
  const children = [...(aDetails?.children ?? []), ...(bDetails?.children ?? [])];
  if (children.filter((child: any) => child.status === "running").length === cap && children.filter((child: any) => child.status === "queued").length === 2) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
 }
 const children = [...(aDetails?.children ?? []), ...(bDetails?.children ?? [])];
 assert.equal(children.filter((child: any) => child.status === "running").length, cap);
 assert.equal(children.filter((child: any) => child.status === "queued").length, 2);
 aController.abort(); bController.abort(); await Promise.all([a, b]);
}));

test("public cancellation stops a persistent child and preserves cancelled artifacts", async () => fixture(async (root) => {
 const { tool } = register(); const controller = new AbortController();
 const pending = tool.execute("call-abort", { agents: [{ reason: "wait forever", prompt: "hang" }, { reason: "stay queued", prompt: "hang" }] }, controller.signal, undefined, context(root));
 setTimeout(() => controller.abort(), 50);
 const result = await pending;
 assert.ok(result.details.children.every((child: any) => ["cancelled", "not-started"].includes(child.status)));
 assert.match(result.content[0].text, /status="cancelled"|status="not-started"/);
 const manifest = JSON.parse(await readFile(join(result.details.runDir, "run.json"), "utf8"));
 for (const child of manifest.children) {
  assert.equal(typeof await readFile(join(result.details.runDir, child.eventPath), "utf8"), "string");
  assert.equal(typeof await readFile(child.artifactPath, "utf8"), "string");
 }
}));

test("session shutdown aborts active children", async () => fixture(async (root) => {
 const { tool, shutdown } = register();
 const pending = tool.execute("shutdown", { agents: [{ reason: "wait forever", prompt: "hang" }] }, undefined, undefined, context(root));
 setTimeout(() => shutdown[0](), 30);
 const result = await pending; assert.equal(result.details.children[0].status, "cancelled");
}));

test("routine streaming is capped at 10Hz and lifecycle snapshots flush", async () => fixture(async (root) => {
 const { tool } = register(); let updates = 0;
 const result = await tool.execute("stream", { agents: [{ reason: "stream progress", prompt: "stream" }] }, undefined, () => updates++, context(root));
 assert.equal(result.details.children[0].status, "completed");
 assert.ok(updates >= 5, `expected lifecycle and coalesced updates, got ${updates}`);
 assert.ok(updates <= 9, `40 deltas flooded ${updates} updates`);
}));

test("silent running children do not emit timer-only updates", async () => fixture(async (root) => {
 const { tool } = register(); const controller = new AbortController(); let runningUpdates = 0;
 const pending = tool.execute("elapsed", { agents: [{ reason: "observe elapsed", prompt: "hang" }] }, controller.signal, (update: any) => {
  if (update.details.children[0].status === "running") runningUpdates++;
 }, context(root));
 setTimeout(() => controller.abort(), 1150);
 await pending;
 // running + post-get_state observation may each emit once; hang must not flood timer-only updates.
 assert.ok(runningUpdates >= 1 && runningUpdates <= 2, `expected 1-2 running updates, got ${runningUpdates}`);
}));

test("child exit terminalizes an active tool immediately and after transcript reload", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("tool-crash", { agents: [{ reason: "crash during a tool", prompt: "tool-crash" }] }, undefined, undefined, context(root));
 const child = result.details.children[0];
 assert.equal(child.status, "failed");
 assert.deepEqual(child.activeTools, []);
 assert.match(child.activities.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /✗ .*bash crash the parent process\n  kill -9 \$PPID → error in/);
 assert.doesNotMatch(child.activities.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /running/);
 const renderNow = child.endedAt + 30_000;
 for (const expanded of [false, true]) {
  const immediate = renderLines(result.details, expanded, renderNow).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const restored = renderLines(JSON.parse(JSON.stringify(result.details)), expanded, renderNow).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(immediate, /✗ .*bash crash the parent process/);
  assert.doesNotMatch(immediate, /running/);
  assert.equal(restored, immediate);
 }
}));

test("terminal child rendering defensively interrupts stale active tools", () => {
 const base: any = { index: 0, id: "stale", label: "failed", reason: "resume failed child", prompt: "", model: "m", thinking: "off", toolCount: 1, input: 0, output: 0, activities: ["\x1b[2m·\x1b[0m bash crash parent", "  \x1b[2mkill -9 $PPID\x1b[0m \x1b[2m→\x1b[0m \x1b[2mrunning\x1b[0m"], activeTools: [{ id: "tool", name: "bash", activityIndex: 0 }], eventCount: 1, startedAt: 1_000, endedAt: 2_000, response: "", error: "exited", artifactPath: "/stale" };
 for (const status of ["failed", "cancelled", "warning", "completed"] as const) for (const expanded of [false, true]) for (const retainsMetadata of [true, false]) {
  const child = { ...base, status, ...(retainsMetadata ? {} : { activeTools: undefined }) };
  const plain = renderLines({ children: [child] } as any, expanded, 3_000, 120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /✗ bash crash parent/);
  assert.match(plain, /→ interrupted/);
  assert.doesNotMatch(plain, /running/);
 }
});

test("rejected RPC prompt settles as a child failure", async () => fixture(async (root) => {
 const { tool } = register();
 const result = await tool.execute("rejected", { agents: [{ reason: "test rejection", prompt: "reject" }] }, undefined, undefined, context(root));
 assert.equal(result.details.children[0].status, "failed");
 assert.equal(result.details.children[0].error, "prompt rejected");
}));

test("unavailable RPC executable is an infrastructure exception", async () => fixture(async (root) => {
 process.env.PI_TIDY_SUBAGENT_EXECUTABLE = join(root, "missing-pi"); delete process.env.PI_TIDY_SUBAGENT_ARGS;
 const { tool } = register();
 await assert.rejects(tool.execute("bad-start", { agents: [{ reason: "start child", prompt: "x" }] }, undefined, undefined, context(root)), /Could not start Pi RPC/);
}));

test("renderer accepts pre-reload child details without usage components or active tool metadata", () => {
 // Legacy children without schema-v2 runtimePlan remain renderable (AC-013).
 const legacy: any = { children: [{ index: 0, id: "old", label: "agent", reason: "resume old output", prompt: "", status: "completed", model: "m", thinking: "off", toolCount: 1, tokens: 10, activities: ["old output"], response: "", artifactPath: "/old" }] };
 assert.doesNotThrow(() => renderLines(legacy));
 const lines = renderLines(legacy).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(lines[0], /🤖 agent\[m\|off\] resume old output/);
 assert.doesNotMatch(lines[0], / ago\)/);
 assert.match(lines[1], /10 tok/);
});

test("settled child output shows its durable completion age", () => {
 const child: any = { index: 0, id: "restored", label: "auditor", reason: "verify persisted output", prompt: "", status: "completed", model: "m", thinking: "off", toolCount: 1, input: 10, output: 2, activities: ["verified"], activeTools: [], eventCount: 0, startedAt: 1_000, endedAt: 3_000, response: "", artifactPath: "/old" };
 const lines = renderLines({ children: [child] } as any, false, 3_783_000, 120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(lines[0], /verify persisted output \(1h3m ago\)/);
 assert.match(lines[0], /→ 1 tools/);
 const originalNow = Date.now; Date.now = () => 3_783_000;
 try {
  for (const status of ["completed", "warning", "failed", "cancelled", "not-started"] as const) {
   child.status = status;
   const narrow = new SnapshotComponent({ children: [child] } as any, false).render(52)[0]!.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
   assert.match(narrow, /\(1h3m ago\)$/, `${status} lost its age`);
  }
 } finally { Date.now = originalNow; }
 child.status = "running";
 assert.doesNotMatch(renderLines({ children: [child] } as any, false, 3_783_000, 120)[0]!, / ago\)/);
});

test("compact rendering shows each child's observed model identity", () => {
 const details: any = {
  schemaVersion: 2,
  children: [
   { index: 0, id: "a", label: "left", reason: "show observed", prompt: "", status: "completed", model: "fast", thinking: "medium", toolCount: 0, tokens: 0, activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: "/a", runtimePlan: { provider: "fake", modelId: "fast", model: "fake/fast", thinking: "medium", provenance: "request", requestedModel: "fake/fast", observed: { provider: "fake", modelId: "fast", model: "fake/fast" } } },
   { index: 1, id: "b", label: "right", reason: "legacy only", prompt: "", status: "completed", model: "legacy-id", thinking: "low", toolCount: 0, tokens: 0, activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: "/b" },
  ],
 };
 const plain = renderLines(details).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(plain[0], /🤖 left\[fast\|medium\] show observed/);
 assert.match(plain.find((l) => l.includes("right")) ?? "", /🤖 right\[legacy-id\|low\] legacy only/);
});

test("wide view combines child identity reason age and metrics on one line", () => {
 const now = Date.now();
 const child: any = { index: 0, id: "wide", label: "fixer-recovery", reason: "recover missing repair ledger after interrupted fixer", prompt: "", status: "completed", model: "gpt-5.6-sol", thinking: "high", toolCount: 31, input: 99_000, output: 3_700, cacheRead: 500_000, cacheWrite: 0, providerTraffic: 602_700, tokens: 602_700, activities: ["- `git diff --check`: passed", "- Fragment schema: exactly two valid `fix.applied` events, no `seq`"], activeTools: [], eventCount: 0, startedAt: now - 3_919_000, endedAt: now - 3_780_000, response: "", artifactPath: "/wide" };
 const rendered = new SnapshotComponent({ children: [child] } as any, false).render(180).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
 assert.equal(rendered[0], "  ┊ ✓ 🤖 fixer-recovery[gpt-5.6-sol|high] recover missing repair ledger after interrupted fixer (1h3m ago) → 31 tools · ↑99k ↓3.7k · 2m 19s");
 assert.equal(rendered[1], "  ┊     - `git diff --check`: passed");
});

test("multi-child output inserts one blank between siblings and stays tight for one child", () => {
 const mk = (index: number, label: string, reason: string, activity: string): any => ({
  index, id: `child-${index}`, label, reason, prompt: "", status: "running", model: "m", thinking: "high",
  toolCount: index + 1, input: 1000 * (index + 1), output: 100 * (index + 1), cacheRead: 0, cacheWrite: 0,
  providerTraffic: 1100 * (index + 1), tokens: 1100 * (index + 1), activities: [activity], activeTools: [],
  eventCount: 0, startedAt: 1, endedAt: 1_001, response: "", artifactPath: `/${label}`,
 });
 const single = renderLines({ children: [mk(0, "solo", "stay compact", "solo activity")] } as any, false, 2_000, 120)
  .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.equal(single.some((line) => line === ""), false);
 assert.match(single[0]!, /🤖 solo\[m\|high\] stay compact/);

 const multi = renderLines({ children: [
  mk(0, "final-spec-audit", "verify every prior finding", "audit activity"),
  mk(1, "skill-usability", "validate skill execution", "usability activity"),
  mk(2, "docs", "summarize the contract", "docs activity"),
 ] } as any, false, 2_000, 120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 const robotIndexes = multi.map((line, index) => (/🤖/.test(line) ? index : -1)).filter((index) => index >= 0);
 assert.deepEqual(robotIndexes, [0, 3, 6]);
 assert.equal(multi[2], "");
 assert.equal(multi[5], "");
 assert.equal(multi.filter((line) => line === "").length, 2);
 assert.match(multi[3]!, /🤖 skill-usability/);
 assert.match(multi[6]!, /🤖 docs/);

 // Parallel-tool rhythm: the blank is unpainted so sibling cards read as separate blocks.
 const theme = { bg: (name: string, text: string) => `[${name}]${text}` };
 const painted = new SnapshotComponent({ children: [
  mk(0, "left", "left work", "left activity"),
  mk(1, "right", "right work", "right activity"),
 ] } as any, false, (text) => theme.bg("toolPendingBg", text)).render(120);
 assert.equal(painted[2], "");
 assert.match(painted[0]!, /toolPendingBg/);
 assert.match(painted[1]!, /toolPendingBg/);
 assert.doesNotMatch(painted[2]!, /toolPendingBg/);
 assert.match(painted[3]!, /toolPendingBg/);
});

test("robot identifies delegated work in every representative status and layout", () => {
 const statuses = ["queued", "starting", "running", "completed", "warning", "failed", "cancelled", "not-started"];
 for (const [index, status] of statuses.entries()) {
  const child: any = { index, id: String(index), label: status, reason: `show ${status}`, prompt: "", status, model: "m", thinking: "off", toolCount: 1, input: 1200, output: 34, cacheRead: 5000, cacheWrite: 6, providerTraffic: 6240, tokens: 6240, activities: ["representative activity"], activeTools: [], eventCount: 0, response: "", artifactPath: "/old" };
  for (const expanded of [false, true]) {
   const rendered = new SnapshotComponent({ children: [child] } as any, expanded).render(50).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
   assert.match(rendered, /🤖/); assert.doesNotMatch(rendered, /🧭/); assert.match(rendered, /↑1\.2k ↓34/); assert.doesNotMatch(rendered, /tok/);
  }
 }
});

test("renderer preserves native pending and settled state backgrounds", () => {
 const { tool } = register();
 const child: any = { index: 0, id: "child", label: "agent", reason: "show a deliberately long running state", prompt: "", status: "running", model: "m", thinking: "off", toolCount: 2, tokens: 2_100, activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: "/x" };
 const details: any = { schemaVersion: 2, runId: "r", runDir: "/r", cwd: "/", createdAt: "now", cap: 1, children: [child] };
 const theme = { bg: (name: string, text: string) => `[${name}]${text}` };
 let invalidations = 0;
 const renderContext = { state: {}, invalidate() { invalidations++; } };
 const pending = tool.renderResult({ details }, { expanded: false, isPartial: true }, theme, renderContext);
 assert.match(pending.render(200)[0], /toolPendingBg/);
 const frameA = renderLines(details, false, 0)[0].replace(/\x1b\[[0-9;]*m/g, "");
 const frameB = renderLines(details, false, 120)[0].replace(/\x1b\[[0-9;]*m/g, "");
 assert.equal(frameA, frameB); assert.match(frameA, /●/); assert.equal(invalidations, 0);
 const narrow = pending.render(58)[1].replace(/\x1b\[[0-9;]*m/g, "").replace(/\[toolPendingBg\]/g, "");
 assert.match(narrow, /2 tools/); assert.match(narrow, /2\.1k tok/); assert.match(narrow, /<1s/);
 child.status = "failed";
 assert.match(tool.renderResult({ details }, { expanded: false, isPartial: false }, theme, renderContext).render(200)[0], /toolErrorBg/);
 assert.equal(invalidations, 0);
});

test("pure boundaries cover cap FIFO envelope limits and renderer", async () => {
 assert.equal(concurrencyCap(8, 3 * 1024 ** 3), 1);
 const scheduler = new Scheduler(1); const order: string[] = [];
 let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
 const a = scheduler.schedule("a", async () => { order.push("a"); await gate; return 1; });
 const cancelled = scheduler.schedule("cancelled-owner", async () => { order.push("cancelled"); return 0; });
 const b = scheduler.schedule("b", async () => { order.push("b"); return 2; });
 scheduler.cancel("cancelled-owner"); release();
 await assert.rejects(cancelled, /Cancelled/); await Promise.all([a, b]); assert.deepEqual(order, ["a", "b"]);
 const child: any = { index: 0, label: 'a"<&', status: "completed", response: "x".repeat(20_000), artifactPath: "/full.md" };
 const envelope = buildEnvelope([child]); assert.match(envelope, /a&quot;&lt;&amp;/); assert.match(envelope, /format="markdown"/); assert.match(envelope, /artifact="\/full\.md"/); assert.ok(Buffer.byteLength(envelope) <= 50 * 1024);
 const emojiEnvelope = buildEnvelope([{ ...child, response: "🧭".repeat(20_000) }]);
 assert.ok(Buffer.byteLength(emojiEnvelope) <= 50 * 1024); assert.ok(Buffer.byteLength(emojiEnvelope.match(/<!\[CDATA\[(.*)\]\]>/s)![1]!) <= 16 * 1024);
 const cdataEnvelope = buildEnvelope([{ ...child, response: "]]>".repeat(10_000) }]);
 assert.ok(Buffer.byteLength(cdataEnvelope) <= 50 * 1024); assert.doesNotMatch(cdataEnvelope.match(/<!\[CDATA\[(.*)\]\]>/s)![1]!, /]]>(?!<\!\[CDATA\[)/);
 const many = buildEnvelope(Array.from({ length: 1_000 }, (_, index) => ({ ...child, index, label: `agent-${index}`, response: "", artifactPath: `/runs/demo/${index}.md` })));
 assert.ok(Buffer.byteLength(many) <= 50 * 1024); assert.match(many, /subagent_results_truncated/); assert.match(many, /artifacts="\/runs\/demo"/);
 const details: any = { children: [{ ...child, id: "1", reason: "inspect state", model: "m", thinking: "off", toolCount: 0, tokens: 2_100, activities: [], activeTools: [], eventCount: 0, startedAt: 0, response: "" }] };
 const plain = renderLines(details).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(plain[0], /a"<&\[m\|off\] inspect state/); assert.match(plain[1], /2\.1k tok/);
 assert.deepEqual(buildChildArgs({ model: "provider/model", thinking: "high", tools: ["read", "grep"], approved: true }), ["--mode", "rpc", "--no-session", "--approve", "--model", "provider/model", "--thinking", "high", "--tools", "read,grep"]);
 assert.deepEqual(buildChildArgs({ model: "provider/model", thinking: "off", tools: [] }).slice(-1), ["--no-tools"]);
});

test("schema model and thinking guidance: exact IDs, omit inherits, reject fuzzy, thinking-primary", () => {
 const { tool, commands } = register();
 const agentProps = tool.parameters.properties.agents.items.properties;
 const modelDesc = agentProps.model.description as string;
 const thinkingDesc = agentProps.thinking.anyOf
  ? (agentProps.thinking.description as string) // union may hoist description
  : (agentProps.thinking.description as string);
 // Prefer exported constants (TypeBox may nest union descriptions differently).
 assert.equal(MODEL_FIELD_DESCRIPTION, modelDesc || MODEL_FIELD_DESCRIPTION);
 assert.match(MODEL_FIELD_DESCRIPTION, /exact registered provider\/model-id/i);
 assert.match(MODEL_FIELD_DESCRIPTION, /omit inherits parent/i);
 assert.match(MODEL_FIELD_DESCRIPTION, /aliases|profiles|fuzzy/i);
 assert.match(MODEL_FIELD_DESCRIPTION, /tidy-subagents-routing/);
 assert.doesNotMatch(MODEL_FIELD_DESCRIPTION, /claude-|gpt-|gemini-/i);

 assert.match(THINKING_FIELD_DESCRIPTION, /off\|minimal\|low\|medium\|high\|xhigh\|max/);
 assert.match(THINKING_FIELD_DESCRIPTION, /omit inherits parent/i);
 assert.match(THINKING_FIELD_DESCRIPTION, /primary per-child control/i);
 assert.match(THINKING_FIELD_DESCRIPTION, /bounded|mechanical/i);
 assert.match(THINKING_FIELD_DESCRIPTION, /architecture|concurrency/i);

 // TypeBox string optional keeps description on the property; thinking union may put it on the schema root.
 if (modelDesc) assert.equal(modelDesc, MODEL_FIELD_DESCRIPTION);
 if (thinkingDesc) assert.equal(thinkingDesc, THINKING_FIELD_DESCRIPTION);

 const guidelines = tool.promptGuidelines as string[];
 assert.ok(guidelines.some((line) => /primary per-child control/i.test(line)));
 assert.ok(guidelines.some((line) => /exact registered provider\/model-id|No aliases/i.test(line)));
 assert.ok(guidelines.some((line) => /tidy-subagents-routing/.test(line)));
 // Override hierarchy (most specific wins): tool-call fields > user turn > AGENTS.md > routing map > schema defaults > parent inherit.
 const hierarchyLine = guidelines.find((line) => /most specific wins|precedence/i.test(line));
 assert.ok(hierarchyLine, "promptGuidelines must document override precedence");
 assert.match(hierarchyLine!, /explicit|tool[- ]call|request fields/i);
 assert.match(hierarchyLine!, /user turn/i);
 assert.match(hierarchyLine!, /AGENTS\.md/);
 assert.match(hierarchyLine!, /routing map|tidy-subagents-routing/i);
 assert.match(hierarchyLine!, /schema defaults|promptGuidelines/i);
 assert.match(hierarchyLine!, /inherit/i);
 assert.ok(guidelines.every((line) => !/coequal/i.test(line)), "coequal framing must be removed");
 assert.ok(commands.has("tidy-subagents-routing"));
});

test("structured routing config atomic load/save and thinking-primary defaults", async () => fixture(async (root) => {
 const agentDir = join(root, "agent");
 assert.equal(loadRoutingConfig(agentDir), undefined);

 const defaults = buildDefaultRoutingConfig();
 assert.equal(defaults.version, 1);
 assert.deepEqual(Object.keys(defaults.taskClasses).sort(), [...STANDARD_TASK_CLASSES].filter((t) => defaults.taskClasses[t]).sort());
 // Thinking-primary: model omitted by default on every task class.
 for (const selection of Object.values(defaults.taskClasses)) {
  assert.equal(selection?.model, undefined);
 }
 assert.equal(defaults.taskClasses["bounded-lookup"]?.thinking, "minimal");
 assert.equal(defaults.taskClasses["mechanical-implementation"]?.thinking, "low");
 assert.equal(defaults.taskClasses["ordinary-review"]?.thinking, "medium");
 assert.equal(defaults.taskClasses["architectural-judgment"]?.thinking, "high");
 assert.equal(defaults.taskClasses["concurrency-analysis"]?.thinking, "high");
 assert.equal(defaults.taskClasses["cost-sensitive"]?.thinking, "minimal");

 const path = await saveRoutingConfig(defaults, agentDir);
 assert.equal(path, routingConfigPath(agentDir));
 const loaded = loadRoutingConfig(agentDir);
 assert.deepEqual(loaded, defaults);

 const withModels = buildDefaultRoutingConfig({
  "architectural-judgment": "other/strong",
  "cost-sensitive": "fake/fast",
 });
 assert.equal(withModels.taskClasses["architectural-judgment"]?.model, "other/strong");
 assert.equal(withModels.taskClasses["cost-sensitive"]?.model, "fake/fast");
 assert.equal(withModels.taskClasses["ordinary-review"]?.model, undefined);
 await saveRoutingConfig(withModels, agentDir);
 assert.deepEqual(resolveTaskSelection(loadRoutingConfig(agentDir), "architectural-judgment"), {
  thinking: "high", model: "other/strong",
 });
 assert.deepEqual(resolveTaskSelection(loadRoutingConfig(agentDir), "ordinary-review"), {
  thinking: "medium",
 });

 const guidance = formatRoutingGuidance(loadRoutingConfig(agentDir));
 assert.ok(guidance.some((line) => line.includes("architectural-judgment") && line.includes("other/strong")));
 assert.ok(guidance.some((line) => line.includes("model=inherit") || line.includes("ordinary-review")));

 assert.equal(await clearRoutingConfig(agentDir), true);
 assert.equal(loadRoutingConfig(agentDir), undefined);
 assert.equal(await clearRoutingConfig(agentDir), false);
}));

test("listAuthenticatedModels prefers getAvailable and falls back to auth filter", () => {
 const available = listAuthenticatedModels({
  getAvailable: () => [{ provider: "fake", id: "fast" }, { provider: "other", id: "strong" }],
  getAll: () => [{ provider: "fake", id: "ignored" }],
  hasConfiguredAuth: () => false,
 });
 assert.deepEqual(available.map((m) => m.ref), ["fake/fast", "other/strong"]);

 const filtered = listAuthenticatedModels({
  getAll: () => [
   { provider: "fake", id: "fast" },
   { provider: "other", id: "unauthed" },
  ],
  hasConfiguredAuth: (m) => m.id !== "unauthed",
 });
 assert.deepEqual(filtered.map((m) => m.ref), ["fake/fast"]);
 assert.deepEqual(listAuthenticatedModels(undefined), []);
});

test("/tidy-subagents-routing setup writes agent-dir map without parent mutation", async () => fixture(async (root) => {
 process.env.PI_CODING_AGENT_DIR = join(root, "agent");
 const { commands } = register();
 const command = commands.get("tidy-subagents-routing");
 assert.ok(command);

 let setModelCalls = 0;
 let setThinkingCalls = 0;
 const notes: Array<{ message: string; type?: string }> = [];
 const answers = [
  // thinking then model for each of 8 task classes
  "minimal (suggested)", "inherit (parent)",
  "low (suggested)", "fake/fast",
  "medium (suggested)", "inherit (parent)",
  "high (suggested)", "other/strong",
  "high (suggested)", "inherit (parent)",
  "minimal (suggested)", "fake/fast",
  "inherit (parent)", "fake/deep/reasoner",
  "inherit (parent)", "other/strong",
 ];
 let answerIndex = 0;
 const ctx = {
  ui: {
   notify(message: string, type?: string) { notes.push({ message, type }); },
   async select(_title: string, _options: string[]) {
    return answers[answerIndex++];
   },
  },
  modelRegistry: {
   getAvailable: () => [
    { provider: "fake", id: "fast" },
    { provider: "fake", id: "deep/reasoner" },
    { provider: "other", id: "strong" },
   ],
  },
  setModel() { setModelCalls++; },
  setThinkingLevel() { setThinkingCalls++; },
 };

 await command.handler("setup", ctx);
 assert.equal(setModelCalls, 0);
 assert.equal(setThinkingCalls, 0);
 assert.ok(notes.some((n) => /Saved routing map/.test(n.message)));

 const loaded = loadRoutingConfig(join(root, "agent"));
 assert.ok(loaded);
 assert.equal(loaded!.taskClasses["bounded-lookup"]?.thinking, "minimal");
 assert.equal(loaded!.taskClasses["bounded-lookup"]?.model, undefined);
 assert.equal(loaded!.taskClasses["mechanical-implementation"]?.model, "fake/fast");
 assert.equal(loaded!.taskClasses["architectural-judgment"]?.model, "other/strong");
 assert.equal(loaded!.taskClasses["similarly-named-models"]?.model, "fake/deep/reasoner");
 assert.equal(loaded!.taskClasses["cross-provider"]?.model, "other/strong");

 notes.length = 0;
 await command.handler("status", ctx);
 assert.ok(notes.some((n) => /architectural-judgment/.test(n.message)));

 notes.length = 0;
 await command.handler("defaults", ctx);
 const defaults = loadRoutingConfig(join(root, "agent"));
 assert.ok(defaults);
 for (const selection of Object.values(defaults!.taskClasses)) {
  assert.equal(selection?.model, undefined);
 }

 notes.length = 0;
 await command.handler("clear", ctx);
 assert.equal(loadRoutingConfig(join(root, "agent")), undefined);
 assert.ok(notes.some((n) => /Cleared/.test(n.message)));
}));

test("/tidy-subagents-routing setup warns when no authenticated models", async () => fixture(async (root) => {
 process.env.PI_CODING_AGENT_DIR = join(root, "agent");
 const { commands } = register();
 const notes: string[] = [];
 await commands.get("tidy-subagents-routing").handler("setup", {
  ui: {
   notify(message: string) { notes.push(message); },
   async select() { throw new Error("select should not run"); },
  },
  modelRegistry: { getAvailable: () => [] },
 });
 assert.ok(notes.some((n) => /No authenticated models/i.test(n)));
 assert.equal(loadRoutingConfig(join(root, "agent")), undefined);
}));
