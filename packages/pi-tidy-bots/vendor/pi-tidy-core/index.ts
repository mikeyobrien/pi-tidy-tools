import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const CYAN = "\x1b[36m";
export const YELLOW = "\x1b[33m";
export const MAGENTA = "\x1b[35m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

export function style(name: string): { icon: string; color: string } {
  if (["read", "grep", "find", "ls"].includes(name)) return { icon: "📖", color: CYAN };
  if (["write", "edit"].includes(name)) return { icon: "✏️", color: YELLOW };
  if (name === "bash") return { icon: "⚡", color: MAGENTA };
  return { icon: "◆", color: MAGENTA };
}
export function nonEmptyLineCount(value: string): number { return value.trim().split("\n").filter(Boolean).length; }
const HOME = homedir();
export function shortPath(path: string): string {
  if (!path) return "";
  return path === HOME || path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}
export function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim(); }
export function fitLine(line: string, width: number): string {
  return visibleWidth(line) <= Math.max(1, width) ? line : truncateToWidth(line, Math.max(1, width), "…");
}
export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(value < 10_000 ? 1 : 0))}k`;
  return `${Number((value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0))}m`;
}
export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return "<1s";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}
/** Compact age using at most the two largest useful units. */
export function formatAge(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months}mo${days % 30 ? `${days % 30}d` : ""}`;
  }
  const years = Math.floor(days / 365);
  const remainingMonths = Math.floor((days % 365) / 30);
  return `${years}y${remainingMonths ? `${remainingMonths}mo` : ""}`;
}
export function describeTool(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") return oneLine(args.command);
  if ((name === "grep" || name === "find") && typeof args.pattern === "string") return oneLine(typeof args.path === "string" ? `${args.pattern} in ${args.path}` : args.pattern);
  if (typeof args.path === "string") return oneLine(args.path);
  if (typeof args.name === "string") return oneLine(args.name);
  const keys = Object.keys(args);
  return keys.length ? `${name} (${keys.join(", ")})` : name;
}
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return content?.find((part) => part?.type === "text")?.text ?? "";
}
function errorSummary(result: unknown): string {
  const value = result as { error?: unknown; message?: unknown; details?: { error?: unknown } } | undefined;
  const text = resultText(result) || (typeof value?.error === "string" ? value.error : "") || (typeof value?.message === "string" ? value.message : "") || (typeof value?.details?.error === "string" ? value.details.error : "");
  return text.split("\n")[0] || "error";
}
function resultSummary(name: string, args: Record<string, unknown>, result: unknown, elapsedMs: number): string {
  const text = resultText(result);
  if (name === "read") return `${text.split("\n").length} lines`;
  if (name === "write" && typeof args.content === "string") {
    const lines = args.content.length === 0 ? 0 : (args.content.match(/\n/g)?.length ?? 0) + (args.content.endsWith("\n") ? 0 : 1);
    return `${lines} ${lines === 1 ? "line" : "lines"}`;
  }
  if (name === "edit") {
    const diff = (result as { details?: { diff?: string } } | undefined)?.details?.diff ?? "";
    let additions = 0, deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return diff ? `+${additions}/-${deletions}` : "applied";
  }
  if (name === "bash") return `done in ${formatElapsed(elapsedMs)}`;
  if (name === "grep") {
    const matchLines = text.trim().startsWith("No matches found") ? [] : text.split("\n").map((line) => line.match(/^(.+):\d+:/)).filter((match): match is RegExpMatchArray => match !== null);
    const files = new Set(matchLines.map((match) => match[1])).size;
    return `${matchLines.length} ${matchLines.length === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`;
  }
  if (name === "find" || name === "ls") {
    const count = nonEmptyLineCount(text);
    const noun = name === "find" ? (count === 1 ? "file" : "files") : (count === 1 ? "entry" : "entries");
    return `${count} ${noun}`;
  }
  return "done";
}
export function summarizeToolActivity(
  name: string,
  args: Record<string, unknown>,
  state: "running" | "success" | "error",
  result?: unknown,
  elapsedMs = 0,
): string {
  const glyph = state === "running" ? "·" : state === "success" ? "✓" : "✗";
  const target = describeTool(name, args);
  const summary = state === "running" ? "" : ` → ${state === "error" ? (name === "bash" ? `error in ${formatElapsed(elapsedMs)}` : errorSummary(result)) : resultSummary(name, args, result, elapsedMs)}`;
  return `${glyph} ${name}${target && target !== name ? ` ${target}` : ""}${summary}`;
}

export function buildToolActivityBlock(
  name: string,
  args: Record<string, unknown>,
  state: "running" | "success" | "error",
  result?: unknown,
  elapsedMs = 0,
): [string, string] {
  const { reasoning, ...toolArgs } = args;
  const target = describeTool(name, toolArgs);
  const headline = oneLine(typeof reasoning === "string" && reasoning.trim() ? reasoning : target);
  const mark = state === "running" ? `${DIM}·${RESET}` : state === "success" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const toolStyle = style(name);
  const summary = state === "running"
    ? `${DIM}running${RESET}`
    : state === "error"
      ? name === "bash" ? `${RED}error${RESET} ${DIM}in ${formatElapsed(elapsedMs)}${RESET}` : `${RED}${errorSummary(result)}${RESET}`
      : `${GREEN}${resultSummary(name, toolArgs, result, elapsedMs)}${RESET}`;
  return [
    `${mark} ${toolStyle.color}${toolStyle.icon} ${BOLD}${name}${RESET}${headline ? ` ${headline}` : ""}`,
    `  ${target ? `${DIM}${target}${RESET} ${DIM}→${RESET} ` : `${DIM}→${RESET} `}${summary}`,
  ];
}
