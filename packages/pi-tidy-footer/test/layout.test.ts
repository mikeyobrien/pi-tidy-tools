import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  alignSides,
  compactModelId,
  renderFooter,
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

test("alignSides keeps the right field pinned to the terminal edge", () => {
  const line = alignSides("left", "right", 20);
  assert.equal(line, `left${" ".repeat(11)}right`);
  assert.equal(visibleWidth(line), 20);

  const narrow = alignSides("a very long left value", "ctx 28%", 16);
  assert.equal(visibleWidth(narrow), 16);
  assert.ok(narrow.endsWith("ctx 28%"));
  assert.match(narrow, /…/);
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
    sanitizeStatus("ok\n\x1b[31mfailed\x1b[0m\x1b]0;title\x07"),
    "ok failed"
  );
});
