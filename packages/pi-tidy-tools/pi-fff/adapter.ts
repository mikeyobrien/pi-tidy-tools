import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import semver from "semver";
import type { SourceToolCompositionOptions, SourceToolDefinition } from "../tool-composition.js";
import { composeSourceTool } from "../tool-composition.js";
import {
	createRunningPiFffLoader,
	type PiFffLoaderAliases,
	type PiFffModuleLoader,
} from "./loader.js";

export type { PiFffLoaderAliases, PiFffModuleLoader } from "./loader.js";

export type PiFffDiagnosticCode =
	| "PIFFF_BELOW_MINIMUM"
	| "PIFFF_CAPABILITY_MISSING"
	| "PIFFF_CONFIG_MISSING"
	| "PIFFF_CONFIG_FILTER_REQUIRED"
	| "PIFFF_SCOPE_SHADOWED_INVALID"
	| "PIFFF_PACKAGE_MISSING"
	| "PIFFF_PACKAGE_INVALID"
	| "PIFFF_INTEGRITY_UNVERIFIED"
	| "PIFFF_INTEGRITY_MISMATCH"
	| "PIFFF_LOAD_FAILED"
	| "PIFFF_FACTORY_FAILED"
	| "PIFFF_SURFACE_BREAKING"
	| "PIFFF_FORWARD_UNVERIFIED"
	| "PIFFF_FORWARD_PARTIAL"
	| "PIFFF_EXEC_RESULT_INVALID";

export interface PiFffDiagnostic {
	code: PiFffDiagnosticCode;
	severity: "info" | "warning" | "error" | "fatal";
	summary: string;
	detail: string;
	action: string;
	piVersion: string;
	piFffVersion: string;
}

export interface RecordedRegistration {
	readonly method: RegistrationMethod;
	readonly args: readonly unknown[];
}

type RegistrationMethod =
	| "registerTool" | "registerCommand" | "registerShortcut" | "registerFlag"
	| "registerMessageRenderer" | "registerEntryRenderer" | "registerProvider"
	| "unregisterProvider" | "on";

export interface PiFffRegistrationPlan {
	readonly scope: "project" | "user";
	readonly packageRoot: string;
	readonly entryPath: string;
	readonly piVersion: string;
	readonly piFffVersion: string;
	readonly status: "verified" | "forward-compatible/unverified";
	readonly integrity: "missing" | "registry-unverified" | "verified";
	readonly diagnostics: readonly PiFffDiagnostic[];
	readonly trace: readonly RecordedRegistration[];
	readonly captures: { readonly read: SourceToolDefinition; readonly grep: SourceToolDefinition };
}

export type PiFffResult<T> = { ok: true; plan: T } | { ok: false; diagnostic: PiFffDiagnostic };
export type ReplayResult = { ok: true } | { ok: false; diagnostic: PiFffDiagnostic };

export interface PiFffConflictSet {
	tools?: Iterable<string>;
	commands?: Iterable<string>;
	shortcuts?: Iterable<string>;
	flags?: Iterable<string>;
	messageRenderers?: Iterable<string>;
	entryRenderers?: Iterable<string>;
	providers?: Iterable<string>;
}

export interface BuildPiFffPlanOptions {
	cwd: string;
	api: Record<string, any>;
	agentDir?: string;
	/** Explicit prospective participant used by lifecycle preflight, including shadowed scope. */
	selection?: { scope: "project" | "user"; entry: unknown };
	piVersion?: string;
	loader?: PiFffModuleLoader;
	aliases?: PiFffLoaderAliases;
	conflicts?: PiFffConflictSet;
	/** Registry integrity already available to the host; this adapter never fetches it. */
	registryIntegrity?: string;
}

