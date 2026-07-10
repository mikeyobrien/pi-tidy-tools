/**
 * pi-tidy-tools — tidy, reason-first tool output for pi.
 *
 * Model (per-tool 2-line block): each built-in tool renders its OWN compact
 * block inline in the transcript, in execution order, via the tool-renderer
 * path (renderShell: "self"). No collector, no above-editor widget, no
 * turn-end stamping — pi already renders tool components inline; we just make
 * them tight.
 *
 *     ┊ ✓ ✏️ edit put reasoning on line 1, detail on line 2
 *     ┊   index.ts → +28/-14
 *     ┊ ✓ ⚡ bash run the typecheck
 *     ┊   npx tsc --noEmit → done (1 lines)
 *
 * Line 1: {gutter} {mark} {icon} {name} {reasoning headline}
 * Line 2: {gutter}   {dim arg/command detail} → {colored summary}
 *
 * Why this beats the spacer floor: pi bakes a Spacer(1) inside every tool's
 * ToolExecutionComponent, so N default cards = N blank lines. BUT in
 * `renderShell: "self"` mode, ToolExecutionComponent.render() skips that baked
 * spacer — it emits ONE leading blank + the self-rendered content, and returns
 * [] when content is empty. So each tool = 1 separator + 2 tight lines.
 *
 * `reasoning`: built-in tools have no reasoning of their own, so we inject a
 * REQUIRED `reasoning` string param into each wrapped tool. The model must fill
 * it with the GOAL/intent behind the call (not the file or command, which are
 * already shown); we strip it before delegating and render it as the line-1
 * headline. If ever absent, line 1 falls back to the arg detail.
 *
 * C-o (app.tools.expand) expansion: renderResult receives `{ expanded }`.
 * Collapsed shows the 2-line block; expanded appends the tool's real output —
 * a colored line-numbered diff for code edits (details.diff), else raw content.
 *
 * MCP / foreign tools: NOT overridden — we only own the built-in factories, so
 * we can't re-register a foreign tool's rendering without its execute fn. They
 * keep their default inline card.
 *
 * Usage:  pi -e ./index.ts     (or install as a pi package)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	BOLD,
	CYAN,
	DIM,
	GREEN,
	MAGENTA,
	RED,
	RESET,
	nonEmptyLineCount,
	shortPath,
	style,
} from "./render.js";

// A leading indent offsets each tool block from surrounding prose, making tool
// calls visually distinct from the assistant's text.
const LEAD = "  ";
const GUTTER = `${LEAD}${DIM}${String.fromCharCode(0x250a)}${RESET}`;
/** Gutter + hanging indent for line 2 and expanded continuation lines. */
const INDENT = `${GUTTER}   `;

/** Collapse whitespace/newlines to one line (width-based truncation happens at render). */
function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * A width-aware component: truncates each pre-composed (ANSI-colored) line to the
 * live viewport width so nothing soft-wraps past the gutter. Re-flows on resize
 * because render(width) is re-invoked by the TUI.
 */
class WidthAwareLines {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		const max = Math.max(1, width);
		return this.lines.map((l) => (visibleWidth(l) > max ? truncateToWidth(l, max, "…") : l));
	}
}

/** Dim line-2 detail when the model gave no `reasoning`. Always ONE line. */
function argDetail(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") return oneLine(args.command);
	if ((name === "grep" || name === "find") && typeof args.pattern === "string") {
		return oneLine(typeof args.path === "string" ? `${args.pattern} in ${args.path}` : String(args.pattern));
	}
	if (typeof args.path === "string") return oneLine(args.path);
	if (typeof args.name === "string") return oneLine(args.name);
	return "";
}

