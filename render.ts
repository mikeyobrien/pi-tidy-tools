/**
 * Shared palette + helpers for pi-tidy-tools. Raw ANSI is intentional so the
 * look is identical across terminal themes.
 */

import { homedir } from "node:os";

export const CYAN = "\x1b[36m";
export const YELLOW = "\x1b[33m";
export const MAGENTA = "\x1b[35m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

/** icon + color per tool. */
export function style(name: string): { icon: string; color: string } {
	if (name === "read" || name === "grep" || name === "find" || name === "ls") return { icon: "📖", color: CYAN };
	if (name === "write" || name === "edit") return { icon: "✏️", color: YELLOW };
	if (name === "bash") return { icon: "⚡", color: MAGENTA };
	return { icon: "◆", color: MAGENTA };
}

export function nonEmptyLineCount(s: string): number {
	return s.trim().split("\n").filter(Boolean).length;
}
const HOME = homedir();
/** Collapse the home prefix to ~ for readability. */
export function shortPath(p: string): string {
	if (!p) return "";
	return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
