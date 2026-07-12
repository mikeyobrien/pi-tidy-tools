import assert from "node:assert/strict";
import test from "node:test";
import { createPiFffIntegrationController } from "../pi-fff/controller.js";
import type { PiFffLifecycle, PiFffLifecycleParticipant, PiFffLifecycleResult } from "../pi-fff/integration.js";

const participant = (entry: unknown, profile: "legacy" | "scoped" = "legacy"): PiFffLifecycleParticipant => ({
	scope: "project", packageIdentity: profile === "scoped" ? "@ff-labs/pi-fff" : "pi-fff", profile, settingsPath: "/fixture/.pi/settings.json", packageRoot: profile === "scoped" ? "/fixture/.pi/npm/node_modules/@ff-labs/pi-fff" : "/fixture/.pi/npm/node_modules/pi-fff",
	entryIndex: 0, priorEntry: entry, managedEntry: typeof entry === "object" ? { ...(entry as object), extensions: [] } : { source: entry, extensions: [] },
});
const ready = (participants?: readonly PiFffLifecycleParticipant[]): PiFffLifecycleResult => ({ outcome: "ready", message: "ready", reload: "none", participants });
const status = (participants: readonly PiFffLifecycleParticipant[]): PiFffLifecycleResult => ({ outcome: "status", message: "status", reload: "none", participants });
function lifecycle(startup: PiFffLifecycleResult, discovered: readonly PiFffLifecycleParticipant[] = []): PiFffLifecycle {
	return {
		async initialize() { return startup; },
		async run(action) { return action === "status" ? status(discovered) : { outcome: "error", message: "not used", reload: "none" }; },
	};
}

const api = {} as any;

test("controller classifies absent, standalone, and filtered unmanaged without loading adapter", async (t) => {
	for (const [name, entries, state, owner] of [
		["absent", [], "absent", "tidy/native"],
		["standalone", [participant("npm:pi-fff@0.1.12")], "standalone", "standalone pi-fff"],
		["filtered", [participant({ source: "npm:pi-fff@0.1.12", extensions: [] })], "filtered-unmanaged", "native Pi"],
	] as const) await t.test(name, async () => {
		let builds = 0;
		const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready(), entries), buildPlan: async () => { builds++; throw new Error("must not load"); } });
		const plan = await controller.initialize(true);
		assert.equal(plan.status.state, state);
		assert.equal(plan.status.owner, owner);
		assert.equal(builds, 0);
		assert.equal(plan.skipTidyTools.has("read"), state !== "absent");
		assert.equal(plan.notice !== undefined, state !== "absent");
	});
});

test("scoped unmanaged ownership distinguishes loaded and filtered tools", async () => {
	for (const [entry, owner] of [
		["npm:@ff-labs/pi-fff@0.9.6", "tidy/native + pi-fff tools"],
		[{ source: "npm:@ff-labs/pi-fff@0.9.6", extensions: [] }, "tidy/native"],
	] as const) {
		const scoped = participant(entry, "scoped");
		const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready(), [scoped]) });
		const startup = await controller.initialize(true);
		assert.equal(startup.status.owner, owner);
		assert.deepEqual([...startup.skipTidyTools], []);
	}
});

test("scoped controller keeps tidy native read and grep while routing pi-fff tools", async () => {
	const managed = participant({ source: "npm:@ff-labs/pi-fff@0.9.6", extensions: [] }, "scoped");
	const controller = createPiFffIntegrationController({
		pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready([managed])),
		buildPlan: async () => ({ ok: true, plan: {
			scope: "project", packageIdentity: "@ff-labs/pi-fff", profile: "scoped", captureMode: "replay-only", packageRoot: managed.packageRoot,
			entryPath: `${managed.packageRoot}/src/index.ts`, piVersion: "0.80.6", piFffVersion: "0.9.6", status: "verified", integrity: "missing", diagnostics: [], trace: [],
		} as any }),
	});
	const startup = await controller.initialize(true);
	assert.equal(startup.status.owner, "tidy/native + pi-fff tools");
	assert.equal(startup.status.packageIdentity, "@ff-labs/pi-fff");
	assert.equal(startup.status.profile, "scoped");
	assert.deepEqual([...startup.skipTidyTools], []);
	assert.match(startup.status.action, /native read\/grep/);
});

