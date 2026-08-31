import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, isRetryable } from "../src/reasons.ts";

test("classifies provider and delivery failures into typed reasons", () => {
  assert.equal(
    classifyFailure("z.ai: quota exceeded for plan"),
    "provider_quota_limit"
  );
  assert.equal(
    classifyFailure("HTTP 429 too many requests"),
    "provider_rate_limit"
  );
  assert.equal(
    classifyFailure("invalid api key provided"),
    "provider_auth_or_access"
  );
  assert.equal(
    classifyFailure("prompt context too large for model"),
    "context_overflow"
  );
  assert.equal(classifyFailure("rpc child is not running"), "runtime_offline");
  assert.equal(
    classifyFailure(
      "rpc command failed: Agent is already processing. Specify streamingBehavior"
    ),
    "turn_in_flight"
  );
  assert.equal(classifyFailure("mystery"), "delivery_failed");
});

test("retry policy: only transient reasons retry", () => {
  assert.ok(isRetryable("runtime_offline"));
  assert.ok(isRetryable("provider_rate_limit"));
  assert.ok(!isRetryable("provider_quota_limit"));
  assert.ok(!isRetryable("delivery_failed"));
});
