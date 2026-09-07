/**
 * block-render.ts — the tight tool-block renderer for pi-tidy-tools.
 *
 * Pure, stateless rendering kernel extracted from index.ts (issue 185):
 * builds the 2-line tool blocks, the /diff recap block, and the width-aware
 * component that fits pre-composed lines to the live viewport. No extension
 * plumbing, no state — only rendering.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  BOLD,
  CYAN,
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  grepResultCounts,
  nonEmptyLineCount,
  shortPath,
  style,
} from "./render.js";
import { stripReasoning } from "./tool-composition.js";
import type { TidyMode } from "./config.js";

/** Hanging indent for detail and expanded continuation lines. */
const INDENT = "  ";

/** Collapse whitespace/newlines to one line (width-based truncation happens at render). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Fit a rendered line while preserving its useful result tail. */
export function fitToolLine(line: string, width: number): string {
  const max = Math.max(1, width);
  if (visibleWidth(line) <= max) return line;
  const arrowIndex = line.indexOf("→");
  if (arrowIndex < 0) return truncateToWidth(line, max, "…");

  const tail = line.slice(arrowIndex);
  const tailWidth = visibleWidth(tail);
  if (tailWidth >= max) return truncateToWidth(tail, max, "…");
  const head = line.slice(0, arrowIndex).trimEnd();
  return `${truncateToWidth(head, max - tailWidth - 1, "…")} ${tail}`;
}

/**
 * A width-aware component: truncates each pre-composed (ANSI-colored) line to the
 * live viewport width so nothing soft-wraps. Re-flows on resize
 * because render(width) is re-invoked by the TUI.
 *
 * Static sources are settled, immutable blocks, so their fitted lines are
 * cached per width: the TUI re-invokes render() on every frame, and without
 * the cache every settled block in the transcript re-fits its lines on every
 * keystroke — frame cost grows with the session's total tool calls. Function
 * sources (running calls with ticking elapsed time) are never cached.
 */
export class WidthAwareLines {
  private cache?: { width: number; lines: string[] };

  constructor(
    private readonly source: string[] | (() => string[]),
    private readonly background?: (text: string) => string
  ) {}
  invalidate(): void {
    this.cache = undefined;
  }
  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const max = Math.max(1, width);
    const lines =
      typeof this.source === "function" ? this.source() : this.source;
    const rendered = lines.map((line) => {
      const fitted = fitToolLine(line, max);
      if (!this.background) return fitted;
      const padded =
        fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
      // Raw foreground styling uses RESET, which also clears an enclosing
      // background. Apply the background independently to every reset-delimited
      // segment so it remains continuous through the full padded line.
      return padded
        .split(RESET)
        .map((segment) => this.background!(`${segment}${RESET}`))
        .join("");
    });
    if (typeof this.source !== "function")
      this.cache = { width, lines: rendered };
    return rendered;
  }
}