/** Colored result summary from a finished tool result. */
function summarize(name: string, result: any, isError: boolean): string {
	const text = textFromResult(result);
	if (isError) return `${RED}${text.split("\n")[0] || "error"}${RESET}`;
	if (name === "read") return `${GREEN}${text.split("\n").length} lines${RESET}`;
	if (name === "write") {
		const m = text.match(/wrote (\d+) bytes/);
		return m ? `${GREEN}wrote ${DIM}${m[1]}b${RESET}` : `${GREEN}written${RESET}`;
	}
	if (name === "edit") {
		const diff = result?.details?.diff as string | undefined;
		if (!diff) return `${GREEN}applied${RESET}`;
		let add = 0;
		let del = 0;
		for (const l of diff.split("\n")) {
			if (l.startsWith("+") && !l.startsWith("+++")) add++;
			if (l.startsWith("-") && !l.startsWith("---")) del++;
		}
		return `${GREEN}+${add}${RESET}${DIM}/${RESET}${RED}-${del}${RESET}`;
	}
	if (name === "bash") {
		const m = text.match(/exit code: (\d+)/);
		const exit = m ? Number(m[1]) : null;
		return `${exit && exit !== 0 ? `${RED}exit ${exit}` : `${GREEN}done`}${RESET} ${DIM}(${nonEmptyLineCount(text)} lines)${RESET}`;
	}
	if (name === "grep") {
		if (/^No matches found/.test(text.trim())) return `${DIM}0 matches${RESET}`;
		// Count only true match lines (path:lineno:...), not context (path-lineno-...) or -- separators.
		const matches = text.split("\n").filter((l) => /:\d+:/.test(l)).length;
		const count = matches || nonEmptyLineCount(text);
		return `${DIM}${count} ${count === 1 ? "match" : "matches"}${RESET}`;
	}
	const count = nonEmptyLineCount(text);
	const noun = name === "find" ? "files" : name === "ls" ? "entries" : "results";
	return `${DIM}${count} ${noun}${RESET}`;
}

/** Pull the first text block out of a tool result / partial (shape varies). */
function textFromResult(r: any): string {
	const content = r?.content ?? r?.partialResult?.content;
	if (Array.isArray(content)) {
		const c = content.find((x: any) => x?.type === "text");
		if (c?.text) return c.text;
	}
	if (typeof r?.output === "string") return r.output;
	return "";
}

/** Colorize a unified/line-numbered diff string (edit tool's details.diff). */
function colorizeDiff(diff: string): string[] {
	return diff.split("\n").map((l) => {
		if (l.startsWith("+") && !l.startsWith("+++")) return `${GREEN}${l}${RESET}`;
		if (l.startsWith("-") && !l.startsWith("---")) return `${RED}${l}${RESET}`;
		if (l.startsWith("@@")) return `${CYAN}${l}${RESET}`;
		return `${DIM}${l}${RESET}`;
	});
}

/** A file change captured during a turn, for the `/diff` recap. */
interface TurnDiff {
	tool: string; // "edit" | "write"
	path: string;
	diff: string; // raw details.diff (may be empty for whole-file writes)
}

/** Render a set of turn diffs as colored lines with per-file headers. */
function renderTurnDiffs(diffs: TurnDiff[]): string[] {
	const lines: string[] = [];
	diffs.forEach((d, i) => {
		if (i > 0) lines.push("");
		const { icon, color } = style(d.tool);
		lines.push(`${color}${icon} ${BOLD}${shortPath(d.path)}${RESET}`);
		if (d.diff.trim()) lines.push(...colorizeDiff(d.diff.replace(/\s+$/, "")));
		else lines.push(`${DIM}(new file / full overwrite — no line diff)${RESET}`);
	});
	return lines;
}

/** Clone a JSON-schema params object and inject a REQUIRED `reasoning` prop. */
function withReasoning(parameters: any): any {
	const props = { ...(parameters?.properties ?? {}) };
	props.reasoning = {
		type: "string",
		description:
			"Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. \"confirm executionStarted is a timestamp\", \"fix the map leak from review\", \"retry match after previous miss\".",
	};
	const required = Array.from(new Set([...(parameters?.required ?? []), "reasoning"]));
	return { ...parameters, properties: props, required };
}

