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
	generateDiffString,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CONFIG_PATH, loadTidyMode, loadTidyState, saveTidyEnabled, saveTidyMode, type TidyMode } from "./config.js";
import {
	BOLD,
	CYAN,
	DIM,
	GREEN,
	MAGENTA,
	RED,
	RESET,
	formatAge,
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

/** Fit a rendered line while preserving its age and useful result tail. */
export function fitToolLine(line: string, width: number): string {
	const max = Math.max(1, width);
	if (visibleWidth(line) <= max) return line;
	const arrowIndex = line.indexOf("→");
	const ageIndex = line.lastIndexOf(`${DIM}(`);
	let tailIndex = ageIndex >= 0 && (arrowIndex < 0 || ageIndex < arrowIndex) ? ageIndex : arrowIndex;
	if (tailIndex < 0) return truncateToWidth(line, max, "…");

	let tail = line.slice(tailIndex);
	let tailWidth = visibleWidth(tail);
	// If an age plus result cannot physically fit, preserve the decision-useful
	// result rather than replacing it with decoration.
	if (tailWidth >= max && arrowIndex >= 0 && tailIndex !== arrowIndex) {
		tailIndex = arrowIndex;
		tail = line.slice(tailIndex);
		tailWidth = visibleWidth(tail);
	}
	if (tailWidth >= max) return truncateToWidth(tail, max, "…");
	const head = line.slice(0, tailIndex).trimEnd();
	return `${truncateToWidth(head, max - tailWidth - 1, "…")} ${tail}`;
}

/**
 * A width-aware component: truncates each pre-composed (ANSI-colored) line to the
 * live viewport width so nothing soft-wraps past the gutter. Re-flows on resize
 * because render(width) is re-invoked by the TUI.
 */
class WidthAwareLines {
	constructor(
		private readonly source: string[] | (() => string[]),
		private readonly background?: (text: string) => string,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const max = Math.max(1, width);
		const lines = typeof this.source === "function" ? this.source() : this.source;
		return lines.map((line) => {
			const fitted = fitToolLine(line, max);
			if (!this.background) return fitted;
			const padded = fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
			// Raw foreground styling uses RESET, which also clears an enclosing
			// background. Apply the background independently to every reset-delimited
			// segment so it remains continuous through the full padded line.
			return padded.split(RESET).map((segment) => this.background!(`${segment}${RESET}`)).join("");
		});
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

/** Compact elapsed time for an in-progress tool. */
export function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return "<1s";
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Colored result summary from a finished tool result. */
function summarize(
	name: string,
	result: any,
	isError: boolean,
	args: Record<string, unknown> = {},
	elapsedMs = 0,
): string {
	const text = textFromResult(result);
	if (isError) {
		if (name === "bash") return `${RED}error${RESET} ${DIM}in ${formatElapsed(elapsedMs)}${RESET}`;
		return `${RED}${text.split("\n")[0] || "error"}${RESET}`;
	}
	if (name === "read") return `${GREEN}${text.split("\n").length} lines${RESET}`;
	if (name === "write") {
		if (typeof args.content === "string" && !args.content.includes("\0")) {
			const lines = args.content.length === 0
				? 0
				: (args.content.match(/\n/g)?.length ?? 0) + (args.content.endsWith("\n") ? 0 : 1);
			return `${GREEN}${lines}${RESET} ${DIM}${lines === 1 ? "line" : "lines"}${RESET}`;
		}
		const bytes = text.match(/wrote (\d+) bytes/i)?.[1];
		return bytes ? `${GREEN}${bytes}b${RESET}` : `${GREEN}written${RESET}`;
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
		const status = exit && exit !== 0 ? `${RED}exit ${exit}` : `${GREEN}done`;
		return `${status}${RESET} ${DIM}in ${formatElapsed(elapsedMs)}${RESET}`;
	}
	if (name === "grep") {
		if (/^No matches found/.test(text.trim())) return `${DIM}0 matches in 0 files${RESET}`;
		// Count only true match lines (path:lineno:...), not context (path-lineno-...) or -- separators.
		const matchLines = text.split("\n").map((line) => ({ line, match: line.match(/^(.+):\d+:/) })).filter((entry) => entry.match);
		const count = matchLines.length || nonEmptyLineCount(text);
		const files = new Set(matchLines.map((entry) => entry.match?.[1])).size;
		const matchLabel = count === 1 ? "match" : "matches";
		const fileLabel = files === 1 ? "file" : "files";
		return `${GREEN}${count} ${matchLabel}${RESET} ${DIM}in${RESET} ${CYAN}${files} ${fileLabel}${RESET}`;
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
	if (typeof r?.error === "string") return r.error;
	if (typeof r?.message === "string") return r.message;
	if (typeof r?.details?.error === "string") return r.details.error;
	return "";
}

/** Replace tabs with painted cells using stops relative to the code payload. */
function expandTabs(text: string): string {
	let column = 0;
	let expanded = "";
	for (const character of text) {
		if (character === "\t") {
			const spaces = 8 - (column % 8);
			expanded += " ".repeat(spaces);
			column += spaces;
		} else {
			expanded += character;
			column += visibleWidth(character);
		}
	}
	return expanded;
}

/** Keep line-number prefixes out of edit payload tab-stop calculations. */
function expandDiffTabs(line: string): string {
	const numbered = line.match(/^([ +\-]\s*\d+ )(.*)$/);
	return numbered ? `${numbered[1]}${expandTabs(numbered[2])}` : expandTabs(line);
}

/** Colorize a unified/line-numbered diff string (edit tool's details.diff). */
function colorizeDiff(diff: string): string[] {
	return diff.split("\n").map((rawLine) => {
		const line = expandDiffTabs(rawLine);
		if (line.startsWith("+") && !line.startsWith("+++")) return `${GREEN}${line}${RESET}`;
		if (line.startsWith("-") && !line.startsWith("---")) return `${RED}${line}${RESET}`;
		if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
		return `${DIM}${line}${RESET}`;
	});
}

/** A file change captured during a turn, for the `/diff` recap. */
export interface TurnDiff {
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

/** Full `/diff` recap block — same lines the command posts into the transcript. */
export function buildTurnDiffBlock(diffs: TurnDiff[]): string[] {
	const n = diffs.length;
	const header = `${MAGENTA}◆ ${BOLD}last turn diff${RESET} ${DIM}(${n} file${n === 1 ? "" : "s"})${RESET}`;
	return [header, ...renderTurnDiffs(diffs)];
}

/** Clone a JSON-schema params object and inject a REQUIRED, first `reasoning` prop. */
export function withReasoning(parameters: any): any {
	const reasoning = {
		type: "string",
		description:
			"Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. \"confirm executionStarted is a timestamp\", \"fix the map leak from review\", \"retry match after previous miss\".",
	};
	const properties = { reasoning, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["reasoning", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
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

	// Whole-file writes do not provide a useful diff. Show the actual written
	// content instead of repeating the generic "Successfully wrote..." result.
	if (name === "write" && typeof args.content === "string") {
		if (args.content.length === 0) {
			out.push(`${INDENT}${DIM}(empty file)${RESET}`);
			return out;
		}
		const splitLines = args.content.split("\n");
		const contentLines = args.content.endsWith("\n") ? splitLines.slice(0, -1) : splitLines;
		const lineNumberWidth = String(contentLines.length).length;
		contentLines.forEach((line, index) => {
			const lineNumber = String(index + 1).padStart(lineNumberWidth, " ");
			out.push(`${INDENT}${DIM}${lineNumber} ${RESET}${expandTabs(line)}`);
		});
		return out;
	}

	// Prefer the structured diff over the generic "Successfully replaced..." text.
	const diff = result?.details?.diff as string | undefined;
	if (diff && diff.trim()) {
		for (const dl of colorizeDiff(diff)) out.push(`${INDENT}${dl}`);
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
	opts: { isError?: boolean; isPartial?: boolean; expanded?: boolean; elapsedMs?: number; completedAt?: number; now?: number; mode?: TidyMode } = {},
): string[] {
	const { isError = false, isPartial = false, expanded = false, elapsedMs = 0, completedAt, now = Date.now(), mode = "default" } = opts;
	const { reasoning, rest } = stripReasoning(args ?? {});

	const mark = isPartial
		? `${DIM}·${RESET}`
		: isError
			? `${RED}✗${RESET}`
			: `${GREEN}✓${RESET}`;
	const summary = isPartial
		? `${DIM}${formatElapsed(elapsedMs)}${RESET}`
		: summarize(name, result, isError, rest, elapsedMs);

	const { icon, color } = style(name);
	const headline = oneLine(reasoning || argDetail(name, rest));
	const detail = argDetail(name, rest);
	const age = !isPartial && Number.isFinite(completedAt)
		? ` ${DIM}(${formatAge(now - completedAt!)} ago)${RESET}`
		: "";
	// Keep the target on failures too; width fitting preserves the useful error
	// tail while the command/path answers what actually failed.
	const line2 = !detail
		? `${INDENT}${DIM}→${RESET} ${summary}`
		: `${INDENT}${DIM}${detail}${RESET} ${DIM}→${RESET} ${summary}`;
	let lines: string[];
	if (mode === "reasoning") {
		lines = [`${GUTTER} ${mark} ${color}${icon} ${BOLD}${name}${RESET} ${headline}${age} ${DIM}→${RESET} ${summary}`];
	} else if (mode === "result") {
		const resultDetail = !detail ? "" : ` ${DIM}${detail}${RESET}`;
		lines = [`${GUTTER} ${mark} ${color}${icon} ${BOLD}${name}${RESET}${resultDetail}${age} ${DIM}→${RESET} ${summary}`];
	} else {
		lines = [
			`${GUTTER} ${mark} ${color}${icon} ${BOLD}${name}${RESET} ${headline}${age}`,
			line2,
		];
	}
	if (expanded && !isPartial) lines.push(...expandedLines(name, rest, result));
	return lines;
}

const cwd = process.cwd();

const DIFF_MSG_TYPE = "minimal-turn-diff";

export default function (pi: ExtensionAPI) {
	const tidyState = loadTidyState();
	const tidyMode = loadTidyMode();

	// This management command is intentionally the sole registration that remains
	// while disabled, allowing the extension to be re-enabled without editing files.
	pi.registerCommand("tidy", {
		description: "Manage pi-tidy-tools state and layout mode",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "toggle", "status", "mode default", "mode reasoning", "mode result", "mode status"];
			return values.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status" || action === "mode status") {
				const detail = tidyState.source === "environment"
					? "PI_TIDY_TOOLS override"
					: tidyState.source === "file"
						? CONFIG_PATH
						: "default; no config file";
				ctx.ui.notify(`pi-tidy-tools is ${tidyState.enabled ? "on" : "off"}, mode ${tidyMode} (${detail}).`, "info");
				return;
			}

			const modeMatch = action.match(/^mode (default|reasoning|result)$/);
			if (modeMatch) {
				const mode = modeMatch[1] as TidyMode;
				if (mode === tidyMode) {
					ctx.ui.notify(`pi-tidy-tools mode is already ${mode}.`, "info");
					return;
				}
				try {
					await saveTidyMode(mode);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save ${CONFIG_PATH}: ${message}`, "error");
					return;
				}
				ctx.ui.notify(`pi-tidy-tools mode set to ${mode}; reloading.`, "info");
				await ctx.reload();
				return;
			}

			if (action !== "on" && action !== "off" && action !== "toggle") {
				ctx.ui.notify("Usage: /tidy on|off|toggle|status|mode default|reasoning|result|status", "warning");
				return;
			}
			if (tidyState.source === "environment") {
				ctx.ui.notify("PI_TIDY_TOOLS overrides persistent settings; change or unset it first.", "warning");
				return;
			}

			const enabled = action === "toggle" ? !tidyState.enabled : action === "on";
			if (enabled === tidyState.enabled) {
				ctx.ui.notify(`pi-tidy-tools is already ${enabled ? "on" : "off"}.`, "info");
				return;
			}
			try {
				await saveTidyEnabled(enabled);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save ${CONFIG_PATH}: ${message}`, "error");
				return;
			}
			ctx.ui.notify(`pi-tidy-tools ${enabled ? "enabled" : "disabled"}; reloading.`, "info");
			await ctx.reload();
			return;
		},
	});

	// Every other registration changes optional behavior and must stay absent in
	// disabled mode, including schemas, prompt guidelines, hooks, and renderers.
	if (!tidyState.enabled) return;

	// --- Turn-diff tracking: capture edit/write changes, bucketed per turn, so
	// `/diff` can recap the last turn's file changes as one combined diff.
	// NOTE: tool_execution_end has NO args — only tool_execution_start carries
	// args.path. So we stash the path by toolCallId on start, read it on end. ---
	let currentTurn: TurnDiff[] = [];
	let lastTurn: TurnDiff[] = [];
	const pathByCallId = new Map<string, string>();
	const startedAtByCallId = new Map<string, number>();
	const elapsedTimerByCallId = new Map<string, ReturnType<typeof setInterval>>();
	const ageRefreshByCallId = new Map<string, { completedAt: number; invalidate: () => void }>();
	let ageRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let ageRefreshAt: number | undefined;

	const nextAgeRefreshAt = (completedAt: number, now: number): number => {
		const age = Math.max(0, now - completedAt);
		if (age < 24 * 60 * 60_000) return completedAt + (Math.floor(age / 60_000) + 1) * 60_000;
		if (age < 30 * 24 * 60 * 60_000) return completedAt + (Math.floor(age / 3_600_000) + 1) * 3_600_000;
		return completedAt + (Math.floor(age / 86_400_000) + 1) * 86_400_000;
	};
	const ageRefreshCadence = (now: number): number => {
		let cadence = 86_400_000;
		for (const { completedAt } of ageRefreshByCallId.values()) {
			const age = Math.max(0, now - completedAt);
			if (age < 24 * 60 * 60_000) return 60_000;
			if (age < 30 * 24 * 60 * 60_000) cadence = 3_600_000;
		}
		return cadence;
	};
	const scheduleAgeRefreshAt = (next: number): void => {
		if (ageRefreshByCallId.size === 0) return;
		if (ageRefreshTimer && ageRefreshAt !== undefined && ageRefreshAt <= next) return;
		if (ageRefreshTimer) clearTimeout(ageRefreshTimer);
		ageRefreshAt = next;
		ageRefreshTimer = setTimeout(() => {
			ageRefreshTimer = undefined;
			ageRefreshAt = undefined;
			const refreshNow = Date.now();
			for (const { invalidate } of ageRefreshByCallId.values()) invalidate();
			scheduleAgeRefreshAt(refreshNow + ageRefreshCadence(refreshNow));
		}, Math.max(1, next - Date.now()));
		ageRefreshTimer.unref?.();
	};
	const registerAgeRefresh = (id: string, completedAt: number, invalidate: () => void): void => {
		const previous = ageRefreshByCallId.get(id);
		const unchanged = previous?.completedAt === completedAt;
		ageRefreshByCallId.set(id, { completedAt, invalidate });
		if (!unchanged) scheduleAgeRefreshAt(nextAgeRefreshAt(completedAt, Date.now()));
	};
	const clearAgeRefresh = (): void => {
		if (ageRefreshTimer) clearTimeout(ageRefreshTimer);
		ageRefreshTimer = undefined;
		ageRefreshAt = undefined;
		ageRefreshByCallId.clear();
	};

	pi.on("tool_execution_start", async (e: any) => {
		if (!startedAtByCallId.has(e.toolCallId)) startedAtByCallId.set(e.toolCallId, Date.now());
		if ((e.toolName === "edit" || e.toolName === "write") && typeof e?.args?.path === "string") {
			pathByCallId.set(e.toolCallId, e.args.path);
		}
	});

	pi.on("tool_execution_end", async (e: any) => {
		const elapsedTimer = elapsedTimerByCallId.get(e.toolCallId);
		if (elapsedTimer) clearInterval(elapsedTimer);
		elapsedTimerByCallId.delete(e.toolCallId);
		if (e.toolName !== "edit" && e.toolName !== "write") return;
		const path = pathByCallId.get(e.toolCallId);
		pathByCallId.delete(e.toolCallId);
		if (e.isError) return;
		const diff = (e?.result?.details?.diff as string | undefined) ?? "";
		currentTurn.push({ tool: e.toolName, path: path ?? "(unknown)", diff });
	});

	pi.on("tool_result", async (e: any) => {
		if (!Object.hasOwn(builtinTools, e.toolName)) return;
		const startedAt = startedAtByCallId.get(e.toolCallId);
		if (startedAt === undefined) return;
		const completedAt = Date.now();
		return { details: {
			...(e.details ?? {}),
			piTidyElapsedMs: Math.max(0, completedAt - startedAt),
			piTidyCompletedAt: completedAt,
		} };
	});

	pi.on("turn_end", async () => {
		lastTurn = currentTurn;
		currentTurn = [];
		// toolCallIds never span turns; drop any entries whose end never fired
		// (e.g. an interrupted/aborted call) so the map can't grow unbounded.
		pathByCallId.clear();
		startedAtByCallId.clear();
		for (const timer of elapsedTimerByCallId.values()) clearInterval(timer);
		elapsedTimerByCallId.clear();
	});

	pi.on("session_shutdown", async () => {
		for (const timer of elapsedTimerByCallId.values()) clearInterval(timer);
		elapsedTimerByCallId.clear();
		clearAgeRefresh();
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
		const rows = buildTurnDiffBlock(lastTurn);
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
			parameters: tidyMode === "result" ? tool.parameters : withReasoning(tool.parameters),
			promptGuidelines: tidyMode === "result" ? [] : [
				`Always pass a "reasoning" phrase to ${name}: state the GOAL/intent, not the file or command (those are shown already).`,
			],
			renderShell: "self",

			// Strip our injected `reasoning`, delegate to the real built-in. Writes
			// use per-call operations so the before-content is read inside Pi's file
			// mutation queue and can produce the same diff format as edit.
			execute: async (id: string, p: any, sig: any, up: any) => {
				const { rest } = stripReasoning(p);
				if (name !== "write") return tool.execute(id, rest, sig, up);

				let diff = "";
				const writeTool = createWriteTool(cwd, {
					operations: {
						mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }); },
						writeFile: async (path: string, content: string) => {
							let previous = "";
							try {
								previous = await readFile(path, "utf8");
							} catch (error: any) {
								if (error?.code !== "ENOENT") throw error;
							}
							await mkdir(dirname(path), { recursive: true });
							await writeFile(path, content, "utf8");
							diff = generateDiffString(previous, content).diff;
						},
					},
				});
				const result = await writeTool.execute(id, rest, sig, up);
				return { ...result, details: { ...(result.details ?? {}), diff } };
			},

			// The call slot owns the running block, so tools that never stream partial
			// results still appear immediately with a live elapsed timer.
			renderCall: (args: any, theme: any, context: any) => {
				if (!context?.isPartial) return new Container();
				const toolCallId = context.toolCallId as string;
				if (!elapsedTimerByCallId.has(toolCallId)) {
					const timer = setInterval(() => context.invalidate(), 1000);
					timer.unref?.();
					elapsedTimerByCallId.set(toolCallId, timer);
				}
				let startedAt = startedAtByCallId.get(toolCallId);
				if (startedAt === undefined) {
					startedAt = Date.now();
					startedAtByCallId.set(toolCallId, startedAt);
				}
				return new WidthAwareLines(
					() => buildToolBlock(name, args ?? {}, {}, {
						isPartial: true,
						elapsedMs: Date.now() - startedAt,
						mode: tidyMode,
					}),
					(text) => theme.bg("toolPendingBg", text),
				);
			},

			// The result slot stays empty for streaming partials to avoid duplicating
			// the running call block, then replaces it with the settled output.
			renderResult: (result: any, options: any, theme: any, context: any) => {
				if (options?.isPartial) return new Container();
				const isError = context?.isError ?? result?.isError ?? false;
				const toolCallId = context?.toolCallId as string | undefined;
				const startedAt = startedAtByCallId.get(toolCallId ?? "");
				const elapsedTimer = elapsedTimerByCallId.get(toolCallId ?? "");
				if (elapsedTimer) clearInterval(elapsedTimer);
				elapsedTimerByCallId.delete(toolCallId ?? "");
				startedAtByCallId.delete(toolCallId ?? "");
				const persistedElapsed = Number(result?.details?.piTidyElapsedMs);
				const elapsedMs = Number.isFinite(persistedElapsed)
					? persistedElapsed
					: startedAt === undefined ? 0 : Date.now() - startedAt;
				const persistedCompletedAt = Number(result?.details?.piTidyCompletedAt);
				const completedAt = Number.isFinite(persistedCompletedAt) ? persistedCompletedAt : undefined;
				if (toolCallId && completedAt !== undefined && typeof context?.invalidate === "function") {
					registerAgeRefresh(toolCallId, completedAt, () => context.invalidate());
				}
				const lines = () => buildToolBlock(name, context?.args ?? {}, result, {
					isError,
					expanded: options?.expanded ?? false,
					elapsedMs,
					completedAt,
					mode: tidyMode,
				});

				// Keep the self-rendered, zero-spacing layout while restoring only Pi's
				// native tool-state background across the full transcript width.
				const background = isError ? "toolErrorBg" : "toolSuccessBg";
				return new WidthAwareLines(lines, (text) => theme.bg(background, text));
			},
		});
	}
}
