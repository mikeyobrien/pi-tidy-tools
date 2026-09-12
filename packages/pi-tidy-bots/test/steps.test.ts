import assert from "node:assert/strict";
import test from "node:test";
import { stepReason } from "../src/rpc.ts";

test("stepReason uses only explicitly supplied purpose", () => {
  assert.equal(
    stepReason({ command: "pwd", reasoning: "confirm cwd" }),
    "confirm cwd"
  );
  assert.equal(stepReason({ command: "ls -la" }), "");
  assert.equal(stepReason({ path: "/tmp/x.log" }), "");
  assert.equal(
    stepReason(
      { target: "mason", message: "private body", reason: "review the fix" },
      "message_agent"
    ),
    "review the fix"
  );
  assert.equal(
    stepReason({ target: "mason", message: "private body" }, "message_agent"),
    ""
  );
  assert.equal(
    stepReason({ reasoning: "explicit reasoning", reason: "secondary reason" }),
    "explicit reasoning"
  );
  assert.equal(stepReason({}), "");
});

test("stepReason ignores non-string values", () => {
  assert.equal(stepReason({ limit: 10, query: "errors" }), "");
});

test("stepLabel maps tool args to compact digests", async () => {
  const { stepLabel } = await import("../src/rpc.ts");
  // message_agent: target only — never the message body.
  assert.equal(
    stepLabel("message_agent", {
      target: "forge",
      message: "long briefing body that must not leak",
    }),
    "→ forge"
  );
  // File tools: basename of the path argument.
  assert.equal(
    stepLabel("edit", { file_path: "/Users/rook/fleet/config.toml" }),
    "✎ config.toml"
  );
  assert.equal(stepLabel("write", { path: "docs/notes/plan.md" }), "✎ plan.md");
  assert.equal(stepLabel("read", { file_path: "x" }), "✎ x");
  // Neither command text nor arbitrary input is a safe collapsed label.
  assert.equal(stepLabel("bash", { command: "TOKEN=secret run" }), undefined);
  assert.equal(stepLabel("search", { query: "private query" }), undefined);
  // No args: no label (console falls back to bare name).
  assert.equal(stepLabel("bash", undefined), undefined);
  assert.equal(stepLabel("bash", {}), undefined);
});
