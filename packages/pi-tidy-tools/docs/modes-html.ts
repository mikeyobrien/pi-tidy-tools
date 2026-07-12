import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { buildToolBlock } from "../index.js";
import type { TidyMode } from "../config.js";

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
		for (const code of match[1].split(";").filter(Boolean).length ? match[1].split(";").filter(Boolean) : ["0"]) {
			if (code === "0") {
				while (open > 0) { out += "</span>"; open--; }
			} else if (code === "1") {
				out += '<span style="font-weight:700">'; open++;
			} else if (code === "2") {
				out += '<span style="opacity:.55">'; open++;
			} else if (COLORS[code]) {
				out += `<span style="color:${COLORS[code]}">`; open++;
			}
		}
	}
	out += escape(text.slice(last));
	while (open > 0) { out += "</span>"; open--; }
	return out;
}

async function main() {
	const directory = mkdtempSync(join(tmpdir(), "pi-tidy-modes-"));
	mkdirSync(join(directory, "src"));
	const file = join(directory, "src", "cache.ts");
	writeFileSync(file, "const cache = new Map();\ncache.set(key, value);\n");
	const edit = createEditTool(directory);
	const result = await edit.execute("mode-demo", {
		path: file,
		edits: [{ oldText: "const cache = new Map();", newText: "const cache = new Map<string, Entry>();" }],
	}, undefined, undefined);
	rmSync(directory, { recursive: true, force: true });

	const modes: Array<{ mode: TidyMode; description: string }> = [
		{ mode: "default", description: "intent, then target + result" },
		{ mode: "reasoning", description: "intent + result" },
		{ mode: "result", description: "target + result" },
	];
	const cards = modes.map(({ mode, description }) => {
		const lines = buildToolBlock("edit", {
			path: "src/cache.ts",
			reasoning: "add types to the cache",
		}, result, { mode, completedAt: 1_000, now: 3_781_000 });
		return `<section class="mode"><h2>${mode}</h2><p>${description}</p><pre>${ansiToHtml(lines.join("\n"))}</pre></section>`;
	}).join("");

	process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent} body{display:inline-block}
.frame{display:flex;gap:24px;padding:48px;background:linear-gradient(135deg,#6d5efc,#c86dd7 48%,#ff7eb3);font-family:"JetBrains Mono",monospace}
.mode{width:620px;padding:28px;border-radius:13px;background:#1a1b26;box-shadow:0 20px 55px rgba(0,0,0,.35);color:#c0caf5}
h2{margin:0;color:#bb9af7;font-size:25px;text-transform:uppercase} p{margin:7px 0 25px;color:#70768b;font-size:17px}
pre{margin:0 -28px;padding:10px 28px;background:#1f2d29;font:20px/1.6 "JetBrains Mono",monospace;white-space:pre}
</style></head><body><main class="frame">${cards}</main></body></html>`);
}

main();
