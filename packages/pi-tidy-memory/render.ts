import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  BOLD,
  CYAN,
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  oneLine,
} from "./vendor/pi-tidy-core/index.js";
import { sanitizeTerminalText } from "./runtime.js";
import type { MemoryRecord } from "./types.js";

const GUTTER = `  ${DIM}┊${RESET}`;

export interface MemoryToolDetails {
  operation: "recall" | "retain" | "reflect";
  query?: string;
  memories?: MemoryRecord[];
  accepted?: number;
  deferred?: boolean;
  operationId?: string;
  reflectedText?: string;
}

function paint(
  lines: string[],
  width: number,
  background?: (text: string) => string
): string[] {
  const max = Math.max(1, width);
  return lines.map((line) => {
    const fitted =
      visibleWidth(line) <= max ? line : truncateToWidth(line, max, "…");
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
    return oneLine(sanitizeTerminalText(value)).slice(0, 80);
  }
  const value =
    typeof args.query === "string" ? args.query : (details?.query ?? "memory");
  return oneLine(sanitizeTerminalText(value)).slice(0, 80);
}

export function renderMemoryLines(
  operation: "recall" | "retain" | "reflect",
  args: Record<string, unknown>,
  details: MemoryToolDetails | undefined,
  expanded: boolean,
  isPartial: boolean,
  isError: boolean
): string[] {
  const glyph = isPartial
    ? `${CYAN}·${RESET}`
    : isError
      ? `${RED}✗${RESET}`
      : `${GREEN}✓${RESET}`;
  let summary = isPartial ? "working" : isError ? "failed" : "done";
  if (!isPartial && !isError && details) {
    if (operation === "recall")
      summary = `${details.memories?.length ?? 0} memories`;
    if (operation === "retain")
      summary = `${details.accepted ?? 0} accepted${details.deferred ? "; queued" : ""}`;
    if (operation === "reflect") summary = "synthesized";
  }
  const lines = [
    `${GUTTER} ${glyph} ${MAGENTA}🧠${RESET} ${BOLD}${operation}${RESET} ${target(operation, args, details)} ${DIM}→ ${summary}${RESET}`,
  ];
  if (expanded && details) {
    if (details.memories) {
      for (const item of details.memories.slice(0, 20)) {
        lines.push(
          `${GUTTER}     ${DIM}${item.kind ? `[${sanitizeTerminalText(item.kind)}] ` : ""}${oneLine(sanitizeTerminalText(item.text))}${RESET}`
        );
      }
    }
    if (details.reflectedText) {
      for (const line of sanitizeTerminalText(details.reflectedText)
        .split("\n")
        .slice(0, 30))
        lines.push(`${GUTTER}     ${line}`);
    }
    if (details.operationId)
      lines.push(
        `${GUTTER}     ${DIM}operation ${sanitizeTerminalText(details.operationId)}${RESET}`
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
