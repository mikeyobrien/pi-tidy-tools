import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const packageRoot = process.env.PI_TIDY_SUBAGENTS_FIXTURE_PACKAGE
  ? resolve(process.env.PI_TIDY_SUBAGENTS_FIXTURE_PACKAGE)
  : resolve(import.meta.dirname, "../../../../packages/pi-tidy-subagents");
const { BackgroundStampComponent, BackgroundWidgetComponent, ManagementOverlay, managementItems } = await import(pathToFileURL(resolve(packageRoot, "ui.ts")).href);

const now = Date.now();
const theme = {
  fg(name, text) {
    const code = name === "error" ? 31 : name === "success" ? 32 : name === "warning" ? 33 : name === "accent" || name === "customMessageText" ? 35 : name === "muted" || name === "dim" ? 2 : 36;
    return `\x1b[${code}m${text}\x1b[0m`;
  },
  bg(_name, text) { return text; },
  bold(text) { return `\x1b[1m${text}\x1b[0m`; },
};
function child(index, status, label, ownership = "background", overrides = {}) {
  const active = ["queued", "starting", "running"].includes(status);
  return {
    index, id: `child-${index}`, target: `qa-run:child-${index}`, label, reason: `${status} ${label} work`, prompt: "", status,
    requestedExecution: ownership, ownership, ownershipChangedAt: now, ownershipReason: ownership === "background" ? "direct-launch" : "agent-control",
    deliveryPolicy: ownership === "background" ? "auto" : undefined, deliveryState: ownership === "background" ? "pending" : "none",
    model: "model-x", thinking: "high", toolCount: index, input: index * 1200, output: index * 120, cacheRead: 0, cacheWrite: 0,
    providerTraffic: index * 1320, tokens: index * 1320, activities: [status === "running" ? "Inspecting coordinator state" : status], activeTools: [],
    eventCount: 0, response: "", artifactPath: `/tmp/qa-run/child-${index}.md`,
    ...(active && status !== "queued" ? { startedAt: now - 12_000 } : {}),
    ...(!active ? { startedAt: now - 30_000, endedAt: now - 5_000, terminalOwnership: ownership } : {}),
    ...overrides,
  };
}
const queued = child(1, "queued", "queued-bg");
const running = child(2, "running", "running-bg", "background", { deliveryPolicy: "manual", deliveryState: "manual", pendingSteering: 2 });
const foreground = child(3, "running", "foreground", "foreground", { deliveryPolicy: undefined, deliveryState: "none" });
const failed = child(4, "failed", "failed-bg", "background", { deliveryPolicy: "manual", deliveryState: "manual", error: "provider failed" });
const widget = new BackgroundWidgetComponent(() => [queued, running], theme, () => true).render(104);
const narrow = new BackgroundWidgetComponent(() => [running], theme).render(42);
const handoff = new BackgroundStampComponent({ kind: "handoff", target: running.target, timestamp: now, child: running }, false, theme).render(104);
const terminal = new BackgroundStampComponent({ kind: "terminal", target: failed.target, timestamp: now, child: failed, result: "provider failed" }, true, theme).render(104);
const overlay = new ManagementOverlay(managementItems({ activeForeground: [foreground], activeBackground: [queued, running], terminalUncollected: [failed] }), theme, () => {}).render(76);
const lines = [
  theme.fg("accent", theme.bold("BACKGROUND WIDGET — above editor")),
  ...widget,
  "",
  theme.fg("accent", theme.bold("DURABLE HANDOFF STAMP")),
  ...handoff,
  "",
  theme.fg("accent", theme.bold("EXPANDED TERMINAL STAMP")),
  ...terminal,
  "",
  theme.fg("accent", theme.bold("MANAGEMENT OVERLAY")),
  ...overlay,
  "",
  theme.fg("accent", theme.bold("NARROW VIEWPORT — 42 columns")),
  ...narrow,
];
process.stdout.write(`\x1b[2J\x1b[H\x1b[?25l${lines.join("\n")}\x1b[0m`);
setInterval(() => {}, 60_000);
