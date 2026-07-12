import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import semver from "semver";
import type { SourceToolCompositionOptions, SourceToolDefinition } from "../tool-composition.js";
import { composeSourceTool } from "../tool-composition.js";
import { matchPiFffSource, PI_FFF_PACKAGE_PROFILES, type PiFffCapabilityProfile, type PiFffPackageIdentity, type PiFffPackageProfile } from "./profiles.js";
import {
	createRunningPiFffLoader,
	type PiFffLoaderAliases,
	type PiFffModuleLoader,
} from "./loader.js";

export type { PiFffLoaderAliases, PiFffModuleLoader } from "./loader.js";
export type { PiFffCapabilityProfile, PiFffPackageIdentity } from "./profiles.js";

export type PiFffDiagnosticCode =
	| "PIFFF_BELOW_MINIMUM"
	| "PIFFF_CAPABILITY_MISSING"
	| "PIFFF_CONFIG_MISSING"
	| "PIFFF_CONFIG_AMBIGUOUS"
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

interface PiFffPlanBase {
	readonly scope: "project" | "user";
	readonly packageIdentity: PiFffPackageIdentity;
	readonly profile: PiFffCapabilityProfile;
	readonly packageRoot: string;
	readonly entryPath: string;
	readonly piVersion: string;
	readonly piFffVersion: string;
	readonly status: "verified" | "forward-compatible/unverified";
	readonly integrity: "missing" | "registry-unverified" | "verified";
	readonly diagnostics: readonly PiFffDiagnostic[];
	readonly trace: readonly RecordedRegistration[];
}

export type PiFffRegistrationPlan =
	| (PiFffPlanBase & { readonly profile: "legacy"; readonly captureMode: "legacy-pair"; readonly captures: { readonly read: SourceToolDefinition; readonly grep: SourceToolDefinition } })
	| (PiFffPlanBase & { readonly profile: "scoped"; readonly captureMode: "scoped-pair"; readonly captures: { readonly grep: SourceToolDefinition; readonly find: SourceToolDefinition } });

export type PiFffComposites =
	| { readonly read: SourceToolDefinition; readonly grep: SourceToolDefinition }
	| { readonly grep: SourceToolDefinition; readonly find: SourceToolDefinition };

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
const PACKAGE_PROFILES = PI_FFF_PACKAGE_PROFILES;
const REGISTRATION_METHODS: readonly RegistrationMethod[] = [
	"registerTool", "registerCommand", "registerShortcut", "registerFlag",
	"registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on",
];
export const TIDY_PI_FFF_CONFLICTS: Readonly<PiFffConflictSet> = Object.freeze({
	// grep/find are intentional scoped substitution targets, so callers report
	// only external target conflicts through BuildPiFffPlanOptions.conflicts.
	tools: Object.freeze(["write", "edit", "bash", "ls"]),
	commands: Object.freeze(["tidy", "diff"]),
	shortcuts: Object.freeze(["ctrl+shift+o"]),
	messageRenderers: Object.freeze(["minimal-turn-diff"]),
});
const REQUIRED_NONMUTATING_METHODS = ["getFlag"] as const;
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
// Stable anchors shared by the scoped 0.6.0 floor and verified 0.9.6.
// Version-specific optional fields (literal vs caseSensitive/exclude, find cursor)
// remain compatible additions and are preserved without freezing one release.
const SCOPED_BASELINE: Record<"grep" | "find", Record<string, { type: "string" | "number"; required: boolean }>> = {
	grep: {
		pattern: { type: "string", required: true }, path: { type: "string", required: false }, context: { type: "number", required: false },
		limit: { type: "number", required: false }, cursor: { type: "string", required: false },
	},
	find: { pattern: { type: "string", required: true }, path: { type: "string", required: false }, limit: { type: "number", required: false } },
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
	profile: PiFffPackageProfile = PACKAGE_PROFILES["pi-fff"],
): PiFffDiagnostic {
	const summaries: Record<PiFffDiagnosticCode, string> = {
		PIFFF_BELOW_MINIMUM: `pi-fff adapter inactive: minimums are Pi ${MIN_PI} and ${profile.identity} ${profile.minimum}.`,
		PIFFF_CAPABILITY_MISSING: "pi-fff adapter inactive: a required running Pi capability is unavailable.",
		PIFFF_CONFIG_MISSING: "pi-fff adapter inactive: no managed pi-fff package entry is selected.",
		PIFFF_CONFIG_AMBIGUOUS: "pi-fff adapter inactive: package identity selection is ambiguous.",
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
		PIFFF_CONFIG_MISSING: "Install pi-fff or @ff-labs/pi-fff in a managed Pi npm scope, then run /tidy pi-fff setup.",
		PIFFF_CONFIG_AMBIGUOUS: "Keep exactly one pi-fff package identity in each settings scope, then /reload.",
		PIFFF_CONFIG_FILTER_REQUIRED: "Run /tidy pi-fff setup to set extensions: [], then /reload.",
		PIFFF_SCOPE_SHADOWED_INVALID: "Fix or remove the selected project entry; tidy will not fall back to user scope.",
		PIFFF_PACKAGE_MISSING: `Install npm:${profile.identity}@${profile.minimum} or newer with extensions: [], then /reload.`,
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

function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	return entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as any).source === "string" ? (entry as any).source : undefined;
}

