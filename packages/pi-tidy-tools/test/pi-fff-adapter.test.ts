import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	buildPiFffRegistrationPlan,
	createPiFffComposites,
	replayPiFffRegistrationPlan,
	TIDY_PI_FFF_CONFLICTS,
	type PiFffDiagnostic,
	type PiFffModuleLoader,
} from "../pi-fff/adapter.js";
import { createRunningPiFffLoader, readPackageVersionForEntry, resolveRunningPiAliases } from "../pi-fff/loader.js";

const textResult = (text = "ok", details: unknown = { source: "fff" }) => ({
	content: [{ type: "text", text }], details, terminate: true,
});

function readTool(overrides: Record<string, unknown> = {}) {
	return {
		name: "read", label: "FFF read", description: "read metadata",
		parameters: { type: "object", properties: {
			path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" },
		}, required: ["path"] },
		execute() { return textResult("read"); },
		...overrides,
	};
}

function grepTool(overrides: Record<string, unknown> = {}) {
	return {
		name: "grep", label: "FFF grep", description: "grep metadata", promptSnippet: "changed metadata",
		parameters: { type: "object", properties: {
			pattern: { type: "string" }, mode: { type: "string" }, path: { type: "string" },
			glob: { type: "string" }, constraints: { type: "string" }, cursor: { type: "string" },
			outputMode: { type: "string" }, ignoreCase: { type: "boolean" }, literal: { type: "boolean" },
			context: { type: "number" }, limit: { type: "number" },
		}, required: ["pattern"] },
		execute() { return textResult("grep"); },
		...overrides,
	};
}

function baselineFactory(extra?: (pi: any) => void) {
	let calls = 0;
	const factory = (pi: any) => {
		calls++;
		pi.registerTool(readTool());
		pi.registerTool(grepTool());
		pi.registerTool({ name: "find_files", label: "Find", description: "find", parameters: { type: "object", properties: {}, required: [] }, execute() { return textResult(); } });
		pi.registerCommand("fff-status", { description: "status", handler() {} });
		pi.on("session_start", () => {});
		pi.on("session_shutdown", () => {});
		extra?.(pi);
	};
	return { factory, calls: () => calls };
}

async function fixture(options: {
	projectEntry?: unknown; userEntry?: unknown; projectVersion?: string; userVersion?: string;
	projectIdentity?: "pi-fff" | "@ff-labs/pi-fff"; userIdentity?: "pi-fff" | "@ff-labs/pi-fff";
	projectFactory?: ReturnType<typeof baselineFactory>; userFactory?: ReturnType<typeof baselineFactory>;
	projectManifest?: Record<string, unknown>; userManifest?: Record<string, unknown>;
	projectLock?: Record<string, unknown>; userLock?: Record<string, unknown>;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "tidy-pi-fff-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const projectPackage = join(cwd, ".pi", "npm", "node_modules", "pi-fff");
	const userPackage = join(agentDir, "npm", "node_modules", "pi-fff");
	const factories = new Map<string, ReturnType<typeof baselineFactory>>();
	const writeScope = async (scope: "project" | "user", entry: unknown, version: string, supplied: ReturnType<typeof baselineFactory> | undefined, manifest: Record<string, unknown> | undefined, lock: Record<string, unknown> | undefined, identity: "pi-fff" | "@ff-labs/pi-fff") => {
		const settings = scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
		const managedRoot = scope === "project" ? join(cwd, ".pi", "npm") : join(agentDir, "npm");
		const packageRoot = join(managedRoot, "node_modules", ...identity.split("/"));
		await mkdir(packageRoot, { recursive: true });
		await writeFile(settings, JSON.stringify({ packages: [entry] }));
		await writeFile(join(packageRoot, "index.ts"), "export default function () {}\n");
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({
			name: identity, version, type: "module", pi: { extensions: ["./index.ts"] }, ...manifest,
		}));
		if (lock) await writeFile(join(packageRoot, "..", "..", "package-lock.json"), JSON.stringify(lock));
		factories.set(await realpath(join(packageRoot, "index.ts")), supplied ?? baselineFactory());
	};
	if (options.projectEntry !== undefined) await writeScope("project", options.projectEntry, options.projectVersion ?? "0.1.12", options.projectFactory, options.projectManifest, options.projectLock, options.projectIdentity ?? "pi-fff");
	if (options.userEntry !== undefined) await writeScope("user", options.userEntry, options.userVersion ?? "0.1.12", options.userFactory, options.userManifest, options.userLock, options.userIdentity ?? "pi-fff");
	const imports: string[] = [];
	const loader: PiFffModuleLoader = {
		async load(entryPath, aliases) {
			imports.push(entryPath);
			assert.ok(aliases.codingAgent);
			assert.ok(aliases.tui);
			assert.equal(aliases.typebox, aliases.sinclairTypebox);
			return factories.get(await realpath(entryPath))?.factory;
		},
	};
	return { root, cwd, agentDir, projectPackage, userPackage, loader, imports, factories };
}

function apiRecorder() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const api: any = { events: { on() {}, emit() {} } };
	for (const method of ["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on"]) {
		api[method] = (...args: unknown[]) => { calls.push({ method, args }); };
	}
	for (const method of ["getActiveTools", "getAllTools", "setActiveTools", "getCommands", "getFlag", "sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "getSessionName", "setLabel", "exec", "setModel", "getThinkingLevel", "setThinkingLevel", "shutdown", "abort", "compact"]) api[method] = () => undefined;
	return { api, calls };
}

async function buildFrom(f: Awaited<ReturnType<typeof fixture>>, api = apiRecorder().api, piVersion = "0.80.6", registryIntegrity?: string) {
	return buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion, api, loader: f.loader, registryIntegrity });
}

function expectCode(result: Awaited<ReturnType<typeof buildPiFffRegistrationPlan>>, code: PiFffDiagnostic["code"]) {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.diagnostic.code, code);
}

