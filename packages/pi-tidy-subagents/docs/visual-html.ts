import { ToolSnapshotComponent } from "../render.js";
import { BackgroundStampComponent, BackgroundWidgetComponent, ManagementOverlay, managementItems } from "../ui.js";
import { buildToolActivityBlock } from "../vendor/pi-tidy-core/index.js";
import type { ChildState, RunDetails } from "../types.js";

const colors: Record<string, string> = { "31": "#f7768e", "32": "#9ece6a", "33": "#e0af68", "35": "#bb9af7", "36": "#7dcfff" };
function ansi(value: string): string {
 let open = 0, out = "", last = 0;
 const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
 const re = /\x1b\[([0-9;]*)m/g;
 let match;
 while ((match = re.exec(value))) {
  out += esc(value.slice(last, match.index)); last = re.lastIndex;
  for (const code of match[1].split(";").filter(Boolean).length ? match[1].split(";") : ["0"]) {
   if (code === "0") { while (open--) out += "</span>"; open = 0; }
   else { out += `<span style="${code === "1" ? "font-weight:700" : code === "2" ? "opacity:.55" : `color:${colors[code] ?? "#c0caf5"}`}\">`; open++; }
  }
 }
 out += esc(value.slice(last)); while (open--) out += "</span>"; return out;
}
function paint(lines: string[], bg: string): string {
 return lines.map((line) => line.length === 0 ? `<div class="gap"></div>` : `<div class="row" style="background:${bg}">${ansi(line)}</div>`).join("");
}
const theme: any = {
 fg(name: string, text: string) {
  const code = name === "error" ? 31 : name === "success" ? 32 : name === "warning" ? 33 : name === "accent" || name === "customMessageText" ? 35 : name === "muted" || name === "dim" ? 2 : 36;
  return `\x1b[${code}m${text}\x1b[0m`;
 },
 bg(_name: string, text: string) { return text; },
 bold(text: string) { return `\x1b[1m${text}\x1b[0m`; },
};
const now = Date.now();
function child(index: number, status: ChildState["status"], label: string, reason: string, overrides: Partial<ChildState> = {}): ChildState {
 const active = ["queued", "starting", "running"].includes(status);
 const endedAt = now - 180_000;
 const input = status === "queued" ? 0 : index * 1234, output = status === "queued" ? 0 : index * 169;
 return {
  index, id: `child-${String(index).padStart(3, "0")}`, target: `2026-demo:child-${String(index).padStart(3, "0")}`,
  label, reason, prompt: "", status, model: "sonnet-4", thinking: "high", toolCount: status === "queued" ? 0 : index,
  input, output, cacheRead: 0, cacheWrite: 0, providerTraffic: input + output, tokens: input + output,
  activities: [], activeTools: [], eventCount: 0, response: "", artifactPath: `/agent/pi-tidy-subagents/runs/2026-demo/child-${String(index).padStart(3, "0")}.md`,
  ...(active && status !== "queued" ? { startedAt: now - index * 10_000 } : {}),
  ...(!active ? { startedAt: endedAt - index * 10_000, endedAt } : {}),
  ...overrides,
 };
}
const readRunning = buildToolActivityBlock("read", { path: "src/coordinator.ts", reasoning: "inspect session ownership" }, "running");
const grepRunning = buildToolActivityBlock("grep", { pattern: "deliveryState", path: "src", reasoning: "trace completion delivery" }, "running");
const foreground = child(1, "completed", "needed", "return required analysis", { activities: ["Returned the ordered foreground result"] });
const detached = child(2, "running", "handoff", "continue long diagnosis", { requestedExecution: "foreground", ownership: "background", ownershipReason: "agent-control", deliveryPolicy: "auto", deliveryState: "pending", activities: readRunning });
const cardDetails: RunDetails = { schemaVersion: 3, runId: "2026-demo", runDir: "", cwd: "/repo", createdAt: "", cap: 2, runtime: { provider: "anthropic", modelId: "sonnet-4", model: "anthropic/sonnet-4", thinking: "high", activeTools: ["read", "grep"], projectTrusted: true }, children: [foreground, detached] };

const queued = child(3, "queued", "queued-bg", "wait for shared capacity", { requestedExecution: "background", ownership: "background", ownershipReason: "direct-launch", deliveryPolicy: "auto", deliveryState: "pending" });
const runningAuto = child(4, "running", "research", "map background lifecycle", { requestedExecution: "background", ownership: "background", ownershipReason: "direct-launch", deliveryPolicy: "auto", deliveryState: "pending", pendingSteering: 2, activities: [...readRunning, ...grepRunning], activeTools: [{ id: "read", name: "read", activityIndex: 0 }, { id: "grep", name: "grep", activityIndex: 2 }] });
const runningManual = child(5, "running", "audit", "hold completion for collection", { requestedExecution: "background", ownership: "background", ownershipReason: "direct-launch", deliveryPolicy: "manual", deliveryState: "manual", activities: ["Reviewing persisted transitions"] });
const widgetChildren = [queued, runningAuto, runningManual];

const success = child(6, "completed", "success", "finish delegated research", { requestedExecution: "background", ownership: "background", terminalOwnership: "background", deliveryPolicy: "auto", deliveryState: "accepted", response: "Background research completed." });
const failure = child(7, "failed", "failure", "surface provider failure", { requestedExecution: "background", ownership: "background", terminalOwnership: "background", deliveryPolicy: "manual", deliveryState: "manual", error: "provider failed", activities: ["Provider rejected the final request"] });
const cancelled = child(8, "cancelled", "cancelled", "stop obsolete work", { requestedExecution: "background", ownership: "background", terminalOwnership: "background", deliveryPolicy: "manual", deliveryState: "manual", error: "Cancelled" });

const widget = new BackgroundWidgetComponent(() => widgetChildren, theme, () => true).render(112);
const directStamp = new BackgroundStampComponent({ kind: "handoff", target: queued.target!, timestamp: now, child: queued }, false, theme).render(112);
const handoffStamp = new BackgroundStampComponent({ kind: "handoff", target: detached.target!, timestamp: now, child: detached }, false, theme).render(112);
const terminalStamps = [success, failure, cancelled].flatMap((item, index) => [
 ...(index ? [""] : []),
 ...new BackgroundStampComponent({ kind: "terminal", target: item.target!, timestamp: now, child: item, result: item.response || item.error }, false, theme).render(112),
]);
const expanded = new BackgroundStampComponent({ kind: "terminal", target: failure.target!, timestamp: now, child: failure, result: "provider failed\nFull response remains in the artifact." }, true, theme).render(112);
const overlayForeground = child(9, "running", "foreground", "await synchronous result", { requestedExecution: "foreground", ownership: "foreground" });
const overlay = new ManagementOverlay(managementItems({ activeForeground: [overlayForeground], activeBackground: widgetChildren, terminalUncollected: [failure, cancelled] }), theme, () => {}).render(78);
const narrow = new BackgroundWidgetComponent(() => [runningAuto], theme).render(48);
const toolCard = new ToolSnapshotComponent(cardDetails, false).render(112);

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}body{display:inline-block}.frame{margin:30px;padding:35px;background:linear-gradient(135deg,#6157da,#cf6cae);border-radius:18px}.win{background:#1a1b26;color:#c0caf5;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px #0008}.bar{padding:14px 20px;background:#15161e;color:#777;font:14px monospace}.grid{display:grid;grid-template-columns:auto auto;gap:18px;padding:22px}.term{padding:18px 22px;font:16px/1.5 "JetBrains Mono",monospace;background:#1a1b26}.row{white-space:pre}.gap{height:1.5em}.label{color:#7a8194;margin-bottom:8px}.wide{grid-column:1 / -1}.narrow{width:48ch}.overlay{align-self:start}
</style><div class="frame"><div class="win"><div class="bar">● ● ●　pi — session background subagents</div><div class="grid">
<div class="term wide"><div class="label">mixed foreground result + foreground handoff acknowledgement</div>${paint(toolCard,"#242738")}</div>
<div class="term wide"><div class="label">active widget · direct launch · queued/running · auto/manual · pending steering</div>${paint(widget,"#252331")}</div>
<div class="term"><div class="label">durable direct-launch and foreground-handoff stamps</div>${paint([...directStamp,"",...handoffStamp],"#202d29")}</div>
<div class="term"><div class="label">terminal success · failure · cancellation stamps</div>${paint(terminalStamps,"#202d29")}</div>
<div class="term"><div class="label">expanded terminal detail</div>${paint(expanded,"#242738")}</div>
<div class="term overlay"><div class="label">management overlay groups + state-valid actions</div>${paint(overlay,"#1f2433")}</div>
<div class="term narrow"><div class="label">narrow viewport</div>${paint(narrow,"#252331")}</div>
</div></div></div>`;
process.stdout.write(html);
