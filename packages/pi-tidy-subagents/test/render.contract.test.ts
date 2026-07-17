import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ControlSnapshotComponent, renderControlLines, renderLines, SnapshotComponent } from "../render.js";
import type { ChildState, ChildStatus, RunDetails } from "../types.js";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function child(overrides: Partial<ChildState> = {}): ChildState {
  return {
    index: 0,
    id: "child-0",
    label: "agent",
    reason: "inspect state",
    prompt: "prompt",
    status: "completed",
    model: "m",
    thinking: "off",
    toolCount: 0,
    input: 12,
    output: 3,
    cacheRead: 40,
    cacheWrite: 5,
    providerTraffic: 60,
    tokens: 60,
    activities: [],
    activeTools: [],
    eventCount: 0,
    response: "",
    artifactPath: "/tmp/child.md",
    ...overrides,
  };
}
function details(children: ChildState[]): RunDetails {
  return {
    schemaVersion: 1,
    runId: "run",
    runDir: "/tmp/run",
    cwd: "/tmp",
    createdAt: "now",
    cap: 4,
    runtime: {
      provider: "provider",
      modelId: "model-id",
      model: "provider/model-id",
      thinking: "off",
      activeTools: [],
      projectTrusted: true,
    },
    children,
  };
}

const glyphs: Record<ChildStatus, string> = {
  queued: `${DIM}○${RESET}`,
  starting: `${CYAN}●${RESET}`,
  running: `${CYAN}●${RESET}`,
  completed: `${GREEN}✓${RESET}`,
  warning: `${YELLOW}!${RESET}`,
  failed: `${RED}✗${RESET}`,
  cancelled: `${YELLOW}■${RESET}`,
  "not-started": `${DIM}○${RESET}`,
};
const fallbacks: Record<ChildStatus, string> = {
  queued: "queued",
  starting: "waiting for model",
  running: "waiting for model",
  completed: "completed",
  warning: "warning",
  failed: "boom",
  cancelled: "cancelled",
  "not-started": "not-started",
};

test("renderLines returns no lines when public details are missing", () => {
  assert.deepEqual(renderLines(undefined), []);
});

test("every child status has an exact ANSI header while only active fallbacks stay collapsed", () => {
  for (const status of Object.keys(glyphs) as ChildStatus[]) {
    const state = child({
      status,
      error: status === "failed" ? "boom" : undefined,
    });
    const expected = [
      `${glyphs[status]} ${MAGENTA}🤖${RESET} ${BOLD}agent[m|off]${RESET} inspect state ${DIM}→ 0 tools · ↑12 ↓3 · <1s${RESET}`,
    ];
    if (["queued", "starting", "running"].includes(status)) expected.push(`    ${fallbacks[status]}`);
    assert.deepEqual(renderLines(details([state]), false, 500, 200), expected);
  }
});

test("wide and narrow layouts combine or split exact header and statistics lines", () => {
  const state = child({
    label: "worker",
    reason: "do work",
    model: "model",
    thinking: "high",
    toolCount: 2,
    startedAt: 1_000,
    endedAt: 63_000,
  });
  const identity = `${GREEN}✓${RESET} ${MAGENTA}🤖${RESET} ${BOLD}worker[model|high]${RESET} do work ${DIM}(<1m ago)${RESET}`;
  const statistics = `${DIM}→ 2 tools · ↑12 ↓3 · 1m 02s${RESET}`;
  assert.deepEqual(renderLines(details([state]), false, 99_000, 200), [
    `${identity} ${statistics}`,
  ]);
  assert.deepEqual(renderLines(details([state]), false, 99_000, 40), [
    identity,
    `  ${statistics}`,
  ]);
  assert.deepEqual(renderLines(details([state]), false, 99_000), [
    identity,
    `  ${statistics}`,
  ]);
});

