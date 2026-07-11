#!/usr/bin/env node
// PROTOTYPE — tiny TUI for driving the real pi-fff orchestration probe.

import { initialState, reduce, scopes } from "./model.mjs";
import { cleanResult, runScope } from "./runner.mjs";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const reset = "\x1b[0m";
let state = initialState();

function value(value) {
	if (value === true) return `${green}yes${reset}`;
	if (value === false) return `${red}no${reset}`;
	return value ?? `${dim}—${reset}`;
}

function scopeLines(scope) {
	const entry = state.scopes[scope];
	const result = entry.result;
	const mark = entry.status === "pass" ? `${green}PASS${reset}` : entry.status === "fail" ? `${red}FAIL${reset}` : entry.status === "running" ? `${yellow}RUNNING${reset}` : `${dim}NOT RUN${reset}`;
	const lines = [`${bold}${scope} npm scope${reset}  ${mark}`];
	if (!result) {
		const detail = entry.status === "running"
			? `${yellow}Installing pi-fff and starting the real Pi probe…${reset}`
			: `${dim}Press ${scope === "user" ? "u" : "p"} to install pi-fff in a scratch ${scope} root and run Pi.${reset}`;
		return [...lines, `  ${detail}`];
	}
	lines.push(`  ${bold}installed/filter:${reset} ${value(result.filterPreservedInstall)}  ${dim}${result.version ?? ""}${reset}`);
	lines.push(`  ${bold}captured:${reset} ${(result.captured ?? []).join(", ") || "—"}`);
	lines.push(`  ${bold}forwarded tools:${reset} ${(result.forwardedTools ?? []).join(", ") || "—"}`);
	lines.push(`  ${bold}forwarded commands:${reset} ${(result.forwardedCommands ?? []).join(", ") || "—"}`);
	lines.push(`  ${bold}forwarded API methods:${reset} ${(result.forwardedMethods ?? []).join(", ") || "—"}`);
	lines.push(`  ${bold}composite ownership:${reset} ${(result.composites ?? []).map((tool) => `${tool.name}=fff exec/tidy schema+render`).join("; ") || "—"}`);
	lines.push(`  ${bold}registered read/grep:${reset} ${value(result.readCount)}/${value(result.grepCount)}`);
	lines.push(`  ${bold}fuzzy read marker:${reset} ${value(result.fuzzyRead?.resolvedMarker)}`);
	lines.push(`  ${bold}Pi exit:${reset} ${value(result.piExitCode)}`);
	for (const failure of result.failures ?? []) lines.push(`  ${red}• ${failure}${reset}`);
	return lines;
}

function render() {
	console.clear();
	const verdict = state.status === "proved"
		? `${green}${bold}PROVED — both scopes passed${reset}`
		: state.status === "failed"
			? `${red}${bold}FAILED — inspect the red findings below${reset}`
			: state.status === "running"
				? `${yellow}${bold}RUNNING — wait for the active scope${reset}`
				: `${dim}${state.status}${reset}`;
	const lines = [
		`${bold}PROTOTYPE — pi-fff execution + tidy presentation${reset}`,
		`${dim}${state.question}${reset}`,
		"",
		`${bold}verdict${reset}`,
		`  ${verdict}`,
		`  last action: ${state.lastAction}`,
		`  last action: ${state.lastAction}`,
		"",
		...scopeLines("user"),
		"",
		...scopeLines("project"),
		"",
		`${bold}controls${reset}`,
		`  ${bold}[u]${reset} ${dim}run user scope${reset}  ${bold}[p]${reset} ${dim}run project scope${reset}  ${bold}[a]${reset} ${dim}run both${reset}  ${bold}[r]${reset} ${dim}reset${reset}  ${bold}[q]${reset} ${dim}quit${reset}`,
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function dispatchRun(scope) {
	const oldResult = state.scopes[scope].result;
	state = reduce(state, { type: "run_started", scope });
	render();
	if (oldResult) await cleanResult(oldResult);
	const result = await runScope(scope);
	state = reduce(state, { type: "run_finished", scope, result });
	render();
}

async function cleanup() {
	await Promise.all(scopes.map((scope) => cleanResult(state.scopes[scope].result)));
}

if (process.argv.includes("--all")) {
	for (const scope of scopes) {
		state = reduce(state, { type: "run_started", scope });
		state = reduce(state, { type: "run_finished", scope, result: await runScope(scope) });
	}
	process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
	await cleanup();
	process.exit(Object.values(state.scopes).every((entry) => entry.status === "pass") ? 0 : 1);
}

if (!process.stdin.isTTY) {
	console.error("Run this prototype in a terminal, or pass --all for a non-interactive probe.");
	process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
render();
let busy = false;
process.stdin.on("data", async (key) => {
	if (busy) return;
	if (key === "q" || key === "\u0003") {
		busy = true;
		await cleanup();
		process.stdin.setRawMode(false);
		process.exit(0);
	}
	if (key === "r") {
		busy = true;
		await cleanup();
		state = reduce(state, { type: "reset" });
		busy = false;
		render();
		return;
	}
	if (key === "u" || key === "p") {
		busy = true;
		await dispatchRun(key === "u" ? "user" : "project");
		busy = false;
		return;
	}
	if (key === "a") {
		busy = true;
		for (const scope of scopes) await dispatchRun(scope);
		busy = false;
	}
});
