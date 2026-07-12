import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	buildPiFffRegistrationPlan,
	createPiFffCompositeSources,
	replayPiFffRegistrationPlan,
	type PiFffCapabilityProfile,
	type PiFffDiagnostic,
	type PiFffPackageIdentity,
	type PiFffRegistrationPlan,
} from "./adapter.js";
import type { SourceToolDefinition } from "../tool-composition.js";
import {
	createPiFffLifecycle,
	type PiFffLifecycle,
	type PiFffLifecycleAction,
	type PiFffLifecycleParticipant,
	type PiFffLifecyclePreview,
	type PiFffLifecycleResult,
} from "./integration.js";

export type PiFffRoutingState =
	| "absent" | "standalone" | "filtered-unmanaged" | "managed-compatible"
	| "managed-invalid" | "recovery-pending" | "disabled";

export interface PiFffRoutingStatus {
	readonly state: PiFffRoutingState;
	readonly owner: "tidy/native" | "standalone pi-fff" | "tidy/pi-fff" | "native Pi" | "tidy/native read + FFF-executed tidy grep/find" | "native Pi + pi-fff tools" | "tidy/native read; grep/find unavailable" | "tidy native tools; read/grep unavailable" | "unsafe partial registration; reload required";
	readonly scopes: readonly ("project" | "user")[];
	readonly packageIdentity?: PiFffPackageIdentity;
	readonly profile?: PiFffCapabilityProfile;
	readonly piVersion?: string;
	readonly piFffVersion?: string;
	readonly tuple?: "verified" | "forward-compatible/unverified" | "unavailable";
	readonly journal: string;
	readonly diagnostic?: { readonly code: string; readonly severity: "info" | "warning" | "error" | "fatal"; readonly detail: string };
	readonly action: string;
}

export interface PiFffStartupPlan {
	readonly status: PiFffRoutingStatus;
	readonly skipTidyTools: ReadonlySet<"read" | "grep" | "find">;
	readonly notice?: { readonly message: string; readonly level: "warning" | "error" };
	commit(createComposite: (source: SourceToolDefinition) => SourceToolDefinition): void;
}

export interface PiFffCommandResult {
	readonly message: string;
	readonly level: "info" | "warning" | "error";
	readonly reload: "none" | "requested" | "required";
	readonly status: PiFffRoutingStatus;
}

export interface PiFffIntegrationController {
	initialize(enabled: boolean): Promise<PiFffStartupPlan>;
	run(action: PiFffLifecycleAction, options: {
		enabled: boolean;
		confirm?: (preview: PiFffLifecyclePreview) => Promise<boolean>;
		reload?: () => Promise<void>;
	}): Promise<PiFffCommandResult>;
}

export interface CreatePiFffControllerOptions {
	pi: Record<string, any>;
	cwd: string;
	agentDir?: string;
	lifecycle?: PiFffLifecycle;
	buildPlan?: typeof buildPiFffRegistrationPlan;
}

const SKIP_LEGACY = new Set<"read" | "grep" | "find">(["read", "grep"]);
const SKIP_SCOPED = new Set<"read" | "grep" | "find">(["grep", "find"]);
const NONE = new Set<"read" | "grep" | "find">();
const skipFor = (participant?: PiFffLifecycleParticipant) => participant?.profile === "scoped" ? NONE : SKIP_LEGACY;

function selected(participants: readonly PiFffLifecycleParticipant[]): PiFffLifecycleParticipant | undefined {
	return participants.find((item) => item.scope === "project") ?? participants.find((item) => item.scope === "user");
}

function isFiltered(entry: unknown): boolean {
	return !!entry && typeof entry === "object" && !Array.isArray(entry)
		&& Array.isArray((entry as { extensions?: unknown }).extensions)
		&& (entry as { extensions: unknown[] }).extensions.length === 0;
}

function lifecycleDiagnostic(value: PiFffLifecycleResult): PiFffRoutingStatus["diagnostic"] {
	return value.code ? { code: value.code, severity: value.outcome === "error" ? "error" : "warning", detail: value.message } : undefined;
}

function adapterDiagnostic(value: PiFffDiagnostic): PiFffRoutingStatus["diagnostic"] {
	return { code: value.code, severity: value.severity, detail: value.detail };
}