/** Dim line-2 detail when the model gave no `reasoning`. Always ONE line. */
function argDetail(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string")
    return oneLine(args.command);
  if (
    (name === "grep" || name === "find") &&
    typeof args.pattern === "string"
  ) {
    return oneLine(
      typeof args.path === "string"
        ? `${args.pattern} in ${args.path}`
        : String(args.pattern)
    );
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
  if (minutes < 60)
    return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Colored result summary from a finished tool result. */
function summarize(
  name: string,
  result: any,
  isError: boolean,
  args: Record<string, unknown> = {},
  elapsedMs = 0
): string {
  const text = textFromResult(result);
  if (isError) {
    if (name === "bash")
      return `${RED}error${RESET} ${DIM}in ${formatElapsed(elapsedMs)}${RESET}`;
    return `${RED}${text.split("\n")[0] || "error"}${RESET}`;
  }
  if (name === "read")
    return `${GREEN}${text.split("\n").length} lines${RESET}`;
  if (name === "write") {
    if (typeof args.content === "string" && !args.content.includes("\0")) {
      const lines =
        args.content.length === 0
          ? 0
          : (args.content.match(/\n/g)?.length ?? 0) +
            (args.content.endsWith("\n") ? 0 : 1);
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
    const { matches: count, files } = grepResultCounts(text);
    const matchLabel = count === 1 ? "match" : "matches";
    const fileLabel = files === 1 ? "file" : "files";
    return `${GREEN}${count} ${matchLabel}${RESET} ${DIM}in${RESET} ${CYAN}${files} ${fileLabel}${RESET}`;
  }
  const count = nonEmptyLineCount(text);
  const noun =
    name === "find" ? "files" : name === "ls" ? "entries" : "results";
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
  return numbered
    ? `${numbered[1]}${expandTabs(numbered[2])}`
    : expandTabs(line);
}

/** Colorize a unified/line-numbered diff string (edit tool's details.diff). */
function colorizeDiff(diff: string): string[] {
  return diff.split("\n").map((rawLine) => {
    const line = expandDiffTabs(rawLine);
    if (line.startsWith("+") && !line.startsWith("+++"))
      return `${GREEN}${line}${RESET}`;
    if (line.startsWith("-") && !line.startsWith("---"))
      return `${RED}${line}${RESET}`;
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
function renderTurnDiffs(diffs: TurnDiff[], icons = true): string[] {
  const lines: string[] = [];
  diffs.forEach((d, i) => {
    if (i > 0) lines.push("");
    const { icon, color } = style(d.tool);
    lines.push(
      `${color}${icons ? `${icon} ` : ""}${BOLD}${shortPath(d.path)}${RESET}`
    );
    if (d.diff.trim()) lines.push(...colorizeDiff(d.diff.replace(/\s+$/, "")));
    else lines.push(`${DIM}(new file / full overwrite — no line diff)${RESET}`);
  });
  return lines;
}

/** Full `/diff` recap block — same lines the command posts into the transcript. */
export function buildTurnDiffBlock(
  diffs: TurnDiff[],
  opts: { icons?: boolean } = {}
): string[] {
  const { icons = true } = opts;
  const n = diffs.length;
  const header = `${MAGENTA}${icons ? "◆ " : ""}${BOLD}last turn diff${RESET} ${DIM}(${n} file${n === 1 ? "" : "s"})${RESET}`;
  return [header, ...renderTurnDiffs(diffs, icons)];
}

/**
 * Build the expanded (C-o) continuation lines for a settled tool result:
 *   - bash: the full multi-line command input, then its output
 *   - edit/write: the colored line-numbered diff when present
 *   - otherwise: the raw result text
 * Each line is prefixed with the hanging INDENT.
 */
function expandedLines(
  name: string,
  args: Record<string, unknown>,
  result: any
): string[] {
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
    const contentLines = args.content.endsWith("\n")
      ? splitLines.slice(0, -1)
      : splitLines;
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
  if (text)
    for (const raw of text.split("\n"))
      out.push(`${INDENT}${DIM}${raw}${RESET}`);
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
  opts: {
    isError?: boolean;
    isPartial?: boolean;
    expanded?: boolean;
    elapsedMs?: number;
    mode?: TidyMode;
    icons?: boolean;
  } = {}
): string[] {
  const {
    isError = false,
    isPartial = false,
    expanded = false,
    elapsedMs = 0,
    mode = "default",
    icons = true,
  } = opts;
  const { reasoning, rest } = stripReasoning(args ?? {});

  // Settled success/error is already encoded by Pi's native row background.
  // Only running calls need an inline state mark.
  const runningPrefix = isPartial ? `${DIM}·${RESET} ` : "";
  const summary = isPartial
    ? `${DIM}${formatElapsed(elapsedMs)}${RESET}`
    : summarize(name, result, isError, rest, elapsedMs);

  const { icon, color } = style(name);
  const toolLabel = `${color}${icons ? `${icon} ` : ""}${BOLD}${name}${RESET}`;
  const headline = oneLine(reasoning || argDetail(name, rest));
  const detail = argDetail(name, rest);
  // Keep the target on failures too; width fitting preserves the useful error
  // tail while the command/path answers what actually failed.
  const line2 = !detail
    ? `${INDENT}${DIM}→${RESET} ${summary}`
    : `${INDENT}${DIM}${detail}${RESET} ${DIM}→${RESET} ${summary}`;
  let lines: string[];
  if (mode === "reasoning") {
    lines = [
      `${runningPrefix}${toolLabel} ${headline} ${DIM}→${RESET} ${summary}`,
    ];
  } else if (mode === "result") {
    const resultDetail = !detail ? "" : ` ${DIM}${detail}${RESET}`;
    lines = [
      `${runningPrefix}${toolLabel}${resultDetail} ${DIM}→${RESET} ${summary}`,
    ];
  } else {
    lines = [`${runningPrefix}${toolLabel} ${headline}`, line2];
  }
  if (expanded && !isPartial) lines.push(...expandedLines(name, rest, result));
  return lines;
}