test("usage is directional, formats all scales, and omits provider and cache totals", () => {
  const cases = [
    [999, 1, "↑999 ↓1"],
    [1_250, 9_999, "↑1.3k ↓10.0k"],
    [12_499, 999_999, "↑12k ↓1000k"],
    [1_250_000, 9_999_999, "↑1.3M ↓10.0M"],
    [12_500_000, 10_000_000, "↑13M ↓10M"],
  ] as const;
  for (const [input, output, usage] of cases) {
    const line = strip(
      renderLines(
        details([
          child({
            input,
            output,
            cacheRead: 88_888,
            cacheWrite: 77_777,
            providerTraffic: 66_666_666,
            tokens: 55_555_555,
          }),
        ]),
        false,
        0
      )[1]!
    );
    assert.equal(line, `  → 0 tools · ${usage} · <1s`);
    assert.doesNotMatch(line, /cache|provider|55\.6m|66\.7m|tok/);
  }
  const legacy = child({ tokens: 2_100 }) as Partial<ChildState>;
  delete legacy.input;
  delete legacy.output;
  delete legacy.activeTools;
  assert.equal(
    strip(renderLines(details([legacy as ChildState]), false, 0)[1]!),
    "  → 0 tools · 2.1k tok · <1s"
  );
  delete legacy.tokens;
  delete legacy.toolCount;
  delete legacy.activities;
  assert.deepEqual(
    renderLines(details([legacy as ChildState]), false, 0).map(strip),
    [
      "✓ 🤖 agent[m|off] inspect state",
      "  → 0 tools · 0 tok · <1s",
    ]
  );
});

test("collapsed activities select text, complete tool blocks, and one active tool exactly", () => {
  const first = `${DIM}·${RESET} ${CYAN}📖 ${BOLD}read${RESET} inspect file`;
  const second = `  ${DIM}/tmp/a.ts${RESET} ${DIM}→${RESET} ${DIM}running${RESET}`;
  const activity = ["old prose", first, second, "new prose", "latest prose"];
  assert.deepEqual(
    renderLines(details([child({ status: "running", activities: activity })]), false, 0).slice(2),
    [`    new prose`, `    latest prose`]
  );
  assert.deepEqual(
    renderLines(
      details([child({ activities: ["old", first, second] })]),
      false,
      0
    ).slice(2),
    [
      `  ${RED}✗${RESET} ${CYAN}📖 ${BOLD}read${RESET} inspect file`,
      `    ${DIM}/tmp/a.ts${RESET} ${DIM}→${RESET} ${RED}interrupted${RESET}`,
    ]
  );
  assert.deepEqual(
    renderLines(
      details([
        child({
          status: "running",
          activities: activity,
          activeTools: [{ id: "one", name: "read", activityIndex: 1 }],
        }),
      ]),
      false,
      0
    ).slice(2),
    [`  ${first}`, `  ${second}`]
  );
  assert.deepEqual(
    renderLines(details([child({ activities: [first] })]), false, 0).slice(2),
    [`  ${first}`]
  );
});

test("collapsed parallel active tools render exact counted ANSI summary", () => {
  const state = child({
    status: "running",
    activities: ["ignored"],
    activeTools: [
      { id: "1", name: "read", activityIndex: 0 },
      { id: "2", name: "read", activityIndex: 0 },
      { id: "3", name: "bash", activityIndex: 0 },
      { id: "4", name: "mystery", activityIndex: 0 },
    ],
  });
  assert.deepEqual(renderLines(details([state]), false, 0).slice(2), [
    `  ${CYAN}●${RESET} ${MAGENTA}◆ ${BOLD}parallel${RESET} 4 tools running`,
    `      ${CYAN}📖 ${BOLD}read${RESET} ×2 ${DIM}·${RESET} ${MAGENTA}⚡ ${BOLD}bash${RESET} ×1 ${DIM}·${RESET} ${MAGENTA}◆ ${BOLD}mystery${RESET} ×1`,
  ]);
});

