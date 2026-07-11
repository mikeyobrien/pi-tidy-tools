/**
 * Render a /diff recap screenshot from real tool diffs.
 *
 *   npx tsx docs/diff-html.ts > docs/diff.html
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createWriteTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { buildTurnDiffBlock } from "../index.js";

const COLORS: Record<string, string> = {
	"31": "#f7768e",
	"32": "#9ece6a",
	"33": "#e0af68",
	"35": "#bb9af7",
	"36": "#7dcfff",
};

function ansiToHtml(text: string): string {
	let out = "";
	const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const ansi = /\x1b\[([0-9;]*)m/g;
	let last = 0;
	let open = 0;
	let match: RegExpExecArray | null;
	while ((match = ansi.exec(text)) !== null) {
		out += escape(text.slice(last, match.index));
		last = ansi.lastIndex;
		const codes = match[1].split(";").filter(Boolean);
		for (const code of codes.length ? codes : ["0"]) {
			if (code === "0") {
				while (open > 0) {
					out += "</span>";
					open--;
				}
			} else if (code === "1") {
				out += '<span style="font-weight:700">';
				open++;
			} else if (code === "2") {
				out += '<span style="opacity:.55">';
				open++;
			} else if (COLORS[code]) {
				out += `<span style="color:${COLORS[code]}">`;
				open++;
			}
		}
	}
	out += escape(text.slice(last));
	while (open > 0) {
		out += "</span>";
		open--;
	}
	return out;
}

async function main() {
	const directory = mkdtempSync(join(tmpdir(), "pi-tidy-diff-"));
	mkdirSync(join(directory, "src"));
	const auth = join(directory, "src", "auth.ts");
	writeFileSync(auth, [
		"export function verifyToken(token: string) {",
		"  return token.length > 0;",
		"}",
		"",
	].join("\n"));

	const edit = createEditTool(directory);
	const write = createWriteTool(directory);
	const edited = await edit.execute("edit", {
		path: auth,
		edits: [{
			oldText: "return token.length > 0;",
			newText: "return typeof token === 'string' && token.length > 0;",
		}],
	}, undefined, undefined);
	const configPath = join(directory, "src", "config.ts");
	const configContent = "export const TIMEOUT_MS = 5_000;\n";
	await write.execute("write", { path: configPath, content: configContent }, undefined, undefined);
	const writeDiff = generateDiffString("", configContent).diff;
	rmSync(directory, { recursive: true, force: true });

	const rows = buildTurnDiffBlock([
		{ tool: "edit", path: "src/auth.ts", diff: edited.details?.diff ?? "" },
		{ tool: "write", path: "src/config.ts", diff: writeDiff },
	]);

	const DIMc = "#565a6e";
	const MAGc = "#bb9af7";
	const BORDERc = "#2b2d3a";
	const prompt = `<span style="color:${DIMc}">❯</span> <span style="color:${MAGc}">/diff</span>`;
	const recap = `<span class="diff">${ansiToHtml(rows.join("\n"))}</span>`;
	const rule = `<span style="color:${BORDERc}">${"─".repeat(78)}</span>`;
	const editor = `${rule}\n${" "}\n${rule}`;
	const body = `${prompt}\n\n${recap}\n\n${editor}`;

	const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  body{display:inline-block}
  .bg{
    display:inline-block;
    padding:56px 100px;
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
  .diff{display:block; margin:0 -40px; padding:14px 40px; background:#1f2433}
</style></head>
<body><div class="bg"><div class="win">
  <div class="bar">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="title">pi — /diff</span>
  </div>
  <div class="term">${body}</div>
</div></div></body></html>`;
	process.stdout.write(html);
}

main();