function forwardedDiagnostic(error: unknown): PiFffDiagnostic | undefined {
	return error && typeof error === "object" ? (error as { diagnostic?: PiFffDiagnostic }).diagnostic : undefined;
}

function safeCompositionDiagnostic(plan: PiFffRegistrationPlan, error: unknown): PiFffDiagnostic {
	const forwarded = forwardedDiagnostic(error);
	if (forwarded && forwarded.code !== "PIFFF_FORWARD_PARTIAL") return forwarded;
	return {
		code: "PIFFF_SURFACE_BREAKING", severity: "error",
		summary: "pi-fff tool composition failed before registration.",
		detail: error instanceof Error ? error.message : String(error),
		action: "Repair the incompatible composition and /reload; unaffected tools remain safe.",
		piVersion: plan.piVersion, piFffVersion: plan.piFffVersion,
	};
}

function partialReplayDiagnostic(plan: PiFffRegistrationPlan, error: unknown): PiFffDiagnostic {
	const forwarded = forwardedDiagnostic(error);
	if (forwarded?.code === "PIFFF_FORWARD_PARTIAL") return { ...forwarded, severity: "fatal" };
	const detail = forwarded ? `${forwarded.code}: ${forwarded.detail}` : error instanceof Error ? error.message : String(error);
	return {
		code: "PIFFF_FORWARD_PARTIAL", severity: "fatal",
		summary: "pi-fff registration replay failed; reload is required.", detail,
		action: "Stop using the affected integration and /reload before using FFF tools.",
		piVersion: plan.piVersion, piFffVersion: plan.piFffVersion,
	};
}

function statusFromLifecycle(value: PiFffLifecycleResult, enabled: boolean): PiFffRoutingStatus {
	const recovery = value.reload === "required";
	const active = selected(value.participants ?? []);
	return {
		state: recovery ? "recovery-pending" : enabled ? "managed-invalid" : "disabled",
		owner: active?.profile === "scoped" && enabled ? "tidy/native" : "native Pi",
		scopes: value.participants?.map((item) => item.scope) ?? [], packageIdentity: active?.packageIdentity, profile: active?.profile,
		tuple: "unavailable",
		journal: recovery ? "reload pending" : value.code ? "unsafe/incomplete" : "none",
		diagnostic: lifecycleDiagnostic(value),
		action: recovery ? `${active?.profile === "scoped" && enabled ? "Native tidy read/grep/find remain active; raw FFF names are hidden. " : ""}Run /reload once.`
			: value.code === "PIFFF_CONFIG_AMBIGUOUS" ? "Keep one pi-fff package identity across project and user settings, then run /tidy pi-fff status or setup again."
				: active?.profile === "scoped" && enabled ? "Native tidy read/grep/find remain active; raw FFF names are hidden. Use /tidy pi-fff status for safe recovery paths."
					: "Use /tidy pi-fff status for safe recovery paths.",
	};
}

function detailed(status: PiFffRoutingStatus): string {
	const scopes = status.scopes.length ? status.scopes.join(", ") : "none";
	const versions = `Pi ${status.piVersion ?? "unavailable"}; pi-fff ${status.piFffVersion ?? "unavailable"}`;
	return [
		`pi-fff: ${status.state}`,
		`scopes: ${scopes}`,
		`package: ${status.packageIdentity ?? "unavailable"}`,
		`profile: ${status.profile ?? "unavailable"}`,
		`versions: ${versions}`,
		`tuple: ${status.tuple ?? "unavailable"}`,
		`owner: ${status.owner}`,
		`journal: ${status.journal}`,
		`diagnostic: ${status.diagnostic ? `${status.diagnostic.code} — ${status.diagnostic.detail}` : "none"}`,
		`action: ${status.action}`,
	].join("\n");
}

export function concisePiFffStatus(status: PiFffRoutingStatus): string {
	return `pi-fff ${status.state}; tools: ${status.owner}`;
}

export function formatPiFffStatus(status: PiFffRoutingStatus): string { return detailed(status); }

