import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import {
  BOLD,
  CYAN,
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  YELLOW,
  buildToolActivityBlock,
  describeTool,
  fitLine,
  formatAge,
  formatCount,
  formatElapsed,
  nonEmptyLineCount,
  oneLine,
  shortPath,
  style,
  summarizeToolActivity,
} from "../index.js";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");
const plainBlock = (block: [string, string]): [string, string] =>
  block.map(stripAnsi) as [string, string];

test("public color constants and tool styles identify every supported tool family", () => {
  assert.deepEqual(
    { CYAN, YELLOW, MAGENTA, GREEN, RED, DIM, BOLD, RESET },
    {
      CYAN: "\x1b[36m",
      YELLOW: "\x1b[33m",
      MAGENTA: "\x1b[35m",
      GREEN: "\x1b[32m",
      RED: "\x1b[31m",
      DIM: "\x1b[2m",
      BOLD: "\x1b[1m",
      RESET: "\x1b[0m",
    }
  );

  for (const name of ["read", "grep", "find", "ls"]) {
    assert.deepEqual(style(name), { icon: "📖", color: "\x1b[36m" });
  }
  for (const name of ["write", "edit"]) {
    assert.deepEqual(style(name), { icon: "✏️", color: "\x1b[33m" });
  }
  assert.deepEqual(style("bash"), { icon: "⚡", color: "\x1b[35m" });
  assert.deepEqual(style("custom"), { icon: "◆", color: "\x1b[35m" });
});

test("text and path primitives normalize user-facing values", () => {
  assert.equal(nonEmptyLineCount("  alpha\n\n beta \n"), 2);
  assert.equal(nonEmptyLineCount(" \n\t\n "), 0);
  assert.equal(oneLine("  alpha\n beta\t gamma  "), "alpha beta gamma");
  assert.equal(oneLine("   "), "");

  const home = homedir();
  assert.equal(shortPath(""), "");
  assert.equal(shortPath(home), "~");
  assert.equal(shortPath(`${home}/projects/demo`), "~/projects/demo");
  assert.equal(shortPath(`${home}-backup/file`), `${home}-backup/file`);
  assert.equal(shortPath("relative/file.ts"), "relative/file.ts");
});

test("fitLine preserves fitting text and truncates to at least one column", () => {
  assert.equal(fitLine("abc", 5), "abc");
  assert.equal(stripAnsi(fitLine("abcdefgh", 5)), "abcd…");
  assert.equal(stripAnsi(fitLine("abcdefgh", 0)), "…");
  assert.equal(stripAnsi(fitLine("abcdefgh", -4)), "…");
});

test("formatCount uses readable decimal and whole-number suffixes", () => {
  const examples: Array<[number, string]> = [
    [-1, "-1"],
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_234, "1.2k"],
    [9_999, "10k"],
    [10_500, "11k"],
    [999_999, "1000k"],
    [1_000_000, "1m"],
    [1_250_000, "1.3m"],
    [9_999_999, "10m"],
    [10_500_000, "11m"],
  ];
  for (const [value, expected] of examples)
    assert.equal(formatCount(value), expected);
});

test("formatAge keeps durable relative ages compact", () => {
  assert.equal(formatAge(0), "<1m");
  assert.equal(formatAge(3_780_000), "1h3m");
  assert.equal(formatAge(26 * 60 * 60_000), "1d2h");
  assert.equal(formatAge(425 * 24 * 60 * 60_000), "1y2mo");
});