test("expanded activities keep the last fifteen, drop an orphan detail, and include streaming text", () => {
  const orphan = `  ${DIM}orphan detail${RESET}`;
  const activity = [
    "discarded",
    orphan,
    ...Array.from({ length: 14 }, (_, index) => `line ${index}`),
  ];
  const rendered = renderLines(
    details([child({ activities: activity, streamingLine: " live stream " })]),
    true,
    0
  ).slice(2);
  assert.deepEqual(rendered.map(strip), [
    "    line 0",
    "    line 1",
    "    line 2",
    "    line 3",
    "    line 4",
    "    line 5",
    "    line 6",
    "    line 7",
    "    line 8",
    "    line 9",
    "    line 10",
    "    line 11",
    "    line 12",
    "    line 13",
    "     live stream ",
  ]);
  assert.equal(rendered.length, 15);
  assert.deepEqual(
    renderLines(details([child({ activities: [orphan, "kept"] })]), true, 0)
      .slice(2)
      .map(strip),
    ["    kept"]
  );
  assert.deepEqual(
    renderLines(
      details([child({ activities: [], streamingLine: "   " })]),
      true,
      0
    )
      .slice(2)
      .map(strip),
    ["    completed"]
  );
});

test("activity indentation recognizes ANSI tool marks and running marks", () => {
  const entries = [
    `${GREEN}✓${RESET} ${CYAN}📖 read`,
    `${RED}✗${RESET} ${MAGENTA}⚡ bash`,
    `${CYAN}●${RESET} active tool`,
    "ordinary text",
  ];
  assert.deepEqual(
    renderLines(details([child({ activities: entries })]), true, 0).slice(2),
    [
      `  ${entries[0]}`,
      `  ${entries[1]}`,
      `  ${entries[2]}`,
      `    ordinary text`,
    ]
  );
});

test("multiple children preserve exact header-child line ordering", () => {
  const rendered = renderLines(
    details([
      child({
        id: "a",
        label: "alpha",
        reason: "first",
        activities: ["alpha child"],
      }),
      child({
        id: "b",
        label: "beta",
        reason: "second",
        status: "failed",
        error: "beta child",
        activities: [],
      }),
    ]),
    false,
    0,
    200
  ).map(strip);
  assert.deepEqual(rendered, [
    "✓ 🤖 alpha[m|off] first → 0 tools · ↑12 ↓3 · <1s",
    "",
    "✗ 🤖 beta[m|off] second → 0 tools · ↑12 ↓3 · <1s",
  ]);
});

test("SnapshotComponent fits ANSI lines, preserves metric tails, and does not pad without a background", () => {
  const component = new SnapshotComponent(
    details([
      child({
        label: "long-agent-name",
        reason: "a deliberately long reason",
        toolCount: 31,
        input: 99_000,
        output: 3_700,
      }),
    ]),
    false
  );
  const rendered = component.render(36);
  assert.deepEqual(rendered.map(strip), [
    "✓ 🤖 long-agent-name[m|off] a delib…",
    "  → 31 tools · ↑99k ↓3.7k · <1s",
  ]);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 36));
  assert.ok(rendered.every((line) => !line.endsWith(" ")));
  assert.deepEqual(component.render(32).map(strip), [
    "✓ 🤖 long-agent-name[m|off] a d…",
    "  → 31 tools · ↑99k ↓3.7k · <1s",
  ]);
  assert.deepEqual(component.render(20).map(strip), [
    "✓ 🤖 long-agent-nam…",
    "→ 31 tools · ↑99k ↓…",
  ]);
  assert.deepEqual(component.render(0).map(strip), ["…", "…"]);
  assert.deepEqual(new SnapshotComponent(undefined, false).render(0), []);
});

test("SnapshotComponent honors expanded disclosure exactly", () => {
  const component = new SnapshotComponent(
    details([child({ activities: ["first", "second"] })]),
    true
  );
  assert.deepEqual(component.render(80).map(strip), [
    "✓ 🤖 agent[m|off] inspect state → 0 tools · ↑12 ↓3 · <1s",
    "    first",
    "    second",
  ]);
});

test("SnapshotComponent pads and reapplies exact backgrounds across resets", () => {
  const background = (text: string): string => `\x1b[48;5;24m${text}`;
  const component = new SnapshotComponent(
    details([child()]),
    false,
    background
  );
  const source = renderLines(details([child()]), false, Date.now(), 80)[0]!;
  const padded = source + " ".repeat(80 - visibleWidth(source));
  const expected = padded
    .split(RESET)
    .map((segment) => `${background(`${segment}${RESET}`)}`)
    .join("");
  const actual = component.render(80)[0]!;
  assert.equal(actual, expected);
  assert.equal(visibleWidth(actual), 80);
  assert.equal(
    actual.split("\x1b[48;5;24m").length - 1,
    source.split(RESET).length
  );
});

