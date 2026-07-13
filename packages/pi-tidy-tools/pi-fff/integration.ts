import * as nodeFs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPlannedPiFffRegistrationPlan, type PiFffRegistrationPlan } from "./adapter.js";
import { matchPiFffSource, type PiFffCapabilityProfile, type PiFffPackageIdentity } from "./profiles.js";

export type PiFffLifecycleScope = "project" | "user";
export type PiFffLifecycleAction = "setup" | "status" | "teardown";
export type PiFffLifecycleDiagnosticCode =
	| "PIFFF_CONFIG_MISSING" | "PIFFF_CONFIG_AMBIGUOUS" | "PIFFF_CONFIRMATION_UNAVAILABLE"
	| "PIFFF_SETTINGS_DRIFT" | "PIFFF_TRANSACTION_INCOMPLETE" | "PIFFF_RECOVERY_RELOAD_REQUIRED"
	| "PIFFF_RECOVERY_UNSAFE" | "PIFFF_SETUP_DISABLED" | "PIFFF_PREFLIGHT_FAILED";

export interface PiFffLifecycleParticipant {
	readonly scope: PiFffLifecycleScope;
	readonly packageIdentity: PiFffPackageIdentity;
	readonly profile: PiFffCapabilityProfile;
	readonly settingsPath: string;
	readonly packageRoot: string;
	readonly entryIndex: number;
	readonly priorEntry: unknown;
	readonly managedEntry: unknown;
}

export interface PiFffLifecyclePreview {
	readonly action: "setup" | "teardown";
	readonly changes: readonly {
		readonly scope: PiFffLifecycleScope;
		readonly settingsPath: string;
		readonly before: unknown;
		readonly after: unknown;
	}[];
}

export interface PiFffLifecycleResult {
	readonly outcome: "ready" | "status" | "setup-committed" | "teardown-committed" | "cancelled" | "idempotent" | "recovery-reload-required" | "error";
	readonly code?: PiFffLifecycleDiagnosticCode;
	readonly message: string;
	readonly reload: "none" | "requested" | "required";
	readonly manualPaths?: readonly string[];
	readonly participants?: readonly PiFffLifecycleParticipant[];
}

export interface PiFffLifecycleFs {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; flag?: string }): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<{ writeFile(data: string | Uint8Array): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
	access(path: string, mode?: number): Promise<void>;
	realpath(path: string): Promise<string>;
	lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; mode: number }>;
	stat(path: string): Promise<{ isFile(): boolean; mode: number }>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface CreatePiFffLifecycleOptions {
	cwd: string;
	agentDir: string;
	/** Must build and fully validate the participant's genuine adapter plan; rejection aborts all writes. */
	preflight(participant: PiFffLifecycleParticipant): Promise<PiFffRegistrationPlan>;
	filesystem?: PiFffLifecycleFs;
	transactionId?: () => string;
	/** Deterministic crash seam, called after every durable lifecycle boundary. */
	checkpoint?: (name: string) => void | Promise<void>;
}

export interface PiFffLifecycle {
	initialize(enabled: boolean): Promise<PiFffLifecycleResult>;
	run(action: PiFffLifecycleAction, options: {
		enabled: boolean;
		confirm?: (preview: PiFffLifecyclePreview) => Promise<boolean>;
		reload?: () => Promise<void>;
	}): Promise<PiFffLifecycleResult>;
}

interface ParticipantRecord {
	scope: PiFffLifecycleScope;
	packageIdentity: PiFffPackageIdentity;
	profile: PiFffCapabilityProfile;
	settingsPath: string;
	entryIndex: number;
	priorEntry: unknown;
	managedEntry: unknown;
}

interface Journal {
	version: 1;
	transactionId: string;
	operation: "setup" | "teardown";
	phase: "prepared" | "settings-written" | "reload-pending" | "committed" | "restoring" | "restored";
	scope: PiFffLifecycleScope;
	settingsPath: string;
	counterpartPaths: string[];
	priorEntry: unknown;
	managedEntry: unknown;
	participants: ParticipantRecord[];
}

interface LocatedParticipant extends PiFffLifecycleParticipant {
	settingsBytes: Buffer;
	settings: Record<string, unknown> & { packages: unknown[] };
	mode: number;
	journalPath: string;
}

const JOURNAL_NAME = "pi-tidy-tools.pi-fff.json";
const scopes: readonly PiFffLifecycleScope[] = ["project", "user"];