const filtered = (version = "0.1.12") => ({ source: `npm:pi-fff@${version}`, extensions: [] });
const entryForPreflight = filtered;
const INTEGRITY = "sha512-YWJjZA==";
const lockFor = (version = "0.1.12", overrides: Record<string, unknown> = {}) => ({
	name: "managed-pi-packages", lockfileVersion: 3,
	packages: { "node_modules/pi-fff": { version, resolved: `https://registry.npmjs.org/pi-fff/-/pi-fff-${version}.tgz`, integrity: INTEGRITY, ...overrides } },
});
const scopedFiltered = (version = "0.9.6") => ({ source: `npm:@ff-labs/pi-fff@${version}`, extensions: [] });
const scopedLock = (version = "0.9.6") => ({
	name: "managed-pi-packages", lockfileVersion: 3,
	packages: { "node_modules/@ff-labs/pi-fff": { version, resolved: `https://registry.npmjs.org/@ff-labs/pi-fff/-/pi-fff-${version}.tgz`, integrity: INTEGRITY } },
	dependencies: { "@ff-labs/pi-fff": { version, resolved: `https://registry.npmjs.org/@ff-labs/pi-fff/-/pi-fff-${version}.tgz`, integrity: INTEGRITY } },
});
function scopedTool(name: string, overrides: Record<string, unknown> = {}) {
	const capture = name === "ffgrep" || name === "fffind";
	const properties: Record<string, unknown> = capture ? {
		pattern: { type: "string" }, path: { type: "string" }, exclude: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
		limit: { type: "number" }, cursor: { type: "string" },
	} : { pattern: { type: "string" }, optional: { type: "number" } };
	if (name === "ffgrep") Object.assign(properties, { caseSensitive: { type: "boolean" }, context: { type: "number" } });
	return {
		name, label: name, description: `${name} metadata`, promptSnippet: `${name} snippet`, promptGuidelines: [`${name} guideline`],
		parameters: { type: "object", properties, required: ["pattern"] },
		execute() { return textResult(name); }, renderCall() {}, renderResult() {}, ...overrides,
	};
}

function registerScopedSurface(pi: any, tools: any[], extra?: (pi: any) => void, flags: readonly (readonly [string, "string" | "boolean"])[] = [["fff-mode", "string"], ["fff-frecency-db", "string"], ["fff-history-db", "string"], ["fff-enable-root-scan", "boolean"]]) {
	for (const [name, type] of flags) pi.registerFlag(name, { type });
	for (const tool of tools) pi.registerTool(tool);
	extra?.(pi);
	for (const name of ["fff-mode", "fff-health", "fff-rescan"]) pi.registerCommand(name, { handler() {} });
	pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
}

