import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  BOLD,
  CYAN,
  DIM,
  MAGENTA,
  RESET,
  oneLine,
} from "./vendor/pi-tidy-core/index.js";
import { redactObviousCredentials, sanitizeTerminalText } from "./runtime.js";
import type { MemoryRecord } from "./types.js";

export const MEMORY_REASONING_MAX_LENGTH = 64;
export const MEMORY_REASONING_PATTERN =
  "^(?!.*\\.)[^\\s\\u0000-\\u001F\\u007F]+(?: [^\\s\\u0000-\\u001F\\u007F]+){0,11}$";

export interface MemoryToolDetails {
  operation: "recall" | "retain" | "reflect";
  query?: string;
  memories?: MemoryRecord[];
  accepted?: number;
  deferred?: boolean;
  operationId?: string;
  reflectedText?: string;
  error?: string;
}

function displayText(value: string): string {
  return redactObviousCredentials(sanitizeTerminalText(value));
}

function fitOutcomeLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  const marker = `${DIM}→ `;
  const markerAt = line.lastIndexOf(marker);
  if (markerAt < 0) return truncateToWidth(line, width, "…");

  const prefix = line.slice(0, markerAt).trimEnd();
  const outcome = line.slice(markerAt);
  const outcomeWidth = visibleWidth(outcome);
  const prefixBudget = width - outcomeWidth - 1;
  if (prefixBudget < 2) return truncateToWidth(outcome, width, "…");
  return `${truncateToWidth(prefix, prefixBudget, "…")} ${outcome}`;
}

function paint(
  lines: string[],
  width: number,
  background?: (text: string) => string
): string[] {
  const max = Math.max(1, width);
  return lines.map((line, index) => {
    const fitted =
      index === 1
        ? fitOutcomeLine(line, max)
        : visibleWidth(line) <= max
          ? line
          : truncateToWidth(line, max, "…");
    if (!background) return fitted;
    const padded = `${fitted}${" ".repeat(Math.max(0, max - visibleWidth(fitted)))}`;
    return padded
      .split(RESET)
      .map((segment) => background(`${segment}${RESET}`))
      .join("");
  });
}

function target(
  operation: string,
  args: Record<string, unknown>,
  details?: MemoryToolDetails
): string {
  if (operation === "retain") {
    const value = typeof args.content === "string" ? args.content : "memory";
    return oneLine(displayText(value)).slice(0, 80);
  }
  const value =
    typeof args.query === "string" ? args.query : (details?.query ?? "memory");
  return oneLine(displayText(value)).slice(0, 80);
}

function rationale(args: Record<string, unknown>, fallback: string): string {
  const value =
    typeof args.reasoning === "string"
      ? oneLine(displayText(args.reasoning))
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 12)
          .join(" ")
          .replaceAll(".", "")
          .slice(0, MEMORY_REASONING_MAX_LENGTH)
          .trim()
      : "";
  return value || fallback;
}

export function renderMemoryLines(
  operation: "recall" | "retain" | "reflect",
  args: Record<string, unknown>,
  details: MemoryToolDetails | undefined,
  expanded: boolean,
  isPartial: boolean,
  isError: boolean
): string[] {
  const liveMark = isPartial ? `${CYAN}·${RESET} ` : "";
  let summary = isPartial
    ? "working"
    : isError
      ? oneLine(
          displayText(details?.error ?? "failed").split(/\r?\n/, 1)[0] ??
            "failed"
        ).slice(0, 160)
      : "done";
  if (!isPartial && !isError && details) {
    if (operation === "recall") {
      const count = details.memories?.length ?? 0;
      summary = `${count} ${count === 1 ? "memory" : "memories"}`;
    }
    if (operation === "retain")
      summary = `${details.accepted ?? 0} accepted${details.deferred ? "; queued" : ""}`;
    if (operation === "reflect") summary = "synthesized";
  }
  const operationTarget = target(operation, args, details);
  const operationRationale = rationale(args, operationTarget);
  const resultTarget =
    operationRationale === operationTarget ? "" : `${operationTarget} `;
  const lines = [
    `${liveMark}${MAGENTA}🧠${RESET} ${BOLD}${operation}${RESET} ${operationRationale}`,
    `  ${resultTarget}${DIM}→ ${summary}${RESET}`,
  ];
  if (expanded && details) {
    if (details.memories) {
      for (const item of details.memories.slice(0, 20)) {
        lines.push(
          `    ${DIM}${item.kind ? `[${displayText(item.kind)}] ` : ""}${oneLine(displayText(item.text))}${RESET}`
        );
      }
    }
    if (details.reflectedText) {
      for (const line of displayText(details.reflectedText)
        .split("\n")
        .slice(0, 30))
        lines.push(`    ${line}`);
    }
    if (details.operationId)
      lines.push(
        `    ${DIM}operation ${displayText(details.operationId)}${RESET}`
      );
  }
  return lines;
}

export class MemoryToolComponent {
  constructor(
    private readonly operation: "recall" | "retain" | "reflect",
    private readonly args: Record<string, unknown>,
    private readonly details: MemoryToolDetails | undefined,
    private readonly expanded: boolean,
    private readonly isPartial: boolean,
    private readonly isError: boolean,
    private readonly background?: (text: string) => string
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return paint(
      renderMemoryLines(
        this.operation,
        this.args,
        this.details,
        this.expanded,
        this.isPartial,
        this.isError
      ),
      width,
      this.background
    );
  }
}