export function createPiFffIntegrationController(options: CreatePiFffControllerOptions): PiFffIntegrationController {
	const agentDir = options.agentDir ?? getAgentDir();
	const buildPlan = options.buildPlan ?? buildPiFffRegistrationPlan;
	const lifecycle = options.lifecycle ?? createPiFffLifecycle({
		cwd: options.cwd,
		agentDir,
		preflight: async (participant) => {
			const built = await buildPlan({ cwd: options.cwd, agentDir, api: options.pi, selection: { scope: participant.scope, entry: participant.managedEntry } });
			if (!built.ok) throw Object.assign(new Error(built.diagnostic.summary), { diagnostic: built.diagnostic });
			return built.plan;
		},
	});
	let current: PiFffRoutingStatus = { state: "absent", owner: "tidy/native", scopes: [], tuple: "unavailable", journal: "none", action: "Install pi-fff before setup." };
	let initialized = false;

	const inspect = async (enabled: boolean): Promise<{ startup: PiFffLifecycleResult; discovered?: PiFffLifecycleResult }> => {
		const startup = await lifecycle.initialize(enabled);
		if (startup.outcome !== "ready") return { startup };
		return { startup, discovered: await lifecycle.run("status", { enabled }) };
	};

	return {
		async initialize(enabled) {
			const { startup, discovered } = await inspect(enabled);
			initialized = true;
			const lifecycleFailure = startup.outcome !== "ready" ? startup : discovered?.outcome !== "status" ? discovered : undefined;
			if (lifecycleFailure) {
				current = statusFromLifecycle(lifecycleFailure, enabled);
				return { status: current, skipTidyTools: skipFor(selected(lifecycleFailure.participants ?? [])), notice: { message: `${lifecycleFailure.message}${lifecycleFailure.reload === "required" ? " Run /reload once." : ""}`, level: lifecycleFailure.outcome === "error" ? "error" : "warning" }, commit() {} };
			}
			const participants = startup.participants ?? discovered?.participants ?? [];
			if (!enabled) {
				const managed = (startup.participants?.length ?? 0) > 0;
				const active = selected(participants);
				const standalone = !managed && active !== undefined && !isFiltered(active.priorEntry);
				current = {
					state: "disabled", owner: active?.profile === "scoped" && standalone ? "native Pi + pi-fff tools" : standalone ? "standalone pi-fff" : "native Pi",
					scopes: participants.map((item) => item.scope), packageIdentity: active?.packageIdentity, profile: active?.profile, tuple: "unavailable",
					journal: managed ? "committed (inactive)" : "none",
					action: managed ? "Enable tidy, or run /tidy pi-fff teardown to restore standalone loading."
						: standalone ? "Run /tidy on, then /tidy pi-fff setup for tidy presentation." : "Run /tidy on to enable tidy.",
				};
				return { status: current, skipTidyTools: skipFor(active), commit() {} };
			}
			if (!participants.length) {
				current = { state: "absent", owner: "tidy/native", scopes: [], tuple: "unavailable", journal: "none", action: "Install pi-fff before setup." };
				return { status: current, skipTidyTools: NONE, commit() {} };
			}
			const managed = (startup.participants?.length ?? 0) > 0;
			if (!managed) {
				const active = selected(participants)!;
				const filtered = isFiltered(active.priorEntry);
				current = { state: filtered ? "filtered-unmanaged" : "standalone", owner: active.profile === "scoped" ? (filtered ? "tidy/native" : "native Pi + pi-fff tools") : filtered ? "native Pi" : "standalone pi-fff", scopes: participants.map((item) => item.scope), packageIdentity: active.packageIdentity, profile: active.profile, tuple: "unavailable", journal: "none", diagnostic: { code: "PIFFF_SETUP_REQUIRED", severity: "warning", detail: "Explicit setup is required before tidy can manage this package." }, action: "Run /tidy pi-fff setup." };
				return { status: current, skipTidyTools: skipFor(active), notice: { message: "pi-fff is not managed by tidy; run /tidy pi-fff setup.", level: "warning" }, commit() {} };
			}
			const built = await buildPlan({ cwd: options.cwd, agentDir, api: options.pi });
			if (!built.ok) {
				const active = selected(participants);
				current = { state: "managed-invalid", owner: active?.profile === "scoped" ? "tidy/native" : "native Pi", scopes: participants.map((item) => item.scope), packageIdentity: active?.packageIdentity, profile: active?.profile, piVersion: built.diagnostic.piVersion, piFffVersion: built.diagnostic.piFffVersion, tuple: "unavailable", journal: "committed", diagnostic: adapterDiagnostic(built.diagnostic), action: `${active?.profile === "scoped" ? "Native tidy read/grep/find remain active; raw FFF names are hidden. " : ""}${built.diagnostic.action} Or run /tidy pi-fff teardown.` };
				return { status: current, skipTidyTools: skipFor(active), notice: built.diagnostic.severity === "info" ? undefined : { message: `${built.diagnostic.summary} ${current.action}`, level: "error" }, commit() {} };
			}
			const plan = built.plan;
			current = { state: "managed-compatible", owner: plan.profile === "scoped" ? "tidy/native read + FFF-executed tidy grep/find" : "tidy/pi-fff", scopes: participants.map((item) => item.scope), packageIdentity: plan.packageIdentity, profile: plan.profile, piVersion: plan.piVersion, piFffVersion: plan.piFffVersion, tuple: plan.status, journal: "committed", diagnostic: plan.diagnostics[0] ? adapterDiagnostic(plan.diagnostics[0]) : undefined, action: plan.profile === "scoped" ? "Native tidy read remains; FFF executes tidy-presented grep/find; raw ffgrep/fffind names are hidden. Use status or teardown." : "Use /tidy pi-fff status or teardown." };
			let committed = false;
			return {
				status: current, skipTidyTools: plan.profile === "scoped" ? SKIP_SCOPED : SKIP_LEGACY,
				commit(createComposite) {
					if (committed) return;
					committed = true;
					if (plan.profile === "legacy") {
						// Legacy pi-fff is last-writer-wins: it replaces, rather than wraps,
						// an editor already installed by another extension.
						options.pi.on("session_start", (_event: unknown, ctx: any) => {
							if (typeof ctx?.ui?.getEditorComponent?.() !== "function" || !ctx.ui.getEditorComponent()) return;
							ctx.ui.notify("pi-fff will replace an existing custom editor. Disable one editor feature and /reload; editor composition is not supported by this tuple.", "warning");
						});
					}
					const failSafe = (error: unknown): never => {
						const diagnostic = safeCompositionDiagnostic(plan, error);
						current = {
							...current, state: "managed-invalid",
							owner: plan.profile === "scoped" ? "tidy/native read; grep/find unavailable" : "tidy native tools; read/grep unavailable",
							tuple: "unavailable", journal: "committed", diagnostic: adapterDiagnostic(diagnostic),
							action: "FFF-backed tools were not registered; fix the diagnostic and /reload. Unaffected tools remain safe.",
						};
						throw Object.assign(new Error(diagnostic.summary, { cause: error }), { diagnostic });
					};
					const failPartial = (error: unknown): never => {
						const fatal = partialReplayDiagnostic(plan, error);
						current = {
							...current, state: "managed-invalid", owner: "unsafe partial registration; reload required",
							tuple: "unavailable", journal: "unsafe partial registration; reload required",
							diagnostic: adapterDiagnostic(fatal), action: "Stop using tools and /reload; registration ownership is unsafe until Pi restarts.",
						};
						throw Object.assign(new Error(fatal.summary, { cause: error }), { diagnostic: fatal });
					};
					let composites: any;
					try {
						const sources = createPiFffCompositeSources(plan);
						composites = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, createComposite(source)]));
					} catch (error) { return failSafe(error); }
					let replay;
					try { replay = replayPiFffRegistrationPlan(plan, options.pi, composites); }
					catch (error) { return failPartial(error); }
					if (!replay.ok) {
						const error = Object.assign(new Error(replay.diagnostic.summary), { diagnostic: replay.diagnostic });
						return replay.diagnostic.code === "PIFFF_FORWARD_PARTIAL" ? failPartial(error) : failSafe(error);
					}
				},
			};
		},
		async run(action, command) {
			if (action === "status") {
				if (!initialized) await this.initialize(command.enabled);
				const level = current.diagnostic?.severity === "error" || current.diagnostic?.severity === "fatal" ? "error" : "info";
				return { message: detailed(current), level, reload: "none", status: current };
			}
			const value = await lifecycle.run(action, command);
			const level = value.outcome === "error" ? "error" : value.outcome === "cancelled" ? "info" : "info";
			if (value.reload === "required") current = statusFromLifecycle(value, command.enabled);
			const refreshed = value.reload === "none" ? (await this.initialize(command.enabled)).status : current;
			return { message: value.code ? `${value.code}: ${value.message}` : value.message, level, reload: value.reload, status: refreshed };
		},
	};
}
