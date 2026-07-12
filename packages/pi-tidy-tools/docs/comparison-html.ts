import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEditTool, createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { buildToolBlock } from "../index.js";

const codingAgentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { ToolExecutionComponent } = await import(pathToFileURL(join(codingAgentDist, "modes/interactive/components/tool-execution.js")).href);
const { initTheme } = await import(pathToFileURL(join(codingAgentDist, "modes/interactive/theme/theme.js")).href);

const PALETTE: Record<string, string> = {
	"31": "#f7768e", "32": "#9ece6a", "33": "#e0af68", "35": "#bb9af7", "36": "#7dcfff",
};

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(input: string): string {
	const text = input.replace(/\x1b\]8;;.*?(?:\x07|\x1b\\)/g, "");
	const ansi = /\x1b\[([0-9;]*)m/g;
	const state: { color?: string; background?: string; bold?: boolean; dim?: boolean } = {};
	let output = "";
	let last = 0;
	let match: RegExpExecArray | null;
	const append = (value: string) => {
		if (!value) return;
		const styles = [
			state.color && `color:${state.color}`,
			state.background && `background:${state.background}`,
			state.bold && "font-weight:700",
			state.dim && "opacity:.55",
		].filter(Boolean).join(";");
		const escaped = escapeHtml(value);
		output += styles ? `<span style="${styles}">${escaped}</span>` : escaped;
	};
	while ((match = ansi.exec(text)) !== null) {
		append(text.slice(last, match.index));
		last = ansi.lastIndex;
		const codes = match[1] ? match[1].split(";").map(Number) : [0];
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 0) {
				delete state.color; delete state.background; delete state.bold; delete state.dim;
			} else if (code === 1) state.bold = true;
			else if (code === 2) state.dim = true;
			else if (code === 22) { delete state.bold; delete state.dim; }
			else if (code === 39) delete state.color;
			else if (code === 49) delete state.background;
			else if (PALETTE[String(code)]) state.color = PALETTE[String(code)];
			else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
				const color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				if (code === 38) state.color = color;
				else state.background = color;
				i += 4;
			}
		}
	}
	append(text.slice(last));
	return output;
}

// Wide enough that the native edit diff keeps the replacement on one line.
// At 58 cols the `typeof token === 'string' && token.length > 0` line wraps
// mid-expression and looks broken in the before/after screenshot.
const NATIVE_RENDER_WIDTH = 72;

function nativeBlock(name: string, id: string, args: Record<string, unknown>, result: any, cwd: string): string[] {
	const component = new ToolExecutionComponent(
		name, id, args, { showImages: false }, undefined, { requestRender() {} }, cwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult(result, false);
	return component.render(NATIVE_RENDER_WIDTH);
}

async function main() {
	initTheme("dark");
	const directory = mkdtempSync(join(tmpdir(), "pi-tidy-comparison-"));
	const source = join(directory, "src");
	mkdirSync(source);
	const file = join(source, "auth.ts");
	writeFileSync(file, [
		"export function verifyToken(token: string) {",
		"  return token.length > 0;",
		"}",
		"",
		"export function authorize(token: string) {",
		"  return verifyToken(token);",
		"}",
		"",
	].join("\n"));

	const read = createReadTool(directory);
	const grep = createGrepTool(directory);
	const edit = createEditTool(directory);
	const calls = [
		{ name: "read", args: { path: "src/auth.ts" }, reasoning: "inspect the current auth flow", result: await read.execute("read", { path: file }, undefined, undefined) },
		{ name: "grep", args: { pattern: "verifyToken", path: "src" }, reasoning: "find every token validation call", result: await grep.execute("grep", { pattern: "verifyToken", path: source }, undefined, undefined) },
		{ name: "edit", args: { path: "src/auth.ts" }, reasoning: "tighten the token type check", result: await edit.execute("edit", { path: file, edits: [{ oldText: "return token.length > 0;", newText: "return typeof token === 'string' && token.length > 0;" }] }, undefined, undefined) },
	];

	const native = calls.flatMap((call, index) => nativeBlock(call.name, String(index), call.args, call.result, directory));
	const tidy = calls.flatMap((call) => ["", ...buildToolBlock(call.name, { ...call.args, reasoning: call.reasoning }, call.result, { completedAt: 1_000, now: 3_781_000 })]);
	rmSync(directory, { recursive: true, force: true });

	const panel = (label: string, subtitle: string, lines: string[], tidyPanel = false) => {
		const content = lines.map((line) => line
			? `<span class="${tidyPanel ? "tidy-row" : "native-row"}">${ansiToHtml(line)}</span>`
			: `<span class="${tidyPanel ? "tidy-gap" : "native-gap"}"> </span>`).join("");
		return `
		<section class="panel">
			<header><span>${label}</span><small>${subtitle}</small></header>
			<pre class="${tidyPanel ? "tidy" : "native"}">${content}</pre>
		</section>`;
	};
	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}body{display:inline-block}
.frame{display:flex;gap:30px;padding:52px;background:linear-gradient(135deg,#6d5efc,#c86dd7 48%,#ff7eb3);font-family:"JetBrains Mono","SF Mono",monospace}
.panel{width:1040px;overflow:hidden;border-radius:14px;background:#1a1b26;box-shadow:0 24px 65px rgba(0,0,0,.38)}
header{display:flex;align-items:baseline;justify-content:space-between;padding:22px 28px;background:#16171f;border-bottom:1px solid #292b38;color:#c0caf5;font-size:24px;font-weight:700}
header small{color:#70768b;font-size:16px;font-weight:400}pre{box-sizing:border-box;min-height:410px;margin:0;padding:22px 28px;color:#c0caf5;font:19px/1.55 "JetBrains Mono","SF Mono",monospace;white-space:pre;overflow:hidden}.native-row,.native-gap,.tidy-row,.tidy-gap{display:block;height:1.55em;margin:0;white-space:pre}.native-row,.tidy-row{background:rgb(40,50,40)}
</style></head><body><main class="frame">${panel("Before — native pi", "default tool cards", native)}${panel("After — pi-tidy-tools", "compact, reason-first", tidy, true)}</main></body></html>`;
	process.stdout.write(html);
}

main();