function scopedFactory(mode: "tools-and-ui" | "tools-only" | "override" = "tools-and-ui") {
	const source = baselineFactory();
	const renderCall = () => Symbol.for("call");
	const renderResult = () => Symbol.for("result");
	source.factory = (pi: any) => {
		assert.equal(pi.getFlag("fff-mode"), mode === "tools-and-ui" ? undefined : mode);
		for (const [name, type] of [["fff-mode", "string"], ["fff-frecency-db", "string"], ["fff-history-db", "string"], ["fff-enable-root-scan", "boolean"]] as const) pi.registerFlag(name, { type });
		const names = mode === "override" ? ["grep", "find", "multi_grep"] : ["ffgrep", "fffind", "fff-multi-grep"];
		for (const name of names) pi.registerTool(scopedTool(name, { renderCall, renderResult }));
		let append = pi.appendEntry;
		pi.registerCommand("fff-mode", { handler() { append("fff-mode", { mode: "tools-only" }); } });
		pi.registerCommand("fff-health", { handler() {} });
		pi.registerCommand("fff-rescan", { handler() {} });
		pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	return { source, renderCall, renderResult };
}

test("scoped profile captures raw pair and substitutes public tidy names in trace order", async () => {
	const scoped = scopedFactory();
	const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: scoped.source, userLock: scopedLock() });
	const real = apiRecorder(); real.api.getFlag = () => undefined; let appended = 0; real.api.appendEntry = () => { appended++; };
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.packageIdentity, "@ff-labs/pi-fff");
		assert.equal(result.plan.profile, "scoped"); if (result.plan.profile !== "scoped") return;
		assert.equal(result.plan.captureMode, "scoped-pair");
		assert.equal(result.plan.status, "verified");
		assert.equal(result.plan.captures.grep.name, "ffgrep");
		assert.equal(result.plan.captures.find.name, "fffind");
		assert.equal(real.calls.length, 0);
		const recordedMode = result.plan.trace.find((call) => call.method === "registerCommand" && call.args[0] === "fff-mode")?.args[1] as any;
		assert.throws(() => recordedMode.handler(), /registration-time action appendEntry is unsafe/);
		const composites = createPiFffComposites(result.plan, { mode: "default", reasoningGuideline: "State the goal." });
		assert.equal(replayPiFffRegistrationPlan(result.plan, real.api, composites).ok, true);
		const tools = real.calls.filter((call) => call.method === "registerTool").map((call) => call.args[0] as any);
		assert.deepEqual(tools.map((tool) => tool.name), ["grep", "find", "fff-multi-grep"]);
		assert.equal(tools.filter((tool) => ["ffgrep", "fffind"].includes(tool.name)).length, 0);
		assert.equal(tools[0], composites.grep); assert.equal(tools[1], composites.find);
		assert.equal(composites.grep.renderCall, scoped.renderCall); assert.equal(composites.grep.renderResult, scoped.renderResult);
		const mode = real.calls.find((call) => call.method === "registerCommand" && call.args[0] === "fff-mode")?.args[1] as any;
		mode.handler();
		assert.equal(appended, 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped tools-only trace captures the same explicit pair", async () => {
	const toolsOnly = scopedFactory("tools-only");
	const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: toolsOnly.source });
	const real = apiRecorder(); real.api.getFlag = () => "tools-only";
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.captureMode, "scoped-pair");
		assert.deepEqual(result.plan.trace.filter((call) => call.method === "registerTool").map((call) => (call.args[0] as any).name), ["ffgrep", "fffind", "fff-multi-grep"]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped 0.6.0 schema and newer optional additions both validate", async () => {
	const grep = scopedTool("ffgrep", { parameters: { type: "object", properties: {
		pattern: { type: "string" }, path: { type: "string" }, literal: { type: "boolean" }, context: { type: "number" }, limit: { type: "number" }, cursor: { type: "string" },
	}, required: ["pattern"] } });
	const find = scopedTool("fffind", { parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }, required: ["pattern"] } });
	const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, [grep, find], undefined, [["fff-mode", "string"], ["fff-frecency-db", "string"], ["fff-history-db", "string"]]);
	const f = await fixture({ userEntry: scopedFiltered("0.6.0"), userVersion: "0.6.0", userIdentity: "@ff-labs/pi-fff", userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok || result.plan.profile !== "scoped") return;
		assert.equal(result.plan.captures.grep.parameters.properties.literal.type, "boolean");
		assert.equal(result.plan.captures.find.parameters.properties.cursor, undefined);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped 0.9.5+ requires the fourth current flag", async () => {
	const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, [scopedTool("ffgrep"), scopedTool("fffind")], undefined, [["fff-mode", "string"], ["fff-frecency-db", "string"], ["fff-history-db", "string"]]);
	const f = await fixture({ userEntry: scopedFiltered("0.9.5"), userVersion: "0.9.5", userIdentity: "@ff-labs/pi-fff", userFactory: source });
	try { expectCode(await buildFrom(f), "PIFFF_SURFACE_BREAKING"); }
	finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped composites preserve metadata, schemas by mode, and exact execution semantics", async () => {
	const signal = new AbortController().signal;
	const update = () => {};
	const context = { cwd: "/scoped" };
	const settled = textResult("scoped result", { totalMatched: 2 });
	let observed: unknown[] = [];
	const grep = scopedTool("ffgrep", { marker: Symbol.for("grep"), execute(this: unknown, ...args: unknown[]) { observed = [this, ...args]; (args[3] as Function)(textResult("update")); return settled; } });
	const find = scopedTool("fffind");
	const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, [grep, find]);
	const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok || result.plan.profile !== "scoped") return;
		assert.equal(result.plan.captures.grep, grep); assert.equal(result.plan.captures.find, find);
		const resultMode = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(resultMode.grep.parameters, grep.parameters);
		assert.equal(resultMode.grep.promptGuidelines, grep.promptGuidelines);
		assert.equal(resultMode.grep.name, "grep"); assert.equal(resultMode.find.name, "find");
		const defaults = createPiFffComposites(result.plan, { mode: "default", reasoningGuideline: "reason" });
		assert.equal(defaults.grep.parameters.required[0], "reasoning");
		assert.deepEqual(defaults.grep.promptGuidelines, [...grep.promptGuidelines, "reason"]);
		const params = { reasoning: "search index", pattern: "needle", optional: 1, nested: { same: true } };
		const updates: unknown[] = [];
		const onUpdate = (value: unknown) => { updates.push(value); update(); };
		assert.equal(await defaults.grep.execute("id", params, signal, onUpdate, context), settled);
		assert.equal(observed[0], grep); assert.equal(observed.length, 6);
		assert.equal(observed[1], "id"); assert.deepEqual(observed[2], { pattern: "needle", optional: 1, nested: params.nested });
		assert.equal((observed[2] as any).nested, params.nested); assert.equal(observed[3], signal); assert.equal(observed[4], onUpdate); assert.equal(observed[5], context);
		assert.equal(updates.length, 1);
		const aborted = new DOMException("aborted", "AbortError");
		find.execute = () => { throw aborted; };
		assert.throws(() => defaults.find.execute("id", { pattern: "x", reasoning: "find x" }, signal, update, context), (error) => error === aborted);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped capture failures and target conflicts fail before replay", async (t) => {
	const cases: Array<[string, any[], Record<string, unknown> | undefined]> = [
		["missing ffgrep", [scopedTool("fffind")], undefined],
		["missing fffind", [scopedTool("ffgrep")], undefined],
		["duplicate ffgrep", [scopedTool("ffgrep"), scopedTool("ffgrep"), scopedTool("fffind")], undefined],
		["duplicate fffind", [scopedTool("ffgrep"), scopedTool("fffind"), scopedTool("fffind")], undefined],
		["malformed definition", [scopedTool("ffgrep", { parameters: { type: "string" } }), scopedTool("fffind")], undefined],
		["missing baseline property", [scopedTool("ffgrep", { parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } }), scopedTool("fffind")], undefined],
		["narrowed primitive property", [scopedTool("ffgrep", { parameters: { ...scopedTool("ffgrep").parameters, properties: { ...scopedTool("ffgrep").parameters.properties, path: { type: "string", enum: ["src"] } } } }), scopedTool("fffind")], undefined],
		["malformed prompt guidance", [scopedTool("ffgrep", { promptGuidelines: ["valid", 42] }), scopedTool("fffind")], undefined],
		["source reasoning", [scopedTool("ffgrep", { parameters: { type: "object", properties: { reasoning: { type: "string" } } } }), scopedTool("fffind")], undefined],
		["target grep conflict", [scopedTool("ffgrep"), scopedTool("fffind")], { tools: ["grep"] }],
		["target find conflict", [scopedTool("ffgrep"), scopedTool("fffind")], { tools: ["find"] }],
	];
	for (const [name, tools, conflicts] of cases) await t.test(name, async () => {
		const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, tools);
		const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: source });
		const real = apiRecorder();
		try {
			const result = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: real.api, loader: f.loader, conflicts });
			expectCode(result, "PIFFF_SURFACE_BREAKING"); assert.equal(real.calls.length, 0);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("legacy compatible-forward find addition conflicts before replay", async () => {
	const source = baselineFactory((pi) => pi.registerTool(scopedTool("find")));
	const f = await fixture({ userEntry: filtered("0.2.0"), userVersion: "0.2.0", userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.81.0", api: real.api, loader: f.loader });
		expectCode(result, "PIFFF_SURFACE_BREAKING");
		assert.equal(real.calls.length, 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped production static conflicts allow substitutions while caller targets fail", async (t) => {
	assert.deepEqual(TIDY_PI_FFF_CONFLICTS, {
		tools: ["write", "edit", "bash", "ls"], commands: ["tidy", "diff"],
		shortcuts: ["ctrl+shift+o"], messageRenderers: ["minimal-turn-diff"],
	});
	const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, [scopedTool("ffgrep"), scopedTool("fffind")]);
	for (const [name, conflicts, expected] of [
		["production static configuration", undefined, true],
		["caller grep conflict", { tools: ["grep"] }, false],
		["caller find conflict", { tools: ["find"] }, false],
	] as const) await t.test(name, async () => {
		const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: source });
		const real = apiRecorder();
		try {
			const result = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: real.api, loader: f.loader, conflicts });
			assert.equal(result.ok, expected);
			if (!expected) expectCode(result, "PIFFF_SURFACE_BREAKING");
			assert.equal(real.calls.length, 0);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("scoped compatible additions replay once around substituted slots", async () => {
	const before = () => textResult("before"); const after = () => {};
	const source = baselineFactory(); source.factory = (pi: any) => registerScopedSurface(pi, [
		scopedTool("future-before", { execute: before }), scopedTool("ffgrep"), scopedTool("future-middle"), scopedTool("fffind"),
	], (recording) => recording.registerShortcut("ctrl+f", { handler: after }));
	const f = await fixture({ userEntry: scopedFiltered("1.0.0"), userVersion: "1.0.0", userIdentity: "@ff-labs/pi-fff", userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildFrom(f, real.api); assert.equal(result.ok, true); if (!result.ok || result.plan.profile !== "scoped") return;
		const composites = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(replayPiFffRegistrationPlan(result.plan, real.api, composites).ok, true);
		assert.deepEqual(real.calls.slice(4, 9).map((call) => call.method === "registerTool" ? (call.args[0] as any).name : `${call.method}:${call.args[0]}`), ["future-before", "grep", "future-middle", "find", "registerShortcut:ctrl+f"]);
		assert.equal((real.calls[4]!.args[0] as any).execute, before); assert.equal((real.calls[8]!.args[1] as any).handler, after);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scoped override mode and mixed identities fail before replay", async () => {
	const override = scopedFactory("override");
	const f = await fixture({ userEntry: scopedFiltered(), userVersion: "0.9.6", userIdentity: "@ff-labs/pi-fff", userFactory: override.source });
	const real = apiRecorder(); real.api.getFlag = () => "override";
	try {
		expectCode(await buildFrom(f, real.api), "PIFFF_SURFACE_BREAKING");
		assert.equal(real.calls.length, 0);
		await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [scopedFiltered(), filtered()] }));
		expectCode(await buildFrom(f, real.api), "PIFFF_CONFIG_AMBIGUOUS");
		assert.equal(real.calls.length, 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("managed discovery selects canonical project root and never falls back", async () => {
	const invalidProject = baselineFactory();
	const f = await fixture({ projectEntry: { source: "npm:pi-fff@0.1.12", extensions: ["./index.ts"] }, userEntry: filtered(), projectFactory: invalidProject });
	try {
		const result = await buildFrom(f);
		expectCode(result, "PIFFF_SCOPE_SHADOWED_INVALID");
		assert.equal(f.imports.length, 0);
		assert.equal(invalidProject.calls(), 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("lifecycle preflight can fully validate selected and shadowed participants independently", async () => {
	const project = baselineFactory();
	const user = baselineFactory();
	const f = await fixture({ projectEntry: entryForPreflight(), userEntry: entryForPreflight(), projectFactory: project, userFactory: user });
	try {
		const projectResult = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: apiRecorder().api, loader: f.loader, selection: { scope: "project", entry: entryForPreflight() } });
		const userResult = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: apiRecorder().api, loader: f.loader, selection: { scope: "user", entry: entryForPreflight() } });
		assert.equal(projectResult.ok && projectResult.plan.scope, "project");
		assert.equal(userResult.ok && userResult.plan.scope, "user");
		assert.equal(project.calls(), 1); assert.equal(user.calls(), 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("valid project scope wins over user and a broken selected artifact never falls back", async () => {
	const project = baselineFactory();
	const user = baselineFactory();
	const both = await fixture({ projectEntry: filtered(), userEntry: filtered(), projectFactory: project, userFactory: user });
	const broken = await fixture({ projectEntry: filtered(), userEntry: filtered(), projectManifest: { name: "other" }, userFactory: user });
	try {
		const selected = await buildFrom(both);
		assert.equal(selected.ok && selected.plan.scope, "project");
		assert.equal(project.calls(), 1);
		assert.equal(user.calls(), 0);
		expectCode(await buildFrom(broken), "PIFFF_PACKAGE_INVALID");
		assert.equal(broken.imports.length, 0);
	} finally {
		await rm(both.root, { recursive: true, force: true });
		await rm(broken.root, { recursive: true, force: true });
	}
});

test("managed discovery ignores non-npm scope and rejects string filters", async () => {
	const ignored = await fixture({ projectEntry: "git:github.com/example/pi-fff", userEntry: filtered() });
	const stringOnly = await fixture({ userEntry: "npm:pi-fff@0.1.12" });
	try {
		const selected = await buildFrom(ignored);
		assert.equal(selected.ok && selected.plan.scope, "user");
		expectCode(await buildFrom(stringOnly), "PIFFF_CONFIG_FILTER_REQUIRED");
	} finally {
		await rm(ignored.root, { recursive: true, force: true });
		await rm(stringOnly.root, { recursive: true, force: true });
	}
});

test("canonical package checks reject symlink escapes, mismatches, and wrong identities", async () => {
	const escaped = await fixture({ userEntry: filtered() });
	const wrong = await fixture({ userEntry: filtered(), userManifest: { name: "not-pi-fff" } });
	const mismatch = await fixture({ userEntry: filtered("0.2.0"), userVersion: "0.3.0" });
	try {
		const outside = join(escaped.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "package.json"), JSON.stringify({ name: "pi-fff", version: "0.1.12", pi: { extensions: ["./index.ts"] } }));
		await writeFile(join(outside, "index.ts"), "export default () => {}\n");
		await rm(escaped.userPackage, { recursive: true });
		await symlink(outside, escaped.userPackage, "dir");
		expectCode(await buildFrom(escaped), "PIFFF_PACKAGE_INVALID");
		expectCode(await buildFrom(wrong), "PIFFF_PACKAGE_INVALID");
		expectCode(await buildFrom(mismatch), "PIFFF_PACKAGE_INVALID");
	} finally {
		await rm(escaped.root, { recursive: true, force: true });
		await rm(wrong.root, { recursive: true, force: true });
		await rm(mismatch.root, { recursive: true, force: true });
	}
});

test("lock identity, version, resolved, and integrity are checked offline", async (t) => {
	await t.test("matching local lock continues with registry-unverified information", async () => {
		const f = await fixture({ userEntry: filtered(), userLock: lockFor() });
		try {
			const result = await buildFrom(f);
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(result.plan.integrity, "registry-unverified");
			assert.equal(result.plan.diagnostics[0]?.code, "PIFFF_INTEGRITY_UNVERIFIED");
			assert.equal(result.plan.diagnostics[0]?.severity, "info");
			const verified = await fixture({ userEntry: filtered(), userLock: lockFor() });
			try {
				const available = await buildFrom(verified, apiRecorder().api, "0.80.6", INTEGRITY);
				assert.equal(available.ok && available.plan.integrity, "verified");
			} finally { await rm(verified.root, { recursive: true, force: true }); }
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
	for (const [name, lock, registry] of [
		["version mismatch", lockFor("0.2.0"), undefined],
		["identity mismatch", lockFor("0.1.12", { name: "other" }), undefined],
		["malformed resolved", lockFor("0.1.12", { resolved: 42 }), undefined],
		["resolved identity mismatch", lockFor("0.1.12", { resolved: "https://registry.npmjs.org/other/-/other-0.1.12.tgz" }), undefined],
		["malformed integrity", lockFor("0.1.12", { integrity: "not-sri" }), undefined],
		["registry mismatch", lockFor(), "sha512-ZGlmZmVyZW50"],
	] as const) await t.test(name, async () => {
		const f = await fixture({ userEntry: filtered(), userLock: lock });
		try { expectCode(await buildFrom(f, apiRecorder().api, "0.80.6", registry), "PIFFF_INTEGRITY_MISMATCH"); }
		finally { await rm(f.root, { recursive: true, force: true }); }
	});
	await t.test("missing integrity remains compatible", async () => {
		const f = await fixture({ userEntry: filtered(), userLock: lockFor("0.1.12", { integrity: undefined }) });
		try {
			const result = await buildFrom(f);
			assert.equal(result.ok && result.plan.integrity, "missing");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("version floors have no upper bound and status is explicit", async () => {
	const baseline = await fixture({ userEntry: filtered() });
	const future = await fixture({ userEntry: filtered("9.4.0"), userVersion: "9.4.0" });
	try {
		const verified = await buildFrom(baseline);
		assert.equal(verified.ok && verified.plan.status, "verified");
		const forward = await buildFrom(future, apiRecorder().api, "8.0.0");
		assert.equal(forward.ok && forward.plan.status, "forward-compatible/unverified");
		expectCode(await buildFrom(baseline, apiRecorder().api, "0.80.5"), "PIFFF_BELOW_MINIMUM");
		const oldFff = await fixture({ userEntry: filtered("0.1.11"), userVersion: "0.1.11" });
		try { expectCode(await buildFrom(oldFff), "PIFFF_BELOW_MINIMUM"); }
		finally { await rm(oldFff.root, { recursive: true, force: true }); }
	} finally {
		await rm(baseline.root, { recursive: true, force: true });
		await rm(future.root, { recursive: true, force: true });
	}
});

test("scoped profile enforces 0.6.0 floor independently", async () => {
	const old = await fixture({ userEntry: scopedFiltered("0.5.9"), userVersion: "0.5.9", userIdentity: "@ff-labs/pi-fff", userFactory: scopedFactory().source });
	const floor = await fixture({ userEntry: scopedFiltered("0.6.0"), userVersion: "0.6.0", userIdentity: "@ff-labs/pi-fff", userFactory: scopedFactory().source });
	try {
		expectCode(await buildFrom(old), "PIFFF_BELOW_MINIMUM");
		const accepted = await buildFrom(floor); assert.equal(accepted.ok, true);
		assert.equal(accepted.ok && accepted.plan.status, "forward-compatible/unverified");
	} finally { await rm(old.root, { recursive: true, force: true }); await rm(floor.root, { recursive: true, force: true }); }
});

test("SemVer rejects malformed cores and honors prerelease precedence", async () => {
	const malformedPi = await fixture({ userEntry: filtered() });
	const leadingFff = await fixture({ userEntry: filtered("01.1.12"), userVersion: "01.1.12" });
	const prereleaseFloor = await fixture({ userEntry: filtered("0.1.12-rc.1"), userVersion: "0.1.12-rc.1" });
	const futurePrerelease = await fixture({ userEntry: filtered("0.1.13-alpha.2"), userVersion: "0.1.13-alpha.2" });
	try {
		expectCode(await buildFrom(malformedPi, apiRecorder().api, "01.80.6"), "PIFFF_BELOW_MINIMUM");
		expectCode(await buildFrom(leadingFff), "PIFFF_BELOW_MINIMUM");
		expectCode(await buildFrom(prereleaseFloor), "PIFFF_BELOW_MINIMUM");
		const future = await buildFrom(futurePrerelease);
		assert.equal(future.ok && future.plan.status, "forward-compatible/unverified");
		assert.equal(future.ok && future.plan.diagnostics.some((item) => item.code === "PIFFF_FORWARD_UNVERIFIED"), true);
	} finally {
		for (const f of [malformedPi, leadingFff, prereleaseFloor, futurePrerelease]) await rm(f.root, { recursive: true, force: true });
	}
});

test("running Pi Jiti aliases legacy peers and shared TypeBox to one identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "tidy-pi-fff-loader-"));
	const entry = join(root, "entry.ts");
	const codingEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const previousArgv = process.argv[1];
	try {
		process.argv[1] = codingEntry;
		await writeFile(entry, `
			import { VERSION } from "@mariozechner/pi-coding-agent";
			import { Text } from "@mariozechner/pi-tui";
			import { Type as LegacyType } from "@sinclair/typebox";
			import { Type } from "typebox";
			export default function () { return { VERSION, Text, sameType: LegacyType === Type }; }
		`);
		const { loader, aliases } = createRunningPiFffLoader();
		assert.equal(aliases["@mariozechner/pi-coding-agent"], aliases.codingAgent);
		assert.equal(aliases["@mariozechner/pi-tui"], aliases.tui);
		assert.equal(aliases["@sinclair/typebox"], aliases.typebox);
		const loaded = await loader.load(entry, aliases);
		assert.equal(typeof loaded, "function");
		const evidence = (loaded as () => any)();
		assert.equal(evidence.VERSION, "0.80.6");
		assert.equal(typeof evidence.Text, "function");
		assert.equal(evidence.sameType, true);
		assert.equal(readPackageVersionForEntry(codingEntry), "0.80.6");
		assert.throws(() => readPackageVersionForEntry(join(root, "missing", "entry.js")), /running Pi package root is unavailable/);
	} finally {
		process.argv[1] = previousArgv;
		await rm(root, { recursive: true, force: true });
	}
});

test("running Pi resolution handles host manifests and rejects missing Jiti capability", async () => {
	const root = await mkdtemp(join(process.cwd(), ".loader-host-"));
	const cli = join(root, "dist", "cli.js");
	const jitiRoot = join(root, "node_modules", "jiti");
	const previousArgv = process.argv[1];
	try {
		await mkdir(join(root, "dist"), { recursive: true });
		await mkdir(jitiRoot, { recursive: true });
		await writeFile(cli, "// fixture CLI\n");
		await writeFile(join(root, "index.js"), "export {};\n");
		await writeFile(join(root, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./index.js" } },
		}));
		await writeFile(join(jitiRoot, "package.json"), JSON.stringify({
			name: "jiti", exports: { "./package.json": "./package.json", "./static": { import: "./static.mjs" } },
		}));
		await writeFile(join(jitiRoot, "static.mjs"), "export const unavailable = true;\n");
		process.argv[1] = cli;
		const resolved = resolveRunningPiAliases();
		assert.equal(resolved.aliases.codingAgent, join(root, "index.js"));
		assert.equal(resolved.jitiEntry, join(jitiRoot, "static.mjs"));
		const missingFactory = createRunningPiFffLoader();
		await assert.rejects(missingFactory.loader.load(join(root, "entry.ts"), missingFactory.aliases), /running Pi Jiti factory is unavailable/);

		await writeFile(join(jitiRoot, "package.json"), JSON.stringify({
			name: "jiti", exports: { "./package.json": "./package.json", "./static": { import: {} } },
		}));
		assert.throws(resolveRunningPiAliases, /running Pi Jiti static export is unavailable/);
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "not-pi" }));
		resolveRunningPiAliases();
		await writeFile(join(root, "package.json"), "{");
		resolveRunningPiAliases();
		delete process.argv[1];
		resolveRunningPiAliases();
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "not-pi" }));
		assert.throws(() => readPackageVersionForEntry(join(root, "index.js")), /package version is unavailable/);
	} finally {
		process.argv[1] = previousArgv;
		await rm(root, { recursive: true, force: true });
	}
});

test("factory is loaded and invoked once while real registrations remain zero", async () => {
	const source = baselineFactory();
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true);
		assert.equal(f.imports.length, 1);
		assert.equal(source.calls(), 1);
		assert.equal(real.calls.length, 0);
		assert.deepEqual(result.ok && result.plan.trace.map((call) => call.method), ["registerTool", "registerTool", "registerTool", "registerCommand", "on", "on"]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("async factory and result are awaited exactly once", async () => {
	const expected = textResult("async");
	const source = baselineFactory();
	let calls = 0;
	source.factory = async (pi: any) => {
		calls++;
		await Promise.resolve();
		pi.registerTool(readTool({ async execute() { await Promise.resolve(); return expected; } }));
		pi.registerTool(grepTool());
		pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f);
		assert.equal(result.ok, true); assert.equal(calls, 1); if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy"); if (result.plan.profile !== "legacy") return;
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(await tools.read.execute("id", { path: "x" }, undefined, undefined, {}), expected);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("compatible forward additions preserve metadata, tool schema, identities, and order on replay", async () => {
	const marker = Symbol("metadata");
	const extraHandler = () => {};
	const extraExecute = () => textResult("future");
	const source = baselineFactory((pi) => {
		pi.registerShortcut("ctrl+x", { description: "forward", handler: extraHandler });
	});
	source.factory = (pi: any) => {
		pi.registerTool(readTool({ marker, promptGuidelines: ["new prompt"], parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, encoding: { type: "string" } }, required: ["path"] } }));
		pi.registerTool(grepTool());
		pi.on("session_start", extraHandler);
		pi.registerTool({ name: "future_tool", label: "Future", description: "future", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, execute: extraExecute });
		pi.registerShortcut("ctrl+x", { description: "forward", handler: extraHandler });
		pi.on("session_shutdown", extraHandler);
	};
	const f = await fixture({ userEntry: filtered("0.2.0"), userVersion: "0.2.0", userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy");
		if (result.plan.profile !== "legacy") return;
		assert.equal(result.plan.captures.read.marker, marker);
		assert.ok(result.plan.captures.read.parameters.properties.encoding);
		const composites = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		const replay = replayPiFffRegistrationPlan(result.plan, real.api, composites);
		assert.equal(replay.ok, true);
		assert.deepEqual(real.calls.map((call) => call.method), ["registerTool", "registerTool", "on", "registerTool", "registerShortcut", "on"]);
		assert.equal(real.calls[0]?.args[0], composites.read);
		assert.equal(real.calls[2]?.args[1], extraHandler);
		assert.equal((real.calls[3]?.args[0] as any).parameters.properties.query.type, "string");
		assert.equal((real.calls[3]?.args[0] as any).execute, extraExecute);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("breaking surface matrix fails closed with stable diagnostics", async (t) => {
	const cases: Array<[string, (pi: any) => void]> = [
		["missing read", (pi) => { pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["missing grep", (pi) => { pi.registerTool(readTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["missing both", (pi) => { pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["noncallable captured executor", (pi) => { pi.registerTool(readTool({ execute: "no" })); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["source-owned captured reasoning", (pi) => { pi.registerTool(readTool({ parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, reasoning: { type: "string" } }, required: ["path"] } })); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["malformed forwarded parameters", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); pi.registerTool({ name: "future", label: "Future", description: "future", parameters: { type: "string" }, execute() {} }); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["noncallable forwarded executor", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); pi.registerTool({ name: "future", label: "Future", description: "future", parameters: { type: "object", properties: {} }, execute: null }); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["duplicate grep", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["changed baseline type", (pi) => { pi.registerTool(readTool({ parameters: { type: "object", properties: { path: { type: "number" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } })); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["optional made required", (pi) => { pi.registerTool(readTool({ parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path", "offset"] } })); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["missing lifecycle", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); }],
		["overlapping tidy tool", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); pi.registerTool({ ...readTool(), name: "write" }); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["unsafe unregister", (pi) => { pi.registerTool(readTool()); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); pi.unregisterProvider("x"); }],
		["unknown registration", (pi) => { void pi.registerWidget; }],
	];
	for (const [name, customFactory] of cases) await t.test(name, async () => {
		const source = baselineFactory(); source.factory = customFactory;
		const f = await fixture({ userEntry: filtered(), userFactory: source });
		const real = apiRecorder();
		try {
			expectCode(await buildFrom(f, real.api), "PIFFF_SURFACE_BREAKING");
			assert.equal(real.calls.length, 0);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("semantic singleton primitive schema forms pass without accepting broadened unions", async () => {
	const equivalent = baselineFactory();
	equivalent.factory = (pi: any) => {
		pi.registerTool(readTool({ parameters: { type: "object", properties: { path: { anyOf: [{ type: "string" }] }, offset: { type: ["number"] }, limit: { oneOf: [{ type: "number" }] } }, required: ["path"] } }));
		pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const broadened = baselineFactory();
	broadened.factory = (pi: any) => {
		pi.registerTool(readTool({ parameters: { type: "object", properties: { path: { anyOf: [{ type: "string" }, { type: "number" }] }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } }));
		pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const accepted = await fixture({ userEntry: filtered(), userFactory: equivalent });
	const rejected = await fixture({ userEntry: filtered(), userFactory: broadened });
	try {
		assert.equal((await buildFrom(accepted)).ok, true);
		expectCode(await buildFrom(rejected), "PIFFF_SURFACE_BREAKING");
	} finally {
		await rm(accepted.root, { recursive: true, force: true });
		await rm(rejected.root, { recursive: true, force: true });
	}
});

test("known registration methods validate and preserve nonconflicting additions", async () => {
	const fn = () => {};
	const source = baselineFactory((pi) => {
		pi.registerShortcut("ctrl+k", { handler: fn });
		pi.registerFlag("fff-flag", { type: "boolean" });
		pi.registerMessageRenderer("fff-message", fn);
		pi.registerEntryRenderer("fff-entry", fn);
		pi.registerProvider("fff-provider", { name: "FFF" });
	});
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f);
		assert.equal(result.ok, true); if (!result.ok) return;
		assert.deepEqual(result.plan.trace.slice(-5).map((call) => call.method), ["registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider"]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("known registration conflicts fail before replay", async (t) => {
	for (const [name, command, conflicts] of [
		["caller conflict", "taken", { commands: ["taken"] }],
		["built-in tidy conflict", "tidy", undefined],
	] as const) await t.test(name, async () => {
		const source = baselineFactory((pi) => pi.registerCommand(command, { handler() {} }));
		const f = await fixture({ userEntry: filtered(), userFactory: source });
		const real = apiRecorder();
		try {
			const result = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: real.api, loader: f.loader, conflicts });
			expectCode(result, "PIFFF_SURFACE_BREAKING");
			assert.equal(real.calls.length, 0);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("load, factory, and capability failures are sanitized and side-effect free", async () => {
	const f = await fixture({ userEntry: filtered() });
	try {
		const missingApi = apiRecorder(); delete missingApi.api.registerFlag;
		expectCode(await buildFrom(f, missingApi.api), "PIFFF_CAPABILITY_MISSING");
		const load = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: apiRecorder().api, loader: { async load() { throw new Error("secret\nstack"); } } });
		expectCode(load, "PIFFF_LOAD_FAILED");
		const throwing = baselineFactory(); throwing.factory = (pi: any) => { pi.registerTool(readTool()); throw new Error("factory secret\nstack"); };
		const ff = await fixture({ userEntry: filtered(), userFactory: throwing });
		try { expectCode(await buildFrom(ff), "PIFFF_FACTORY_FAILED"); }
		finally { await rm(ff.root, { recursive: true, force: true }); }
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("registration-time mutators and property writes cannot escape the recorder", async (t) => {
	for (const [name, escape] of [
		["message", (pi: any) => pi.sendMessage({ customType: "unsafe", content: "x" })],
		["shutdown", (pi: any) => pi.shutdown()],
		["abort", (pi: any) => pi.abort()],
		["compact", (pi: any) => pi.compact()],
		["api write", (pi: any) => { pi.changed = true; }],
		["events write", (pi: any) => { pi.events.changed = true; }],
		["events call", (pi: any) => pi.events.emit("unsafe")],
	] as const) await t.test(name, async () => {
		const source = baselineFactory(escape);
		const f = await fixture({ userEntry: filtered(), userFactory: source });
		const real = apiRecorder();
		try {
			expectCode(await buildFrom(f, real.api), "PIFFF_SURFACE_BREAKING");
			assert.equal(real.calls.length, 0);
			assert.equal(real.api.changed, undefined);
			assert.equal(real.api.events.changed, undefined);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("deferred API closures bind the real receiver only after activation", async () => {
	let handler: (() => void) | undefined;
	let receiver: unknown;
	const source = baselineFactory((pi) => {
		const deferred = pi.sendMessage;
		pi.registerCommand("deferred", { handler() { deferred({ customType: "safe", content: "x" }); } });
	});
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	const real = apiRecorder();
	real.api.sendMessage = function () { receiver = this; };
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true); if (!result.ok) return;
		handler = result.plan.trace.find((call) => call.method === "registerCommand" && call.args[0] === "deferred")?.args[1] && (result.plan.trace.find((call) => call.method === "registerCommand" && call.args[0] === "deferred")!.args[1] as any).handler;
		assert.throws(() => handler!(), /registration-time action/);
		const composites = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(replayPiFffRegistrationPlan(result.plan, real.api, composites).ok, true);
		handler!();
		assert.equal(receiver, real.api);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("composite delegation preserves receiver, five arguments, updates, results, aborts, and errors", async () => {
	const signal = new AbortController().signal;
	const update = () => {};
	const context = { cwd: "/fixture" };
	const expected = textResult("delegated", { resolution: "fuzzy" });
	let observed: unknown[] = [];
	const source = baselineFactory();
	source.factory = (pi: any) => {
		const read = readTool({ execute(this: unknown, ...args: unknown[]) { observed = [this, ...args]; return expected; } });
		pi.registerTool(read); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy"); if (result.plan.profile !== "legacy") return;
		const composites = createPiFffComposites(result.plan, { mode: "default", reasoningGuideline: "reason" });
		const params = { path: "x", reasoning: "find x", extra: { same: true } };
		const actual = await composites.read.execute("id", params, signal, update, context);
		assert.equal(actual, expected);
		assert.equal(observed[0], result.plan.captures.read);
		assert.equal(observed[1], "id");
		assert.deepEqual(observed[2], { path: "x", extra: params.extra });
		assert.equal((observed[2] as any).extra, params.extra);
		assert.equal(observed[3], signal); assert.equal(observed[4], update); assert.equal(observed[5], context);
		const aborted = new DOMException("aborted", "AbortError");
		result.plan.captures.grep.execute = () => { throw aborted; };
		assert.throws(() => composites.grep.execute("id", {}, signal, update, context), (error) => error === aborted);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("malformed settled results fail closed without native retry", async () => {
	let executions = 0;
	const source = baselineFactory();
	source.factory = (pi: any) => {
		pi.registerTool(readTool({ execute() { executions++; return { content: "bad" }; } }));
		pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy"); if (result.plan.profile !== "legacy") return;
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.throws(() => tools.read.execute("id", { path: "x" }, undefined, undefined, {}), (error: any) => error?.code === "PIFFF_EXEC_RESULT_INVALID");
		assert.equal(executions, 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("partial updates preserve callback, object identity, and source behavior naturally", async () => {
	const validPartial = { ...textResult("partial", { truncation: { truncated: false } }), custom: Symbol("kept") };
	const settled = { ...textResult("settled"), custom: "field" };
	const observed: unknown[] = [];
	let malformed = false;
	const source = baselineFactory();
	source.factory = (pi: any) => {
		pi.registerTool(readTool({ execute(_id: string, _params: any, _signal: any, onUpdate: any) {
			onUpdate(validPartial);
			if (malformed) onUpdate({ content: "bad" });
			return settled;
		} }));
		pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy"); if (result.plan.profile !== "legacy") return;
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		const actual = await tools.read.execute("id", { path: "x" }, undefined, (value: unknown) => observed.push(value), {});
		assert.equal(actual, settled);
		assert.equal(observed[0], validPartial);
		malformed = true;
		const malformedUpdates: unknown[] = [];
		assert.equal(await tools.read.execute("id", { path: "x" }, undefined, (value: unknown) => malformedUpdates.push(value), {}), settled);
		assert.deepEqual(malformedUpdates[1], { content: "bad" });
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("read and grep result families preserve native and FFF details", async () => {
	const families = [
		textResult("native read", { source: "native" }),
		textResult("missing read", { resolution: { attempted: "fuzzy" } }),
		textResult("native grep", { matches: 2 }),
		textResult("indexed grep", { truncation: { truncated: true }, limit: 20, scope: ".", cursor: "next", constraints: "*.ts", suggestion: "narrow", error: { code: "FFF" }, disabledFeature: false }),
	];
	let index = 0;
	const source = baselineFactory();
	source.factory = (pi: any) => {
		pi.registerTool(readTool({ execute() { return families[index++]!; } }));
		pi.registerTool(grepTool({ execute() { return families[index++]!; } }));
		pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
	};
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.plan.profile, "legacy"); if (result.plan.profile !== "legacy") return;
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(await tools.read.execute("1", {}, undefined, undefined, {}), families[0]);
		assert.equal(await tools.read.execute("2", {}, undefined, undefined, {}), families[1]);
		assert.equal(await tools.grep.execute("3", {}, undefined, undefined, {}), families[2]);
		assert.equal(await tools.grep.execute("4", {}, undefined, undefined, {}), families[3]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("diagnostics provide condition-specific safe recovery actions", async () => {
	const missing = await fixture();
	const invalid = await fixture({ userEntry: filtered(), userLock: lockFor("0.2.0") });
	try {
		const noConfig = await buildFrom(missing);
		assert.equal(noConfig.ok, false); if (noConfig.ok) return;
		assert.match(noConfig.diagnostic.action, /Install pi-fff/);
		const mismatch = await buildFrom(invalid);
		assert.equal(mismatch.ok, false); if (mismatch.ok) return;
		assert.equal(mismatch.diagnostic.code, "PIFFF_INTEGRITY_MISMATCH");
		assert.match(mismatch.diagnostic.action, /Reinstall/);
		assert.notEqual(noConfig.diagnostic.action, mismatch.diagnostic.action);
	} finally {
		await rm(missing.root, { recursive: true, force: true });
		await rm(invalid.root, { recursive: true, force: true });
	}
});

test("replay rejects malformed composites before any registration", async () => {
	const f = await fixture({ userEntry: filtered() });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		const real = apiRecorder();
		const replay = replayPiFffRegistrationPlan(result.plan, real.api, { read: {} as any, grep: {} as any });
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.diagnostic.code, "PIFFF_SURFACE_BREAKING");
		assert.equal(real.calls.length, 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("replay stops after an unexpected registration failure", async () => {
	const f = await fixture({ userEntry: filtered() });
	try {
		const result = await buildFrom(f); assert.equal(result.ok, true); if (!result.ok) return;
		const real = apiRecorder(); let count = 0;
		real.api.registerTool = (...args: unknown[]) => { real.calls.push({ method: "registerTool", args }); if (++count === 2) throw new Error("rejected"); };
		const composites = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		const replay = replayPiFffRegistrationPlan(result.plan, real.api, composites);
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.diagnostic.code, "PIFFF_FORWARD_PARTIAL");
		assert.equal(real.calls.length, 2);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});