const MIN_PI = "0.80.6";
const MIN_FFF = "0.1.12";
const REGISTRATION_METHODS: readonly RegistrationMethod[] = [
	"registerTool", "registerCommand", "registerShortcut", "registerFlag",
	"registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on",
];
export const TIDY_PI_FFF_CONFLICTS: Readonly<PiFffConflictSet> = Object.freeze({
	tools: Object.freeze(["write", "edit", "bash", "find", "ls"]),
	commands: Object.freeze(["tidy", "diff"]),
	shortcuts: Object.freeze(["ctrl+shift+o"]),
	messageRenderers: Object.freeze(["minimal-turn-diff"]),
});
const MUTATING_METHODS = new Set([
	"sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "setLabel", "exec",
	"setActiveTools", "setModel", "setThinkingLevel", "shutdown", "abort", "compact",
]);

const BASELINE: Record<"read" | "grep", Record<string, { type: string; required: boolean }>> = {
	read: {
		path: { type: "string", required: true }, offset: { type: "number", required: false }, limit: { type: "number", required: false },
	},
	grep: {
		pattern: { type: "string", required: true }, mode: { type: "string", required: false }, path: { type: "string", required: false },
		glob: { type: "string", required: false }, constraints: { type: "string", required: false }, cursor: { type: "string", required: false },
		outputMode: { type: "string", required: false }, ignoreCase: { type: "boolean", required: false }, literal: { type: "boolean", required: false },
		context: { type: "number", required: false }, limit: { type: "number", required: false },
	},
};

interface Gate { phase: "recording" | "planned" | "committing" | "active" | "failed" }
const gates = new WeakMap<PiFffRegistrationPlan, Gate>();

/** Proves a lifecycle preflight result was produced by this adapter and remains uncommitted. */
export function isPlannedPiFffRegistrationPlan(value: unknown): value is PiFffRegistrationPlan {
	if (!value || typeof value !== "object") return false;
	return gates.get(value as PiFffRegistrationPlan)?.phase === "planned";
}

class SurfaceFailure extends Error {}

function diagnostic(
	code: PiFffDiagnosticCode,
	piVersion: string,
	piFffVersion: string,
	detail: string,
	severity: PiFffDiagnostic["severity"] = "error",
): PiFffDiagnostic {
	const summaries: Record<PiFffDiagnosticCode, string> = {
		PIFFF_BELOW_MINIMUM: `pi-fff adapter inactive: minimums are Pi ${MIN_PI} and pi-fff ${MIN_FFF}.`,
		PIFFF_CAPABILITY_MISSING: "pi-fff adapter inactive: a required running Pi capability is unavailable.",
		PIFFF_CONFIG_MISSING: "pi-fff adapter inactive: no managed npm:pi-fff entry is selected.",
		PIFFF_CONFIG_FILTER_REQUIRED: "pi-fff adapter inactive: pi-fff must use object form with extensions: [].",
		PIFFF_SCOPE_SHADOWED_INVALID: "pi-fff adapter inactive: the selected project entry is invalid and shadows user scope.",
		PIFFF_PACKAGE_MISSING: "pi-fff adapter inactive: the selected managed package is missing.",
		PIFFF_PACKAGE_INVALID: "pi-fff adapter inactive: the selected package artifact is invalid.",
		PIFFF_INTEGRITY_UNVERIFIED: "pi-fff passed local artifact checks; registry integrity was not verified offline.",
		PIFFF_INTEGRITY_MISMATCH: "pi-fff adapter inactive: installed artifact integrity validation failed.",
		PIFFF_LOAD_FAILED: "pi-fff adapter inactive: the selected package entry could not be loaded.",
		PIFFF_FACTORY_FAILED: "pi-fff adapter inactive: the pi-fff factory failed before commit.",
		PIFFF_SURFACE_BREAKING: "pi-fff changed a required adapter surface; no registrations were forwarded.",
		PIFFF_FORWARD_UNVERIFIED: "Pi and pi-fff passed structural checks and are forward-compatible/unverified.",
		PIFFF_FORWARD_PARTIAL: "pi-fff registration replay failed; reload is required.",
		PIFFF_EXEC_RESULT_INVALID: "pi-fff returned an unsupported tool result; native execution was not retried.",
	};
	const actions: Record<PiFffDiagnosticCode, string> = {
		PIFFF_BELOW_MINIMUM: "Upgrade the below-minimum component, then /reload; this version is outside the supported range, not necessarily broken.",
		PIFFF_CAPABILITY_MISSING: "Upgrade or reinstall Pi so the named capability is available, then /reload.",
		PIFFF_CONFIG_MISSING: "Install pi-fff in a managed Pi npm scope, then run /tidy pi-fff setup.",
		PIFFF_CONFIG_FILTER_REQUIRED: "Run /tidy pi-fff setup to set extensions: [], then /reload.",
		PIFFF_SCOPE_SHADOWED_INVALID: "Fix or remove the selected project entry; tidy will not fall back to user scope.",
		PIFFF_PACKAGE_MISSING: `Install npm:pi-fff@${MIN_FFF} or newer with extensions: [], then /reload.`,
		PIFFF_PACKAGE_INVALID: "Reinstall the selected package through Pi, then /reload.",
		PIFFF_INTEGRITY_UNVERIFIED: "Capability validation continues offline; verify registry integrity during release smoke.",
		PIFFF_INTEGRITY_MISMATCH: "Reinstall that pi-fff version through Pi, then /reload.",
		PIFFF_LOAD_FAILED: "Reinstall pi-fff and verify its native dependencies support this platform, then /reload.",
		PIFFF_FACTORY_FAILED: "Install a structurally compatible pi-fff release or disable orchestration; no registrations were forwarded.",
		PIFFF_SURFACE_BREAKING: "Install a structurally compatible release or disable orchestration, then /reload.",
		PIFFF_FORWARD_UNVERIFIED: "Run the release smoke matrix before promoting this tuple to verified.",
		PIFFF_FORWARD_PARTIAL: "Stop using the affected integration and /reload before using FFF tools.",
		PIFFF_EXEC_RESULT_INVALID: "Use a verified or smoke-tested tuple, then /reload; native execution was not retried.",
	};
	return { code, severity, summary: summaries[code], detail: oneLine(detail), action: actions[code], piVersion, piFffVersion };
}

