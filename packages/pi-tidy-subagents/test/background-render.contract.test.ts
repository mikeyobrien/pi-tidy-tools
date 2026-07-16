import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildMixedEnvelope } from "../coordinator.js";
import { ToolSnapshotComponent } from "../render.js";
import { BackgroundStampComponent, BackgroundWidgetComponent, ManagementOverlay, managementActions, managementItems } from "../ui.js";
import type { ChildState, RunDetails } from "../types.js";

const theme: any = {
 fg(_name: string, text: string) { return text; },
 bg(_name: string, text: string) { return text; },
 bold(text: string) { return text; },
};
const strip = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
function child(overrides: Partial<ChildState> = {}): ChildState {
 return {
  index: 0, id: "child-001", target: "run:child-001", label: "worker", reason: "inspect background state", prompt: "hidden prompt",
  status: "running", requestedExecution: "background", ownership: "background", ownershipChangedAt: 1, ownershipReason: "direct-launch",
  deliveryPolicy: "auto", deliveryState: "pending", model: "model-x", thinking: "high", startedAt: Date.now() - 1_500,
  toolCount: 2, input: 1_200, output: 34, cacheRead: 0, cacheWrite: 0, providerTraffic: 1_234, tokens: 1_234,
  pendingSteering: 2, activities: ["secret live output"], activeTools: [], eventCount: 0, response: "hidden response", artifactPath: "/tmp/run/child-001.md",
  ...overrides,
 };
}
function details(children: ChildState[]): RunDetails {
 return { schemaVersion: 3, runId: "run", runDir: "/tmp/run", cwd: "/tmp", createdAt: "now", cap: 2, runtime: { provider: "fake", modelId: "model-x", model: "fake/model-x", thinking: "high", activeTools: [], projectTrusted: true }, children };
}

