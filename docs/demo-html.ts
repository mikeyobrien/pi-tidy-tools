/**
 * Render the demo as HTML (real tool output → ANSI → HTML spans) so a headless
 * Chromium can screenshot it with proper COLOR EMOJI and box-drawing glyphs —
 * something `freeze` can't do (it embeds a single monochrome font).
 *
 *   npx tsx docs/demo-html.ts > docs/demo.html
 *
 * Then screenshot docs/demo.html in a browser and save as docs/demo.png.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createReadTool,
	createEditTool,
	createGrepTool,
	createBashTool,
} from "@earendil-works/pi-coding-agent";
import { buildToolBlock } from "../index.js";

// --- minimal ANSI SGR → HTML converter ---
const COLORS: Record<string, string> = {
	"31": "#f7768e", // red
	"32": "#9ece6a", // green
	"33": "#e0af68", // yellow
	"35": "#bb9af7", // magenta
	"36": "#7dcfff", // cyan
};

function ansiToHtml(text: string): string {
	let out = "";
	const open: string[] = []; // stack of open span count markers
	let i = 0;
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const re = /\x1b\[([0-9;]*)m/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let openCount = 0;
	while ((m = re.exec(text)) !== null) {
		out += esc(text.slice(last, m.index));
		last = re.lastIndex;
		const codes = m[1].split(";").filter(Boolean);
		for (const code of codes.length ? codes : ["0"]) {
			if (code === "0") {
				while (openCount > 0) { out += "</span>"; openCount--; }
			} else if (code === "1") {
				out += `<span style="font-weight:700">`; openCount++;
			} else if (code === "2") {
				out += `<span style="opacity:.55">`; openCount++;
			} else if (COLORS[code]) {
				out += `<span style="color:${COLORS[code]}">`; openCount++;
			}
		}
	}
	out += esc(text.slice(last));
	while (openCount > 0) { out += "</span>"; openCount--; }
	return out;
}

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "pi-tidy-tools-demo-"));
	const subdir = join(dir, "src");
	mkdirSync(subdir);
	const file = join(subdir, "auth.ts");
	writeFileSync(
		file,
		[
			"export function verifyToken(t: string): boolean {",
			"  return t.length > 0;",
			"}",
			"",
			"export function handler(req: Request) {",
			"  if (!verifyToken(req.token)) throw new Error('unauthorized');",
			"}",
			"",
		].join("\n"),
	);

	const read = createReadTool(dir);
	const grep = createGrepTool(dir);
	const edit = createEditTool(dir);
	const bash = createBashTool(dir);

	const rel = "src/auth.ts";
	const rRead = await read.execute("1", { path: file }, undefined, undefined);
	const rGrep = await grep.execute("2", { pattern: "verifyToken", path: subdir }, undefined, undefined);
	const rEdit = await edit.execute(
		"3",
		{ path: file, edits: [{ oldText: "return t.length > 0;", newText: "return typeof t === 'string' && t.length > 0;" }] },
		undefined,
		undefined,
	);
	const rBashOk = await bash.execute("4", { command: "echo build ok; echo done" }, undefined, undefined);
	let rBashFail: any;
	try {
		rBashFail = await bash.execute("5", { command: "eslint src/auth.ts" }, undefined, undefined);
	} catch (e: any) {
		rBashFail = { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
	}

	const blocks: string[][] = [
		buildToolBlock("read", { path: rel, reasoning: "check current verifyToken flow" }, rRead),
		buildToolBlock("grep", { pattern: "verifyToken", path: "src", reasoning: "find every call site" }, rGrep),
		buildToolBlock("edit", { path: rel, reasoning: "tighten the token type check" }, rEdit),
		buildToolBlock("bash", { command: "npm test", reasoning: "run the suite to confirm green" }, rBashOk),
		buildToolBlock("bash", { command: "npm run lint", reasoning: "lint the changed files" }, rBashFail, { isError: true }),
	];

	rmSync(dir, { recursive: true, force: true });

	// Frame the blocks like a live pi session: a user prompt above, and the
	// "Working..." spinner below, so the image reads as a real transcript.
	const DIMc = "#565a6e";
	const CYANc = "#7dcfff";
	const BORDERc = "#2b2d3a";
	const prompt = `<span style="color:${DIMc}">❯</span> refactor the auth middleware and run the tests`;
	const spinner = `<span style="color:${CYANc}">⠋</span> <span style="color:${DIMc}">Working…</span>`;
	const blockHtml = blocks.map((b) => ansiToHtml(b.join("\n"))).join("\n\n");
	const body = `${prompt}\n\n${blockHtml}\n\n${spinner}`;

	// pi's real editor chrome: a full-width rule, a blank input line, and a
	// closing rule.
	const rule = `<span style="color:${BORDERc}">${"─".repeat(94)}</span>`;
	const editor = `${rule}\n${" "}\n${rule}`;
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  body{display:inline-block}
  .bg{
    display:inline-block;
    padding:56px 120px;
    background:linear-gradient(135deg,#6d5efc 0%,#c86dd7 45%,#ff7eb3 100%);
  }
  .win{
    display:inline-block; border-radius:14px; overflow:hidden;
    background:#1a1b26;
    box-shadow:0 30px 80px rgba(0,0,0,.45), 0 8px 24px rgba(0,0,0,.30);
  }
  .bar{
    display:flex; align-items:center; gap:9px;
    padding:14px 18px; background:#16171f;
    border-bottom:1px solid #23242e;
  }
  .dot{width:14px; height:14px; border-radius:50%}
  .dot.r{background:#ff5f56} .dot.y{background:#ffbd2e} .dot.g{background:#27c93f}
  .title{
    flex:1; text-align:center; margin-right:42px;
    font-family:"JetBrains Mono","SF Mono",Menlo,monospace;
    font-size:15px; color:#6b7080;
  }
  .term{
    padding:24px 40px 22px;
    font-family:"JetBrains Mono","SF Mono",Menlo,monospace;
    font-size:20px; line-height:1.6; color:#c0caf5;
    white-space:pre; tab-size:2;
  }
</style></head>
<body><div class="bg"><div class="win">
  <div class="bar">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="title">pi — pi-tidy-tools</span>
  </div>
  <div class="term" id="term">${body}\n\n${editor}</div>
</div></div></body></html>`;
	process.stdout.write(html);
}

main();