function oneLine(value: unknown): string {
	return String(value instanceof Error ? value.message : value).split(/\r?\n/, 1)[0]!.slice(0, 240);
}

function compareVersions(left: string, right: string): number | undefined {
	return semver.valid(left) && semver.valid(right) ? semver.compare(left, right) : undefined;
}

function isAtLeast(value: string, floor: string): boolean {
	return semver.valid(value) !== null && semver.gte(value, floor);
}

async function readSettings(path: string): Promise<any> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch { return {}; }
}

function npmPiFffEntry(settings: any): unknown {
	if (!Array.isArray(settings?.packages)) return undefined;
	return settings.packages.find((entry: any) => {
		const source = typeof entry === "string" ? entry : entry?.source;
		return typeof source === "string" && /^npm:pi-fff(?:@.+)?$/.test(source);
	});
}

function validateSelectedEntry(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "the selected entry is not object form";
	const selected = entry as any;
	if (typeof selected.source !== "string" || !/^npm:pi-fff(?:@.+)?$/.test(selected.source)) return "the selected source is not managed npm:pi-fff";
	if (!Array.isArray(selected.extensions) || selected.extensions.length !== 0) return "extensions must be exactly []";
	return undefined;
}

async function canonicalExact(path: string): Promise<string | undefined> {
	try {
		const canonical = await realpath(path);
		return canonical === resolve(path) ? canonical : undefined;
	} catch { return undefined; }
}

