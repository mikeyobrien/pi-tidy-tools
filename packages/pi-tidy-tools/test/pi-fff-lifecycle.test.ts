import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildPiFffRegistrationPlan } from "../pi-fff/adapter.js";
import { createPiFffIntegrationController } from "../pi-fff/controller.js";
import {
	createPiFffLifecycle,
	type PiFffLifecycleParticipant,
	type PiFffLifecyclePreview,
} from "../pi-fff/integration.js";

const entry = (scope: string) => ({ source: `npm:pi-fff@0.1.12`, extensions: ["index.ts"], scope, extra: { keep: true } });
const scopedEntry = (scope: string) => ({ source: `npm:@ff-labs/pi-fff@0.9.6`, extensions: ["src/index.ts"], scope, extra: { keep: true } });
const identityOf = (value: any) => String(typeof value === "string" ? value : value?.source).startsWith("npm:@ff-labs/pi-fff") ? "@ff-labs/pi-fff" as const : "pi-fff" as const;

async function fixture(options: { project?: unknown; user?: unknown; projectMode?: number; symlinkProject?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "tidy-fff-lifecycle-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const paths = { project: join(cwd, ".pi", "settings.json"), user: join(agentDir, "settings.json") };
	const writeSettings = async (scope: "project" | "user", value: unknown, mode = 0o640) => {
		const bytes = JSON.stringify({ theme: scope, nested: { preserved: true }, packages: [value] }, null, 2) + "\n";
		if (scope === "project" && options.symlinkProject) {
			const target = join(cwd, ".pi", "canonical-settings.json");
			await writeFile(target, bytes, { mode });
			await symlink("canonical-settings.json", paths.project);
			return;
		}
		await writeFile(paths[scope], bytes, { mode });
	};
	if (options.project !== undefined) await writeSettings("project", options.project, options.projectMode);
	if (options.user !== undefined) await writeSettings("user", options.user);
	for (const scope of ["project", "user"] as const) if (options[scope] !== undefined) {
		const identity = identityOf(options[scope]);
		const managedRoot = scope === "project" ? join(cwd, ".pi", "npm") : join(agentDir, "npm");
		const packageRoot = join(managedRoot, "node_modules", ...identity.split("/"));
		const extension = identity === "pi-fff" ? "./index.ts" : "./src/index.ts";
		await mkdir(join(packageRoot, dirname(extension)), { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: identity, version: identity === "pi-fff" ? "0.1.12" : "0.9.6", pi: { extensions: [extension] } }));
		await writeFile(join(packageRoot, extension), "export default () => {}\n");
	}
	const preflighted: string[] = [];
	const api: any = { events: { on() {}, emit() {} }, getFlag() { return undefined; } };
	for (const method of ["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on"]) api[method] = () => {};
	const tool = (name: "read" | "grep") => ({ name, label: name, description: name, parameters: { type: "object", properties: name === "read" ? { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } : { pattern: { type: "string" }, mode: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, constraints: { type: "string" }, cursor: { type: "string" }, outputMode: { type: "string" }, ignoreCase: { type: "boolean" }, literal: { type: "boolean" }, context: { type: "number" }, limit: { type: "number" } }, required: [name === "read" ? "path" : "pattern"] }, execute() { return { content: [{ type: "text", text: "ok" }] }; } });
	const preflight = async (participant: PiFffLifecycleParticipant) => {
		preflighted.push(participant.scope);
		const built = await buildPiFffRegistrationPlan({ cwd, agentDir, piVersion: "0.80.6", api, selection: { scope: participant.scope, entry: participant.managedEntry }, loader: { async load() { return (pi: any) => {
			if (participant.profile === "legacy") { pi.registerTool(tool("read")); pi.registerTool(tool("grep")); }
			else {
				for (const [name, type] of [["fff-mode", "string"], ["fff-frecency-db", "string"], ["fff-history-db", "string"], ["fff-enable-root-scan", "boolean"]] as const) pi.registerFlag(name, { type });
				for (const name of ["ffgrep", "fffind"]) {
				const properties: Record<string, unknown> = { pattern: { type: "string" }, path: { type: "string" }, exclude: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, limit: { type: "number" }, cursor: { type: "string" } };
				if (name === "ffgrep") Object.assign(properties, { caseSensitive: { type: "boolean" }, context: { type: "number" } });
				pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties, required: ["pattern"] }, execute() {} });
			}
				for (const name of ["fff-mode", "fff-health", "fff-rescan"]) pi.registerCommand(name, { handler() {} });
			}
			pi.on("session_start", () => {}); pi.on("session_shutdown", () => {});
		}; } } });
		if (!built.ok) throw new Error(built.diagnostic.summary);
		return built.plan;
	};
	const lifecycle = (extra: Record<string, unknown> = {}) => createPiFffLifecycle({ cwd, agentDir, preflight, ...extra });
	return { root, cwd, agentDir, paths, preflighted, preflight, lifecycle };
}

