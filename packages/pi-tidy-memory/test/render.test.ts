import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryToolComponent, renderMemoryLines } from "../render.js";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

test("renders one compact settled why-and-result block", () => {
  const lines = renderMemoryLines(
    "recall",
    {
      reasoning: "restore deployment context",
      query: "deployment preferences",
    },
    {
      operation: "recall",
      memories: [{ id: "1", text: "Use GitOps", kind: "world" }],
    },
    false,
    false,
    false
  );
  assert.deepEqual(lines.map(plain), [
    "🧠 recall restore deployment context",
    "  deployment preferences → 1 memory",
  ]);
});

test("matches the pi-tidy left-edge state-mark contract", () => {
  const pending = renderMemoryLines(
    "recall",
    { reasoning: "restore relevant context", query: "q" },
    undefined,
    false,
    true,
    false
  )
    .map(plain)
    .join("\n");
  const success = renderMemoryLines(
    "recall",
    { reasoning: "restore relevant context", query: "q" },
    { operation: "recall", memories: [] },
    false,
    false,
    false
  )
    .map(plain)
    .join("\n");
  const failure = renderMemoryLines(
    "recall",
    { reasoning: "restore relevant context", query: "q" },
    undefined,
    false,
    false,
    true
  )
    .map(plain)
    .join("\n");

  assert.equal(pending, "· 🧠 recall restore relevant context\n  q → working");
  assert.equal(success, "🧠 recall restore relevant context\n  q → 0 memories");
  assert.equal(failure, "🧠 recall restore relevant context\n  q → failed");
  assert.doesNotMatch(`${pending}\n${success}\n${failure}`, /┊|✓|✗/);
});

test("legacy arguments without reasoning avoid duplicate target text", () => {
  const lines = renderMemoryLines(
    "recall",
    { query: "q" },
    { operation: "recall", memories: [] },
    false,
    false,
    false
  ).map(plain);
  assert.deepEqual(lines, ["🧠 recall q", "  → 0 memories"]);
});

test("defensively bounds malformed reasoning to twelve compact words", () => {
  const lines = renderMemoryLines(
    "recall",
    {
      reasoning: "a b c d e f g h i j k l m\nignored",
      query: "history",
    },
    { operation: "recall", memories: [] },
    false,
    false,
    false
  ).map(plain);
  assert.equal(lines[0], "🧠 recall a b c d e f g h i j k l");
  assert.doesNotMatch(lines.join("\n"), /\bm\b|ignored/);
});