function pathIsInside(root: string, target: string): boolean {
	const child = relative(root, target);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

type IntegrityCheck =
	| { status: "missing" }
	| { status: "registry-unverified" | "verified"; integrity: string }
	| { status: "mismatch"; detail: string };

async function validateLocalIntegrity(managedRoot: string, manifest: any, registryIntegrity?: string): Promise<IntegrityCheck> {
	let lock: any;
	try { lock = JSON.parse(await readFile(join(managedRoot, "package-lock.json"), "utf8")); }
	catch (error: any) {
		if (error?.code === "ENOENT") return { status: "missing" };
		return { status: "mismatch", detail: `selected lock is unreadable: ${oneLine(error)}` };
	}
	if (!lock || typeof lock !== "object") return { status: "mismatch", detail: "selected lock is malformed" };
	const packageEntry = lock.packages?.["node_modules/pi-fff"];
	const dependencyEntry = lock.dependencies?.["pi-fff"];
	const entries = [packageEntry, dependencyEntry].filter((value) => value !== undefined);
	if (!entries.length) return { status: "mismatch", detail: "selected lock has no pi-fff entry" };
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") return { status: "mismatch", detail: "selected lock pi-fff entry is malformed" };
		if (entry.name !== undefined && entry.name !== "pi-fff") return { status: "mismatch", detail: "selected lock identity differs from pi-fff" };
		if (entry.version !== manifest.version) return { status: "mismatch", detail: `selected lock version ${String(entry.version)} differs from installed ${manifest.version}` };
		if (entry.resolved !== undefined) {
			if (typeof entry.resolved !== "string" || entry.resolved.length === 0) return { status: "mismatch", detail: "selected lock resolved artifact is malformed" };
			try {
				const resolvedArtifact = new URL(entry.resolved);
				if (!resolvedArtifact.pathname.endsWith(`/pi-fff-${manifest.version}.tgz`)) return { status: "mismatch", detail: "selected lock resolved artifact differs from pi-fff identity or version" };
			} catch { return { status: "mismatch", detail: "selected lock resolved artifact is malformed" }; }
		}
		if (entry.integrity !== undefined && (typeof entry.integrity !== "string" || !/^(?:sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/.test(entry.integrity))) {
			return { status: "mismatch", detail: "selected lock integrity is malformed" };
		}
	}
	if (packageEntry && dependencyEntry) {
		for (const field of ["version", "resolved", "integrity"] as const) {
			if (packageEntry[field] !== undefined && dependencyEntry[field] !== undefined && packageEntry[field] !== dependencyEntry[field]) {
				return { status: "mismatch", detail: `selected lock ${field} fields conflict` };
			}
		}
	}
	const integrity = packageEntry?.integrity ?? dependencyEntry?.integrity;
	if (integrity === undefined) return { status: "missing" };
	if (registryIntegrity === undefined) return { status: "registry-unverified", integrity };
	return registryIntegrity === integrity
		? { status: "verified", integrity }
		: { status: "mismatch", detail: "selected lock integrity differs from available registry metadata" };
}

function validateApi(api: Record<string, any>): string | undefined {
	for (const method of REGISTRATION_METHODS) if (typeof api?.[method] !== "function") return method;
	if (!api.events || typeof api.events.on !== "function" || typeof api.events.emit !== "function") return "events";
	return undefined;
}

function makeRecorder(api: Record<string, any>, trace: RecordedRegistration[], gate: Gate): Record<string, any> {
	const registrationSet = new Set<string>(REGISTRATION_METHODS);
	const rejectWrite = (property: PropertyKey): never => { throw new SurfaceFailure(`registration-time property write ${String(property)} is unsafe`); };
	const writeTraps = {
		set(_target: object, property: PropertyKey): boolean { return rejectWrite(property); },
		defineProperty(_target: object, property: PropertyKey): boolean { return rejectWrite(property); },
		deleteProperty(_target: object, property: PropertyKey): boolean { return rejectWrite(property); },
		setPrototypeOf(): boolean { return rejectWrite("[[Prototype]]"); },
	};
	const deferred = (property: string, fn: (...args: any[]) => any, receiver: any) => function (this: unknown, ...args: unknown[]) {
		if (gate.phase !== "active") throw new SurfaceFailure(`registration-time action ${property} is unsafe`);
		return fn.apply(receiver, args);
	};
	const events = new Proxy(api.events, {
		...writeTraps,
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? deferred(`events.${String(property)}`, value, target) : value;
		},
	});
	return new Proxy(api, {
		...writeTraps,
		get(target, property, receiver) {
			if (property === "events") return events;
			if (typeof property === "string" && registrationSet.has(property)) {
				return (...args: unknown[]) => { trace.push(Object.freeze({ method: property as RegistrationMethod, args })); };
			}
			if (typeof property === "string" && /(?:register|unregister|subscribe)/i.test(property)) {
				throw new SurfaceFailure(`unknown registration-like method ${property}`);
			}
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return typeof property === "string" && MUTATING_METHODS.has(property)
				? deferred(property, value, target)
				: value.bind(target);
		},
	});
}