function npmPiFffEntry(settings: any): { entry?: unknown; ambiguous: boolean } {
	if (!Array.isArray(settings?.packages)) return { ambiguous: false };
	const entries = settings.packages.filter((entry: unknown) => matchPiFffSource(sourceOf(entry)) !== undefined);
	return { entry: entries[0], ambiguous: entries.length > 1 };
}

function validateSelectedEntry(entry: unknown, expected?: PiFffPackageProfile): { failure?: string; profile?: PiFffPackageProfile; version?: string } {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { failure: "the selected entry is not object form" };
	const selected = entry as any;
	const parsed = matchPiFffSource(selected.source);
	if (!parsed) return { failure: "the selected source is not a managed pi-fff identity" };
	if (expected && parsed.packageProfile.identity !== expected.identity) return { failure: `the selected source is not ${expected.identity}` };
	const selectedProfile = { profile: parsed.packageProfile, version: parsed.version };
	if (!Array.isArray(selected.extensions) || selected.extensions.length !== 0) return { failure: "extensions must be exactly []", ...selectedProfile };
	return selectedProfile;
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

async function validateLocalIntegrity(managedRoot: string, manifest: any, profile: PiFffPackageProfile, registryIntegrity?: string): Promise<IntegrityCheck> {
	let lock: any;
	try { lock = JSON.parse(await readFile(join(managedRoot, "package-lock.json"), "utf8")); }
	catch (error: any) {
		if (error?.code === "ENOENT") return { status: "missing" };
		return { status: "mismatch", detail: `selected lock is unreadable: ${oneLine(error)}` };
	}
	if (!lock || typeof lock !== "object") return { status: "mismatch", detail: "selected lock is malformed" };
	const packageKey = `node_modules/${profile.identity}`;
	const packageEntry = lock.packages?.[packageKey];
	const dependencyEntry = lock.dependencies?.[profile.identity];
	const entries = [packageEntry, dependencyEntry].filter((value) => value !== undefined);
	if (!entries.length) return { status: "mismatch", detail: `selected lock has no ${profile.identity} entry` };
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") return { status: "mismatch", detail: `selected lock ${profile.identity} entry is malformed` };
		if (entry.name !== undefined && entry.name !== profile.identity) return { status: "mismatch", detail: `selected lock identity differs from ${profile.identity}` };
		if (entry.version !== manifest.version) return { status: "mismatch", detail: `selected lock version ${String(entry.version)} differs from installed ${manifest.version}` };
		if (entry.resolved !== undefined) {
			if (typeof entry.resolved !== "string" || entry.resolved.length === 0) return { status: "mismatch", detail: "selected lock resolved artifact is malformed" };
			try {
				const resolvedArtifact = new URL(entry.resolved);
				const expectedPath = `/${profile.identity}/-/pi-fff-${manifest.version}.tgz`;
				if (resolvedArtifact.hostname !== "registry.npmjs.org" || decodeURIComponent(resolvedArtifact.pathname) !== expectedPath) return { status: "mismatch", detail: `selected lock resolved artifact differs from ${profile.identity} identity or version` };
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
	for (const method of REQUIRED_NONMUTATING_METHODS) if (typeof api?.[method] !== "function") return method;
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

function objectParameterSchemaFailure(schema: unknown): string | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "parameters is not an object schema";
	const value = schema as Record<string, unknown>;
	if (!equivalentPrimitive({ type: value.type }, "object")) return "parameters is not an object schema";
	if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) return "parameters.properties is malformed";
	for (const [name, property] of Object.entries(value.properties as Record<string, unknown>)) {
		if (!name || !property || typeof property !== "object" || Array.isArray(property)) return `parameter ${name || "<empty>"} schema is malformed`;
	}
	if (value.required !== undefined) {
		if (!Array.isArray(value.required) || value.required.some((field) => typeof field !== "string" || !Object.hasOwn(value.properties as object, field))) {
			return "parameters.required is malformed";
		}
	}
	return undefined;
}

const SCHEMA_ANNOTATIONS = new Set(["description", "title", "$id", "$comment", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
function plainPrimitiveSchema(schema: unknown, expected: "string" | "number"): boolean {
	return !!schema && typeof schema === "object" && !Array.isArray(schema)
		&& (schema as any).type === expected
		&& Object.keys(schema as Record<string, unknown>).every((key) => key === "type" || SCHEMA_ANNOTATIONS.has(key));
}

function scopedSchemaFailure(tool: any, name: "grep" | "find"): string | undefined {
	const schema = tool.parameters;
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const [field, anchor] of Object.entries(SCOPED_BASELINE[name])) {
		const property = schema.properties[field];
		const compatible = plainPrimitiveSchema(property, anchor.type);
		if (!compatible) return `${tool.name}.${field} must remain ${anchor.type}`;
		if (required.has(field) !== anchor.required) return `${tool.name}.${field} requiredness changed`;
	}
	for (const field of required) if (!Object.hasOwn(SCOPED_BASELINE[name], String(field))) return `${tool.name} added required field ${String(field)}`;
	if (tool.promptSnippet !== undefined && typeof tool.promptSnippet !== "string") return `${tool.name}.promptSnippet is malformed`;
	if (tool.promptGuidelines !== undefined && (!Array.isArray(tool.promptGuidelines) || tool.promptGuidelines.some((item: unknown) => typeof item !== "string"))) return `${tool.name}.promptGuidelines is malformed`;
	if (tool.renderCall !== undefined && typeof tool.renderCall !== "function") return `${tool.name}.renderCall is malformed`;
	if (tool.renderResult !== undefined && typeof tool.renderResult !== "function") return `${tool.name}.renderResult is malformed`;
	return undefined;
}

function schemaFailure(tool: any, name: "read" | "grep"): string | undefined {
	if (!tool || typeof tool !== "object" || tool.name !== name) return `${name} definition is malformed`;
	if (typeof tool.execute !== "function") return `${name}.execute is not callable`;
	const schema = tool.parameters;
	const parameterFailure = objectParameterSchemaFailure(schema);
	if (parameterFailure) return `${name}.${parameterFailure}`;
	if (Object.hasOwn(schema.properties, "reasoning")) return `${name}.reasoning conflicts with tidy-owned reasoning`;
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

function validateTrace(trace: readonly RecordedRegistration[], profile: PiFffPackageProfile, piFffVersion: string, conflicts: PiFffConflictSet | undefined): { read: SourceToolDefinition; grep: SourceToolDefinition } | { grep: SourceToolDefinition; find: SourceToolDefinition } {
	const legacyCaptures: Partial<Record<"read" | "grep", SourceToolDefinition>> = {};
	const scopedCaptures: Partial<Record<"grep" | "find", SourceToolDefinition>> = {};
	const conflictNames = (key: keyof PiFffConflictSet): string[] => [
		...(TIDY_PI_FFF_CONFLICTS[key] ?? []),
		...(conflicts?.[key] ?? []),
	];
	const seen = {
		tools: new Set([...conflictNames("tools"), ...(profile.profile === "legacy" ? ["find"] : [])]), commands: new Set(conflictNames("commands")), shortcuts: new Set(conflictNames("shortcuts")),
		flags: new Set(conflictNames("flags")), messageRenderers: new Set(conflictNames("messageRenderers")),
		entryRenderers: new Set(conflictNames("entryRenderers")), providers: new Set(conflictNames("providers")),
	};
	const lifecycle = new Set<string>();
	const scopedTools = new Set<string>();
	const scopedCommands = new Set<string>();
	const scopedFlags = new Set<string>();
	for (const call of trace) {
		if (call.method === "unregisterProvider") throw new SurfaceFailure("unregisterProvider cannot be committed transactionally");
		if (call.method === "registerTool") {
			if (call.args.length !== 1 || !call.args[0] || typeof call.args[0] !== "object") throw new SurfaceFailure("registerTool arguments are malformed");
			const tool = call.args[0] as any;
			if (typeof tool.name !== "string" || typeof tool.description !== "string" || typeof tool.label !== "string" || typeof tool.execute !== "function") throw new SurfaceFailure("tool definition is structurally invalid");
			const parameterFailure = objectParameterSchemaFailure(tool.parameters);
			if (parameterFailure) throw new SurfaceFailure(`${tool.name}.${parameterFailure}`);
			if (tool.name === "read" || tool.name === "grep") {
				if (profile.profile === "scoped") throw new SurfaceFailure(`scoped ${tool.name} override uses an unsupported capture surface`);
				const toolName = tool.name as "read" | "grep";
				if (legacyCaptures[toolName]) throw new SurfaceFailure(`duplicate ${toolName} capture`);
				const failure = schemaFailure(tool, toolName); if (failure) throw new SurfaceFailure(failure);
				legacyCaptures[toolName] = tool;
				continue;
			}
			if (profile.profile === "scoped" && (tool.name === "ffgrep" || tool.name === "fffind")) {
				const publicName = tool.name === "ffgrep" ? "grep" : "find";
				if (scopedCaptures[publicName]) throw new SurfaceFailure(`duplicate ${tool.name} capture`);
				if (Object.hasOwn(tool.parameters.properties, "reasoning")) throw new SurfaceFailure(`${tool.name}.reasoning conflicts with tidy-owned reasoning`);
				const failure = scopedSchemaFailure(tool, publicName); if (failure) throw new SurfaceFailure(failure);
				if (conflictNames("tools").includes(publicName)) throw new SurfaceFailure(`tool conflict ${publicName}`);
				scopedCaptures[publicName] = tool;
				scopedTools.add(tool.name);
				continue;
			}
			if (profile.profile === "scoped" && ["grep", "find", "multi_grep"].includes(tool.name)) throw new SurfaceFailure(`scoped override tool ${tool.name} conflicts with tidy ownership`);
			if (seen.tools.has(tool.name)) throw new SurfaceFailure(`tool conflict ${tool.name}`);
			seen.tools.add(tool.name);
			if (profile.profile === "scoped") scopedTools.add(tool.name);
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
		if (profile.profile === "scoped" && call.method === "registerCommand") scopedCommands.add(name);
		if (profile.profile === "scoped" && call.method === "registerFlag") scopedFlags.add(name);
		const value = call.args[1] as any;
		if (call.method === "registerCommand" && (call.args.length !== 2 || !value || typeof value.handler !== "function")) throw new SurfaceFailure("command definition is malformed");
		if (call.method === "registerShortcut" && (call.args.length !== 2 || !value || typeof value.handler !== "function")) throw new SurfaceFailure("shortcut definition is malformed");
		if (call.method === "registerFlag" && (call.args.length !== 2 || !value || (value.type !== "boolean" && value.type !== "string"))) throw new SurfaceFailure("flag definition is malformed");
		if ((call.method === "registerMessageRenderer" || call.method === "registerEntryRenderer") && (call.args.length !== 2 || typeof value !== "function")) throw new SurfaceFailure("renderer definition is malformed");
		if (call.method === "registerProvider" && (call.args.length !== 2 || !value || typeof value !== "object")) throw new SurfaceFailure("provider definition is malformed");
	}
	if (profile.profile === "legacy" && (!legacyCaptures.read || !legacyCaptures.grep)) throw new SurfaceFailure("exactly one enabled read and grep capture is required");
	if (profile.profile === "scoped") {
		for (const name of ["ffgrep", "fffind"]) if (!scopedTools.has(name)) throw new SurfaceFailure(`exactly one scoped tool ${name} capture is required`);
		for (const name of ["fff-mode", "fff-health", "fff-rescan"]) if (!scopedCommands.has(name)) throw new SurfaceFailure(`scoped command ${name} is required`);
		const requiredFlags = ["fff-mode", "fff-frecency-db", "fff-history-db"];
		if (semver.gte(piFffVersion, "0.9.5")) requiredFlags.push("fff-enable-root-scan");
		for (const name of requiredFlags) if (!scopedFlags.has(name)) throw new SurfaceFailure(`scoped flag ${name} is required`);
	}
	if (!lifecycle.has("session_start") || !lifecycle.has("session_shutdown")) throw new SurfaceFailure("session_start and session_shutdown lifecycle anchors are required");
	return profile.profile === "legacy"
		? legacyCaptures as { read: SourceToolDefinition; grep: SourceToolDefinition }
		: scopedCaptures as { grep: SourceToolDefinition; find: SourceToolDefinition };
}

export async function buildPiFffRegistrationPlan(options: BuildPiFffPlanOptions): Promise<PiFffResult<PiFffRegistrationPlan>> {
	const piVersion = options.piVersion ?? VERSION;
	let piFffVersion = "unknown";
	if (!isAtLeast(piVersion, MIN_PI)) return { ok: false, diagnostic: diagnostic("PIFFF_BELOW_MINIMUM", piVersion, piFffVersion, `detected Pi ${piVersion}`) };
	const capability = validateApi(options.api);
	if (capability) return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", piVersion, piFffVersion, `ExtensionAPI.${capability}`) };

	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const project = options.selection ? { ambiguous: false } : npmPiFffEntry(await readSettings(join(cwd, ".pi", "settings.json")));
	const user = options.selection ? { ambiguous: false } : npmPiFffEntry(await readSettings(join(agentDir, "settings.json")));
	if (project.ambiguous || user.ambiguous) return { ok: false, diagnostic: diagnostic("PIFFF_CONFIG_AMBIGUOUS", piVersion, piFffVersion, `${project.ambiguous ? "project" : "user"} settings contains both or duplicate pi-fff identities`) };
	const projectEntry = project.entry;
	const userEntry = user.entry;
	const scope = options.selection?.scope ?? (projectEntry !== undefined ? "project" : userEntry !== undefined ? "user" : undefined);
	const entry = options.selection?.entry ?? projectEntry ?? userEntry;
	if (!scope) return { ok: false, diagnostic: diagnostic("PIFFF_CONFIG_MISSING", piVersion, piFffVersion, "no managed npm entry") };
	const selected = validateSelectedEntry(entry);
	const profile = selected.profile ?? PACKAGE_PROFILES["pi-fff"];
	if (selected.failure) {
		const code = scope === "project" && userEntry !== undefined ? "PIFFF_SCOPE_SHADOWED_INVALID" : "PIFFF_CONFIG_FILTER_REQUIRED";
		return { ok: false, diagnostic: diagnostic(code, piVersion, piFffVersion, selected.failure, "error", profile) };
	}

	const managedRoot = scope === "project" ? join(cwd, ".pi", "npm") : join(agentDir, "npm");
	const packageRoot = join(managedRoot, "node_modules", ...profile.segments);
	const canonicalRoot = await canonicalExact(packageRoot);
	if (!canonicalRoot) {
		let missing = false;
		try { await readFile(join(packageRoot, "package.json")); } catch { missing = true; }
		return { ok: false, diagnostic: diagnostic(missing ? "PIFFF_PACKAGE_MISSING" : "PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, missing ? `selected ${scope} package is absent` : "package root is non-canonical", "error", profile) };
	}

	let manifest: any;
	try { manifest = JSON.parse(await readFile(join(canonicalRoot, "package.json"), "utf8")); }
	catch (error) { return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `manifest: ${oneLine(error)}`, "error", profile) }; }
	piFffVersion = typeof manifest?.version === "string" ? manifest.version : "unknown";
	if (!isAtLeast(piFffVersion, profile.minimum)) return { ok: false, diagnostic: diagnostic("PIFFF_BELOW_MINIMUM", piVersion, piFffVersion, `detected ${profile.identity} ${piFffVersion}`, "error", profile) };
	if (manifest?.name !== profile.identity) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `manifest identity is not ${profile.identity}`, "error", profile) };
	const configuredVersion = selected.version;
	if (configuredVersion !== undefined) {
		if (!semver.valid(configuredVersion)) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `configured version ${configuredVersion} is not valid SemVer`, "error", profile) };
		if (configuredVersion !== piFffVersion) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, `configured ${configuredVersion} does not match installed ${piFffVersion}`, "error", profile) };
	}
	const integrity = await validateLocalIntegrity(managedRoot, manifest, profile, options.registryIntegrity);
	if (integrity.status === "mismatch") return { ok: false, diagnostic: diagnostic("PIFFF_INTEGRITY_MISMATCH", piVersion, piFffVersion, integrity.detail, "error", profile) };
	const extensions = manifest?.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string") return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, "manifest must declare one current extension entry", "error", profile) };
	const expectedEntry = resolve(canonicalRoot, extensions[0]);
	const canonicalEntry = await canonicalExact(expectedEntry);
	if (!canonicalEntry || !pathIsInside(canonicalRoot, canonicalEntry)) return { ok: false, diagnostic: diagnostic("PIFFF_PACKAGE_INVALID", piVersion, piFffVersion, "extension entry escapes or is unavailable", "error", profile) };

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
		return { ok: false, diagnostic: diagnostic(code, piVersion, piFffVersion, oneLine(error), "error", profile) };
	}
	let captures: { read: SourceToolDefinition; grep: SourceToolDefinition } | { grep: SourceToolDefinition; find: SourceToolDefinition };
	try { captures = validateTrace(trace, profile, piFffVersion, options.conflicts); }
	catch (error) { return { ok: false, diagnostic: diagnostic("PIFFF_SURFACE_BREAKING", piVersion, piFffVersion, oneLine(error), "error", profile) }; }
	gate.phase = "planned";
	const status: PiFffRegistrationPlan["status"] = compareVersions(piVersion, MIN_PI) === 0 && compareVersions(piFffVersion, profile.verified) === 0 ? "verified" : "forward-compatible/unverified";
	const infos: PiFffDiagnostic[] = [];
	if (integrity.status === "registry-unverified") infos.push(diagnostic("PIFFF_INTEGRITY_UNVERIFIED", piVersion, piFffVersion, "local lock identity, version, resolved artifact, and integrity are consistent", "info", profile));
	if (status === "forward-compatible/unverified") infos.push(diagnostic("PIFFF_FORWARD_UNVERIFIED", piVersion, piFffVersion, "eligible tuple passed structural capability validation", "info", profile));
	const common = {
		scope, packageIdentity: profile.identity, profile: profile.profile, packageRoot: canonicalRoot, entryPath: canonicalEntry, piVersion, piFffVersion, status,
		integrity: integrity.status, diagnostics: Object.freeze(infos), trace: Object.freeze(trace.slice()),
	};
	const plan: PiFffRegistrationPlan = profile.profile === "legacy"
		? Object.freeze({ ...common, profile: "legacy" as const, captureMode: "legacy-pair" as const, captures: Object.freeze(captures as { read: SourceToolDefinition; grep: SourceToolDefinition }) })
		: Object.freeze({ ...common, profile: "scoped" as const, captureMode: "scoped-pair" as const, captures: Object.freeze(captures as { grep: SourceToolDefinition; find: SourceToolDefinition }) });
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

