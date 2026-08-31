import assert from "node:assert/strict";
import test from "node:test";
import { stepReason } from "../src/rpc.ts";

test("stepReason picks the most readable argument", () => {
  assert.equal(
    stepReason({ command: "pwd", reasoning: "confirm cwd" }),
    "confirm cwd"
  );
  assert.equal(stepReason({ command: "ls -la" }), "ls -la");
  assert.equal(stepReason({ path: "/tmp/x.log" }), "/tmp/x.log");
  assert.equal(stepReason({}), "");
});

test("stepReason ignores non-string values", () => {
  assert.equal(stepReason({ limit: 10, query: "errors" }), "errors");
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
  // bash: first ~60 chars of the command, newlines flattened.
  const long = "for f in $(ls); do echo $f; done; echo done; echo more; echo x";
  const label = stepLabel("bash", { command: long });
  assert.equal(label?.startsWith(long.slice(0, 58)), true);
  assert.equal(label?.includes("…"), true);
  assert.equal(
    stepLabel("bash", { command: "echo a\necho b" }),
    "echo a echo b"
  );
  // Default: first ~40 chars of stringified args.
  const def = stepLabel("search", { query: "x".repeat(80) });
  assert.equal(def?.startsWith('{"query":"x'), true);
  assert.ok((def?.length ?? 0) <= 42);
  // No args: no label (console falls back to bare name).
  assert.equal(stepLabel("bash", undefined), undefined);
  assert.equal(stepLabel("bash", {}), undefined);
});