function equivalentPrimitive(schema: unknown, expected: string): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const value = schema as Record<string, unknown>;
	if (value.type !== undefined) return value.type === expected
		|| (Array.isArray(value.type) && value.type.length === 1 && value.type[0] === expected);
	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const alternatives = value[keyword];
		if (alternatives !== undefined) return Array.isArray(alternatives) && alternatives.length === 1
			&& equivalentPrimitive(alternatives[0], expected);
	}
	return false;
}

function schemaFailure(tool: any, name: "read" | "grep"): string | undefined {
	if (!tool || typeof tool !== "object" || tool.name !== name) return `${name} definition is malformed`;
	if (typeof tool.execute !== "function") return `${name}.execute is not callable`;
	const schema = tool.parameters;
	if (!schema || !equivalentPrimitive({ type: schema.type }, "object") || !schema.properties || typeof schema.properties !== "object") return `${name}.parameters is not an object schema`;
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const [field, anchor] of Object.entries(BASELINE[name])) {
		const property = schema.properties[field];
		if (!equivalentPrimitive(property, anchor.type)) return `${name}.${field} must remain ${anchor.type}`;
		if (required.has(field) !== anchor.required) return `${name}.${field} requiredness changed`;
	}
	for (const field of required) if (!Object.hasOwn(BASELINE[name], String(field))) return `${name} added required field ${String(field)}`;
	return undefined;
}

function stringArg(call: RecordedRegistration, index: number): string | undefined {
	return typeof call.args[index] === "string" ? call.args[index] as string : undefined;
}

function validateTrace(trace: readonly RecordedRegistration[], conflicts: PiFffConflictSet | undefined): { read: SourceToolDefinition; grep: SourceToolDefinition } {
	const captures: Partial<Record<"read" | "grep", SourceToolDefinition>> = {};
	const conflictNames = (key: keyof PiFffConflictSet): string[] => [
		...(TIDY_PI_FFF_CONFLICTS[key] ?? []),
		...(conflicts?.[key] ?? []),
	];
	const seen = {
		tools: new Set(conflictNames("tools")), commands: new Set(conflictNames("commands")), shortcuts: new Set(conflictNames("shortcuts")),
		flags: new Set(conflictNames("flags")), messageRenderers: new Set(conflictNames("messageRenderers")),
		entryRenderers: new Set(conflictNames("entryRenderers")), providers: new Set(conflictNames("providers")),
	};
	const lifecycle = new Set<string>();
	for (const call of trace) {
		if (call.method === "unregisterProvider") throw new SurfaceFailure("unregisterProvider cannot be committed transactionally");
		if (call.method === "registerTool") {
			if (call.args.length !== 1 || !call.args[0] || typeof call.args[0] !== "object") throw new SurfaceFailure("registerTool arguments are malformed");
			const tool = call.args[0] as any;
			if (typeof tool.name !== "string" || typeof tool.description !== "string" || typeof tool.label !== "string" || typeof tool.execute !== "function") throw new SurfaceFailure("tool definition is structurally invalid");
			if (tool.name === "read" || tool.name === "grep") {
				const toolName = tool.name as "read" | "grep";
				if (captures[toolName]) throw new SurfaceFailure(`duplicate ${toolName} capture`);
				const failure = schemaFailure(tool, toolName); if (failure) throw new SurfaceFailure(failure);
				captures[toolName] = tool;
				continue;
			}
			if (seen.tools.has(tool.name)) throw new SurfaceFailure(`tool conflict ${tool.name}`);
			seen.tools.add(tool.name);
			continue;
		}
		if (call.method === "on") {
			const event = stringArg(call, 0);
			if (call.args.length !== 2 || !event || typeof call.args[1] !== "function") throw new SurfaceFailure("event registration is malformed");
			if (event === "session_start" || event === "session_shutdown") lifecycle.add(event);
			continue;
		}
		const name = stringArg(call, 0);
		if (!name) throw new SurfaceFailure(`${call.method} name is malformed`);
		const key = call.method === "registerCommand" ? "commands"
			: call.method === "registerShortcut" ? "shortcuts"
			: call.method === "registerFlag" ? "flags"
			: call.method === "registerMessageRenderer" ? "messageRenderers"
			: call.method === "registerEntryRenderer" ? "entryRenderers" : "providers";
		if (seen[key].has(name)) throw new SurfaceFailure(`${call.method} conflict ${name}`);
		seen[key].add(name);
		const value = call.args[1] as any;
		if (call.method === "registerCommand" && (call.args.length !== 2 || !value || typeof value.handler !== "function")) throw new SurfaceFailure("command definition is malformed");
		if (call.method === "registerShortcut" && (call.args.length !== 2 || !value || typeof value.handler !== "function")) throw new SurfaceFailure("shortcut definition is malformed");
		if (call.method === "registerFlag" && (call.args.length !== 2 || !value || (value.type !== "boolean" && value.type !== "string"))) throw new SurfaceFailure("flag definition is malformed");
		if ((call.method === "registerMessageRenderer" || call.method === "registerEntryRenderer") && (call.args.length !== 2 || typeof value !== "function")) throw new SurfaceFailure("renderer definition is malformed");
		if (call.method === "registerProvider" && (call.args.length !== 2 || !value || typeof value !== "object")) throw new SurfaceFailure("provider definition is malformed");
	}
	if (!captures.read || !captures.grep) throw new SurfaceFailure("exactly one enabled read and grep capture is required");
	if (!lifecycle.has("session_start") || !lifecycle.has("session_shutdown")) throw new SurfaceFailure("session_start and session_shutdown lifecycle anchors are required");
	return captures as { read: SourceToolDefinition; grep: SourceToolDefinition };
}

