import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, YELLOW, fitLine, formatCount, formatElapsed, style } from "./vendor/pi-tidy-core/index.js";
import type { ChildState, RunDetails } from "./types.js";

const GUTTER = `${DIM}  ┊${RESET}`;
const ansiPattern = /\x1b\[[0-9;]*m/g;
const RUNNING_GLYPH = "●";
function formatTokens(count: number): string {
 if (count < 1_000) return String(count);
 if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
 if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
 if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
 return `${Math.round(count / 1_000_000)}M`;
}
function usageSummary(child: ChildState): string {
 if (typeof child.input === "number" && typeof child.output === "number") return `↑${formatTokens(child.input)} ↓${formatTokens(child.output)}`;
 return `${formatCount(child.tokens ?? 0)} tok`;
}
const statusGlyph = (status: ChildState["status"]): string => {
 switch (status) {
  case "queued": return `${DIM}○${RESET}`;
  case "starting": case "running": return `${CYAN}${RUNNING_GLYPH}${RESET}`;
  case "completed": return `${GREEN}✓${RESET}`;
  case "warning": return `${YELLOW}!${RESET}`;
  case "failed": return `${RED}✗${RESET}`;
  case "cancelled": return `${YELLOW}■${RESET}`;
  case "not-started": return `${DIM}○${RESET}`;
 }
};
function tail(child: ChildState): string[] {
 const activities = child.activities ?? [];
 return child.streamingLine?.trim() ? [...activities, child.streamingLine] : activities;
}
function isToolFirstLine(line: string): boolean {
 return line.startsWith(`${DIM}·`) || line.startsWith(`${GREEN}✓`) || line.startsWith(`${RED}✗`);
}
function isToolSecondLine(line: string): boolean { return line.startsWith(`  ${DIM}`); }
function collapsedActivity(child: ChildState): string[] {
 const activeTools = child.activeTools ?? [];
 if (activeTools.length > 1) {
  const counts = new Map<string, number>();
  for (const tool of activeTools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [
   `${CYAN}${RUNNING_GLYPH}${RESET} ${MAGENTA}◆ ${BOLD}parallel${RESET} ${activeTools.length} tools running`,
   `  ${[...counts].map(([name, count]) => { const tool = style(name); return `${tool.color}${tool.icon} ${BOLD}${name}${RESET} ×${count}`; }).join(` ${DIM}·${RESET} `)}`,
  ];
 }
 if (activeTools.length === 1) {
  const index = activeTools[0]!.activityIndex;
  return child.activities.slice(index, index + 2);
 }
 const activity = tail(child);
 if (activity.length > 0) {
  const last = activity.length - 1;
  if (isToolSecondLine(activity[last]!) && last > 0 && isToolFirstLine(activity[last - 1]!)) return activity.slice(last - 1);
  const text: string[] = [];
  for (let index = last; index >= 0 && text.length < 2; index--) {
   if (!isToolFirstLine(activity[index]!) && !isToolSecondLine(activity[index]!)) text.unshift(activity[index]!);
  }
  return text.length > 0 ? text : activity.slice(-2);
 }
 if (child.status === "queued") return ["queued"];
 if (child.status === "starting" || child.status === "running") return ["waiting for model"];
 return [child.error || (child.status === "completed" ? "completed" : child.status)];
}
function isToolActivity(line: string): boolean {
 const plain = line.replace(ansiPattern, "");
 return isToolFirstLine(line) || isToolSecondLine(line) || /^● /.test(plain);
}
function expandedActivity(child: ChildState): string[] {
 const entries = tail(child).slice(-15);
 if (entries.length > 0 && isToolSecondLine(entries[0]!)) entries.shift();
 return entries;
}
export function renderLines(details: RunDetails | undefined, expanded = false, now = Date.now(), width?: number): string[] {
 if (!details) return [];
 const lines: string[] = [];
 for (const child of details.children) {
  const elapsed = child.startedAt ? (child.endedAt ?? now) - child.startedAt : 0;
  const identity = `${GUTTER} ${statusGlyph(child.status)} ${MAGENTA}🤖${RESET} ${BOLD}${child.label}[${child.model}|${child.thinking}]${RESET} ${child.reason}`;
  const statistics = `${DIM}→ ${child.toolCount ?? 0} tools · ${usageSummary(child)} · ${formatElapsed(elapsed)}${RESET}`;
  const combined = `${identity} ${statistics}`;
  if (width !== undefined && visibleWidth(combined) <= width) lines.push(combined);
  else lines.push(identity, `${GUTTER}   ${statistics}`);
  const activity = tail(child);
  const entries = expanded && activity.length > 0 ? expandedActivity(child) : collapsedActivity(child);
  for (const entry of entries) lines.push(`${GUTTER}${isToolActivity(entry) ? "   " : "     "}${entry}`);
 }
 return lines;
}
function fitDisplayLine(line: string, width: number): string {
 const marker = `${DIM}→ `;
 const markerIndex = line.indexOf(marker);
 if (markerIndex < 0 || visibleWidth(line) <= width) return fitLine(line, width);
 const tail = line.slice(markerIndex);
 const tailWidth = visibleWidth(tail);
 if (tailWidth >= width) return fitLine(tail, width);
 const head = line.slice(0, markerIndex).trimEnd();
 return `${truncateToWidth(head, width - tailWidth - 1, "…")} ${tail}`;
}
export class SnapshotComponent {
 constructor(private details: RunDetails | undefined, private expanded: boolean, private background?: (text: string) => string) {}
 invalidate(): void {}
 render(width: number): string[] {
  const max = Math.max(1, width);
  return renderLines(this.details, this.expanded, Date.now(), max).map((line) => {
   const fitted = fitDisplayLine(line, max); const padded = fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
   if (!this.background) return fitted;
   return padded.split(RESET).map((segment) => this.background!(`${segment}${RESET}`)).join("");
  });
 }
}