test("formatElapsed selects seconds, minutes, and hours at their boundaries", () => {
  const examples: Array<[number, string]> = [
    [0, "<1s"],
    [999, "<1s"],
    [1_000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [64_000, "1m 04s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 00m"],
    [7_500_000, "2h 05m"],
  ];
  for (const [milliseconds, expected] of examples)
    assert.equal(formatElapsed(milliseconds), expected);
});

test("describeTool chooses the most useful public argument", () => {
  assert.equal(
    describeTool("bash", { command: "  npm\n test  ", path: "ignored" }),
    "npm test"
  );
  assert.equal(
    describeTool("bash", { command: 42, path: "script.sh" }),
    "script.sh"
  );
  assert.equal(
    describeTool("custom", { command: "ignored", path: "target.txt" }),
    "target.txt"
  );
  assert.equal(
    describeTool("grep", { pattern: " user\\s+ id ", path: "src" }),
    "user\\s+ id in src"
  );
  assert.equal(describeTool("grep", { pattern: "  TODO\nitem " }), "TODO item");
  assert.equal(
    describeTool("find", { pattern: " *.ts ", path: " test " }),
    "*.ts in test"
  );
  assert.equal(
    describeTool("find", { pattern: 7, name: "fallback" }),
    "fallback"
  );
  assert.equal(
    describeTool("custom", { pattern: "ignored", path: "target.txt" }),
    "target.txt"
  );
  assert.equal(describeTool("read", { path: "  src/a.ts\n" }), "src/a.ts");
  assert.equal(describeTool("custom", { name: "  deploy job " }), "deploy job");
  assert.equal(
    describeTool("custom", { limit: 10, hidden: true }),
    "custom (limit, hidden)"
  );
  assert.equal(describeTool("custom", {}), "custom");
});

test("summarizeToolActivity reports running and basic successful activity", () => {
  assert.equal(summarizeToolActivity("mcp", {}, "running"), "· mcp");
  assert.equal(
    summarizeToolActivity("mcp", { name: "mcp" }, "running"),
    "· mcp"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "success", {
      content: [{ type: "text", text: "a\nb" }],
    }),
    "✓ read a.ts → 2 lines"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "nullable.ts" }, "success", {
      content: [undefined, { type: "text", text: "a\nb" }],
    }),
    "✓ read nullable.ts → 2 lines"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "empty.ts" }, "success", {}),
    "✓ read empty.ts → 1 lines"
  );
  assert.equal(
    summarizeToolActivity(
      "bash",
      { command: "npm test" },
      "success",
      {},
      2_100
    ),
    "✓ bash npm test → done in 2s"
  );
  assert.equal(
    summarizeToolActivity("custom", { name: "job" }, "success", {}),
    "✓ custom job → done"
  );
  assert.equal(
    summarizeToolActivity(
      "custom",
      { path: "job", content: "not a write" },
      "success",
      {}
    ),
    "✓ custom job → done"
  );
});

test("summarizeToolActivity counts writes and edit diff changes", () => {
  assert.equal(
    summarizeToolActivity(
      "write",
      { path: "empty", content: "" },
      "success",
      {}
    ),
    "✓ write empty → 0 lines"
  );
  assert.equal(
    summarizeToolActivity(
      "write",
      { path: "one", content: "hello" },
      "success",
      {}
    ),
    "✓ write one → 1 line"
  );
  assert.equal(
    summarizeToolActivity(
      "write",
      { path: "two", content: "hello\nworld\n" },
      "success",
      {}
    ),
    "✓ write two → 2 lines"
  );
  assert.equal(
    summarizeToolActivity("write", { path: "unknown" }, "success", {}),
    "✓ write unknown → done"
  );

  const diff =
    "--- a/file.ts\n+++ b/file.ts\n-old\n-obsolete\n+new\n+extra\n context";
  assert.equal(
    summarizeToolActivity("edit", { path: "file.ts" }, "success", {
      details: { diff },
    }),
    "✓ edit file.ts → +2/-2"
  );
  assert.equal(
    summarizeToolActivity("edit", { path: "file.ts" }, "success", {}),
    "✓ edit file.ts → applied"
  );
});