test("controller suppresses informational compatibility notices and closes adapter failures", async () => {
	const managed = participant({ source: "npm:pi-fff@0.1.12", extensions: [] });
	const compatible = createPiFffIntegrationController({
		pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready([managed])),
		buildPlan: async () => ({ ok: true, plan: {
			scope: "project", packageRoot: managed.packageRoot, entryPath: `${managed.packageRoot}/index.ts`, piVersion: "0.81.0", piFffVersion: "0.2.0",
			status: "forward-compatible/unverified", integrity: "registry-unverified",
			diagnostics: [{ code: "PIFFF_INTEGRITY_UNVERIFIED", severity: "info", summary: "offline", detail: "registry unavailable", action: "smoke", piVersion: "0.81.0", piFffVersion: "0.2.0" }],
			trace: [], captures: { read: {} as any, grep: {} as any },
		} as any }),
	});
	const active = await compatible.initialize(true);
	assert.equal(active.status.state, "managed-compatible");
	assert.equal(active.status.owner, "tidy/pi-fff");
	assert.equal(active.status.tuple, "forward-compatible/unverified");
	assert.equal(active.notice, undefined);

	const invalid = createPiFffIntegrationController({
		pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready([managed])),
		buildPlan: async () => ({ ok: false, diagnostic: { code: "PIFFF_PACKAGE_MISSING", severity: "error", summary: "missing", detail: "selected package absent", action: "repair", piVersion: "0.80.6", piFffVersion: "unknown" } }),
	});
	const closed = await invalid.initialize(true);
	assert.equal(closed.status.state, "managed-invalid");
	assert.equal(closed.status.owner, "native Pi");
	assert.equal(closed.notice?.level, "error");
	assert.equal(closed.skipTidyTools.has("read"), true);
});

test("controller returns actionable ambiguity for status and setup instead of throwing", async () => {
	const ambiguity: PiFffLifecycleResult = {
		outcome: "error", code: "PIFFF_CONFIG_AMBIGUOUS",
		message: "Keep one pi-fff package identity across project and user settings.", reload: "none",
	};
	const ambiguousLifecycle: PiFffLifecycle = {
		async initialize() { return ready(); },
		async run() { return ambiguity; },
	};
	const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: ambiguousLifecycle });
	const statusResult = await controller.run("status", { enabled: true });
	assert.equal(statusResult.level, "error");
	assert.equal(statusResult.status.diagnostic?.code, "PIFFF_CONFIG_AMBIGUOUS");
	assert.match(statusResult.message, /one pi-fff package identity across project and user settings/i);
	assert.match(statusResult.status.action, /project and user settings/i);

	const setupResult = await controller.run("setup", { enabled: true });
	assert.equal(setupResult.level, "error");
	assert.match(setupResult.message, /^PIFFF_CONFIG_AMBIGUOUS:.*one pi-fff package identity across project and user settings/i);
	assert.equal(setupResult.status.diagnostic?.code, "PIFFF_CONFIG_AMBIGUOUS");
});

test("repeated status uses initialized routing without re-evaluating the factory", async () => {
	const managed = participant({ source: "npm:pi-fff@0.1.12", extensions: [] });
	let builds = 0;
	const controller = createPiFffIntegrationController({
		pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(ready([managed])),
		buildPlan: async (options) => {
			builds++;
			assert.deepEqual([...(options.conflicts?.commands ?? [])], ["tidy", "diff"]);
			assert.deepEqual([...(options.conflicts?.tools ?? [])], ["write", "edit", "bash", "find", "ls"]);
			return { ok: true, plan: {
				scope: "project", packageRoot: managed.packageRoot, entryPath: `${managed.packageRoot}/index.ts`, piVersion: "0.80.6", piFffVersion: "0.1.12",
				status: "verified", integrity: "missing", diagnostics: [], trace: [], captures: { read: {} as any, grep: {} as any },
			} as any };
		},
	});
	await controller.initialize(true);
	await controller.run("status", { enabled: true });
	await controller.run("status", { enabled: true });
	assert.equal(builds, 1);
});

