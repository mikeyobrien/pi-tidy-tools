import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import extension, { buildEnvelope, concurrencyCap, renderLines, Scheduler } from "../index.js";
import { SnapshotComponent } from "../render.js";
import { buildChildArgs } from "../runner.js";

const here = dirname(fileURLToPath(import.meta.url));
function register() {
 let tool: any; const shutdown: any[] = [];
 const pi = { registerTool(value: any) { tool = value; }, on(name: string, handler: any) { if (name === "session_shutdown") shutdown.push(handler); }, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "subagent", "mystery"] };
 extension(pi as any); return { tool, shutdown };
}
const context = (cwd: string) => ({ cwd, mode: "tui", model: { provider: "fake", id: "model-x" }, isProjectTrusted: () => true });
async function fixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
 const root = await mkdtemp(join(tmpdir(), "tidy-subagents-"));
 const old = { dir: process.env.PI_CODING_AGENT_DIR, exe: process.env.PI_TIDY_SUBAGENT_EXECUTABLE, args: process.env.PI_TIDY_SUBAGENT_ARGS };
 process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath; process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([join(here, "fake-rpc.mjs")]);
 try { return await fn(root); } finally {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", old.dir], ["PI_TIDY_SUBAGENT_EXECUTABLE", old.exe], ["PI_TIDY_SUBAGENT_ARGS", old.args]] as const) value === undefined ? delete process.env[key] : process.env[key] = value;
  await rm(root, { recursive: true, force: true });
 }
}

test("public tool runs ordered all-settled fanout and persists full truth", async () => fixture(async (root) => {
 const { tool } = register(); const snapshots: any[] = [];
 assert.deepEqual(Object.keys(tool.parameters.properties), ["agents"]);
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
 assert.equal(run.schemaVersion, 1); assert.equal(run.cwd, root); assert.equal(run.children.length, 3);
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
 await pending; assert.equal(runningUpdates, 1);
}));

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
 const legacy: any = { children: [{ index: 0, id: "old", label: "agent", reason: "resume old output", prompt: "", status: "completed", model: "m", thinking: "off", toolCount: 1, tokens: 10, activities: ["old output"], response: "", artifactPath: "/old" }] };
 assert.doesNotThrow(() => renderLines(legacy));
 const lines = renderLines(legacy).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
 assert.match(lines[0], /🤖 agent\[m\|off\] resume old output/);
 assert.match(lines[1], /10 tok/);
});

test("wide view combines child identity reason and metrics on one line", () => {
 const child: any = { index: 0, id: "wide", label: "fixer-recovery", reason: "recover missing repair ledger after interrupted fixer", prompt: "", status: "completed", model: "gpt-5.6-sol", thinking: "high", toolCount: 31, input: 99_000, output: 3_700, cacheRead: 500_000, cacheWrite: 0, providerTraffic: 602_700, tokens: 602_700, activities: ["- `git diff --check`: passed", "- Fragment schema: exactly two valid `fix.applied` events, no `seq`"], activeTools: [], eventCount: 0, startedAt: 1, endedAt: 139_001, response: "", artifactPath: "/wide" };
 const rendered = new SnapshotComponent({ children: [child] } as any, false).render(180).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
 assert.equal(rendered[0], "  ┊ ✓ 🤖 fixer-recovery[gpt-5.6-sol|high] recover missing repair ledger after interrupted fixer → 31 tools · ↑99k ↓3.7k · 2m 19s");
 assert.equal(rendered[1], "  ┊     - `git diff --check`: passed");
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
 const details: any = { schemaVersion: 1, runId: "r", runDir: "/r", cwd: "/", createdAt: "now", cap: 1, children: [child] };
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