test("control cards summarize every action without exposing raw prose", () => {
  const controlled = child({
    label: "tui-regression-builder",
    status: "completed",
    ownership: "foreground",
    deliveryPolicy: undefined,
  });
  const base = { content: [{ type: "text", text: "unsafe diagnostic prose that must stay collapsed" }], details: { child: controlled } };
  const cases = [
    [{ action: "inspect", target: "run:child-001" }, base, "completed/foreground · delivery none"],
    [{ action: "background", target: "run:child-001" }, { ...base, details: { child: { ...controlled, status: "running", ownership: "background", deliveryPolicy: "auto" } } }, "running/background · delivery auto"],
    [{ action: "steer", target: "run:child-001" }, base, "steering accepted"],
    [{ action: "cancel", target: "run:child-001" }, { ...base, details: { child: { ...controlled, status: "cancelled" } } }, "cancelled"],
    [{ action: "set_delivery", target: "run:child-001" }, { ...base, details: { child: { ...controlled, deliveryPolicy: "manual" } } }, "delivery manual · completed"],
    [{ action: "collect", target: "run:child-001" }, { ...base, details: { child: controlled, collectionCount: 2 } }, "completed · collection 2"],
    [{ action: "status" }, { content: [{ type: "text", text: "verbose status" }], details: { activeForeground: [{}], activeBackground: [{}, {}], terminalUncollected: [{}, {}, {}] } }, "1 foreground · 2 background · 3 uncollected"],
  ] as const;
  for (const [args, result, summary] of cases) {
    const lines = renderControlLines(args, result as any).map(strip);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^🤖 control/);
    assert.match(lines[0]!, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(lines[0]!, /unsafe diagnostic prose|verbose status/);
  }
});

test("control cards disclose bounded raw detail, errors, pending state, and fit narrow widths", () => {
  const detail = Array.from({ length: 20 }, (_, index) => `detail ${index}`).join("\n");
  const result = { content: [{ type: "text", text: detail }], details: { child: child({ label: "worker", status: "completed", ownership: "foreground" }) } };
  const component = new ControlSnapshotComponent({ action: "inspect", target: "run:child" }, result as any, true, false, false);
  const expanded = component.render(80).map(strip);
  assert.match(expanded[0]!, /control inspect worker/);
  assert.match(expanded.join("\n"), /detail 0/);
  assert.match(expanded.at(-1)!, /… 5 more lines/);
  assert.ok(component.render(42).every((line) => visibleWidth(line) <= 42));

  const pending = renderControlLines({ action: "cancel", target: "worker" }, undefined, false, true).map(strip);
  assert.deepEqual(pending, ["● 🤖 control cancel worker → running"]);
  const failed = renderControlLines(
    { action: "inspect", target: "worker" },
    { content: [{ type: "text", text: "No eligible subagent found" }] },
    false,
    false,
    true,
  ).map(strip);
  assert.deepEqual(failed, ["🤖 control inspect worker → No eligible subagent found"]);
});

test("ControlSnapshotComponent reapplies settled backgrounds and invalidates inertly", () => {
  const background = (text: string): string => `\x1b[48;5;24m${text}`;
  const component = new ControlSnapshotComponent(
    { action: "status" },
    { content: [{ type: "text", text: "status" }], details: { activeForeground: [], activeBackground: [], terminalUncollected: [] } },
    false,
    false,
    false,
    background,
  );
  const rendered = component.render(60);
  assert.equal(visibleWidth(rendered[0]!), 60);
  assert.match(rendered[0]!, /\x1b\[48;5;24m/);
  assert.equal(component.invalidate(), undefined);
});

test("SnapshotComponent invalidate is intentionally inert", () => {
  const component = new SnapshotComponent(details([child()]), false);
  const before = component.render(80);
  assert.equal(component.invalidate(), undefined);
  assert.deepEqual(component.render(80), before);
});
