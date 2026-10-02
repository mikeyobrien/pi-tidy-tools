import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  alignSides,
  compactModelId,
  formatGiB,
  formatTokens,
  renderFooter,
  resourceItems,
  sanitizeStatus,
} from "../layout.js";
import type { FooterPalette, FooterSnapshot } from "../types.js";

const palette: FooterPalette = {
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  accent: (text) => `\x1b[36m${text}\x1b[0m`,
  warning: (text) => `\x1b[33m${text}\x1b[0m`,
  error: (text) => `\x1b[31m${text}\x1b[0m`,
};

const snapshot = (overrides: Partial<FooterSnapshot> = {}): FooterSnapshot => ({
  cwd: "/data/data/com.termux/files/home/projects/pi-tidy-tools",
  branch: "main",
  modelId: "gpt-5.6-sol",
  provider: "openai-codex",
  thinkingLevel: "max",
  contextPercent: 27.6,
  contextWindow: 272_000,
  usage: {
    input: 83_000,
    output: 37_000,
    cacheRead: 6_700_000,
    cacheWrite: 492_000,
  },
  quota: {
    primary: { usedPercent: 3, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10_080 },
  },
  statuses: new Map([
    ["memory", "🧠 58L 16P"],
    ["subagents", "ρ 23m"],
  ]),
  ...overrides,
});

test("formats token counts at every representation boundary", () => {
  assert.deepEqual(
    [
      0, 999, 1_000, 9_999, 10_000, 999_499, 999_500, 999_999, 1_000_000,
      9_999_999, 10_000_000,
    ].map(formatTokens),
    [
      "0",
      "999",
      "1.0k",
      "10.0k",
      "10k",
      "999k",
      "1.0M",
      "1.0M",
      "1.0M",
      "10.0M",
      "10M",
    ]
  );
});

test("alignSides keeps the right field pinned to the terminal edge", () => {
  const line = alignSides("left", "right", 20);
  assert.equal(line, `left${" ".repeat(11)}right`);
  assert.equal(visibleWidth(line), 20);

  const narrow = alignSides("a very long left value", "ctx 28%", 16);
  assert.equal(visibleWidth(narrow), 16);
  assert.ok(narrow.endsWith("ctx 28%"));
  assert.match(narrow, /…/);
  assert.equal(alignSides("left", "right", 0), "");
  assert.equal(alignSides("left", "right", -1), "");
  assert.equal(alignSides("", "right", 8), "   right");
  assert.equal(alignSides("left", "123456", 8), "  123456");
  assert.equal(alignSides("left", "1234567", 8), " 1234567");
  assert.equal(alignSides("a", "b", 4), "a  b");
});

test("the 52–56 column layout anchors identity and context on the right", () => {
  for (const width of [52, 56]) {
    const lines = renderFooter(snapshot(), width, palette);
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes("main"));
    assert.ok(lines[0]!.includes("sol/max"));
    assert.ok(lines[0]!.endsWith("\x1b[36msol/max\x1b[0m"));
    assert.ok(lines[1]!.includes("5h 3%"));
    assert.ok(lines[1]!.includes("7d 20%"));
    assert.ok(lines[1]!.endsWith("\x1b[36mctx 28%\x1b[0m"));
    assert.equal(visibleWidth(lines[0]!), width);
    assert.equal(visibleWidth(lines[1]!), width);
  }
});