test("render state matrix has exact stable text", () => {
  const cases: Array<{
    input: Parameters<typeof renderMemoryLines>;
    expected: string[];
  }> = [
    {
      input: [
        "recall",
        { reasoning: "restore context", query: "q" },
        undefined,
        false,
        true,
        false,
      ],
      expected: ["· 🧠 recall restore context", "  q → working"],
    },
    {
      input: [
        "recall",
        { reasoning: "restore context", query: "q" },
        undefined,
        false,
        false,
        true,
      ],
      expected: ["🧠 recall restore context", "  q → failed"],
    },
    {
      input: [
        "recall",
        { reasoning: "restore context", query: "q" },
        { operation: "recall", memories: [] },
        false,
        false,
        false,
      ],
      expected: ["🧠 recall restore context", "  q → 0 memories"],
    },
    {
      input: [
        "retain",
        { reasoning: "store durable decision", content: "fact" },
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
        "🧠 retain store durable decision",
        "  fact → 2 accepted; queued",
        "    operation op",
      ],
    },
    {
      input: [
        "reflect",
        { reasoning: "explain repeated failures", query: "why" },
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
        "🧠 reflect explain repeated failures",
        "  why → synthesized",
        "    [world] fact",
        "    a",
        "    b",
      ],
    },
    {
      input: ["reflect", {}, undefined, false, false, false],
      expected: ["🧠 reflect memory", "  → done"],
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
  assert.match(lines[1], /synthesized/);
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

test("credential-shaped values never reach collapsed expanded or painted output", () => {
  const secret = "SECRET_SYNTHETIC_987654321";
  const args = {
    reasoning: `recover token=${secret}`,
    query: `api_key=${secret}`,
  };
  const details = {
    operation: "reflect" as const,
    memories: [
      {
        id: "1",
        kind: `secret=${secret}`,
        text: `{"password":"${secret}"}`,
      },
    ],
    reflectedText: `Authorization: Bearer ${secret}`,
    operationId: `token=${secret}`,
  };
  const pending = renderMemoryLines(
    "reflect",
    args,
    undefined,
    false,
    true,
    false
  );
  const expanded = renderMemoryLines(
    "reflect",
    args,
    details,
    true,
    false,
    false
  );
  const painted = new MemoryToolComponent(
    "reflect",
    args,
    details,
    true,
    false,
    false,
    (value) => `bg(${value})`
  ).render(200);
  const output = [...pending, ...expanded, ...painted].join("\n");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /redacted/);
});

test("errors show a bounded actionable redacted reason", () => {
  const secret = "SECRET_SYNTHETIC_987654321";
  const lines = renderMemoryLines(
    "recall",
    { reasoning: "restore context", query: "q" },
    {
      operation: "recall",
      error: `permission denied token=${secret}`,
    },
    false,
    false,
    true
  ).map(plain);
  assert.deepEqual(lines, [
    "🧠 recall restore context",
    "  q → permission denied token=[redacted]",
  ]);
  assert.doesNotMatch(lines.join("\n"), new RegExp(secret));
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
    {
      reasoning: "preserve operator preference",
      content: "a very long durable preference that cannot fit",
    },
    { operation: "retain", accepted: 1, deferred: true, operationId: "op1" },
    true,
    false,
    false,
    (value) => `BG(${value})`
  );
  const exactWidthCases = [
    {
      width: 80,
      expected: [
        "🧠 retain preserve operator preference",
        "  a very long durable preference that cannot fit → 1 accepted; queued",
        "    operation op1",
      ],
    },
    {
      width: 32,
      expected: [
        "🧠 retain preserve operator pre…",
        "  a very l… → 1 accepted; queued",
        "    operation op1",
      ],
    },
    {
      width: 24,
      expected: [
        "🧠 retain preserve oper…",
        "  … → 1 accepted; queued",
        "    operation op1",
      ],
    },
  ];
  for (const { width, expected } of exactWidthCases) {
    const rendered = component.render(width);
    assert(rendered.every((line) => line.startsWith("BG(")));
    assert(
      rendered.every(
        (line) =>
          visibleWidth(line.replaceAll("BG(", "").replaceAll(")", "")) === width
      )
    );
    assert.deepEqual(
      rendered.map((line) =>
        plain(line.replaceAll("BG(", "").replaceAll(")", "")).trimEnd()
      ),
      expected
    );
  }

  const boundedTarget = "x".repeat(80);
  const boundaryLines = renderMemoryLines(
    "retain",
    { content: `${boundedTarget}SENTINEL` },
    { operation: "retain", accepted: 1 },
    false,
    false,
    false
  ).map(plain);
  assert.equal(boundaryLines[0], `🧠 retain ${boundedTarget}`);
  assert.doesNotMatch(boundaryLines.join("\n"), /SENTINEL/);

  const lines = component.render(28);
  assert(lines.length >= 2);
  assert(lines.every((line) => line.startsWith("BG(")));
  assert(
    lines.every(
      (line) =>
        visibleWidth(line.replaceAll("BG(", "").replaceAll(")", "")) === 28
    )
  );
  assert.match(
    plain(lines[1].replaceAll("BG(", "").replaceAll(")", "")).trimEnd(),
    /→ 1 accepted; queued$/
  );
  const outcomeOnly = component.render(12);
  assert.match(
    plain(outcomeOnly[1].replaceAll("BG(", "").replaceAll(")", "")).trimEnd(),
    /^→ 1 accepte…$/
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
