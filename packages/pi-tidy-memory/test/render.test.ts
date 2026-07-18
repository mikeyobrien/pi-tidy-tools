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
        visibleWidth(line.replaceAll("BG(", "").replaceAll(")", "")) <= 28
    )
  );
});