test("every responsive tier stays within terminal cell width", () => {
  const hostile = snapshot({
    branch: "feature/非常に長い-mobile-footer-branch",
    modelId: "provider/very-long-model-name",
    statuses: new Map([
      ["bad", "\x1b]52;c;clipboard\x07failed\nwith\ttabs"],
      ["emoji", "🧠 👩🏽‍💻 e\u0301 status"],
    ]),
  });
  for (const width of [
    1, 8, 20, 31, 32, 40, 47, 48, 52, 56, 71, 72, 80, 95, 96, 120,
  ]) {
    for (const line of renderFooter(hostile, width, palette)) {
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}`
      );
      assert.doesNotMatch(line, /clipboard|\n|\t/);
    }
  }
});

test("context pressure uses a non-color warning marker", () => {
  const warning = renderFooter(
    snapshot({ contextPercent: 76 }),
    52,
    palette
  )[1]!;
  const error = renderFooter(snapshot({ contextPercent: 94 }), 52, palette)[1]!;
  assert.ok(warning.includes("! ctx 76%"));
  assert.ok(error.includes("!! ctx 94%"));
  assert.ok(warning.includes("\x1b[33m"));
  assert.ok(error.includes("\x1b[31m"));
});

test("quota pressure has a non-color marker and displaces routine state", () => {
  const warning = renderFooter(
    snapshot({
      quota: {
        primary: { usedPercent: 76, windowMinutes: 300 },
        secondary: { usedPercent: 95, windowMinutes: 10_080 },
      },
      statuses: new Map([["healthy", "memory ready"]]),
    }),
    40,
    palette
  )[1]!;
  assert.ok(warning.includes("!! 7d 95%"));
  assert.ok(warning.includes("! 5h 76%"));
  assert.ok(warning.includes("\x1b[31m"));
  assert.ok(!warning.includes("memory ready"));
});

test("emergency widths preserve critical status text", () => {
  const lines = renderFooter(
    snapshot({ statuses: new Map([["critical", "blocked offline"]]) }),
    9,
    palette
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes("blocked"));
  assert.ok(lines[1]!.includes("\x1b[31m"));
  assert.equal(visibleWidth(lines[1]!), 9);
});

test("emergency context errors displace lower-severity status", () => {
  const second = renderFooter(
    snapshot({
      contextPercent: 95,
      statuses: new Map([["worker", "starting"]]),
    }),
    20,
    palette
  )[1]!;
  assert.ok(second.includes("!! ctx 95%"));
  assert.ok(second.includes("\x1b[31m"));
  assert.ok(!second.includes("starting"));
});

test("critical extension state displaces quotas and remains visible", () => {
  const line = renderFooter(
    snapshot({
      statuses: new Map([
        ["healthy", "memory ready"],
        [
          "critical",
          "blocked because the provider connection failed with a very long explanation",
        ],
      ]),
    }),
    52,
    palette
  )[1]!;
  assert.ok(line.includes("blocked"));
  assert.ok(line.includes("…"));
  assert.ok(line.includes("\x1b[31m"));
  assert.ok(!line.includes("5h 3%"));
  assert.ok(line.endsWith("\x1b[36mctx 28%\x1b[0m"));
});

test("directory and unknown model identities are bounded and sanitized", () => {
  const lines = renderFooter(
    snapshot({
      cwd: "/tmp/project\n\x1b]0;title\x07",
      branch: null,
      modelId: "vendor/an-extremely-long-unknown-model-identifier",
      thinkingLevel: "xhigh",
      quota: undefined,
      statuses: undefined,
    }),
    32,
    palette
  );
  assert.doesNotMatch(lines.join(""), /title|\n/);
  assert.ok(lines[0]!.includes("/xhigh"));
  assert.ok(lines[0]!.includes("…"));
  assert.ok(lines[0]!.includes("project"));
});

test("wide layout expands location context and accounting", () => {
  const lines = renderFooter(
    snapshot({ quota: undefined, statuses: undefined }),
    120,
    palette
  );
  assert.ok(lines[0]!.includes("pi-tidy-tools (main)"));
  assert.ok(lines[0]!.includes("gpt-5.6-sol · max"));
  assert.ok(lines[1]!.includes("↑83k"));
  assert.ok(lines[1]!.includes("↓37k"));
  assert.ok(lines[1]!.includes("ctx 28%/272k"));
});

test("Codex models get compact stable aliases", () => {
  assert.equal(compactModelId("gpt-5.6-luna"), "luna");
  assert.equal(compactModelId("gpt-5.6-sol"), "sol");
  assert.equal(compactModelId("gpt-5.6-terra"), "terra");
  assert.equal(compactModelId("vendor/model"), "model");
});

test("status text cannot inject terminal controls or extra lines", () => {
  assert.equal(
    sanitizeStatus("  ok\n\x1b[31mfailed\x1b[0m\x1b]0;title\x07  "),
    "ok failed"
  );
  assert.equal(sanitizeStatus("\u0000a\u009fb\t c"), "a b c");
});

test("layout thresholds and fallbacks are exact", () => {
  const plain: FooterPalette = {
    dim: (text) => `dim(${text})`,
    accent: (text) => `accent(${text})`,
    warning: (text) => `warning(${text})`,
    error: (text) => `error(${text})`,
  };
  assert.deepEqual(renderFooter(snapshot(), 0, plain), []);
  assert.deepEqual(renderFooter(snapshot(), -1, plain), []);

  const at70 = renderFooter(snapshot({ contextPercent: 70 }), 52, plain)[1]!;
  const over70 = renderFooter(
    snapshot({ contextPercent: 70.1 }),
    52,
    plain
  )[1]!;
  const at90 = renderFooter(snapshot({ contextPercent: 90 }), 52, plain)[1]!;
  const over90 = renderFooter(
    snapshot({ contextPercent: 90.1 }),
    52,
    plain
  )[1]!;
  assert.ok(at70.endsWith("accent(ctx 70%)"));
  assert.ok(over70.endsWith("warning(! ctx 70%)"));
  assert.ok(at90.endsWith("warning(! ctx 90%)"));
  assert.ok(over90.endsWith("error(!! ctx 90%)"));

  const unknown = renderFooter(
    snapshot({
      cwd: "",
      branch: "",
      modelId: undefined,
      thinkingLevel: "off",
      contextPercent: undefined,
      contextWindow: undefined,
      quota: undefined,
      statuses: undefined,
      usage: undefined,
    }),
    72,
    plain
  );
  assert.ok(unknown[0]!.includes("dim(~)"));
  assert.ok(unknown[0]!.endsWith("accent(no-model)"));
  assert.ok(unknown[1]!.endsWith("accent(ctx ?)"));

  assert.ok(
    renderFooter(snapshot(), 71, plain)[0]!.includes("accent(sol/max)")
  );
  const at72 = renderFooter(snapshot(), 72, plain);
  assert.ok(at72[0]!.includes("accent(sol · max)"));
  assert.ok(at72[1]!.endsWith("accent(ctx 28%/272k)"));
  assert.ok(
    renderFooter(snapshot(), 95, plain)[0]!.includes("accent(sol · max)")
  );
  assert.ok(
    renderFooter(snapshot(), 96, plain)[0]!.includes(
      "accent(gpt-5.6-sol · max)"
    )
  );
  assert.ok(
    renderFooter(snapshot({ modelId: undefined }), 96, plain)[0]!.endsWith(
      "accent(no-model · max)"
    )
  );
  assert.ok(!renderFooter(snapshot(), 31, plain)[0]!.includes("main"));
  assert.ok(renderFooter(snapshot(), 32, plain)[0]!.includes("main"));
});

test("capacity ordering, fallback labels, and width admission are deterministic", () => {
  const ordered = renderFooter(
    snapshot({
      quota: {
        primary: { usedPercent: 70, windowMinutes: 42 },
        secondary: { usedPercent: 90, windowMinutes: 43 },
      },
      statuses: new Map([
        ["z", "warning z"],
        ["b", "ready b"],
        ["a", "ready a"],
        ["x", "failed x"],
      ]),
      usage: { input: 1_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    }),
    120,
    { dim: (x) => x, accent: (x) => x, warning: (x) => x, error: (x) => x }
  )[1]!;
  assert.match(
    ordered,
    /^failed x · warning z · ! 7d 90% · 5h 70% · ready a · ready b · ↑1\.0k · ↓2\.0k/
  );

  const exactCandidate = "x".repeat(24);
  const justFits = renderFooter(
    snapshot({
      quota: undefined,
      statuses: new Map([["exact", exactCandidate]]),
      usage: undefined,
      contextPercent: 0,
    }),
    32,
    { dim: (x) => x, accent: (x) => x, warning: (x) => x, error: (x) => x }
  )[1]!;
  assert.equal(justFits, `${exactCandidate}  ctx 0%`);
});

const GiB = 2 ** 30;
const resources = (
  overrides: Partial<NonNullable<FooterSnapshot["resources"]>> = {}
): NonNullable<FooterSnapshot["resources"]> => ({
  warnPercent: 85,
  cpu: { load1: 1.36, cores: 4 },
  memory: { used: 12.4 * GiB, total: 31.2 * GiB },
  disks: [
    { mount: "/", blockPercent: 47, inodePercent: 5 },
    { mount: "/tmp", blockPercent: 16, inodePercent: 3 },
  ],
  ...overrides,
});

test("formats memory in GiB with one decimal below ten", () => {
  assert.deepEqual(
    [0, 3.25 * GiB, 9.94 * GiB, 9.96 * GiB, 31.2 * GiB].map(formatGiB),
    ["0.0", "3.3", "9.9", "10", "31"]
  );
});

test("resource items are compact and omitted without readings", () => {
  assert.deepEqual(resourceItems(snapshot()), []);
  assert.deepEqual(resourceItems(snapshot({ resources: resources() })), [
    { text: "cpu 34%", severity: 2 },
    { text: "mem 12/31G", severity: 2 },
    { text: "/ 47%", severity: 2 },
    { text: "/tmp 16%", severity: 2 },
  ]);
  assert.deepEqual(
    resourceItems(
      snapshot({
        resources: resources({
          cpu: undefined,
          memory: { used: 1, total: 0 },
          disks: [{ mount: "/empty" }, { mount: "\x1b[31m", blockPercent: 1 }],
        }),
      })
    ),
    [{ text: "? 1%", severity: 2 }]
  );
});

test("disk shows the higher of block and inode use and flags inodes", () => {
  const items = resourceItems(
    snapshot({
      resources: resources({
        cpu: undefined,
        memory: undefined,
        disks: [
          { mount: "/tmp", blockPercent: 16, inodePercent: 100 },
          { mount: "/var", blockPercent: 30, inodePercent: 30 },
          { mount: "/srv", inodePercent: 12 },
          { mount: "/data", blockPercent: 12 },
        ],
      }),
    })
  );
  assert.deepEqual(items, [
    { text: "! /tmp 100%i", severity: 1 },
    { text: "/var 30%", severity: 2 },
    { text: "/srv 12%i", severity: 2 },
    { text: "/data 12%", severity: 2 },
  ]);
});

test("resource warnings start exactly at the configured threshold", () => {
  const at = (percent: number, warnPercent = 85) =>
    resourceItems(
      snapshot({
        resources: resources({
          warnPercent,
          cpu: { load1: percent / 100, cores: 1 },
          memory: { used: percent, total: 100 },
          disks: [{ mount: "/", blockPercent: percent }],
        }),
      })
    ).map(({ severity }) => severity);
  assert.deepEqual(at(84.9), [2, 2, 2]);
  assert.deepEqual(at(85), [1, 1, 1]);
  assert.deepEqual(at(60, 50), [1, 1, 1]);
  assert.deepEqual(at(49, 50), [2, 2, 2]);
});

test("an inode-full mount displaces routine fields in warning style", () => {
  const lines = renderFooter(
    snapshot({
      resources: resources({
        disks: [
          { mount: "/", blockPercent: 47, inodePercent: 5 },
          { mount: "/tmp", blockPercent: 16, inodePercent: 100 },
        ],
      }),
    }),
    52,
    palette
  );
  assert.ok(lines[1]!.startsWith("\x1b[33m! /tmp 100%i"), lines[1]);
  for (const line of lines) assert.ok(visibleWidth(line) <= 52);

  const tiny = renderFooter(
    snapshot({
      contextPercent: 10,
      statuses: new Map(),
      resources: resources({
        disks: [{ mount: "/tmp", blockPercent: 16, inodePercent: 100 }],
      }),
    }),
    24,
    palette
  );
  assert.equal(tiny[1], "\x1b[33m! /tmp 100%i\x1b[0m");
});

test("routine resources follow quotas and precede extension statuses", () => {
  const [, line] = renderFooter(snapshot({ resources: resources() }), 160, {
    dim: (t) => t,
    accent: (t) => t,
    warning: (t) => t,
    error: (t) => t,
  });
  assert.match(
    line!,
    /^5h 3% · 7d 20% · cpu 34% · mem 12\/31G · \/ 47% · \/tmp 16% · 🧠 58L 16P/
  );
});
