import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildPiFffRegistrationPlan,
	createPiFffComposites,
	replayPiFffRegistrationPlan,
	type PiFffDiagnostic,
	type PiFffModuleLoader,
} from "../pi-fff/adapter.js";
import { createRunningPiFffLoader } from "../pi-fff/loader.js";

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
	const writeScope = async (scope: "project" | "user", entry: unknown, version: string, supplied: ReturnType<typeof baselineFactory> | undefined, manifest: Record<string, unknown> | undefined, lock: Record<string, unknown> | undefined) => {
		const settings = scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
		const packageRoot = scope === "project" ? projectPackage : userPackage;
		await mkdir(packageRoot, { recursive: true });
		await writeFile(settings, JSON.stringify({ packages: [entry] }));
		await writeFile(join(packageRoot, "index.ts"), "export default function () {}\n");
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({
			name: "pi-fff", version, type: "module", pi: { extensions: ["./index.ts"] }, ...manifest,
		}));
		if (lock) await writeFile(join(packageRoot, "..", "..", "package-lock.json"), JSON.stringify(lock));
		factories.set(await realpath(join(packageRoot, "index.ts")), supplied ?? baselineFactory());
	};
	if (options.projectEntry !== undefined) await writeScope("project", options.projectEntry, options.projectVersion ?? "0.1.12", options.projectFactory, options.projectManifest, options.projectLock);
	if (options.userEntry !== undefined) await writeScope("user", options.userEntry, options.userVersion ?? "0.1.12", options.userFactory, options.userManifest, options.userLock);
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
const INTEGRITY = "sha512-YWJjZA==";
const lockFor = (version = "0.1.12", overrides: Record<string, unknown> = {}) => ({
	name: "managed-pi-packages", lockfileVersion: 3,
	packages: { "node_modules/pi-fff": { version, resolved: `https://registry.npmjs.org/pi-fff/-/pi-fff-${version}.tgz`, integrity: INTEGRITY, ...overrides } },
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
	try {
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
	} finally { await rm(root, { recursive: true, force: true }); }
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
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.equal(await tools.read.execute("id", { path: "x" }, undefined, undefined, {}), expected);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("compatible forward additions preserve metadata, identities, and order on replay", async () => {
	const marker = Symbol("metadata");
	const extraHandler = () => {};
	const source = baselineFactory((pi) => {
		pi.registerShortcut("ctrl+x", { description: "forward", handler: extraHandler });
	});
	source.factory = (pi: any) => {
		pi.registerTool(readTool({ marker, promptGuidelines: ["new prompt"], parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, encoding: { type: "string" } }, required: ["path"] } }));
		pi.registerTool(grepTool());
		pi.on("session_start", extraHandler);
		pi.registerShortcut("ctrl+x", { description: "forward", handler: extraHandler });
		pi.on("session_shutdown", extraHandler);
	};
	const f = await fixture({ userEntry: filtered("0.2.0"), userVersion: "0.2.0", userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildFrom(f, real.api);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.plan.captures.read.marker, marker);
		assert.ok(result.plan.captures.read.parameters.properties.encoding);
		const composites = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		const replay = replayPiFffRegistrationPlan(result.plan, real.api, composites);
		assert.equal(replay.ok, true);
		assert.deepEqual(real.calls.map((call) => call.method), ["registerTool", "registerTool", "on", "registerShortcut", "on"]);
		assert.equal(real.calls[0]?.args[0], composites.read);
		assert.equal(real.calls[2]?.args[1], extraHandler);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("breaking surface matrix fails closed with stable diagnostics", async (t) => {
	const cases: Array<[string, (pi: any) => void]> = [
		["missing read", (pi) => { pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["missing grep", (pi) => { pi.registerTool(readTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["missing both", (pi) => { pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
		["noncallable executor", (pi) => { pi.registerTool(readTool({ execute: "no" })); pi.registerTool(grepTool()); pi.on("session_start", () => {}); pi.on("session_shutdown", () => {}); }],
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

test("known registration conflicts fail before replay", async () => {
	const source = baselineFactory((pi) => pi.registerCommand("taken", { handler() {} }));
	const f = await fixture({ userEntry: filtered(), userFactory: source });
	const real = apiRecorder();
	try {
		const result = await buildPiFffRegistrationPlan({ cwd: f.cwd, agentDir: f.agentDir, piVersion: "0.80.6", api: real.api, loader: f.loader, conflicts: { commands: ["taken"] } });
		expectCode(result, "PIFFF_SURFACE_BREAKING");
		assert.equal(real.calls.length, 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
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
		const composites = createPiFffComposites(result.plan, { mode: "default", reasoningGuideline: "reason" });
		const params = { path: "x", reasoning: "find x", extra: { same: true } };
		const actual = await composites.read.execute("id", params, signal, update, context);
		assert.equal(actual, expected);
		assert.equal(observed[0], result.plan.captures.read);
		assert.equal(observed[1], "id");
		assert.deepEqual(observed[2], { path: "x", extra: params.extra });
		assert.equal((observed[2] as any).extra, params.extra);
		assert.equal(observed[3], signal); assert.notEqual(observed[4], update); assert.equal(typeof observed[4], "function"); assert.equal(observed[5], context);
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
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		assert.throws(() => tools.read.execute("id", { path: "x" }, undefined, undefined, {}), (error: any) => error?.code === "PIFFF_EXEC_RESULT_INVALID");
		assert.equal(executions, 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("partial updates are guarded and valid objects retain identity and fields", async () => {
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
		const tools = createPiFffComposites(result.plan, { mode: "result", reasoningGuideline: "reason" });
		const actual = await tools.read.execute("id", { path: "x" }, undefined, (value: unknown) => observed.push(value), {});
		assert.equal(actual, settled);
		assert.equal(observed[0], validPartial);
		malformed = true;
		assert.throws(() => tools.read.execute("id", { path: "x" }, undefined, () => {}, {}), (error: any) => error?.code === "PIFFF_EXEC_RESULT_INVALID");
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
