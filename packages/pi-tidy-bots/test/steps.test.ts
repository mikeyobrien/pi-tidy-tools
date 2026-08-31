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