test("disabled ownership distinguishes standalone, filtered, and managed states", async (t) => {
	for (const [name, startup, discovered, owner, journal] of [
		["standalone", ready(), [participant("npm:pi-fff@0.1.12")], "standalone pi-fff", "none"],
		["filtered", ready(), [participant({ source: "npm:pi-fff@0.1.12", extensions: [] })], "native Pi", "none"],
		["managed", ready([participant({ source: "npm:pi-fff@0.1.12", extensions: [] })]), [], "native Pi", "committed (inactive)"],
	] as const) await t.test(name, async () => {
		const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: lifecycle(startup, discovered) });
		const plan = await controller.initialize(false);
		assert.equal(plan.status.state, "disabled");
		assert.equal(plan.status.owner, owner);
		assert.equal(plan.status.journal, journal);
		assert.deepEqual([...plan.skipTidyTools], ["read", "grep"]);
	});
});

test("controller does not initialize in old command frames for requested or required reloads", async (t) => {
	for (const reload of ["requested", "required"] as const) await t.test(reload, async () => {
		let initializations = 0;
		const commandLifecycle: PiFffLifecycle = {
			async initialize() { initializations++; return ready(); },
			async run() {
				return reload === "requested"
					? { outcome: "setup-committed", message: "reloaded", reload }
					: { outcome: "error", code: "PIFFF_RECOVERY_RELOAD_REQUIRED", message: "reload rejected", reload };
			},
		};
		const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: commandLifecycle });
		const result = await controller.run("setup", { enabled: true });
		assert.equal(initializations, 0);
		assert.equal(result.reload, reload);
		if (reload === "required") {
			assert.equal(result.status.state, "recovery-pending");
			assert.equal(result.status.diagnostic?.code, "PIFFF_RECOVERY_RELOAD_REQUIRED");
		}
	});
});

test("scoped recovery keeps tidy native tools registered", async () => {
	const scoped = participant({ source: "npm:@ff-labs/pi-fff@0.9.6", extensions: [] }, "scoped");
	const recovering: PiFffLifecycle = {
		async initialize() { return { outcome: "recovery-reload-required", code: "PIFFF_RECOVERY_RELOAD_REQUIRED", message: "pending", reload: "required", participants: [scoped] }; },
		async run() { throw new Error("not used"); },
	};
	const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: recovering });
	const startup = await controller.initialize(true);
	assert.deepEqual([...startup.skipTidyTools], []);
	assert.equal(startup.status.owner, "tidy/native");
	assert.equal(startup.status.profile, "scoped");
});

test("disabled initialization still performs safety recovery but claims no ordinary tools", async () => {
	let initialized = 0;
	const recovering: PiFffLifecycle = {
		async initialize() { initialized++; return { outcome: "recovery-reload-required", code: "PIFFF_RECOVERY_RELOAD_REQUIRED", message: "rolled back", reload: "required" }; },
		async run() { throw new Error("not used"); },
	};
	const controller = createPiFffIntegrationController({ pi: api, cwd: "/fixture", agentDir: "/agent", lifecycle: recovering });
	const plan = await controller.initialize(false);
	assert.equal(initialized, 1);
	assert.equal(plan.status.state, "recovery-pending");
	assert.equal(plan.status.owner, "native Pi");
	assert.equal(plan.notice?.message.includes("/reload"), true);
	assert.deepEqual([...plan.skipTidyTools], ["read", "grep"]);
});
