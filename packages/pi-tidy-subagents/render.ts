import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, YELLOW, fitLine, formatAge, formatCount, formatElapsed, style } from "./vendor/pi-tidy-core/index.js";
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
function terminalView(child: ChildState): ChildState {
 if (["queued", "starting", "running"].includes(child.status)) return child;
 const activities = [...(child.activities ?? [])];
 const indexes = new Set((child.activeTools ?? []).map((tool) => tool.activityIndex));
 for (let index = 0; index < activities.length - 1; index++) {
  if (activities[index]?.startsWith(`${DIM}·${RESET}`) && activities[index + 1]?.includes(`${DIM}running${RESET}`)) indexes.add(index);
 }
 for (const index of indexes) {
  const first = activities[index];
  const second = activities[index + 1];
  if (first?.startsWith(`${DIM}·${RESET}`)) activities[index] = `${RED}✗${RESET}${first.slice(`${DIM}·${RESET}`.length)}`;
  if (second) activities[index + 1] = second.replace(`${DIM}running${RESET}`, `${RED}interrupted${RESET}`);
 }
 return indexes.size > 0 || (child.activeTools?.length ?? 0) > 0 ? { ...child, activities, activeTools: [] } : child;
}
export function renderLines(details: RunDetails | undefined, expanded = false, now = Date.now(), width?: number): string[] {
 if (!details) return [];
 const lines: string[] = [];
 for (const [index, child] of details.children.entries()) {
  // Multi-child fan-out mirrors parallel tool cards: one blank between siblings.
  if (index > 0) lines.push("");
  const elapsed = child.startedAt ? (child.endedAt ?? now) - child.startedAt : 0;
  const settled = !["queued", "starting", "running"].includes(child.status);
  const age = settled && Number.isFinite(child.endedAt)
   ? ` ${DIM}(${formatAge(now - child.endedAt!)} ago)${RESET}`
   : "";
  const identity = `${GUTTER} ${statusGlyph(child.status)} ${MAGENTA}🤖${RESET} ${BOLD}${child.label}[${child.model}|${child.thinking}]${RESET} ${child.reason}${age}`;
  const statistics = `${DIM}→ ${child.toolCount ?? 0} tools · ${usageSummary(child)} · ${formatElapsed(elapsed)}${RESET}`;
  const combined = `${identity} ${statistics}`;
  if (width !== undefined && visibleWidth(combined) <= width) lines.push(combined);
  else lines.push(identity, `${GUTTER}   ${statistics}`);
  const displayChild = terminalView(child);
  const activity = tail(displayChild);
  const entries = expanded && activity.length > 0 ? expandedActivity(displayChild) : collapsedActivity(displayChild);
  for (const entry of entries) lines.push(`${GUTTER}${isToolActivity(entry) ? "   " : "     "}${entry}`);
 }
 return lines;
}
function fitDisplayLine(line: string, width: number): string {
 if (visibleWidth(line) <= width) return line;
 const arrowIndex = line.indexOf(`${DIM}→ `);
 const ageIndex = line.lastIndexOf(`${DIM}(`);
 let tailIndex = ageIndex >= 0 && (arrowIndex < 0 || ageIndex < arrowIndex) ? ageIndex : arrowIndex;
 if (tailIndex < 0) return fitLine(line, width);
 let tail = line.slice(tailIndex);
 let tailWidth = visibleWidth(tail);
 // Metrics remain more useful than age when both cannot physically fit.
 if (tailWidth >= width && arrowIndex >= 0 && tailIndex !== arrowIndex) {
  tailIndex = arrowIndex; tail = line.slice(tailIndex); tailWidth = visibleWidth(tail);
 }
 if (tailWidth >= width) return fitLine(tail, width);
 const head = line.slice(0, tailIndex).trimEnd();
 return `${truncateToWidth(head, width - tailWidth - 1, "…")} ${tail}`;
}
export class SnapshotComponent {
 constructor(private details: RunDetails | undefined, private expanded: boolean, private background?: (text: string) => string) {}
 invalidate(): void {}
 render(width: number): string[] {
  const max = Math.max(1, width);
  return renderLines(this.details, this.expanded, Date.now(), max).map((line) => {
   // Sibling separators stay unpainted so they read as real gaps between parallel tool cards.
   if (line.length === 0) return "";
   const fitted = fitDisplayLine(line, max); const padded = fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
   if (!this.background) return fitted;
   return padded.split(RESET).map((segment) => this.background!(`${segment}${RESET}`)).join("");
  });
 }
}