export async function buildPiFffRegistrationPlan(options: BuildPiFffPlanOptions): Promise<PiFffResult<PiFffRegistrationPlan>> {
	const piVersion = options.piVersion ?? VERSION;
	let piFffVersion = "unknown";
	if (!isAtLeast(piVersion, MIN_PI)) return { ok: false, diagnostic: diagnostic("PIFFF_BELOW_MINIMUM", piVersion, piFffVersion, `detected Pi ${piVersion}`) };
	const capability = validateApi(options.api);
	if (capability) return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", piVersion, piFffVersion, `ExtensionAPI.${capability}`) };

	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const projectEntry = options.selection ? undefined : npmPiFffEntry(await readSettings(join(cwd, ".pi", "settings.json")));
	const userEntry = options.selection ? undefined : npmPiFffEntry(await readSettings(join(agentDir, "settings.json")));
	const scope = options.selection?.scope ?? (projectEntry !== undefined ? "project" : userEntry !== undefined ? "user" : undefined);
	const entry = options.selection?.entry ?? projectEntry ?? userEntry;
	if (!scope) return { ok: false, diagnostic: diagnostic("PIFFF_CONFIG_MISSING", piVersion, piFffVersion, "no managed npm entry") };
	const entryFailure = validateSelectedEntry(entry);
	if (entryFailure) {
		const code = scope === "project" && userEntry !== undefined ? "PIFFF_SCOPE_SHADOWED_INVALID" : "PIFFF_CONFIG_FILTER_REQUIRED";
		return { ok: false, diagnostic: diagnostic(code, piVersion, piFffVersion, entryFailure) };
	}

	const managedRoot = scope === "project" ? join(cwd, ".pi", "npm") : join(agentDir, "npm");
	const packageRoot = join(managedRoot, "node_modules", "pi-fff");
	const canonicalRoot = await canonicalExact(packageRoot);
	if (!canonicalRoot) {
		let missing = false;
		try { await readFile(join(packageRoot, "package.json")); } catch { missing = true; }
		return { ok: false, diagnostic: diagnostic(missing ? "PIFFF_PACKAGE_MISSING" : "PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, missing ? `selected ${scope} package is absent` : "package root is non-canonical") };
	}

	let manifest: any;
	try { manifest = JSON.parse(await readFile(join(canonicalRoot, "package.json"), "utf8")); }
	catch (error) { return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `manifest: ${oneLine(error)}`) }; }
	piFffVersion = typeof manifest?.version === "string" ? manifest.version : "unknown";
	if (!isAtLeast(piFffVersion, MIN_FFF)) return { ok: false, diagnostic: diagnostic("PIFFF_BELOW_MINIMUM", piVersion, piFffVersion, `detected pi-fff ${piFffVersion}`) };
	if (manifest?.name !== "pi-fff") return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, "manifest identity is not pi-fff") };
	const configuredSource = (entry as { source: string }).source;
	const configuredVersion = configuredSource.slice("npm:pi-fff@".length);
	if (configuredSource.startsWith("npm:pi-fff@")) {
		if (!semver.valid(configuredVersion)) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `configured version ${configuredVersion} is not valid SemVer`) };
		if (configuredVersion !== piFffVersion) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `configured ${configuredVersion} does not match installed ${piFffVersion}`) };
	}
	const integrity = await validateLocalIntegrity(managedRoot, manifest, options.registryIntegrity);
	if (integrity.status === "mismatch") return { ok: false, diagnostic: diagnostic("PIFFF_INTEGRITY_MISMATCH", piVersion, piFffVersion, integrity.detail) };
	const extensions = manifest?.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string") return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, "manifest must declare one current extension entry") };
	const expectedEntry = resolve(canonicalRoot, extensions[0]);
	const canonicalEntry = await canonicalExact(expectedEntry);
	if (!canonicalEntry || !pathIsInside(canonicalRoot, canonicalEntry)) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, "extension entry escapes or is unavailable") };

	let loader = options.loader;
	let aliases = options.aliases;
	if (!loader) {
		try {
			const running = createRunningPiFffLoader();
			loader = running.loader;
			aliases ??= running.aliases;
		} catch (error) {
			return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", piVersion, piFffVersion, `loader aliases: ${oneLine(error)}`) };
		}
	}
	if (!aliases) {
		// Injected hermetic loaders still receive explicit identity slots.
		aliases = { codingAgent: "injected:pi", tui: "injected:tui", typebox: "injected:typebox", sinclairTypebox: "injected:typebox" };
	}
	if (!aliases.codingAgent || !aliases.tui || !aliases.typebox || aliases.typebox !== aliases.sinclairTypebox) return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", piVersion, piFffVersion, "loader alias identity") };

	let factory: any;
	try {
		const loaded = await loader!.load(canonicalEntry, aliases);
		factory = typeof loaded === "function" ? loaded : (loaded as any)?.default;
		if (typeof factory !== "function") throw new Error("default export is not callable");
	} catch (error) { return { ok: false, diagnostic: diagnostic("PIFFF_LOAD_FAILED", piVersion, piFffVersion, oneLine(error)) }; }

	const trace: RecordedRegistration[] = [];
	const gate: Gate = { phase: "recording" };
	try { await factory(makeRecorder(options.api, trace, gate)); }
	catch (error) {
		const code = error instanceof SurfaceFailure ? "PIFFF_SURFACE_BREAKING" : "PIFFF_FACTORY_FAILED";
		return { ok: false, diagnostic: diagnostic(code, piVersion, piFffVersion, oneLine(error)) };
	}
	let captures: { read: SourceToolDefinition; grep: SourceToolDefinition };
	try { captures = validateTrace(trace, options.conflicts); }
	catch (error) { return { ok: false, diagnostic: diagnostic("PIFFF_SURFACE_BREAKING", piVersion, piFffVersion, oneLine(error)) }; }
	gate.phase = "planned";
	const status = compareVersions(piVersion, MIN_PI) === 0 && compareVersions(piFffVersion, MIN_FFF) === 0 ? "verified" : "forward-compatible/unverified";
	const infos: PiFffDiagnostic[] = [];
	if (integrity.status === "registry-unverified") infos.push(diagnostic("PIFFF_INTEGRITY_UNVERIFIED", piVersion, piFffVersion, "local lock identity, version, resolved artifact, and integrity are consistent", "info"));
	if (status === "forward-compatible/unverified") infos.push(diagnostic("PIFFF_FORWARD_UNVERIFIED", piVersion, piFffVersion, "eligible tuple passed structural capability validation", "info"));
	const plan: PiFffRegistrationPlan = Object.freeze({
		scope, packageRoot: canonicalRoot, entryPath: canonicalEntry, piVersion, piFffVersion, status,
		integrity: integrity.status, diagnostics: Object.freeze(infos),
		trace: Object.freeze(trace.slice()), captures: Object.freeze(captures),
	});
	gates.set(plan, gate);
	return { ok: true, plan };
}