async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
const sidecar = (settings: string) => join(dirname(settings), "pi-tidy-tools.pi-fff.json");

async function setup(f: Awaited<ReturnType<typeof fixture>>, confirm = async (_preview: PiFffLifecyclePreview) => true) {
	let reloads = 0;
	const result = await f.lifecycle().run("setup", { enabled: true, confirm, reload: async () => { reloads++; } });
	return { result, reloads };
}

test("scoped setup and teardown preserve exact source identity", async () => {
	const projectPrior = scopedEntry("project");
	const userPrior = "npm:@ff-labs/pi-fff@0.9.6";
	const f = await fixture({ project: projectPrior, user: userPrior });
	try {
		const { result } = await setup(f);
		assert.equal(result.outcome, "setup-committed");
		assert.deepEqual(result.participants?.map((item) => [item.scope, item.packageIdentity, item.profile]), [["project", "@ff-labs/pi-fff", "scoped"], ["user", "@ff-labs/pi-fff", "scoped"]]);
		assert.deepEqual((await json(f.paths.project)).packages[0], { ...projectPrior, extensions: [] });
		assert.deepEqual((await json(f.paths.user)).packages[0], { source: userPrior, extensions: [] });
		const torn = await f.lifecycle().run("teardown", { enabled: true, confirm: async () => true, reload: async () => {} });
		assert.equal(torn.outcome, "teardown-committed");
		assert.deepEqual((await json(f.paths.project)).packages[0], projectPrior);
		assert.equal((await json(f.paths.user)).packages[0], userPrior);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("both package identities in one scope are ambiguous", async () => {
	const f = await fixture();
	try {
		await writeFile(f.paths.user, JSON.stringify({ packages: ["npm:pi-fff@0.1.12", "npm:@ff-labs/pi-fff@0.9.6"] }));
		const before = await readFile(f.paths.user);
		const result = await f.lifecycle().run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
		assert.equal(result.code, "PIFFF_CONFIG_AMBIGUOUS");
		assert.deepEqual(await readFile(f.paths.user), before);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mixed package identities across scopes fail before preflight, confirmation, or writes", async (t) => {
	for (const [name, project, user] of [
		["project scoped and user legacy", scopedEntry("project"), entry("user")],
		["project legacy and user scoped", entry("project"), scopedEntry("user")],
	] as const) await t.test(name, async () => {
		const f = await fixture({ project, user });
		try {
			const before = await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]);
			const status = await f.lifecycle().run("status", { enabled: true });
			let confirmations = 0; let reloads = 0;
			const setupResult = await f.lifecycle().run("setup", {
				enabled: true,
				confirm: async () => { confirmations++; return true; },
				reload: async () => { reloads++; },
			});
			for (const result of [status, setupResult]) {
				assert.equal(result.outcome, "error");
				assert.equal(result.code, "PIFFF_CONFIG_AMBIGUOUS");
				assert.match(result.message, /one pi-fff package identity across project and user settings/i);
			}
			assert.deepEqual(f.preflighted, []);
			assert.equal(confirmations, 0); assert.equal(reloads, 0);
			assert.deepEqual(await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]), before);
			for (const path of [sidecar(f.paths.project), sidecar(f.paths.user)]) {
				await assert.rejects(lstat(path), (error: any) => error?.code === "ENOENT");
			}
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("setup preflights every participant before confirmation or writes and preserves exact entry fields", async () => {
	const f = await fixture({ project: entry("project"), user: "npm:pi-fff@0.1.12", projectMode: 0o640 });
	try {
		let preview: PiFffLifecyclePreview | undefined;
		const { result, reloads } = await setup(f, async (value) => { preview = value; return true; });
		assert.equal(result.outcome, "setup-committed");
		assert.deepEqual(f.preflighted, ["project", "user"]);
		assert.deepEqual(preview?.changes.map((change) => change.scope), ["project", "user"]);
		const project = await json(f.paths.project);
		assert.deepEqual(project.packages[0], { ...entry("project"), extensions: [] });
		assert.deepEqual(project.nested, { preserved: true });
		assert.deepEqual((await json(f.paths.user)).packages[0], { source: "npm:pi-fff@0.1.12", extensions: [] });
		assert.equal((await stat(f.paths.project)).mode & 0o777, 0o640);
		assert.equal(reloads, 1);
		for (const scope of ["project", "user"] as const) {
			const journal = await json(sidecar(f.paths[scope]));
			assert.equal(journal.version, 1); assert.equal(journal.operation, "setup"); assert.equal(journal.phase, "committed");
			assert.equal(journal.scope, scope); assert.equal(typeof journal.transactionId, "string");
			assert.equal(journal.participants.length, 2); assert.equal(journal.settingsPath, f.paths[scope]);
			assert.deepEqual(journal.counterpartPaths, [f.paths[scope === "project" ? "user" : "project"]]);
			assert.equal((await stat(sidecar(f.paths[scope]))).mode & 0o777, 0o600);
		}
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("setup and teardown persist every reload-pending journal before reload and finalize only after success", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		const setupResult = await f.lifecycle().run("setup", {
			enabled: true, confirm: async () => true,
			reload: async () => {
				for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "reload-pending");
			},
		});
		assert.equal(setupResult.outcome, "setup-committed");
		for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "committed");

		const teardownResult = await f.lifecycle().run("teardown", {
			enabled: true, confirm: async () => true,
			reload: async () => {
				for (const scope of ["project", "user"] as const) {
					assert.equal((await json(sidecar(f.paths[scope]))).phase, "reload-pending");
					assert.deepEqual((await json(f.paths[scope])).packages[0], entry(scope));
				}
			},
		});
		assert.equal(teardownResult.outcome, "teardown-committed");
		for (const scope of ["project", "user"] as const) await assert.rejects(readFile(sidecar(f.paths[scope])), /ENOENT/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("replacement startup inside reload finalizes setup and teardown before the old command resumes", async (t) => {
	await t.test("dual-scope setup", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			let replacement: Awaited<ReturnType<ReturnType<typeof f.lifecycle>["initialize"]>> | undefined;
			const command = await f.lifecycle().run("setup", {
				enabled: true, confirm: async () => true,
				reload: async () => {
					replacement = await f.lifecycle().initialize(true);
					assert.equal(replacement.outcome, "ready");
					assert.deepEqual(replacement.participants?.map((participant) => participant.scope), ["project", "user"]);
					for (const scope of ["project", "user"] as const) {
						assert.deepEqual((await json(f.paths[scope])).packages[0], { ...entry(scope), extensions: [] });
						assert.equal((await json(sidecar(f.paths[scope]))).phase, "committed");
					}
				},
			});
			assert.equal(command.outcome, "setup-committed");
			assert.equal(command.reload, "requested");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});

	await t.test("dual-scope teardown", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await setup(f);
			const command = await f.lifecycle().run("teardown", {
				enabled: false, confirm: async () => true,
				reload: async () => {
					const replacement = await f.lifecycle().initialize(false);
					assert.equal(replacement.outcome, "ready");
					assert.equal(replacement.participants, undefined);
					for (const scope of ["project", "user"] as const) {
						assert.deepEqual((await json(f.paths[scope])).packages[0], entry(scope));
						await assert.rejects(readFile(sidecar(f.paths[scope])), /ENOENT/);
					}
				},
			});
			assert.equal(command.outcome, "teardown-committed");
			assert.equal(command.reload, "requested");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("failed setup and teardown reloads remain pending until fresh startup converges ready", async (t) => {
	await t.test("setup", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			const failed = await f.lifecycle().run("setup", { enabled: true, confirm: async () => true, reload: async () => { throw new DOMException("aborted", "AbortError"); } });
			assert.equal(failed.code, "PIFFF_RECOVERY_RELOAD_REQUIRED");
			assert.equal(failed.reload, "required");
			for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "reload-pending");
			const recovered = await f.lifecycle().initialize(true);
			assert.equal(recovered.outcome, "ready");
			assert.deepEqual(recovered.participants?.map((participant) => participant.scope), ["project", "user"]);
			for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "committed");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
	await t.test("teardown", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await setup(f);
			const failed = await f.lifecycle().run("teardown", { enabled: false, confirm: async () => true, reload: async () => { throw new Error("reload failed"); } });
			assert.equal(failed.code, "PIFFF_RECOVERY_RELOAD_REQUIRED");
			assert.equal(failed.reload, "required");
			for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "reload-pending");
			const recovered = await f.lifecycle().initialize(false);
			assert.equal(recovered.outcome, "ready");
			assert.equal(recovered.participants, undefined);
			for (const scope of ["project", "user"] as const) await assert.rejects(readFile(sidecar(f.paths[scope])), /ENOENT/);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("controller command frame leaves rejected reload pending until fresh controller startup", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		const oldFrame = createPiFffIntegrationController({ pi: {}, cwd: f.cwd, agentDir: f.agentDir, lifecycle: f.lifecycle() });
		const command = await oldFrame.run("setup", {
			enabled: true, confirm: async () => true,
			reload: async () => { throw new Error("reload rejected"); },
		});
		assert.equal(command.reload, "required");
		assert.equal(command.status.state, "recovery-pending");
		assert.equal(command.status.owner, "native Pi");
		for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "reload-pending");

		const freshFrame = createPiFffIntegrationController({ pi: {}, cwd: f.cwd, agentDir: f.agentDir, lifecycle: f.lifecycle() });
		const startup = await freshFrame.initialize(false);
		assert.equal(startup.status.state, "disabled");
		assert.equal(startup.status.journal, "committed (inactive)");
		for (const scope of ["project", "user"] as const) assert.equal((await json(sidecar(f.paths[scope]))).phase, "committed");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup finalization checkpoint failures resume idempotently", async (t) => {
	await t.test("setup commit", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await f.lifecycle().run("setup", { enabled: true, confirm: async () => true, reload: async () => { throw new Error("reload failed"); } });
			const interrupted = await f.lifecycle({ checkpoint: (name: string) => { if (name === "recovery:setup:journal:project:committed") throw new Error("checkpoint"); } }).initialize(true);
			assert.equal(interrupted.outcome, "error");
			assert.equal((await json(sidecar(f.paths.project))).phase, "committed");
			assert.equal((await json(sidecar(f.paths.user))).phase, "reload-pending");
			const recovered = await f.lifecycle().initialize(true);
			assert.equal(recovered.outcome, "ready");
			assert.deepEqual(recovered.participants?.map((participant) => participant.scope), ["project", "user"]);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});

	await t.test("teardown removal", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await setup(f);
			await f.lifecycle().run("teardown", { enabled: false, confirm: async () => true, reload: async () => { throw new Error("reload failed"); } });
			const interrupted = await f.lifecycle({ checkpoint: (name: string) => { if (name === "recovery:teardown:journal:project:removed") throw new Error("checkpoint"); } }).initialize(false);
			assert.equal(interrupted.outcome, "error");
			await assert.rejects(readFile(sidecar(f.paths.project)), /ENOENT/);
			assert.equal((await json(sidecar(f.paths.user))).phase, "reload-pending");
			const recovered = await f.lifecycle().initialize(false);
			assert.equal(recovered.outcome, "ready");
			assert.equal(recovered.participants, undefined);
			await assert.rejects(readFile(sidecar(f.paths.user)), /ENOENT/);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("preflight failure, duplicate ambiguity, and cancellation change no bytes", async (t) => {
	await t.test("shadowed preflight failure", async () => {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			const before = await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]);
			const lifecycle = createPiFffLifecycle({ cwd: f.cwd, agentDir: f.agentDir, preflight: async (p) => { if (p.scope === "user") { f.preflighted.push(p.scope); throw new Error("invalid shadow"); } return f.preflight(p); } });
			const result = await lifecycle.run("setup", { enabled: true, confirm: async () => true, reload: async () => assert.fail("reload") });
			assert.equal(result.outcome, "error"); assert.deepEqual(f.preflighted, ["project", "user"]);
			assert.deepEqual(await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]), before);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
	await t.test("trivial plan-shaped fake", async () => {
		const f = await fixture({ user: entry("user") });
		try {
			const before = await readFile(f.paths.user);
			const lifecycle = createPiFffLifecycle({ cwd: f.cwd, agentDir: f.agentDir, preflight: async (p) => ({ scope: p.scope, packageRoot: p.packageRoot } as any) });
			const result = await lifecycle.run("setup", { enabled: true, confirm: async () => true, reload: async () => assert.fail("reload") });
			assert.equal(result.code, "PIFFF_PREFLIGHT_FAILED");
			assert.deepEqual(await readFile(f.paths.user), before);
			await assert.rejects(readFile(sidecar(f.paths.user)), /ENOENT/);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
	await t.test("duplicates", async () => {
		const duplicate = { packages: ["npm:pi-fff", { source: "npm:pi-fff@0.1.12", extensions: [] }], sibling: true };
		const f = await fixture();
		try {
			await writeFile(f.paths.user, JSON.stringify(duplicate)); const before = await readFile(f.paths.user);
			const result = await f.lifecycle().run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
			assert.equal(result.code, "PIFFF_CONFIG_AMBIGUOUS"); assert.deepEqual(await readFile(f.paths.user), before);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
	await t.test("cancellation", async () => {
		const f = await fixture({ user: entry("user") });
		try {
			const before = await readFile(f.paths.user); let reloads = 0;
			const result = await f.lifecycle().run("setup", { enabled: true, confirm: async () => false, reload: async () => { reloads++; } });
			assert.equal(result.outcome, "cancelled"); assert.deepEqual(await readFile(f.paths.user), before); assert.equal(reloads, 0);
			await assert.rejects(readFile(sidecar(f.paths.user)), /ENOENT/);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

test("prefiltered and string states are journaled truthfully; setup and teardown are idempotent and guarded", async () => {
	const prior = { source: "npm:pi-fff@0.1.12", extensions: [], custom: "same" };
	const f = await fixture({ project: prior, user: "npm:pi-fff@0.1.12" });
	try {
		assert.equal((await setup(f)).result.outcome, "setup-committed");
		const again = await setup(f); assert.equal(again.result.outcome, "idempotent"); assert.equal(again.reloads, 0);
		let reloads = 0;
		const teardown = await f.lifecycle().run("teardown", { enabled: false, confirm: async () => true, reload: async () => { reloads++; } });
		assert.equal(teardown.outcome, "teardown-committed"); assert.equal(reloads, 1);
		assert.deepEqual((await json(f.paths.project)).packages[0], prior);
		assert.equal((await json(f.paths.user)).packages[0], "npm:pi-fff@0.1.12");
		assert.equal((await stat(f.paths.project)).mode & 0o777, 0o640);
		assert.equal((await stat(f.paths.user)).mode & 0o777, 0o640);
		await assert.rejects(readFile(sidecar(f.paths.project)), /ENOENT/);
		assert.equal((await f.lifecycle().run("teardown", { enabled: false, confirm: async () => true, reload: async () => {} })).outcome, "idempotent");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("teardown cancellation and drift preserve both scopes and do not need package files", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		await setup(f);
		const managed = await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]);
		let result = await f.lifecycle().run("teardown", { enabled: true, confirm: async () => false, reload: async () => assert.fail("reload") });
		assert.equal(result.outcome, "cancelled"); assert.deepEqual(await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]), managed);
		const drift = await json(f.paths.user); drift.packages[0].later = true; await writeFile(f.paths.user, JSON.stringify(drift));
		const beforeDrift = await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]);
		result = await f.lifecycle().run("teardown", { enabled: true, confirm: async () => true, reload: async () => assert.fail("reload") });
		assert.equal(result.code, "PIFFF_SETTINGS_DRIFT"); assert.deepEqual(await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]), beforeDrift);
		delete drift.packages[0].later; await writeFile(f.paths.user, JSON.stringify(drift));
		result = await f.lifecycle().run("teardown", { enabled: true, confirm: async () => true, reload: async () => {} });
		assert.equal(result.outcome, "teardown-committed");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup recovery rolls setup back while disabled and reports one manual reload", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		const interrupted = f.lifecycle({ checkpoint: (name: string) => { if (name === "setup:settings:project:written") throw new Error("crash"); } });
		const failed = await interrupted.run("setup", { enabled: true, confirm: async () => true, reload: async () => assert.fail("reload") });
		assert.equal(failed.outcome, "error");
		const recovered = await f.lifecycle().initialize(false);
		assert.equal(recovered.outcome, "recovery-reload-required"); assert.equal(recovered.reload, "required");
		assert.deepEqual((await json(f.paths.project)).packages[0], entry("project"));
		assert.deepEqual((await json(f.paths.user)).packages[0], entry("user"));
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("orphan sidecars remain discoverable with exact settings and sidecar manual paths", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		await f.lifecycle({ checkpoint: (name: string) => { if (name === "setup:journal:user:prepared") throw new Error("crash"); } }).run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
		await rm(f.paths.user);
		const recovered = await f.lifecycle().initialize(false);
		assert.equal(recovered.code, "PIFFF_RECOVERY_UNSAFE");
		assert.deepEqual(recovered.manualPaths, [f.paths.project, sidecar(f.paths.project), f.paths.user, sidecar(f.paths.user)]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unsafe startup recovery fails closed with exact manual paths", async () => {
	const f = await fixture({ project: entry("project"), user: entry("user") });
	try {
		await f.lifecycle({ checkpoint: (name: string) => { if (name === "setup:settings:project:written") throw new Error("crash"); } }).run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
		const changed = await json(f.paths.project); changed.packages[0].drift = true; await writeFile(f.paths.project, JSON.stringify(changed));
		const before = await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]);
		const result = await f.lifecycle().initialize(false);
		assert.equal(result.code, "PIFFF_RECOVERY_UNSAFE"); assert.deepEqual(result.manualPaths, [f.paths.project, f.paths.user]);
		assert.deepEqual(await Promise.all([readFile(f.paths.project), readFile(f.paths.user)]), before);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("interrupted teardown rolls back managed state; fully restored teardown only retires journals", async () => {
	for (const point of ["teardown:settings:project:written", "teardown:journal:project:removed"] as const) {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await setup(f); let fired = false;
			await f.lifecycle({ checkpoint: (name: string) => { if (!fired && name === point) { fired = true; throw new Error("crash"); } } }).run("teardown", { enabled: true, confirm: async () => true, reload: async () => {} });
			const recovered = await f.lifecycle().initialize(true);
			assert.equal(recovered.outcome, point.includes("settings") ? "recovery-reload-required" : "ready");
			if (point.includes("settings")) {
				assert.deepEqual((await json(f.paths.project)).packages[0].extensions, []);
				assert.deepEqual((await json(f.paths.user)).packages[0].extensions, []);
			} else {
				assert.deepEqual((await json(f.paths.project)).packages[0], entry("project"));
				await assert.rejects(readFile(sidecar(f.paths.user)), /ENOENT/);
			}
		} finally { await rm(f.root, { recursive: true, force: true }); }
	}
});

test("reload capability is required before mutation and committed setup survives disabled startup", async () => {
	const f = await fixture({ user: entry("user") });
	try {
		const before = await readFile(f.paths.user);
		const unavailable = await f.lifecycle().run("setup", { enabled: true, confirm: async () => true });
		assert.equal(unavailable.code, "PIFFF_RECOVERY_RELOAD_REQUIRED");
		assert.deepEqual(await readFile(f.paths.user), before);
		await assert.rejects(readFile(sidecar(f.paths.user)), /ENOENT/);
		let reloads = 0;
		await f.lifecycle({ checkpoint: (name: string) => { if (name === "setup:journal:user:committed") throw new Error("crash"); } }).run("setup", { enabled: true, confirm: async () => true, reload: async () => { reloads++; } });
		assert.equal(reloads, 1);
		const recovered = await f.lifecycle().initialize(false);
		assert.equal(recovered.outcome, "ready");
		assert.equal(recovered.reload, "none");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("settings symlinks preserve links, canonical targets, modes, and temp cleanup", async () => {
	const f = await fixture({ project: entry("project"), symlinkProject: true });
	try {
		const before = await lstat(f.paths.project); assert.equal(before.isSymbolicLink(), true);
		const { result } = await setup(f); assert.equal(result.outcome, "setup-committed");
		assert.equal((await lstat(f.paths.project)).isSymbolicLink(), true);
		const canonical = join(f.cwd, ".pi", "canonical-settings.json");
		assert.deepEqual((await json(canonical)).packages[0].extensions, []);
		assert.equal((await stat(canonical)).mode & 0o777, 0o640);
		assert.equal((await readdir(dirname(canonical))).some((name) => name.includes(".tmp-")), false);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("external settings symlinks are ignored without pi-fff and rejected with it", async () => {
	const f = await fixture();
	try {
		const outside = join(f.root, "outside-settings.json");
		await writeFile(outside, JSON.stringify({ packages: ["npm:not-fff@1.0.0"] }) + "\n");
		await symlink(outside, f.paths.project);
		const status = await f.lifecycle().run("status", { enabled: true });
		assert.equal(status.outcome, "status");
		assert.deepEqual(status.participants, []);
		const bytes = JSON.stringify({ packages: [entry("project")], sibling: true }) + "\n";
		await writeFile(outside, bytes);
		const result = await f.lifecycle().run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
		assert.equal(result.code, "PIFFF_RECOVERY_UNSAFE");
		assert.equal(await readFile(outside, "utf8"), bytes);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a sidecar symlink is rejected without overwriting its target", async () => {
	const f = await fixture({ user: entry("user") });
	try {
		const target = join(f.root, "outside-journal.json");
		await writeFile(target, "do not replace\n");
		await symlink(target, sidecar(f.paths.user));
		const before = await readFile(f.paths.user);
		const setupResult = await setup(f);
		assert.equal(setupResult.result.code, "PIFFF_RECOVERY_UNSAFE");
		assert.deepEqual(await readFile(f.paths.user), before);
		assert.equal(await readFile(target, "utf8"), "do not replace\n");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failure injection at every journal/write/phase boundary remains recoverable and cleanup-safe", async () => {
	const points = [
		"setup:journal:project:prepared", "setup:journal:user:prepared",
		"setup:settings:project:written", "setup:journal:project:settings-written",
		"setup:settings:user:written", "setup:journal:user:settings-written",
		"setup:journal:project:reload-pending", "setup:journal:user:reload-pending",
		"setup:journal:project:committed", "setup:journal:user:committed",
	];
	for (const point of points) {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			let fired = false;
			const result = await f.lifecycle({ checkpoint: (name: string) => { if (!fired && name === point) { fired = true; throw new Error(point); } } }).run("setup", { enabled: true, confirm: async () => true, reload: async () => {} });
			assert.equal(result.outcome, "error", point);
			const recovery = await f.lifecycle().initialize(true);
			assert.ok(["recovery-reload-required", "ready"].includes(recovery.outcome), point);
			const committed = points.indexOf(point) >= points.indexOf("setup:settings:user:written");
			assert.deepEqual((await json(f.paths.project)).packages[0], committed ? { ...entry("project"), extensions: [] } : entry("project"), point);
			assert.deepEqual((await json(f.paths.user)).packages[0], committed ? { ...entry("user"), extensions: [] } : entry("user"), point);
			for (const dir of [dirname(f.paths.project), dirname(f.paths.user)]) assert.equal((await readdir(dir)).some((name) => name.includes(".tmp-")), false, point);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	}
});

test("teardown failure injection rolls partial restoration back and retires complete restoration", async () => {
	const points = [
		"teardown:journal:project:prepared", "teardown:journal:user:prepared",
		"teardown:settings:project:written", "teardown:journal:project:restored",
		"teardown:settings:user:written", "teardown:journal:user:restored",
		"teardown:journal:project:reload-pending", "teardown:journal:user:reload-pending",
		"teardown:journal:project:removed", "teardown:journal:user:removed",
	];
	for (const point of points) {
		const f = await fixture({ project: entry("project"), user: entry("user") });
		try {
			await setup(f); let fired = false;
			const failed = await f.lifecycle({ checkpoint: (name: string) => { if (!fired && name === point) { fired = true; throw new Error(point); } } }).run("teardown", { enabled: false, confirm: async () => true, reload: async () => {} });
			assert.equal(failed.outcome, "error", point);
			const recovery = await f.lifecycle().initialize(false);
			assert.ok(["recovery-reload-required", "ready"].includes(recovery.outcome), point);
			const restorationComplete = points.indexOf(point) >= points.indexOf("teardown:settings:user:written");
			for (const scope of ["project", "user"] as const) {
				const actual = (await json(f.paths[scope])).packages[0];
				assert.deepEqual(actual, restorationComplete ? entry(scope) : { ...entry(scope), extensions: [] }, point);
				assert.equal((await readdir(dirname(f.paths[scope]))).some((name) => name.includes(".tmp-")), false, point);
			}
		} finally { await rm(f.root, { recursive: true, force: true }); }
	}
});