test("summarizeToolActivity counts search and listing results", () => {
  assert.equal(
    summarizeToolActivity("grep", { pattern: "x", path: "src" }, "success", {
      content: [
        { type: "text", text: "a.ts:1:x\na.ts:3:x\nb.ts:2:x\nsummary" },
      ],
    }),
    "✓ grep x in src → 3 matches in 2 files"
  );
  assert.equal(
    summarizeToolActivity("grep", { pattern: "x" }, "success", {
      content: [{ type: "text", text: "a.ts:1:x" }],
    }),
    "✓ grep x → 1 match in 1 file"
  );
  assert.equal(
    summarizeToolActivity("grep", { pattern: "x" }, "success", {
      content: [{ type: "text", text: "No matches found" }],
    }),
    "✓ grep x → 0 matches in 0 files"
  );
  assert.equal(
    summarizeToolActivity("grep", { pattern: "x" }, "success", {
      content: [{ type: "text", text: " \nNo matches found\na.ts:1:x" }],
    }),
    "✓ grep x → 0 matches in 0 files"
  );
  assert.equal(
    summarizeToolActivity("find", { pattern: "*.ts" }, "success", {
      content: [{ type: "text", text: "a.ts" }],
    }),
    "✓ find *.ts → 1 file"
  );
  assert.equal(
    summarizeToolActivity("find", { pattern: "*.ts" }, "success", {
      content: [{ type: "text", text: "a.ts\n\nb.ts" }],
    }),
    "✓ find *.ts → 2 files"
  );
  assert.equal(
    summarizeToolActivity("ls", { path: "src" }, "success", {
      content: [{ type: "text", text: "file.ts" }],
    }),
    "✓ ls src → 1 entry"
  );
  assert.equal(
    summarizeToolActivity("ls", { path: "src" }, "success", {
      content: [{ type: "text", text: "file.ts\nlib/" }],
    }),
    "✓ ls src → 2 entries"
  );
});

test("summarizeToolActivity selects useful error messages", () => {
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "error", {
      content: [{ type: "image" }, { type: "text", text: "not found\nstack" }],
      error: "ignored",
    }),
    "✗ read a.ts → not found"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "error", {
      error: "permission denied",
    }),
    "✗ read a.ts → permission denied"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "error", {
      message: "bad request",
    }),
    "✗ read a.ts → bad request"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "error", {
      details: { error: "disk failure" },
    }),
    "✗ read a.ts → disk failure"
  );
  assert.equal(
    summarizeToolActivity("read", { path: "a.ts" }, "error", {}),
    "✗ read a.ts → error"
  );
  assert.equal(
    summarizeToolActivity(
      "bash",
      { command: "npm test" },
      "error",
      { error: "ignored" },
      61_000
    ),
    "✗ bash npm test → error in 1m 01s"
  );
});

test("buildToolActivityBlock renders public reasoning and terminal state", () => {
  assert.deepEqual(
    plainBlock(
      buildToolActivityBlock(
        "read",
        { path: "a.ts", reasoning: "inspect auth state" },
        "success",
        { content: [{ type: "text", text: "a\nb" }] }
      )
    ),
    ["✓ 📖 read inspect auth state", "  a.ts → 2 lines"]
  );
  assert.deepEqual(
    plainBlock(
      buildToolActivityBlock(
        "bash",
        { command: "npm test", reasoning: "run the suite" },
        "error",
        { content: [{ type: "text", text: "Command failed" }] },
        2_100
      )
    ),
    ["✗ ⚡ bash run the suite", "  npm test → error in 2s"]
  );
  assert.deepEqual(
    plainBlock(
      buildToolActivityBlock(
        "grep",
        { pattern: "x", path: "src", reasoning: "  " },
        "running"
      )
    ),
    ["· 📖 grep x in src", "  x in src → running"]
  );
  assert.deepEqual(
    plainBlock(
      buildToolActivityBlock("read", { path: "a.ts" }, "error", {
        message: "not readable",
      })
    ),
    ["✗ 📖 read a.ts", "  a.ts → not readable"]
  );
  assert.deepEqual(plainBlock(buildToolActivityBlock("", {}, "running")), [
    "· ◆ ",
    "  → running",
  ]);
});