const defaultFs: PiFffLifecycleFs = {
	readFile: (path) => nodeFs.readFile(path),
	writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
	open: (path, flags, mode) => nodeFs.open(path, flags, mode),
	access: (path, mode) => nodeFs.access(path, mode),
	realpath: (path) => nodeFs.realpath(path),
	lstat: (path) => nodeFs.lstat(path),
	stat: (path) => nodeFs.stat(path),
	rename: (from, to) => nodeFs.rename(from, to),
	unlink: (path) => nodeFs.unlink(path),
};

class LifecycleFailure extends Error {
	constructor(readonly code: PiFffLifecycleDiagnosticCode, message: string, readonly manualPaths?: readonly string[]) { super(message); }
}

function result(outcome: PiFffLifecycleResult["outcome"], message: string, extra: Partial<PiFffLifecycleResult> = {}): PiFffLifecycleResult {
	return { outcome, message, reload: "none", ...extra };
}

function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { source?: unknown }).source === "string") return (entry as { source: string }).source;
	return undefined;
}

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function managedEntry(entry: unknown): unknown {
	if (typeof entry === "string") return { source: entry, extensions: [] };
	return { ...(clone(entry) as Record<string, unknown>), extensions: [] };
}

function settingsCandidate(cwd: string, agentDir: string, scope: PiFffLifecycleScope): string {
	return scope === "project" ? join(resolve(cwd), ".pi", "settings.json") : join(resolve(agentDir), "settings.json");
}

async function optionalRead(fs: PiFffLifecycleFs, path: string): Promise<Buffer | undefined> {
	try { return await fs.readFile(path); }
	catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function parseObject(bytes: Buffer, label: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${label} is not valid JSON`); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${label} is not a JSON object`);
	return parsed as Record<string, unknown>;
}

function pathWithin(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function canonicalSettings(fs: PiFffLifecycleFs, candidate: string, managedRoot = dirname(candidate), allowOutsideManagedRoot = false): Promise<{ path: string; bytes: Buffer; mode: number; withinManagedRoot: boolean } | undefined> {
	let link;
	try { link = await fs.lstat(candidate); }
	catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
	if (!link.isFile() && !link.isSymbolicLink()) throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${candidate} is not a file`, [candidate]);
	const [path, root] = await Promise.all([fs.realpath(candidate), fs.realpath(managedRoot)]);
	const withinManagedRoot = pathWithin(root, path);
	if (!withinManagedRoot && !allowOutsideManagedRoot) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `${candidate} resolves outside its managed settings scope: ${path}`, [candidate, path]);
	const target = await fs.stat(path);
	if (!target.isFile()) throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${candidate} does not resolve to a regular file`, [candidate, path]);
	return { path, bytes: await fs.readFile(path), mode: target.mode & 0o777, withinManagedRoot };
}

