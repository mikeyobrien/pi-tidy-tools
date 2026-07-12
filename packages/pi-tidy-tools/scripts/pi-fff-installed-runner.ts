import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildPiFffRegistrationPlan,
	createPiFffComposites,
	replayPiFffRegistrationPlan,
} from "../node_modules/@mobrienv/pi-tidy-tools/pi-fff/adapter.ts";

type Scope = "user" | "project" | "both";
const root = process.env.FIXTURE_ROOT!;
const cwd = join(root, "project");
const agentDir = join(root, "agent");
const expectedScope: Record<Scope, "user" | "project"> = { user: "user", project: "project", both: "project" };
const packageIdentity = process.env.PI_FFF_PACKAGE ?? "pi-fff";
const scoped = packageIdentity === "@ff-labs/pi-fff";

function assertOrderedIncludes(actual: readonly string[], required: readonly string[], label: string) {
	let cursor = 0;
	for (const value of actual) if (value === required[cursor]) cursor++;
	assert.equal(cursor, required.length, `${label} missing ordered baseline ${required.join(", ")}; observed ${actual.join(", ")}`);
}

// Synthetic future surface proves this release runner accepts interleaved additions.
assertOrderedIncludes(["future-before", "read", "future-middle", "grep", "future-after"], ["read", "grep"], "synthetic tools");