test("background widget keeps active launch order, shared vocabulary, delivery, steering, and width bounds", () => {
 const queued = child({ index: 0, id: "queued", target: "run:queued", label: "queued", status: "queued", startedAt: undefined, pendingSteering: 0 });
 const running = child({ index: 1, id: "running", target: "run:running", label: "running", deliveryPolicy: "manual" });
 const terminal = child({ index: 2, id: "done", target: "run:done", label: "done", status: "completed", endedAt: Date.now(), terminalOwnership: "background" });
 const component = new BackgroundWidgetComponent(() => [queued, running, terminal], theme);
 const wide = component.render(120).map(strip);
 assert.match(wide[0]!, /background subagents · ctrl\+shift\+b manage/);
 assert.ok(wide.findIndex((line) => line.includes("🤖 queued[model-x|high]")) < wide.findIndex((line) => line.includes("🤖 running[model-x|high]")));
 assert.equal(wide.some((line) => line.includes("🤖 done")), false);
 assert.match(wide.join("\n"), /delivery|auto|manual/);
 assert.match(wide.join("\n"), /↪2 steer/);
 for (const width of [72, 40, 20]) {
  const lines = component.render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${lines.map(strip).join("\n")}`);
  assert.match(lines.map(strip).join("\n"), /queued|running/);
 }
});

test("background widget follows global expansion for detailed activity", () => {
 const active = child({ activities: ["first activity", "middle activity", "latest activity"] });
 const collapsed = new BackgroundWidgetComponent(() => [active], theme, () => false).render(100).map(strip).join("\n");
 const expanded = new BackgroundWidgetComponent(() => [active], theme, () => true).render(100).map(strip).join("\n");
 assert.doesNotMatch(collapsed, /first activity/);
 assert.match(expanded, /first activity/);
 assert.match(expanded, /latest activity/);
});

test("mixed foreground envelopes remain within the shared 50 KiB total bound", () => {
 const children = Array.from({ length: 4 }, (_, index) => child({
  index,
  id: `child-${index}`,
  target: `run:child-${index}`,
  ownership: "foreground",
  requestedExecution: "foreground",
  status: "completed",
  response: String(index).repeat(20_000),
 }));
 const envelope = buildMixedEnvelope(children);
 assert.ok(Buffer.byteLength(envelope, "utf8") <= 50 * 1024);
 assert.deepEqual([...envelope.matchAll(/index="(\d+)"/g)].map((match) => Number(match[1])), [0, 1, 2, 3]);
});

test("synchronous tool card gives a detached child one acknowledgement without live output", () => {
 const detached = child();
 const foreground = child({ index: 1, id: "front", target: "run:front", label: "front", ownership: "foreground", requestedExecution: "foreground", deliveryPolicy: undefined, deliveryState: "none", status: "completed", endedAt: Date.now(), activities: ["foreground result"] });
 const lines = new ToolSnapshotComponent(details([detached, foreground]), false).render(100).map(strip);
 assert.match(lines.join("\n"), /background · running · delivery=auto · run:child-001/);
 assert.match(lines.join("\n"), /artifact \/tmp\/run\/child-001\.md/);
 assert.doesNotMatch(lines.join("\n"), /secret live output/);
 assert.equal(lines.filter((line) => line.includes("🤖 worker")).length, 1);
 assert.doesNotMatch(lines.join("\n"), /foreground result/);
 const expanded = new ToolSnapshotComponent(details([detached, foreground]), true).render(100).map(strip);
 assert.match(expanded.join("\n"), /foreground result/);
});

test("durable handoff and terminal stamps use collapsed and expanded real rendering", () => {
 const running = child();
 const handoff: any = { kind: "handoff", target: running.target, timestamp: 1, child: running };
 const collapsed = new BackgroundStampComponent(handoff, false, theme).render(64).map(strip);
 assert.match(collapsed.join("\n"), /background handoff · run:child-001/);
 assert.doesNotMatch(collapsed.join("\n"), /artifact \/tmp/);
 const failed = child({ status: "failed", endedAt: Date.now(), terminalOwnership: "background", error: "provider failed", activities: ["last safe activity"] });
 const terminal: any = { kind: "terminal", target: failed.target, timestamp: 2, child: failed, result: "provider failed\nfull detail" };
 const expanded = new BackgroundStampComponent(terminal, true, theme).render(48).map(strip);
 assert.match(expanded.join("\n"), /background terminal/);
 assert.match(expanded.join("\n"), /last safe activity/);
 assert.match(expanded.join("\n"), /artifact \/tmp\/run\/child-001\.md/);
 assert.match(expanded.join("\n"), /provider failed/);
 assert.ok(new BackgroundStampComponent(terminal, true, theme).render(24).every((line) => visibleWidth(line) <= 24));
});

test("management overlay groups children and exposes only state-valid actions", () => {
 const foreground = child({ target: "run:front", label: "front", ownership: "foreground", requestedExecution: "foreground", deliveryPolicy: undefined });
 const background = child({ target: "run:back", label: "back" });
 const inbox = child({ target: "run:inbox", label: "inbox", status: "failed", endedAt: Date.now(), terminalOwnership: "background", deliveryPolicy: "manual", deliveryState: "manual" });
 const items = managementItems({ activeForeground: [foreground], activeBackground: [background], terminalUncollected: [inbox] });
 assert.deepEqual(items.map((item) => item.group), ["Active foreground", "Active background", "Terminal uncollected"]);
 assert.deepEqual(managementActions(items[0]!), ["background", "inspect", "cancel"]);
 assert.deepEqual(managementActions(items[1]!), ["inspect", "steer", "cancel", "set_delivery"]);
 assert.deepEqual(managementActions(items[2]!), ["inspect", "set_delivery", "collect"]);
 assert.deepEqual(managementActions({ ...items[2]!, child: { ...items[2]!.child, followUpAcceptedAt: Date.now() } }), ["inspect", "collect"]);
 const choices: any[] = [];
 const overlay = new ManagementOverlay(items, theme, (choice) => choices.push(choice));
 const rendered = overlay.render(72).map(strip).join("\n");
 assert.match(rendered, /Session subagents/);
 assert.match(rendered, /Active foreground[\s\S]*front[\s\S]*Active background[\s\S]*back[\s\S]*Terminal uncollected[\s\S]*inbox/);
 assert.ok(overlay.render(36).every((line) => visibleWidth(line) <= 36));
 overlay.handleInput("b");
 assert.deepEqual(choices, [{ target: "run:front", action: "background" }]);
});