function validContent(content: unknown): boolean {
	return Array.isArray(content) && content.every((item: any) => item && typeof item === "object" && (
		(item.type === "text" && typeof item.text === "string") ||
		(item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
	));
}

function validateResult(value: any, plan: PiFffRegistrationPlan, tool: string): any {
	if (!value || typeof value !== "object" || !validContent(value.content)) {
		const error: any = new Error(diagnostic("PIFFF_EXEC_RESULT_INVALID", plan.piVersion, plan.piFffVersion, `${tool} result content`).summary);
		error.code = "PIFFF_EXEC_RESULT_INVALID";
		error.diagnostic = diagnostic("PIFFF_EXEC_RESULT_INVALID", plan.piVersion, plan.piFffVersion, `${tool} result content`);
		throw error;
	}
	return value;
}

function guardedSource(plan: PiFffRegistrationPlan, name: "read" | "grep"): SourceToolDefinition {
	const source = plan.captures[name];
	return {
		...source,
		execute(_id: string, params: any, signal: any, onUpdate: any, context: any) {
			const returned = source.execute.call(source, _id, params, signal, onUpdate, context);
			return returned && typeof returned.then === "function"
				? returned.then((value: any) => validateResult(value, plan, name))
				: validateResult(returned, plan, name);
		},
	};
}

/** Apply tidy's schema seam around captured execution without registering it. */
export function createPiFffComposites(plan: PiFffRegistrationPlan, options: SourceToolCompositionOptions): { read: SourceToolDefinition; grep: SourceToolDefinition } {
	return {
		read: composeSourceTool(guardedSource(plan, "read"), options) as SourceToolDefinition,
		grep: composeSourceTool(guardedSource(plan, "grep"), options) as SourceToolDefinition,
	};
}

/** Commit a previously validated plan once, preserving trace order and identities. */
export function replayPiFffRegistrationPlan(
	plan: PiFffRegistrationPlan,
	api: Record<string, any>,
	composites: { read: SourceToolDefinition; grep: SourceToolDefinition },
): ReplayResult {
	const gate = gates.get(plan);
	if (!gate || gate.phase !== "planned") return { ok: false, diagnostic: diagnostic("PIFFF_FORWARD_PARTIAL", plan.piVersion, plan.piFffVersion, "plan is stale or already replayed", "fatal") };
	const capability = validateApi(api);
	if (capability) return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", plan.piVersion, plan.piFffVersion, `ExtensionAPI.${capability}`) };
	const invalidComposite = (["read", "grep"] as const).find((name) => {
		const tool = composites?.[name];
		return !tool || tool.name !== name || typeof tool.execute !== "function" || !tool.parameters || typeof tool.parameters !== "object";
	});
	if (invalidComposite) return { ok: false, diagnostic: diagnostic("PIFFF_SURFACE_BREAKING", plan.piVersion, plan.piFffVersion, `${invalidComposite} composite is malformed`) };
	gate.phase = "committing";
	let committed = 0;
	try {
		for (const call of plan.trace) {
			const args = call.method === "registerTool" && (call.args[0] as any)?.name === "read"
				? [composites.read]
				: call.method === "registerTool" && (call.args[0] as any)?.name === "grep"
					? [composites.grep] : call.args;
			api[call.method].apply(api, args);
			committed++;
		}
		gate.phase = "active";
		return { ok: true };
	} catch (error) {
		gate.phase = "failed";
		return { ok: false, diagnostic: diagnostic("PIFFF_FORWARD_PARTIAL", plan.piVersion, plan.piFffVersion, `registration ${committed + 1}: ${oneLine(error)}`, "fatal") };
	}
}