function guardedSource(plan: PiFffRegistrationPlan, source: SourceToolDefinition, publicName: string): SourceToolDefinition {
	return {
		...source,
		name: publicName,
		execute(_id: string, params: any, signal: any, onUpdate: any, context: any) {
			const returned = source.execute.call(source, _id, params, signal, onUpdate, context);
			return returned && typeof returned.then === "function"
				? returned.then((value: any) => validateResult(value, plan, publicName))
				: validateResult(returned, plan, publicName);
		},
	};
}

/** Return guarded, publicly named sources for the host's tidy decorator. */
export function createPiFffCompositeSources(plan: PiFffRegistrationPlan): PiFffComposites {
	return plan.profile === "legacy"
		? { read: guardedSource(plan, plan.captures.read, "read"), grep: guardedSource(plan, plan.captures.grep, "grep") }
		: { grep: guardedSource(plan, plan.captures.grep, "grep"), find: guardedSource(plan, plan.captures.find, "find") };
}

/** Apply tidy's schema seam around captured execution without registering it. */
export function createPiFffComposites(plan: Extract<PiFffRegistrationPlan, { profile: "legacy" }>, options: SourceToolCompositionOptions): { read: SourceToolDefinition; grep: SourceToolDefinition };
export function createPiFffComposites(plan: Extract<PiFffRegistrationPlan, { profile: "scoped" }>, options: SourceToolCompositionOptions): { grep: SourceToolDefinition; find: SourceToolDefinition };
export function createPiFffComposites(plan: PiFffRegistrationPlan, options: SourceToolCompositionOptions): PiFffComposites;
export function createPiFffComposites(plan: PiFffRegistrationPlan, options: SourceToolCompositionOptions): PiFffComposites {
	const sources = createPiFffCompositeSources(plan);
	return Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, composeSourceTool(source, options)])) as PiFffComposites;
}

