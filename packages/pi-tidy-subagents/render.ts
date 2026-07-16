import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, YELLOW, fitLine, formatAge, formatCount, formatElapsed, style } from "./vendor/pi-tidy-core/index.js";
import type { ChildState, RunDetails } from "./types.js";

export interface ControlRenderArgs {
 action?: string;
 target?: string;
 message?: string;
 delivery?: string;
}

export interface ControlRenderResult {
 content?: Array<{ type: string; text?: string }>;
 details?: Record<string, unknown>;
}

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
  const backgroundMeta = child.ownership === "background"
   ? ` · ${child.deliveryPolicy ?? "auto"}${(child.pendingSteering ?? 0) > 0 ? ` · ↪${child.pendingSteering} steer` : ""}`
   : "";
  const statistics = `${DIM}→ ${child.toolCount ?? 0} tools · ${usageSummary(child)} · ${formatElapsed(elapsed)}${backgroundMeta}${RESET}`;
  const combined = `${identity} ${statistics}`;
  if (width !== undefined && visibleWidth(combined) <= width) lines.push(combined);
  else lines.push(identity, `${GUTTER}   ${statistics}`);
  // Settled prose is result detail, not card chrome. Keep live activity visible while
  // work is active, and retain interrupted tool truth after settlement; other terminal
  // detail requires expansion.
  const displayChild = terminalView(child);
  const activity = tail(displayChild);
  const entries = expanded
   ? activity.length > 0 ? expandedActivity(displayChild) : collapsedActivity(displayChild)
   : !settled
    ? collapsedActivity(displayChild)
    : collapsedActivity(displayChild).filter(isToolActivity);
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
function paintLines(lines: string[], width: number, background?: (text: string) => string): string[] {
 const max = Math.max(1, width);
 return lines.map((line) => {
  // Sibling separators stay unpainted so they read as real gaps between parallel tool cards.
  if (line.length === 0) return "";
  const fitted = fitDisplayLine(line, max); const padded = fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
  if (!background) return fitted;
  return padded.split(RESET).map((segment) => background(`${segment}${RESET}`)).join("");
 });
}

export function renderBackgroundAcknowledgementLines(child: ChildState): string[] {
 const identity = `${GUTTER} ${statusGlyph(child.status)} ${MAGENTA}🤖${RESET} ${BOLD}${child.label}[${child.model}|${child.thinking}]${RESET} ${child.reason}`;
 const delivery = child.deliveryPolicy ?? "auto";
 return [identity, `${GUTTER}   ${DIM}→ background · ${child.status} · delivery=${delivery} · ${child.target ?? child.id}${RESET}`, `${GUTTER}     ${DIM}artifact ${child.artifactPath}${RESET}`];
}

function controlText(result: ControlRenderResult | undefined): string {
 return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function controlChild(result: ControlRenderResult | undefined): ChildState | undefined {
 const child = result?.details?.child;
 return child && typeof child === "object" ? child as ChildState : undefined;
}

function controlCounts(result: ControlRenderResult | undefined): string {
 const details = result?.details;
 const count = (key: string): number => Array.isArray(details?.[key]) ? details[key].length : 0;
 return `${count("activeForeground")} foreground · ${count("activeBackground")} background · ${count("terminalUncollected")} uncollected`;
}

function controlSummary(args: ControlRenderArgs, result: ControlRenderResult | undefined, isPartial: boolean, isError: boolean): string {
 if (isPartial) return "running";
 const text = controlText(result).split("\n")[0]?.trim() || "done";
 if (isError) return text;
 const child = controlChild(result);
 const status = child?.status ?? "accepted";
 const ownership = child?.ownership ?? "foreground";
 const delivery = child?.deliveryPolicy ?? "none";
 switch (args.action) {
  case "status": return controlCounts(result);
  case "inspect": return `${status}/${ownership} · delivery ${delivery}`;
  case "background": return `${status}/background · delivery ${delivery}`;
  case "steer": return "steering accepted";
  case "cancel": return result?.details?.repeated ? `${status} · already terminal` : status;
  case "set_delivery": return `delivery ${delivery} · ${status}`;
  case "collect": {
   const collectionCount = Number(result?.details?.collectionCount);
   return `${status}${Number.isFinite(collectionCount) ? ` · collection ${collectionCount}` : ""}`;
  }
  default: return text;
 }
}

function controlDetailLines(result: ControlRenderResult | undefined): string[] {
 const lines = controlText(result).split("\n");
 if (lines.length === 1 && lines[0] === "") return [];
 const kept = lines.slice(0, 15);
 if (lines.length > kept.length) kept.push(`${DIM}… ${lines.length - kept.length} more lines${RESET}`);
 return kept;
}

export function renderControlLines(
 args: ControlRenderArgs = {},
 result?: ControlRenderResult,
 expanded = false,
 isPartial = false,
 isError = false,
): string[] {
 const child = controlChild(result);
 const target = child?.label || args.target?.trim();
 const action = args.action?.trim() || "control";
 const glyph = isPartial ? `${CYAN}${RUNNING_GLYPH}${RESET}` : isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
 const identity = `${GUTTER} ${glyph} ${MAGENTA}🤖${RESET} ${BOLD}control ${action}${RESET}${target ? ` ${target}` : ""}`;
 const summary = `${DIM}→ ${controlSummary(args, result, isPartial, isError)}${RESET}`;
 const lines = [`${identity} ${summary}`];
 if (expanded && !isPartial) {
  for (const line of controlDetailLines(result)) lines.push(`${GUTTER}     ${line}`);
 }
 return lines;
}

export class ControlSnapshotComponent {
 constructor(
  private args: ControlRenderArgs,
  private result: ControlRenderResult | undefined,
  private expanded: boolean,
  private isPartial: boolean,
  private isError: boolean,
  private background?: (text: string) => string,
 ) {}
 invalidate(): void {}
 render(width: number): string[] {
  return paintLines(renderControlLines(this.args, this.result, this.expanded, this.isPartial, this.isError), width, this.background);
 }
}

export class SnapshotComponent {
 constructor(private details: RunDetails | undefined, private expanded: boolean, private background?: (text: string) => string) {}
 invalidate(): void {}
 render(width: number): string[] {
  return paintLines(renderLines(this.details, this.expanded, Date.now(), Math.max(1, width)), width, this.background);
 }
}

/** Synchronous card renderer: detached children become settled acknowledgements and never retain live activity ownership. */
export class ToolSnapshotComponent {
 constructor(private details: RunDetails | undefined, private expanded: boolean, private background?: (text: string) => string) {}
 invalidate(): void {}
 render(width: number): string[] {
  if (!this.details) return [];
  const lines: string[] = [];
  for (const [index, child] of this.details.children.entries()) {
   if (index > 0) lines.push("");
   if (child.ownership === "background") lines.push(...renderBackgroundAcknowledgementLines(child));
   else lines.push(...renderLines({ ...this.details, children: [child] }, this.expanded, Date.now(), Math.max(1, width)));
  }
  return paintLines(lines, width, this.background);
 }
}
