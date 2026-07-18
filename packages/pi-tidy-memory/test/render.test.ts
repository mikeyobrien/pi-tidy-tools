import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryToolComponent, renderMemoryLines } from "../render.js";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

test("renders one compact settled line", () => {
  const lines = renderMemoryLines(
    "recall",
    { query: "deployment preferences" },
    {
      operation: "recall",
      memories: [{ id: "1", text: "Use GitOps", kind: "world" }],
    },
    false,
    false,
    false
  );
  assert.equal(lines.length, 1);
  assert.match(
    plain(lines[0]),
    /✓ 🧠 recall deployment preferences → 1 memories/
  );
});

test("render state matrix has exact stable text", () => {
  const cases: Array<{
    input: Parameters<typeof renderMemoryLines>;
    expected: string[];
  }> = [
    {
      input: ["recall", { query: "q" }, undefined, false, true, false],
      expected: ["  ┊ · 🧠 recall q → working"],
    },
    {
      input: ["recall", { query: "q" }, undefined, false, false, true],
      expected: ["  ┊ ✗ 🧠 recall q → failed"],
    },
    {
      input: [
        "recall",
        { query: "q" },
        { operation: "recall", memories: [] },
        false,
        false,
        false,
      ],
      expected: ["  ┊ ✓ 🧠 recall q → 0 memories"],
    },
    {
      input: [
        "retain",
        { content: "fact" },
        {
          operation: "retain",
          accepted: 2,
          deferred: true,
          operationId: "op",
        },
        true,
        false,
        false,
      ],
      expected: [
        "  ┊ ✓ 🧠 retain fact → 2 accepted; queued",
        "  ┊     operation op",
      ],
    },
    {
      input: [
        "reflect",
        { query: "why" },
        {
          operation: "reflect",
          reflectedText: "a\nb",
          memories: [{ id: "1", kind: "world", text: "fact" }],
        },
        true,
        false,
        false,
      ],
      expected: [
        "  ┊ ✓ 🧠 reflect why → synthesized",
        "  ┊     [world] fact",
        "  ┊     a",
        "  ┊     b",
      ],
    },
    {
      input: ["reflect", {}, undefined, false, false, false],
      expected: ["  ┊ ✓ 🧠 reflect memory → done"],
    },
  ];
  for (const { input, expected } of cases) {
    assert.deepEqual(renderMemoryLines(...input).map(plain), expected);
  }
});

test("expanded cards show bounded normalized details", () => {
  const lines = renderMemoryLines(
    "reflect",
    { query: "why" },
    {
      operation: "reflect",
      reflectedText: "line one\nline two",
      memories: [{ id: "1", text: "fact" }],
    },
    true,
    false,
    false
  ).map(plain);
  assert.match(lines[0], /synthesized/);
  assert(lines.some((line) => line.includes("fact")));
  assert(lines.some((line) => line.includes("line one")));
});

test("expanded backend fields cannot emit terminal control sequences", () => {
  const lines = renderMemoryLines(
    "recall",
    {},
    {
      operation: "recall",
      memories: [
        { id: "1", kind: "world\u001b]52;c;kind\u0007", text: "safe" },
      ],
      operationId: "op\u001b]52;c;id\u0007",
    },
    true,
    false,
    false
  ).join("\n");
  assert.doesNotMatch(lines, /\u001b\]52|kind\u0007|id\u0007/);
});

test("expanded detail limits are exact", () => {
  const memories = Array.from({ length: 21 }, (_, index) => ({
    id: String(index),
    text: `fact-${index}`,
  }));
  const recall = renderMemoryLines(
    "recall",
    { query: "q" },
    { operation: "recall", memories },
    true,
    false,
    false
  )
    .map(plain)
    .join("\n");
  assert.match(recall, /fact-19/);
  assert.doesNotMatch(recall, /fact-20/);

  const reflection = renderMemoryLines(
    "reflect",
    { query: "q" },
    {
      operation: "reflect",
      reflectedText: Array.from(
        { length: 31 },
        (_, index) => `line-${index}`
      ).join("\n"),
    },
    true,
    false,
    false
  )
    .map(plain)
    .join("\n");
  assert.match(reflection, /line-29/);
  assert.doesNotMatch(reflection, /line-30/);
});

test("component truncates to live width and paints every line", () => {
  const component = new MemoryToolComponent(
    "retain",
    { content: "a very long durable preference that cannot fit" },
    { operation: "retain", accepted: 1, deferred: true, operationId: "op1" },
    true,
    false,
    false,
    (value) => `BG(${value})`
  );
  const lines = component.render(28);
  assert(lines.length >= 2);
  assert(lines.every((line) => line.startsWith("BG(")));
  assert(
    lines.every(
      (line) =>
        visibleWidth(line.replaceAll("BG(", "").replaceAll(")", "")) === 28
    )
  );
  const minimum = component.render(0);
  assert(minimum.every((line) => line.includes("BG(")));
  assert(
    minimum.every(
      (line) =>
        visibleWidth(line.replaceAll("BG(", "").replaceAll(")", "")) === 1
    )
  );
});
