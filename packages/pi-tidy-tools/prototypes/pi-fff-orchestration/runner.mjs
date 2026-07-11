// PROTOTYPE — environment runner for issue #10. Creates only scratch directories.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const adapterPath = join(here, "adapter.prototype.ts");
const marker = "PI_FFF_PROTOTYPE_MARKER";

async function runPi({ cwd, agentDir, scope, settingsPath, reportPath }) {
	const args = [
		"--mode", "rpc",
		"--no-session",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--offline",
		"--approve",
		"-e", adapterPath,
	];
	const child = spawn("pi", args, {
		cwd,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_FFF_PROTOTYPE_SCOPE: scope,
			PI_FFF_PROTOTYPE_SETTINGS: settingsPath,
			PI_FFF_PROTOTYPE_REPORT: reportPath,
			PI_FFF_PROTOTYPE_QUERY: "orchestration-marker",
			PI_FFF_PROTOTYPE_MARKER: marker,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.end(`${JSON.stringify({ type: "get_state", id: "state" })}\n${JSON.stringify({ type: "get_commands", id: "commands" })}\n`);
	const exitCode = await new Promise((resolveExit, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Pi startup probe timed out after 30 seconds"));
		}, 30_000);
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timer); resolveExit(code); });
	});
	return { exitCode, stdout, stderr };
}

function summarize(scope, report, processResult, scratchRoot) {
	const commandsResponse = processResult.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => { try { return JSON.parse(line); } catch { return null; } })
		.find((entry) => entry?.id === "commands");
	const commandNames = commandsResponse?.data?.commands?.map((command) => command.name) ?? [];
	const forwarded = report.registrations?.forwarded ?? [];
	const forwardedMethods = [...new Set(forwarded.map((entry) => entry.method))];
	const captured = report.registrations?.captured ?? [];
	const composites = report.composites ?? [];
	const failures = [];
	if (processResult.exitCode !== 0) failures.push(`Pi exited ${processResult.exitCode}`);
	if (report.error) failures.push(report.error.split("\n")[0]);
	if (!report.resolution?.matchedExpectedScope) failures.push("resolved the wrong npm scope");
	if (!report.filter?.extensionFiltered) failures.push("pi-fff extension was not filtered");
	if (captured.join(",") !== "read,grep") failures.push(`captured [${captured.join(", ")}]`);
	if (composites.length !== 2 || composites.some((tool) => !tool.reasoningRequired)) failures.push("composite schema/render ownership failed");
	if (report.startup?.readCount !== 1 || report.startup?.grepCount !== 1) failures.push("read/grep registration was not singular");
	if (!report.execution?.succeeded) failures.push(report.execution?.error ?? "fuzzy read did not return the marker");
	if (!["fff-features", "reindex-fff", "fff-status"].every((name) => commandNames.includes(name))) failures.push("pi-fff commands were not forwarded");
	if (processResult.stderr.includes("conflicts with")) failures.push("Pi reported a duplicate registration");

	return {
		ok: failures.length === 0,
		scope,
		version: report.resolution?.version,
		packageRoot: report.resolution?.packageRoot,
		filterPreservedInstall: report.filter?.extensionFiltered && report.resolution?.entryExists,
		captured,
		forwardedMethods,
		forwardedTools: forwarded.filter((entry) => entry.method === "registerTool").map((entry) => entry.name),
		forwardedCommands: commandNames.filter((name) => name.startsWith("fff") || name === "reindex-fff"),
		composites,
		readCount: report.startup?.readCount,
		grepCount: report.startup?.grepCount,
		fuzzyRead: report.execution,
		piExitCode: processResult.exitCode,
		failures,
		stderrTail: processResult.stderr.trim().split("\n").slice(-4),
		scratchRoot,
	};
}

export async function runScope(scope) {
	if (scope !== "user" && scope !== "project") throw new Error(`Unknown scope: ${scope}`);
	const scratchRoot = await mkdtemp(join(tmpdir(), `pi-fff-${scope}-prototype-`));
	const agentDir = join(scratchRoot, "agent");
	const cwd = join(scratchRoot, "project");
	const npmRoot = scope === "user" ? join(agentDir, "npm") : join(cwd, ".pi", "npm");
	const settingsPath = scope === "user" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
	const reportPath = join(scratchRoot, "report.json");
	const packageEntry = { source: "npm:pi-fff@0.1.12", extensions: [] };

	await mkdir(npmRoot, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "orchestration-marker.txt"), `${marker}\n`, "utf8");
	await mkdir(dirname(settingsPath), { recursive: true });
	await writeFile(settingsPath, `${JSON.stringify({ packages: [packageEntry] }, null, 2)}\n`, "utf8");
	if (scope === "project") {
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), "{}\n", "utf8");
	}

	try {
		await execFileAsync("npm", [
			"install", "--prefix", npmRoot, "--omit=dev", "--no-package-lock", "--no-save", "pi-fff@0.1.12",
		], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
		const processResult = await runPi({ cwd, agentDir, scope, settingsPath, reportPath });
		const report = JSON.parse(await readFile(reportPath, "utf8"));
		return summarize(scope, report, processResult, scratchRoot);
	} catch (error) {
		return {
			ok: false,
			scope,
			failures: [error instanceof Error ? error.message : String(error)],
			scratchRoot,
		};
	}
}

export async function cleanResult(result) {
	if (result?.scratchRoot) await rm(resolve(result.scratchRoot), { recursive: true, force: true });
}
