import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Value } from "typebox/value";
import extension from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));

function registry() {
  return {
    find(provider: string, id: string) {
      return provider === "fake" && id === "model-x" ? { provider, id, reasoning: true } : undefined;
    },
    hasConfiguredAuth: () => true,
  };
}

async function fixture<T>(run: (host: ReturnType<typeof register>, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-background-"));
  const keys = ["PI_CODING_AGENT_DIR", "PI_TIDY_SUBAGENT_EXECUTABLE", "PI_TIDY_SUBAGENT_ARGS"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_TIDY_SUBAGENT_EXECUTABLE = process.execPath;
  process.env.PI_TIDY_SUBAGENT_ARGS = JSON.stringify([join(here, "fake-rpc.mjs")]);
  try {
    const host = register();
    await host.start();
    return await run(host, root);
  } finally {
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    await rm(root, { recursive: true, force: true });
  }
}

function register() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const renderers = new Map<string, any>();
  const events = new Map<string, any[]>();
  const entries: Array<{ type: string; data: any }> = [];
  const messages: Array<{ message: any; options: any }> = [];
  const widgets: any[] = [];
  const visualEvents: Array<{ type: "entry" | "widget"; kind?: string; value?: any }> = [];
  const overlays: any[] = [];
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
    registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
    on(name: string, handler: any) { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
    appendEntry(type: string, data: any) { entries.push({ type, data }); visualEvents.push({ type: "entry", kind: data.kind }); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["read", "subagent", "subagent_control"],
  };
  extension(pi as any);
  const ui = {
    setWidget(...args: any[]) { widgets.push(args); visualEvents.push({ type: "widget", value: args[1] }); },
    async custom(factory: any, options: any) { overlays.push({ factory, options }); return null; },
    async editor() { return undefined; },
    notify() {},
  };
  const ctx = (mode = "tui", batchId?: string) => ({
    cwd: process.cwd(), mode, hasUI: mode === "tui" || mode === "rpc", ui,
    model: { provider: "fake", id: "model-x" }, modelRegistry: registry(), isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => entries.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })),
      getLeafId: () => batchId,
    },
  });
  return {
    tools, commands, shortcuts, renderers, events, entries, messages, widgets, visualEvents, overlays, ctx,
    async start() { for (const handler of events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx()); },
    async shutdown(reason = "quit") { for (const handler of events.get("session_shutdown") ?? []) await handler({ reason }, ctx()); },
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function text(result: any): string { return result.content[0].text; }

async function control(host: ReturnType<typeof register>, params: any, mode = "tui", batchId?: string) {
  return host.tools.get("subagent_control").execute(`control-${Math.random()}`, params, undefined, undefined, host.ctx(mode, batchId));
}

async function cancelTargets(host: ReturnType<typeof register>, targets: string[]): Promise<void> {
  await Promise.all(targets.map((target) => control(host, { action: "cancel", target }).catch(() => undefined)));
}

test("registers background launch, control, management, stamp, and shortcut contracts", () => {
  const host = register();
  assert.deepEqual([...host.tools.keys()], ["subagent", "subagent_control"]);
  assert.equal(host.tools.get("subagent").executionMode, "parallel");
  assert.equal(host.tools.get("subagent_control").executionMode, "parallel");
  assert.deepEqual([...host.commands.keys()], ["tidy-subagents-routing", "subagents"]);
  assert.deepEqual([...host.shortcuts.keys()], ["ctrl+shift+b"]);
  assert.deepEqual([...host.renderers.keys()], ["pi-tidy-subagent-stamp"]);
  const request = host.tools.get("subagent").parameters.properties.agents.items;
  assert.deepEqual(request.properties.execution.anyOf.map((item: any) => item.const), ["foreground", "background"]);
  assert.equal(Value.Check(host.tools.get("subagent").parameters, { agents: [{ reason: "default foreground", prompt: "first" }] }), true);
  assert.equal(Value.Check(host.tools.get("subagent").parameters, { agents: [{ reason: "bad mode", prompt: "first", execution: "detached" }] }), false);
  const controlSchema = host.tools.get("subagent_control").parameters;
  assert.deepEqual(controlSchema.properties.action.anyOf.map((item: any) => item.const), ["background", "steer", "cancel", "inspect", "status", "set_delivery", "collect"]);
});

test("control validation rejects missing and action-irrelevant fields", async () => fixture(async (host) => {
  await assert.rejects(() => control(host, { action: "status", target: "unused" }), /status does not accept target/);
  await assert.rejects(() => control(host, { action: "steer", target: "missing" }), /non-empty message/);
  await assert.rejects(() => control(host, { action: "inspect", target: "missing", delivery: "manual" }), /inspect does not accept delivery/);
  await assert.rejects(() => control(host, { action: "set_delivery", target: "missing" }), /requires delivery=auto or delivery=manual/);
}));

test("direct background launch returns an acknowledgement before settlement and supports native control", async () => fixture(async (host) => {
  const launch = await host.tools.get("subagent").execute("direct-bg", { agents: [
    { label: "watcher", reason: "watch long work", prompt: "hang", execution: "background" },
  ] }, undefined, undefined, host.ctx());
  const child = launch.details.children[0];
  assert.equal(child.ownership, "background");
  assert.equal(child.requestedExecution, "background");
  assert.match(child.target, /:child-001$/);
  assert.match(text(launch), /background_ack/);
  assert.match(text(launch), new RegExp(child.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text(launch), /working fragments|# Result/);
  assert.equal(host.entries.filter((entry) => entry.data.kind === "handoff").length, 1);
  assert.ok(host.widgets.some((args) => args[0] === "pi-tidy-subagents-background"));

  await waitUntil(async () => {
    const inspected = await control(host, { action: "inspect", target: child.target });
    return inspected.details.child.status === "running" && inspected.details.controlReady;
  }, "background child did not become running");
  const steered = await control(host, { action: "steer", target: "watcher", message: "focus on the lifecycle" });
  assert.equal(steered.details.accepted, true);
  assert.match(text(steered), /Steering accepted/);
  const held = await control(host, { action: "set_delivery", target: child.target, delivery: "manual" });
  assert.equal(held.details.child.deliveryPolicy, "manual");
  const cancelled = await control(host, { action: "cancel", target: child.target });
  assert.equal(cancelled.details.accepted, true);
  const repeated = await control(host, { action: "cancel", target: child.target });
  assert.equal(repeated.details.repeated, true);
  assert.equal(repeated.details.child.status, "cancelled");
  await waitUntil(() => host.entries.some((entry) => entry.data.kind === "terminal" && entry.data.target === child.target), "terminal stamp was not appended");
  const terminalEvent = host.visualEvents.findIndex((event) => event.type === "entry" && event.kind === "terminal");
  const widgetClear = host.visualEvents.findIndex((event, index) => index > terminalEvent && event.type === "widget" && event.value === undefined);
  assert.ok(terminalEvent >= 0 && widgetClear > terminalEvent, JSON.stringify(host.visualEvents));
  const status = await control(host, { action: "status" });
  assert.ok(status.details.terminalUncollected.some((item: any) => item.target === child.target && item.status === "cancelled"));
  assert.equal(host.messages.length, 0, "manual cancellation must not enqueue completion");
}));

test("mixed fan-out waits only for foreground children and preserves input-order result semantics", async () => fixture(async (host) => {
  const result = await host.tools.get("subagent").execute("mixed", { agents: [
    { label: "front", reason: "return required result", prompt: "first" },
    { label: "back", reason: "continue detached work", prompt: "hang", execution: "background" },
  ] }, undefined, undefined, host.ctx());
  assert.deepEqual(result.details.children.map((child: any) => child.ownership), ["foreground", "background"]);
  assert.equal(result.details.children[0].status, "completed");
  assert.ok(["queued", "starting", "running"].includes(result.details.children[1].status));
  assert.ok(text(result).indexOf("subagent_result") < text(result).indexOf("background_ack"));
  assert.match(text(result), /# Result/);
  assert.doesNotMatch(text(result).slice(text(result).indexOf("background_ack")), /working fragments/);
  await cancelTargets(host, [result.details.children[1].target]);
}));

test("foreground handoff is one-way and a race-safe sibling control releases the tool wait", async () => fixture(async (host) => {
  const batchId = "same-parallel-batch";
  const controlFirst = control(host, { action: "background", target: "rendezvous" }, "tui", batchId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const launch = host.tools.get("subagent").execute("handoff", { agents: [
    { label: "rendezvous", reason: "start synchronously", prompt: "hang" },
  ] }, undefined, undefined, host.ctx("tui", batchId));
  const [handoff, result] = await Promise.all([controlFirst, launch]);
  const target = handoff.details.child.target;
  assert.equal(handoff.details.child.ownership, "background");
  assert.match(text(result), /background_ack/);
  assert.equal(host.entries.filter((entry) => entry.data.kind === "handoff" && entry.data.target === target).length, 1);
  await assert.rejects(() => control(host, { action: "background", target }), /already background-owned/);
  await cancelTargets(host, [target]);
}));

test("a failed same-batch rendezvous expires without affecting a later turn", async () => fixture(async (host) => {
  await assert.rejects(() => control(host, { action: "background", target: "future-label" }), /No eligible subagent/);
  const later = await host.tools.get("subagent").execute("later", { agents: [
    { label: "future-label", reason: "run in later turn", prompt: "first" },
  ] }, undefined, undefined, host.ctx());
  assert.equal(later.details.children[0].ownership, "foreground");
  assert.equal(later.details.children[0].status, "completed");
}));

test("a same-label launch inside the rendezvous timeout cannot cross the parent batch boundary", async () => fixture(async (host) => {
  const pending = control(host, { action: "background", target: "later-turn-label" }, "tui", "control-batch");
  await new Promise((resolve) => setTimeout(resolve, 110));
  const later = host.tools.get("subagent").execute("later", { agents: [
    { label: "later-turn-label", reason: "run in later turn", prompt: "first" },
  ] }, undefined, undefined, host.ctx("tui", "later-batch"));
  await assert.rejects(() => pending, /No eligible subagent/);
  const result = await later;
  assert.equal(result.details.children[0].ownership, "foreground");
  assert.equal(result.details.children[0].status, "completed");
}));

test("canonical targets are deterministic and ambiguous labels list every candidate", async () => fixture(async (host) => {
  const left = await host.tools.get("subagent").execute("left", { agents: [{ label: "duplicate", reason: "left copy", prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx());
  const right = await host.tools.get("subagent").execute("right", { agents: [{ label: "duplicate", reason: "right copy", prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx());
  const targets = [left.details.children[0].target, right.details.children[0].target];
  await assert.rejects(() => control(host, { action: "inspect", target: "duplicate" }), (error: any) => targets.every((target) => error.message.includes(target)));
  for (const target of targets) assert.equal((await control(host, { action: "inspect", target })).details.child.target, target);
  await cancelTargets(host, targets);
}));

test("an unambiguous active label wins over same-label terminal history", async () => fixture(async (host) => {
  const old = await host.tools.get("subagent").execute("old-label", { agents: [{ label: "reused", reason: "finish old work", prompt: "first", execution: "background" }] }, undefined, undefined, host.ctx());
  await waitUntil(async () => (await control(host, { action: "inspect", target: old.details.children[0].target })).details.child.status === "completed", "old child did not settle");
  const active = await host.tools.get("subagent").execute("active-label", { agents: [{ label: "reused", reason: "run current work", prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx());
  const inspected = await control(host, { action: "inspect", target: "reused" });
  assert.equal(inspected.details.child.target, active.details.children[0].target);
  await cancelTargets(host, [active.details.children[0].target]);
}));

test("background provider failure is never silent in stamps or completion delivery", async () => fixture(async (host) => {
  const launch = await host.tools.get("subagent").execute("background-failure", {
    agents: [{ label: "failing", reason: "surface detached failure", prompt: "crash", execution: "background" }],
  }, undefined, undefined, host.ctx());
  const target = launch.details.children[0].target;
  await waitUntil(() => host.entries.some((entry) => entry.data.kind === "terminal" && entry.data.target === target), "failure terminal stamp missing");
  await waitUntil(() => host.messages.some((item) => item.message.details?.target === target), "failure completion missing");
  const terminal = host.entries.find((entry) => entry.data.kind === "terminal" && entry.data.target === target)!;
  const completion = host.messages.find((item) => item.message.details?.target === target)!;
  assert.equal(terminal.data.child.status, "failed");
  assert.match(terminal.data.result, /provider failed/);
  assert.match(completion.message.content, /status=\"failed\"/);
}));

test("automatic completion uses follow-up delivery while manual collection is bounded and repeatable", async () => fixture(async (host) => {
  const auto = await host.tools.get("subagent").execute("auto", { agents: [{ label: "auto", reason: "finish in background", prompt: "delayed", execution: "background" }] }, undefined, undefined, host.ctx());
  const autoTarget = auto.details.children[0].target;
  await waitUntil(() => host.messages.some((item) => item.message.details?.target === autoTarget), "automatic follow-up was not queued");
  const completion = host.messages.find((item) => item.message.details?.target === autoTarget)!;
  assert.deepEqual(completion.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(completion.message.content, /subagent_result/);
  await assert.rejects(() => control(host, { action: "set_delivery", target: autoTarget, delivery: "manual" }), /already accepted by Pi|cannot be retracted/);

  const manual = await host.tools.get("subagent").execute("manual", { agents: [{ label: "inbox", reason: "hold result", prompt: "delayed", execution: "background" }] }, undefined, undefined, host.ctx());
  const manualTarget = manual.details.children[0].target;
  await control(host, { action: "set_delivery", target: manualTarget, delivery: "manual" });
  await waitUntil(async () => (await control(host, { action: "inspect", target: manualTarget })).details.child.status === "completed", "manual child did not settle");
  const inbox = await control(host, { action: "status" });
  const inboxLine = text(inbox).split("\n").find((line) => line.includes(manualTarget)) ?? "";
  assert.match(inboxLine, /age=/);
  assert.match(inboxLine, /artifact=/);
  const first = await control(host, { action: "collect", target: manualTarget });
  const second = await control(host, { action: "collect", target: manualTarget });
  assert.equal(text(first), text(second));
  assert.equal(first.details.previouslyCollected, false);
  assert.equal(second.details.previouslyCollected, true);
  assert.ok(Buffer.byteLength(text(first)) <= 50 * 1024);
  assert.equal(host.messages.filter((item) => item.message.details?.target === manualTarget).length, 0);
}));

test("print mode rejects background ownership before artifacts while JSON and RPC remain headless", async () => fixture(async (host, root) => {
  const runs = join(root, "agent", "pi-tidy-subagents", "runs");
  await assert.rejects(() => host.tools.get("subagent").execute("print-bg", { agents: [{ reason: "cannot survive print", prompt: "first", execution: "background" }] }, undefined, undefined, host.ctx("print")), /print mode.*background/i);
  await assert.rejects(access(runs));
  for (const mode of ["json", "rpc"]) {
    const launched = await host.tools.get("subagent").execute(`${mode}-bg`, { agents: [{ label: mode, reason: `exercise ${mode}`, prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx(mode));
    assert.equal(launched.details.children[0].ownership, "background");
    assert.equal(host.entries.some((entry) => entry.data.target === launched.details.children[0].target), false);
    await cancelTargets(host, [launched.details.children[0].target]);
  }
}));

test("background children share the cap and shutdown cancels running and queued siblings", async () => fixture(async (host) => {
  const probe = await host.tools.get("subagent").execute("cap-probe", { agents: [{ label: "probe", reason: "occupy shared cap", prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx());
  const cap = probe.details.cap;
  const batch = await host.tools.get("subagent").execute("cap-batch", { agents: Array.from({ length: cap }, (_, index) => ({ label: `cap-${index}`, reason: `share slot ${index}`, prompt: "hang", execution: "background" })) }, undefined, undefined, host.ctx());
  await waitUntil(async () => {
    const status = await control(host, { action: "status" });
    return status.details.activeBackground.filter((child: any) => child.status === "running").length === cap
      && status.details.activeBackground.filter((child: any) => child.status === "queued").length === 1;
  }, "shared scheduler did not expose one queued background child");
  await host.shutdown("fork");
  const targets = [probe.details.children[0].target, ...batch.details.children.map((child: any) => child.target)];
  const terminalTargets = new Set(host.entries.filter((entry) => entry.data.kind === "terminal").map((entry) => entry.data.target));
  assert.ok(targets.every((target) => terminalTargets.has(target)));
  assert.equal(host.messages.length, 0);
}));

test("legacy terminal artifacts remain collectable without reconstructing active workers", async () => fixture(async (host, root) => {
  const runId = "legacy-run", childId = "child-007";
  const runDir = join(root, "agent", "pi-tidy-subagents", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, `${childId}.md`), "legacy full result", "utf8");
  await writeFile(join(runDir, "child-008.md"), "untouched sibling result", "utf8");
  await writeFile(join(runDir, "run.json"), JSON.stringify({
    schemaVersion: 2, runId, cwd: root, createdAt: "2025-01-01T00:00:00.000Z", concurrencyCap: 1,
    runtime: { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "off", activeTools: [], projectTrusted: true },
    children: [
      { index: 7, id: childId, label: "legacy", reason: "read old result", prompt: "legacy secret prompt", status: "completed", model: "model-x", thinking: "off", toolCount: 0, input: 0, output: 0, tokens: 0, activities: [], eventCount: 0, artifactPath: join(runDir, `${childId}.md`) },
      { index: 8, id: "child-008", label: "sibling", reason: "preserve old sibling", prompt: "sibling secret", status: "completed", model: "model-x", thinking: "off", toolCount: 0, input: 0, output: 0, tokens: 0, activities: [], eventCount: 0, artifactPath: join(runDir, "child-008.md"), legacyOnly: "preserve-me" },
    ],
  }), "utf8");
  const collected = await control(host, { action: "collect", target: `${runId}:${childId}` });
  assert.match(text(collected), /legacy full result/);
  assert.equal(collected.details.child.ownership, "foreground");
  assert.equal(collected.details.child.prompt, "");
  const updatedManifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(updatedManifest.children[0].prompt, "legacy secret prompt");
  assert.equal(updatedManifest.children[1].legacyOnly, "preserve-me");
  assert.equal(await readFile(join(runDir, "child-008.md"), "utf8"), "untouched sibling result");
  const inspected = await control(host, { action: "inspect", target: `${runId}:${childId}` });
  assert.equal(inspected.details.child.status, "completed");
}));

test("artifacts persist ownership, delivery, controls, privacy, and shutdown terminal truth", async () => fixture(async (host) => {
  const launch = await host.tools.get("subagent").execute("persist", { agents: [{ label: "persisted", reason: "record transitions", prompt: "hang", execution: "background" }] }, undefined, undefined, host.ctx());
  const child = launch.details.children[0];
  await control(host, { action: "set_delivery", target: child.target, delivery: "manual" });
  await host.shutdown("reload");
  await waitUntil(() => host.entries.some((entry) => entry.data.kind === "terminal" && entry.data.target === child.target), "shutdown terminal stamp missing");
  const manifest = JSON.parse(await readFile(join(launch.details.runDir, "run.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.children[0].target, child.target);
  assert.equal(manifest.children[0].requestedExecution, "background");
  assert.equal(manifest.children[0].ownership, "background");
  assert.equal(manifest.children[0].terminalOwnership, "background");
  assert.equal(manifest.children[0].deliveryPolicy, "manual");
  assert.equal(manifest.children[0].status, "cancelled");
  assert.ok(manifest.children[0].controlHistory.some((item: any) => item.action === "set_delivery"));
  assert.ok(manifest.children[0].controlHistory.some((item: any) => item.action === "shutdown"));
  assert.equal(manifest.children[0].prompt, "hang");
  assert.equal(launch.details.children[0].prompt, "");
  assert.equal(launch.details.children[0].response, "");
  assert.equal(host.messages.length, 0, "shutdown must suppress completions");
}));