async function discover(fs: PiFffLifecycleFs, cwd: string, agentDir: string): Promise<LocatedParticipant[]> {
	const found: LocatedParticipant[] = [];
	for (const scope of scopes) {
		const candidate = settingsCandidate(cwd, agentDir, scope);
		const canonical = await canonicalSettings(fs, candidate, dirname(candidate), true);
		if (!canonical) continue;
		const settings = parseObject(canonical.bytes, `${scope} settings`);
		const packages = settings.packages;
		if (packages === undefined) continue;
		if (!Array.isArray(packages)) throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${scope} packages is not an array`);
		const matches = packages.flatMap((entry, index) => {
			const matched = matchPiFffSource(sourceOf(entry));
			return matched ? [{ index, packageSource: matched.packageProfile }] : [];
		});
		if (!matches.length) continue;
		if (!canonical.withinManagedRoot) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `${candidate} resolves outside its managed settings scope: ${canonical.path}`, [candidate, canonical.path]);
		if (matches.length > 1) throw new LifecycleFailure("PIFFF_CONFIG_AMBIGUOUS", `${scope} settings contains both or duplicate pi-fff package identities`);
		if (found.some((participant) => participant.settingsPath === canonical.path)) {
			throw new LifecycleFailure("PIFFF_CONFIG_AMBIGUOUS", `project and user settings resolve to the same canonical file: ${canonical.path}`);
		}
		const { index: entryIndex, packageSource } = matches[0]!;
		const priorEntry = clone(packages[entryIndex]);
		const managedRoot = scope === "project" ? join(resolve(cwd), ".pi", "npm") : join(resolve(agentDir), "npm");
		found.push({
			scope, packageIdentity: packageSource.identity, profile: packageSource.profile,
			settingsPath: canonical.path, packageRoot: join(managedRoot, "node_modules", ...packageSource.segments),
			entryIndex, priorEntry, managedEntry: managedEntry(priorEntry), settingsBytes: canonical.bytes,
			settings: settings as LocatedParticipant["settings"], mode: canonical.mode,
			journalPath: join(dirname(candidate), JOURNAL_NAME),
		});
	}
	if (new Set(found.map((participant) => participant.packageIdentity)).size > 1) {
		throw new LifecycleFailure(
			"PIFFF_CONFIG_AMBIGUOUS",
			"Project and user settings select different pi-fff package identities; keep one pi-fff package identity across project and user settings, then retry.",
			found.map((participant) => participant.settingsPath),
		);
	}
	return found;
}

function recordOf(participant: PiFffLifecycleParticipant): ParticipantRecord {
	return { scope: participant.scope, packageIdentity: participant.packageIdentity, profile: participant.profile, settingsPath: participant.settingsPath, entryIndex: participant.entryIndex, priorEntry: clone(participant.priorEntry), managedEntry: clone(participant.managedEntry) };
}

function journalFor(transactionId: string, participant: LocatedParticipant, participants: LocatedParticipant[]): Journal {
	return {
		version: 1, transactionId, operation: "setup", phase: "prepared", scope: participant.scope,
		settingsPath: participant.settingsPath,
		counterpartPaths: participants.filter((item) => item !== participant).map((item) => item.settingsPath),
		priorEntry: clone(participant.priorEntry), managedEntry: clone(participant.managedEntry), participants: participants.map(recordOf),
	};
}

function journalBytes(journal: Journal): Buffer { return Buffer.from(JSON.stringify(journal, null, 2) + "\n"); }

async function rejectSymlink(fs: PiFffLifecycleFs, path: string): Promise<void> {
	try { if ((await fs.lstat(path)).isSymbolicLink()) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `${path} is a symlink`, [path]); }
	catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

async function atomicCompareWrite(fs: PiFffLifecycleFs, path: string, expected: Buffer | undefined, next: Buffer, mode: number): Promise<void> {
	await rejectSymlink(fs, path);
	const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
	let handle: Awaited<ReturnType<PiFffLifecycleFs["open"]>> | undefined;
	try {
		handle = await fs.open(temp, "wx", mode);
		await handle.writeFile(next); await handle.sync(); await handle.close(); handle = undefined;
		const current = await optionalRead(fs, path);
		if ((expected === undefined) !== (current === undefined) || (expected && current && !expected.equals(current))) {
			throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", `${path} changed before atomic rename`, [path]);
		}
		await fs.rename(temp, path);
	} finally {
		if (handle) await handle.close().catch(() => {});
		await fs.unlink(temp).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
	}
}

function replaceEntry(settings: Record<string, unknown>, index: number, expected: unknown, replacement: unknown): Record<string, unknown> {
	const packages = settings.packages;
	if (!Array.isArray(packages) || !equal(packages[index], expected)) throw new LifecycleFailure("PIFFF_SETTINGS_DRIFT", "pi-fff entry no longer matches the transaction snapshot");
	const next = clone(settings); (next.packages as unknown[])[index] = clone(replacement); return next;
}

async function writeParticipant(fs: PiFffLifecycleFs, participant: LocatedParticipant, expected: unknown, replacement: unknown): Promise<void> {
	const currentBytes = await fs.readFile(participant.settingsPath);
	const current = parseObject(currentBytes, participant.settingsPath);
	const next = replaceEntry(current, participant.entryIndex, expected, replacement);
	await atomicCompareWrite(fs, participant.settingsPath, currentBytes, Buffer.from(JSON.stringify(next, null, 2) + "\n"), participant.mode);
	participant.settingsBytes = await fs.readFile(participant.settingsPath);
	participant.settings = next as LocatedParticipant["settings"];
}

async function readJournal(fs: PiFffLifecycleFs, path: string): Promise<{ journal: Journal; bytes: Buffer } | undefined> {
	await rejectSymlink(fs, path);
	const bytes = await optionalRead(fs, path); if (!bytes) return undefined;
	const value = parseObject(bytes, path) as unknown as Journal;
	if (value.version !== 1 || typeof value.transactionId !== "string" || !Array.isArray(value.participants) || !value.participants.length) {
		throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `${path} is not a supported lifecycle journal`, [path]);
	}
	return { journal: value, bytes };
}

async function updateJournal(fs: PiFffLifecycleFs, path: string, mutate: (journal: Journal) => void): Promise<Journal> {
	const current = await readJournal(fs, path);
	if (!current) throw new LifecycleFailure("PIFFF_TRANSACTION_INCOMPLETE", `missing linked journal ${path}`, [path]);
	const next = clone(current.journal); mutate(next);
	await atomicCompareWrite(fs, path, current.bytes, journalBytes(next), 0o600);
	return next;
}

async function removeJournal(fs: PiFffLifecycleFs, path: string): Promise<void> {
	await rejectSymlink(fs, path);
	try { await fs.unlink(path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

async function participantFromRecord(fs: PiFffLifecycleFs, record: ParticipantRecord): Promise<LocatedParticipant> {
	const canonical = await canonicalSettings(fs, record.settingsPath);
	if (!canonical || canonical.path !== record.settingsPath) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `settings target unavailable: ${record.settingsPath}`, [record.settingsPath]);
	const settings = parseObject(canonical.bytes, record.settingsPath);
	return {
		...clone(record), packageRoot: "", settingsBytes: canonical.bytes,
		settings: settings as LocatedParticipant["settings"], mode: canonical.mode,
		journalPath: join(dirname(record.settingsPath), JOURNAL_NAME),
	};
}

function currentEntry(participant: LocatedParticipant): unknown { return participant.settings.packages[participant.entryIndex]; }

async function loadJournalSet(fs: PiFffLifecycleFs, cwd: string, agentDir: string): Promise<{ journals: Journal[]; participants: LocatedParticipant[] } | undefined> {
	const journalPaths = new Map<PiFffLifecycleScope, string>(); const journals: Journal[] = [];
	for (const scope of scopes) {
		const path = join(dirname(settingsCandidate(cwd, agentDir, scope)), JOURNAL_NAME);
		journalPaths.set(scope, path);
		const loaded = await readJournal(fs, path); if (loaded) journals.push(loaded.journal);
	}
	if (!journals.length) return undefined;
	const first = journals[0]!;
	const records = first.participants;
	const linked = journals.every((item) => {
		const own = records.find((record) => record.scope === item.scope);
		const counterparts = records.filter((record) => record.scope !== item.scope).map((record) => record.settingsPath);
		return item.transactionId === first.transactionId && equal(item.participants, records) && own !== undefined
			&& item.settingsPath === own.settingsPath && equal(item.priorEntry, own.priorEntry)
			&& equal(item.managedEntry, own.managedEntry) && equal(item.counterpartPaths, counterparts);
	});
	if (!linked) {
		throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", "linked lifecycle journals disagree", records.map((item) => item.settingsPath));
	}
	const manualPaths = records.flatMap((record) => [record.settingsPath, journalPaths.get(record.scope)!]);
	const participants: LocatedParticipant[] = [];
	try {
		for (const record of records) {
			const participant = await participantFromRecord(fs, record);
			participant.journalPath = journalPaths.get(record.scope)!;
			participants.push(participant);
		}
	} catch (error) {
		if (error instanceof LifecycleFailure) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", error.message, manualPaths);
		throw error;
	}
	return { journals, participants };
}

async function preflightDestinations(fs: PiFffLifecycleFs, participants: LocatedParticipant[]): Promise<void> {
	const paths = participants.flatMap((item) => [item.settingsPath, item.journalPath]);
	if (new Set(paths).size !== paths.length) throw new LifecycleFailure("PIFFF_CONFIG_AMBIGUOUS", "settings and sidecar destinations must be distinct", paths);
	for (const participant of participants) {
		await rejectSymlink(fs, participant.journalPath);
		const parent = await fs.realpath(dirname(participant.journalPath));
		if (parent !== resolve(dirname(participant.journalPath))) throw new LifecycleFailure("PIFFF_RECOVERY_UNSAFE", `sidecar directory is non-canonical: ${dirname(participant.journalPath)}`, [participant.settingsPath, participant.journalPath]);
		await fs.access(participant.settingsPath, constants.R_OK | constants.W_OK);
		await fs.access(parent, constants.W_OK);
	}
}

async function recover(fs: PiFffLifecycleFs, cwd: string, agentDir: string, checkpoint: (name: string) => Promise<void>): Promise<PiFffLifecycleResult> {
	let set: Awaited<ReturnType<typeof loadJournalSet>>;
	try { set = await loadJournalSet(fs, cwd, agentDir); }
	catch (error) {
		if (error instanceof LifecycleFailure) return result("error", error.message, { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: error.manualPaths });
		throw error;
	}
	if (!set) return result("ready", "No interrupted pi-fff transaction.");
	const { journals, participants } = set;
	const operation = journals.some((journal) => journal.operation === "teardown") ? "teardown" : "setup";
	const states = participants.map((participant) => equal(currentEntry(participant), participant.priorEntry) ? "prior" : equal(currentEntry(participant), participant.managedEntry) ? "managed" : "drift");
	const paths = participants.map((item) => item.settingsPath);
	if (states.includes("drift")) return result("error", "Recovery is unsafe because a managed entry drifted; restore it manually from the linked sidecars.", { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: paths, participants });
	const fullyCommittedSetup = operation === "setup" && journals.length === participants.length && journals.every((journal) => journal.phase === "committed") && states.every((state) => state === "managed");
	if (fullyCommittedSetup) return result("ready", "Managed pi-fff transaction is committed.", { participants });
	// Pi starts the replacement extension inside the awaited reload call. Reaching
	// initialize with every target setting and every linked journal reload-pending
	// is therefore the durable proof that the reload boundary was crossed. Mixed
	// pending/committed journals are the equivalent checkpoint-recovery edge.
	const setupReloadSucceeded = operation === "setup" && states.every((state) => state === "managed")
		&& journals.length === participants.length
		&& journals.every((journal) => journal.phase === "reload-pending" || journal.phase === "committed");
	if (setupReloadSucceeded) {
		try {
			for (const participant of participants) {
				await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "committed"; });
				await checkpoint(`recovery:setup:journal:${participant.scope}:committed`);
			}
			return result("ready", "Managed pi-fff transaction completed after successful reload.", { participants });
		} catch (error) {
			return result("error", `Recovery could not finalize setup: ${error instanceof Error ? error.message : String(error)}`, { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: paths, participants });
		}
	}
	// A missing subset is intentional crash evidence: settings were fully restored
	// and teardown journal removal stopped midway. Removing the remainder is safe
	// and idempotent; requiring the original linked count would strand recovery.
	const teardownReloadSucceeded = operation === "teardown" && states.every((state) => state === "prior")
		&& journals.length <= participants.length && journals.every((journal) => journal.phase === "reload-pending");
	if (teardownReloadSucceeded) {
		try {
			for (const participant of participants) {
				await removeJournal(fs, participant.journalPath);
				await checkpoint(`recovery:teardown:journal:${participant.scope}:removed`);
			}
			return result("ready", "pi-fff teardown completed after successful reload.");
		} catch (error) {
			return result("error", `Recovery could not finalize teardown: ${error instanceof Error ? error.message : String(error)}`, { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: paths, participants });
		}
	}
	const targetReached = journals.length === participants.length
		&& ((operation === "setup" && states.every((state) => state === "managed"))
			|| (operation === "teardown" && states.every((state) => state === "prior")));
	if (targetReached) {
		try {
			for (const participant of participants) {
				await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "reload-pending"; });
				await checkpoint(`recovery:${operation}:journal:${participant.scope}:reload-pending`);
			}
			return result("recovery-reload-required", "A pi-fff transition reached its target but reload did not complete. Run /reload once before using the integration.", { code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required", manualPaths: paths, participants });
		} catch (error) {
			return result("error", `Recovery could not persist reload-pending state: ${error instanceof Error ? error.message : String(error)}`, { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: paths, participants });
		}
	}
	try {
		if (operation === "teardown" && states.every((state) => state === "prior")) {
			for (const participant of participants) { await removeJournal(fs, participant.journalPath); await checkpoint(`teardown:journal:${participant.scope}:removed`); }
		} else {
			const target = operation === "setup" ? "prior" : "managed";
			for (let index = 0; index < participants.length; index++) {
				const participant = participants[index]!; const state = states[index]!;
				if (state !== target) await writeParticipant(fs, participant, operation === "setup" ? participant.managedEntry : participant.priorEntry, operation === "setup" ? participant.priorEntry : participant.managedEntry);
				await checkpoint(`recovery:${operation}:settings:${participant.scope}:restored`);
			}
			if (operation === "setup") for (const participant of participants) await removeJournal(fs, participant.journalPath);
			else for (const participant of participants) {
				const existing = await readJournal(fs, participant.journalPath);
				if (existing) await updateJournal(fs, participant.journalPath, (journal) => { journal.operation = "setup"; journal.phase = "committed"; });
			}
		}
		return result("recovery-reload-required", "Recovered interrupted pi-fff transaction. Run /reload once before using the integration.", { code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required", manualPaths: paths, participants });
	} catch (error) {
		return result("error", `Recovery could not proceed safely: ${error instanceof Error ? error.message : String(error)}`, { code: "PIFFF_RECOVERY_UNSAFE", manualPaths: paths, participants });
	}
}

export function createPiFffLifecycle(options: CreatePiFffLifecycleOptions): PiFffLifecycle {
	const fs = options.filesystem ?? defaultFs;
	const checkpoint = async (name: string) => { await options.checkpoint?.(name); };
	const initialize = async (_enabled: boolean) => recover(fs, options.cwd, options.agentDir, checkpoint);

	return {
		initialize,
		async run(action, command): Promise<PiFffLifecycleResult> {
			if (action === "status") {
				try {
					const recovery = await initialize(command.enabled);
					if (recovery.outcome !== "ready") return recovery;
					const participants = await discover(fs, options.cwd, options.agentDir);
					return result("status", participants.length ? `pi-fff is configured in ${participants.map((item) => item.scope).join(" and ")} scope.` : "pi-fff is not configured.", { participants });
				} catch (error) {
					const failure = error instanceof LifecycleFailure ? error : new LifecycleFailure("PIFFF_SETTINGS_DRIFT", error instanceof Error ? error.message : String(error));
					return result("error", failure.message, { code: failure.code, manualPaths: failure.manualPaths });
				}
			}
			if (action === "setup") {
				if (!command.enabled) return result("error", "Enable tidy before pi-fff setup.", { code: "PIFFF_SETUP_DISABLED" });
				if (!command.reload) return result("error", "Command reload capability is unavailable; setup was not changed.", { code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required" });
				try {
					const existing = await loadJournalSet(fs, options.cwd, options.agentDir);
					if (existing) {
						const committed = existing.journals.length === existing.participants.length && existing.journals.every((journal) => journal.operation === "setup" && journal.phase === "committed") && existing.participants.every((participant) => equal(currentEntry(participant), participant.managedEntry));
						if (committed) return result("idempotent", "The same linked setup transaction already owns every current entry.", { participants: existing.participants });
						return result("error", "An incomplete transaction requires startup recovery before setup.", { code: "PIFFF_TRANSACTION_INCOMPLETE", manualPaths: existing.participants.map((item) => item.settingsPath) });
					}
					const participants = await discover(fs, options.cwd, options.agentDir);
					if (!participants.length) return result("error", "No pi-fff package entries were discovered.", { code: "PIFFF_CONFIG_MISSING" });
					for (const participant of participants) {
						const plan = await options.preflight(participant);
						if (!isPlannedPiFffRegistrationPlan(plan) || plan.scope !== participant.scope || plan.packageIdentity !== participant.packageIdentity || plan.profile !== participant.profile || resolve(plan.packageRoot) !== resolve(participant.packageRoot)) {
							throw new LifecycleFailure("PIFFF_PREFLIGHT_FAILED", `${participant.scope} adapter preflight did not return its genuine complete uncommitted plan`);
						}
					}
					await preflightDestinations(fs, participants);
					if (!command.confirm) return result("error", "Interactive confirmation is unavailable; setup was not changed.", { code: "PIFFF_CONFIRMATION_UNAVAILABLE" });
					const preview: PiFffLifecyclePreview = { action: "setup", changes: participants.map((item) => ({ scope: item.scope, settingsPath: item.settingsPath, before: clone(item.priorEntry), after: clone(item.managedEntry) })) };
					if (!await command.confirm(preview)) return result("cancelled", "Setup cancelled; no files changed.");
					const transactionId = (options.transactionId ?? randomUUID)();
					for (const participant of participants) {
						const journal = journalFor(transactionId, participant, participants);
						await atomicCompareWrite(fs, participant.journalPath, undefined, journalBytes(journal), 0o600);
						await checkpoint(`setup:journal:${participant.scope}:prepared`);
					}
					for (const participant of participants) {
						await writeParticipant(fs, participant, participant.priorEntry, participant.managedEntry);
						await checkpoint(`setup:settings:${participant.scope}:written`);
						await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "settings-written"; });
						await checkpoint(`setup:journal:${participant.scope}:settings-written`);
					}
					for (const participant of participants) {
						await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "reload-pending"; });
						await checkpoint(`setup:journal:${participant.scope}:reload-pending`);
					}
					try { await command.reload(); }
					catch (error) {
						return result("error", `Reload did not complete: ${error instanceof Error ? error.message : String(error)}`, {
							code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required",
							manualPaths: participants.map((item) => item.settingsPath), participants,
						});
					}
					for (const participant of participants) {
						await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "committed"; });
						await checkpoint(`setup:journal:${participant.scope}:committed`);
					}
					return result("setup-committed", "Every pi-fff participant is filtered and journaled.", { reload: "requested", participants });
				} catch (error) {
					const failure = error instanceof LifecycleFailure ? error : new LifecycleFailure("PIFFF_PREFLIGHT_FAILED", error instanceof Error ? error.message : String(error));
					return result("error", failure.message, { code: failure.code, manualPaths: failure.manualPaths });
				}
			}

			try {
				if (!command.reload) return result("error", "Command reload capability is unavailable; teardown was not changed.", { code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required" });
				const set = await loadJournalSet(fs, options.cwd, options.agentDir);
				if (!set) return result("idempotent", "No managed pi-fff transaction remains to tear down.");
				const { journals, participants } = set;
				if (journals.length !== participants.length || journals.some((journal) => journal.operation !== "setup" || journal.phase !== "committed")) return result("error", "The linked journal set is incomplete; recover before teardown.", { code: "PIFFF_TRANSACTION_INCOMPLETE", manualPaths: participants.map((item) => item.settingsPath) });
				const drifted = participants.filter((participant) => !equal(currentEntry(participant), participant.managedEntry));
				if (drifted.length) return result("error", `Teardown refused because ${drifted.map((item) => item.scope).join(" and ")} settings drifted.`, { code: "PIFFF_SETTINGS_DRIFT", manualPaths: drifted.map((item) => item.settingsPath) });
				if (!command.confirm) return result("error", "Interactive confirmation is unavailable; teardown was not changed.", { code: "PIFFF_CONFIRMATION_UNAVAILABLE" });
				const preview: PiFffLifecyclePreview = { action: "teardown", changes: participants.map((item) => ({ scope: item.scope, settingsPath: item.settingsPath, before: clone(item.managedEntry), after: clone(item.priorEntry) })) };
				if (!await command.confirm(preview)) return result("cancelled", "Teardown cancelled; no files changed.");
				for (const participant of participants) {
					await updateJournal(fs, participant.journalPath, (journal) => { journal.operation = "teardown"; journal.phase = "prepared"; });
					await checkpoint(`teardown:journal:${participant.scope}:prepared`);
				}
				for (const participant of participants) {
					await writeParticipant(fs, participant, participant.managedEntry, participant.priorEntry);
					await checkpoint(`teardown:settings:${participant.scope}:written`);
					await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "restored"; });
					await checkpoint(`teardown:journal:${participant.scope}:restored`);
				}
				for (const participant of participants) {
					await updateJournal(fs, participant.journalPath, (journal) => { journal.phase = "reload-pending"; });
					await checkpoint(`teardown:journal:${participant.scope}:reload-pending`);
				}
				try { await command.reload(); }
				catch (error) {
					return result("error", `Reload did not complete: ${error instanceof Error ? error.message : String(error)}`, {
						code: "PIFFF_RECOVERY_RELOAD_REQUIRED", reload: "required",
						manualPaths: participants.map((item) => item.settingsPath), participants,
					});
				}
				for (const participant of participants) { await removeJournal(fs, participant.journalPath); await checkpoint(`teardown:journal:${participant.scope}:removed`); }
				return result("teardown-committed", "Exact prior pi-fff entries were restored and journals retired.", { reload: "requested", participants });
			} catch (error) {
				const failure = error instanceof LifecycleFailure ? error : new LifecycleFailure("PIFFF_TRANSACTION_INCOMPLETE", error instanceof Error ? error.message : String(error));
				return result("error", failure.message, { code: failure.code, manualPaths: failure.manualPaths });
			}
		},
	};
}