/** Strip our injected `reasoning` before delegating to the real tool. */
function stripReasoning(params: any): { reasoning?: string; rest: any } {
	if (!params || typeof params !== "object") return { rest: params };
	const { reasoning, ...rest } = params;
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}

/**
 * Build the expanded (C-o) continuation lines for a settled tool result:
 *   - bash: the full multi-line command input, then its output
 *   - edit/write: the colored line-numbered diff when present
 *   - otherwise: the raw result text
 * Each line is prefixed with the hanging INDENT.
 */
function expandedLines(name: string, args: Record<string, unknown>, result: any): string[] {
	const out: string[] = [];

	// bash: show the full command (collapsed line 2 is truncated to one line).
	if (name === "bash" && typeof args.command === "string") {
		const cmdLines = args.command.replace(/\s+$/, "").split("\n");
		cmdLines.forEach((cl, i) => {
			const prefix = i === 0 ? `${CYAN}$ ${RESET}` : `${DIM}  ${RESET}`;
			out.push(`${INDENT}${prefix}${CYAN}${cl}${RESET}`);
		});
	}

	// Prefer the structured diff over the generic "Successfully replaced..." text.
	const diff = result?.details?.diff as string | undefined;
	if (diff && diff.trim()) {
		for (const dl of colorizeDiff(diff.replace(/\s+$/, ""))) out.push(`${INDENT}${dl}`);
		return out;
	}

	const text = textFromResult(result).replace(/\s+$/, "");
	if (text) for (const raw of text.split("\n")) out.push(`${INDENT}${DIM}${raw}${RESET}`);
	return out;
}

/**
 * Build the rendered lines for one settled tool call. Shared by the live
 * renderResult and the demo generator so the demo shows REAL output, never
 * hand-typed ANSI. `args` includes the model's `reasoning` (stripped here).
 */
export function buildToolBlock(
	name: string,
	args: Record<string, unknown>,
	result: any,
	opts: { isError?: boolean; isPartial?: boolean; expanded?: boolean } = {},
): string[] {
	const { isError = false, isPartial = false, expanded = false } = opts;
	const { reasoning, rest } = stripReasoning(args ?? {});

	const mark = isPartial
		? `${DIM}·${RESET}`
		: isError
			? `${RED}✗${RESET}`
			: `${GREEN}✓${RESET}`;
	const summary = isPartial ? `${DIM}…${RESET}` : summarize(name, result, isError);

	const { icon, color } = style(name);
	const headline = oneLine(reasoning || argDetail(name, rest));
	const detail = argDetail(name, rest);
	// On error, give the whole line-2 to the message (skip the detail prefix so a
	// long error isn't squeezed off-screen). The full error is on expand anyway.
	const line2 = isError || !detail
		? `${INDENT}${DIM}→${RESET} ${summary}`
		: `${INDENT}${DIM}${detail}${RESET} ${DIM}→${RESET} ${summary}`;
	const lines = [
		`${GUTTER} ${mark} ${color}${icon} ${BOLD}${name}${RESET} ${headline}`,
		line2,
	];
	if (expanded && !isPartial) lines.push(...expandedLines(name, rest, result));
	return lines;
}

const cwd = process.cwd();

const DIFF_MSG_TYPE = "minimal-turn-diff";