/** Commit a previously validated plan once, preserving trace order and identities. */
export function replayPiFffRegistrationPlan(
	plan: PiFffRegistrationPlan,
	api: Record<string, any>,
	composites?: PiFffComposites,
): ReplayResult {
	const gate = gates.get(plan);
	if (!gate || gate.phase !== "planned") return { ok: false, diagnostic: diagnostic("PIFFF_FORWARD_PARTIAL", plan.piVersion, plan.piFffVersion, "plan is stale or already replayed", "fatal") };
	const capability = validateApi(api);
	if (capability) return { ok: false, diagnostic: diagnostic("PIFFF_CAPABILITY_MISSING", plan.piVersion, plan.piFffVersion, `ExtensionAPI.${capability}`) };
	const publicNames = plan.profile === "legacy" ? (["read", "grep"] as const) : (["grep", "find"] as const);
	const invalidComposite = publicNames.find((name) => {
		const tool = (composites as Record<string, SourceToolDefinition> | undefined)?.[name];
		return !tool || tool.name !== name || typeof tool.execute !== "function" || !tool.parameters || typeof tool.parameters !== "object";
	});
	if (invalidComposite) return { ok: false, diagnostic: diagnostic("PIFFF_SURFACE_BREAKING", plan.piVersion, plan.piFffVersion, `${invalidComposite} composite is malformed`) };
	gate.phase = "committing";
	let committed = 0;
	try {
		for (const call of plan.trace) {
			const sourceName = call.method === "registerTool" ? (call.args[0] as any)?.name : undefined;
			const substitute = plan.profile === "legacy"
				? sourceName === "read" ? "read" : sourceName === "grep" ? "grep" : undefined
				: sourceName === "ffgrep" ? "grep" : sourceName === "fffind" ? "find" : undefined;
			const args = substitute ? [(composites as Record<string, SourceToolDefinition>)[substitute]] : call.args;
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