function createApi() {
	const calls: Array<{ method: string; args: any[] }> = [];
	const active = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
	const api: any = {
		events: { on() {}, emit() {} },
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active.clear(); for (const name of names) active.add(name); },
		getAllTools: () => calls.filter((call) => call.method === "registerTool").map((call) => call.args[0]),
		getCommands: () => calls.filter((call) => call.method === "registerCommand").map((call) => ({ name: call.args[0] })),
		getFlag: () => undefined,
		getSessionName: () => undefined,
		getThinkingLevel: () => "off",
	};
	for (const method of ["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on"]) {
		api[method] = (...args: any[]) => { calls.push({ method, args }); };
	}
	for (const method of ["sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "setLabel", "exec", "setModel", "setThinkingLevel", "shutdown", "abort", "compact"]) api[method] = () => undefined;
	return { api, calls, active };
}

async function setScenario(scope: Scope) {
	const projectSettings = join(cwd, ".pi", "settings.json");
	const userSettings = join(agentDir, "settings.json");
	const entry = (version: string) => ({ source: `npm:${packageIdentity}@${version}`, extensions: [] });
	const version = process.env.PI_FFF_VERSION!;
	const project = scope === "project" || scope === "both" ? [entry(version)] : [];
	const user = scope === "user" || scope === "both" ? [entry(version)] : [];
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(projectSettings, JSON.stringify({ packages: project }, null, 2));
	await writeFile(userSettings, JSON.stringify({ packages: user }, null, 2));
}

async function run(scope: Scope) {
	await setScenario(scope);
	const { api, calls, active } = createApi();
	const built = await buildPiFffRegistrationPlan({
		cwd,
		agentDir,
		api,
		piVersion: process.env.PI_VERSION!,
	});
	assert.equal(built.ok, true, built.ok ? undefined : `${built.diagnostic.code}: ${built.diagnostic.detail}`);
	if (!built.ok) return;
	assert.equal(built.plan.scope, expectedScope[scope]);
	const recordedToolDefinitions = built.plan.trace.filter((call) => call.method === "registerTool").map((call) => call.args[0] as any);
	const recordedTools = recordedToolDefinitions.map((tool) => tool.name as string);
	const recordedCommands = built.plan.trace.filter((call) => call.method === "registerCommand").map((call) => call.args[0] as string);
	const recordedEvents = built.plan.trace.filter((call) => call.method === "on").map((call) => call.args[0] as string);
	assert.equal(built.plan.packageIdentity, packageIdentity);
	assert.equal(built.plan.profile, scoped ? "scoped" : "legacy");
	assertOrderedIncludes(recordedTools, scoped ? ["ffgrep", "fffind"] : ["read", "grep", "find_files", "fff_multi_grep"], "tools");
	assertOrderedIncludes(recordedCommands, scoped ? ["fff-mode", "fff-health", "fff-rescan"] : ["fff-features", "reindex-fff", "fff-status"], "commands");
	assertOrderedIncludes(recordedEvents, ["session_start", "session_shutdown"], "lifecycle");

	const composites = scoped ? undefined : createPiFffComposites(built.plan, { mode: "default", reasoningGuideline: "State the goal." });
	if (composites) assert.equal((composites.read.parameters as any).required.includes("reasoning"), true);
	assert.equal(replayPiFffRegistrationPlan(built.plan, api, composites).ok, true);
	const tools = calls.filter((call) => call.method === "registerTool").map((call) => call.args[0]);
	assert.equal(tools.filter((tool) => tool.name === "read").length, scoped ? 0 : 1);
	assert.equal(tools.filter((tool) => tool.name === "grep").length, scoped ? 0 : 1);
	assert.equal(tools.some((tool) => tool.name === (scoped ? "fffind" : "find_files")), true);
	assert.equal(tools.some((tool) => tool.name === (scoped ? "ffgrep" : "fff_multi_grep")), true);
	if (scoped) for (const [index, tool] of tools.entries()) { assert.equal(tool, recordedToolDefinitions[index]); assert.equal(typeof tool.renderCall, "function"); assert.equal(typeof tool.renderResult, "function"); }

	let editorFactory: unknown;
	let autocompleteInstalled = false;
	const notifications: string[] = [];
	const context: any = {
		cwd,
		sessionManager: { getEntries: () => [] },
		ui: {
			setEditorComponent(value: unknown) { editorFactory = value; },
			getEditorComponent() { return undefined; },
			addAutocompleteProvider(factory: any) { autocompleteInstalled = typeof factory === "function"; },
			notify(message: string) { notifications.push(message); },
			custom: async () => undefined,
		},
	};
	const starts = calls.filter((call) => call.method === "on" && call.args[0] === "session_start");
	const shutdowns = calls.filter((call) => call.method === "on" && call.args[0] === "session_shutdown");
	assert.equal(starts.length, 1); assert.equal(shutdowns.length, 1);
	await starts[0]!.args[1]({ reason: "startup" }, context);
	assert.equal(scoped ? autocompleteInstalled : typeof editorFactory === "function", true);
	if (!scoped) assert.equal(active.has("find_files"), true);
	const commandCalls = calls.filter((call) => call.method === "registerCommand");
	const executedCommands = scoped ? ["fff-mode", "fff-health", "fff-rescan"] : ["fff-status", "reindex-fff", "fff-features"];
	for (const name of executedCommands) {
		const command = commandCalls.find((call) => call.args[0] === name);
		assert.ok(command, `${name} command missing`);
		await command.args[1].handler("", context);
	}

	const grep = tools.find((tool) => tool.name === (scoped ? "ffgrep" : "grep"))!;
	const find = tools.find((tool) => tool.name === (scoped ? "fffind" : "find_files"))!;
	const signal = new AbortController().signal;
	let fuzzyRead = false;
	if (!scoped) {
		const read = tools.find((tool) => tool.name === "read")!;
		const fuzzy = await read.execute("fuzzy-read", { path: "space marker", reasoning: "resolve approximate path" }, signal, undefined, context);
		assert.match(fuzzy.content[0].text, /PI_FFF_INSTALLED_MARKER/); fuzzyRead = true;
	}
	const indexed = await grep.execute("indexed-grep", scoped ? { pattern: "PI_FFF_INSTALLED_MARKER" } : { pattern: "PI_FFF_INSTALLED_MARKER", mode: "plain", reasoning: "search the index" }, signal, undefined, context);
	assert.match(indexed.content[0].text, /space marker\.txt/);
	assert.ok(indexed.details && typeof indexed.details === "object");
	const custom = await find.execute("find-files", scoped ? { pattern: "space marker" } : { query: "space marker" }, signal, undefined, context);
	assert.match(custom.content[0].text, /space marker\.txt/);

	await shutdowns[0]!.args[1]({ reason: "quit" }, context);
	if (!scoped) {
		const afterShutdown = await find.execute("after-shutdown", { query: "marker" }, signal, undefined, context);
		assert.match(afterShutdown.content[0].text, /not ready/i);
	}
	return {
		scope,
		selected: built.plan.scope,
		status: built.plan.status,
		aliases: "real package factory loaded through running-Pi aliases",
		tools: tools.map((tool) => tool.name),
		packageIdentity,
		profile: built.plan.profile,
		commands: { names: calls.filter((call) => call.method === "registerCommand").map((call) => call.args[0]), executed: executedCommands },
		lifecycle: { names: recordedEvents, starts: starts.length, shutdowns: shutdowns.length, runtimeClosed: true },
		compatibleAdditions: {
			tools: recordedTools.filter((name) => !(scoped ? ["ffgrep", "fffind", "fff-multi-grep"] : ["read", "grep", "find_files", "fff_multi_grep"]).includes(name)),
			commands: recordedCommands.filter((name) => !(scoped ? ["fff-mode", "fff-health", "fff-rescan"] : ["fff-features", "reindex-fff", "fff-status"]).includes(name)),
			events: recordedEvents.filter((name) => !["session_start", "session_shutdown"].includes(name)),
			registrations: built.plan.trace.length - (scoped ? 11 : 9),
		},
		fuzzyRead,
		indexedGrep: true,
		customTool: true,
		editorInstalled: typeof editorFactory === "function",
		autocompleteInstalled,
		notifications,
	};
}

const results = [];
for (const scope of ["user", "project", "both"] as const) results.push(await run(scope));
console.log(JSON.stringify({ ok: true, piVersion: process.env.PI_VERSION, packageIdentity, piFffVersion: process.env.PI_FFF_VERSION, results }, null, 2));
