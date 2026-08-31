import assert from "node:assert/strict";
import test from "node:test";
import {
  groupConsecutiveTools,
  summarizeToolGroup,
  TurnPartsAccumulator,
} from "../src/turnparts.ts";

test("turn parts keep true chronological order across text/tool interleave", () => {
  const acc = new TurnPartsAccumulator();
  acc.appendText("Checking the fleet. ");
  acc.startTool({ toolCallId: "t1", tool: "bash", label: "ls -la" });
  acc.settleTool("t1", { isError: false, duration: 12 });
  acc.appendText("Fleet looks fine. ");
  acc.startTool({ toolCallId: "t2", tool: "message_agent", label: "→ forge" });
  acc.settleTool("t2", { isError: false });
  acc.appendText("Delegated.");

  const types = acc.parts.map((p) => p.type).join(",");
  assert.equal(types, "text,tool,text,tool,text", "interleave is data");
  assert.equal(
    acc.concatText(),
    "Checking the fleet. Fleet looks fine. Delegated."
  );
});

test("streaming deltas replace the trailing text part, never split words", () => {
  const acc = new TurnPartsAccumulator();
  acc.startTool({ toolCallId: "t1", tool: "bash", label: "ls" });
  acc.settleTool("t1", { isError: false });
  acc.appendText("Hel");
  acc.appendText("lo w");
  acc.appendText("orld");
  assert.deepEqual(
    acc.parts.map((p) => (p.type === "text" ? p.text : p.type)),
    ["tool", "Hello world"],
    "one text part, cumulative replace semantics"
  );
});

test("tool updates match by toolCallId and cap output", () => {
  const acc = new TurnPartsAccumulator();
  acc.startTool({ toolCallId: "a", tool: "bash", label: "one" });
  acc.startTool({ toolCallId: "b", tool: "bash", label: "two" });
  acc.updateToolOutput("b", "x".repeat(5000));
  acc.settleTool("b", {
    isError: true,
    duration: 5,
    output: "boom".repeat(1000),
  });
  const parts = acc.snapshot();
  const a = parts[0];
  const b = parts[1];
  if (a.type !== "tool" || b.type !== "tool") throw new Error("shape");
  assert.equal(a.status, "running");
  assert.equal(b.status, "error");
  assert.equal(b.duration, 5);
  assert.ok(b.output !== undefined && b.output.length <= 1200, "output capped");
});

test("groupConsecutiveTools collapses runs and splits on text", () => {
  const acc = new TurnPartsAccumulator();
  acc.startTool({ toolCallId: "1", tool: "bash", label: "a" });
  acc.startTool({ toolCallId: "2", tool: "edit", label: "plan.md" });
  acc.appendText("between");
  acc.startTool({ toolCallId: "3", tool: "bash", label: "c" });
  acc.appendText("after");
  const groups = groupConsecutiveTools(acc.snapshot());
  assert.equal(groups.length, 4);
  assert.equal(groups[0].type, "toolgroup");
  assert.equal(groups[1].type, "text");
  assert.equal(groups[2].type, "toolgroup");
  assert.equal(groups[3].type, "text");
  if (groups[0].type === "toolgroup" && groups[2].type === "toolgroup") {
    assert.deepEqual(
      groups[0].tools.map((t) => t.label),
      ["a", "plan.md"]
    );
    assert.deepEqual(
      groups[2].tools.map((t) => t.label),
      ["c"]
    );
  }
});

test("summarizeToolGroup renders the natural-language badge", () => {
  assert.equal(
    summarizeToolGroup([
      { type: "tool", toolCallId: "1", tool: "bash", status: "ok" },
      { type: "tool", toolCallId: "2", tool: "edit", status: "ok" },
      { type: "tool", toolCallId: "3", tool: "bash", status: "error" },
    ]),
    "3 tools · 2 ok · 1 err"
  );
  assert.equal(
    summarizeToolGroup([
      { type: "tool", toolCallId: "1", tool: "bash", status: "running" },
    ]),
    "1 tool · 1 running"
  );
});

test("startTool is idempotent by toolCallId (replay dedupe)", () => {
  const acc = new TurnPartsAccumulator();
  acc.startTool({ toolCallId: "t9", tool: "bash", label: "first" });
  acc.startTool({
    toolCallId: "t9",
    tool: "bash",
    label: "second",
    reason: "re-run",
  });
  assert.equal(acc.parts.length, 1, "no duplicate tool part");
  const part = acc.parts[0];
  if (part.type !== "tool") throw new Error("shape");
  assert.equal(part.label, "second", "label updates in place");
  assert.equal(part.reason, "re-run");
});

test("forceSettleRunning clears running claims at settle", () => {
  const acc = new TurnPartsAccumulator();
  acc.startTool({ toolCallId: "1", tool: "bash", label: "x" });
  acc.startTool({ toolCallId: "2", tool: "edit", label: "y" });
  acc.settleTool("1", { isError: false, duration: 3 });
  acc.forceSettleRunning();
  const states = acc
    .snapshot()
    .map((p) => (p.type === "tool" ? p.status : "text"));
  assert.deepEqual(states, ["ok", "error"], "running clears at settle");
});