export default function (pi: ExtensionAPI) {
	// --- Turn-diff tracking: capture edit/write changes, bucketed per turn, so
	// `/diff` can recap the last turn's file changes as one combined diff.
	// NOTE: tool_execution_end has NO args — only tool_execution_start carries
	// args.path. So we stash the path by toolCallId on start, read it on end. ---
	let currentTurn: TurnDiff[] = [];
	let lastTurn: TurnDiff[] = [];
	const pathByCallId = new Map<string, string>();

	pi.on("tool_execution_start", async (e: any) => {
		if ((e.toolName === "edit" || e.toolName === "write") && typeof e?.args?.path === "string") {
			pathByCallId.set(e.toolCallId, e.args.path);
		}
	});

	pi.on("tool_execution_end", async (e: any) => {
		if (e.toolName !== "edit" && e.toolName !== "write") return;
		const path = pathByCallId.get(e.toolCallId);
		pathByCallId.delete(e.toolCallId);
		if (e.isError) return;
		const diff = (e?.result?.details?.diff as string | undefined) ?? "";
		currentTurn.push({ tool: e.toolName, path: path ?? "(unknown)", diff });
	});

	pi.on("turn_end", async () => {
		if (currentTurn.length > 0) {
			lastTurn = currentTurn;
			currentTurn = [];
		}
		// toolCallIds never span turns; drop any entries whose end never fired
		// (e.g. an interrupted/aborted call) so the map can't grow unbounded.
		pathByCallId.clear();
	});

	// Render the recap message as width-aware colored lines.
	pi.registerMessageRenderer(DIFF_MSG_TYPE, (message: any) => {
		const rows: string[] = message.details?.rows ?? String(message.content ?? "").split("\n");
		return new WidthAwareLines(rows);
	});

	const showLastTurnDiff = (ctx: any) => {
		if (lastTurn.length === 0) {
			ctx.ui.notify("No file changes recorded in the last turn.", "info");
			return;
		}
		const n = lastTurn.length;
		const header = `${MAGENTA}◆ ${BOLD}last turn diff${RESET} ${DIM}(${n} file${n === 1 ? "" : "s"})${RESET}`;
		const rows = [header, ...renderTurnDiffs(lastTurn)];
		pi.sendMessage({ customType: DIFF_MSG_TYPE, content: rows.join("\n"), display: true, details: { rows } });
	};

	pi.registerCommand("diff", {
		description: "Show file changes (edit/write diffs) from the last turn",
		handler: async (_args, ctx) => {
			showLastTurnDiff(ctx);
		},
	});

	// NOTE: ctrl+shift+o collides with the built-in `app.tree.filter.cycleBackward`
	// (only active in the tree view). In the main transcript this triggers /diff.
	pi.registerShortcut("ctrl+shift+o", {
		description: "Show file changes from the last turn",
		handler: async (ctx) => {
			showLastTurnDiff(ctx);
		},
	});

	const builtinTools: Record<string, any> = {
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		bash: createBashTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};

	for (const [name, tool] of Object.entries(builtinTools)) {
		pi.registerTool({
			name,
			label: name,
			description: tool.description,
			parameters: withReasoning(tool.parameters),
			promptGuidelines: [
				`Always pass a "reasoning" phrase to ${name}: state the GOAL/intent, not the file or command (those are shown already).`,
			],
			renderShell: "self",

			// Strip our injected `reasoning`, delegate to the real built-in.
			execute: (id: string, p: any, sig: any, up: any) => {
				const { rest } = stripReasoning(p);
				return tool.execute(id, rest, sig, up);
			},

			// renderCall + renderResult BOTH get composed into the tool component,
			// so rendering the block in each yields two copies. Render nothing here;
			// renderResult owns the whole block and handles the running state via
			// its `isPartial` flag.
			renderCall: () => new Container(),

			// Two-line block; handles running (isPartial) → done/error, and expanded
			// (C-o) appends the tool's real output.
			renderResult: (result: any, options: any, _theme: any, context: any) => {
				// isError lives on the render CONTEXT (from result.isError), not on the
				// result object passed as arg 1 (that only has content/details). Reading
				// result.isError would always be undefined → failed edits render green.
				const lines = buildToolBlock(name, context?.args ?? {}, result, {
					isError: context?.isError ?? result?.isError ?? false,
					isPartial: options?.isPartial ?? false,
					expanded: options?.expanded ?? false,
				});
				return new WidthAwareLines(lines);
			},
		});
	}
}
