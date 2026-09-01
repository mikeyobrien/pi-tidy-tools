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

test("issue 49 follow-up: compact refusal on a small session is not a fatal", () => {
  // A forced compact on a small session: pi refuses; the daemon must treat
  // the refusal as a noop success, never a 500.
  assert.equal(
    classifyFailure("Nothing to compact (session too small)"),
    "delivery_failed",
    "the refusal is a clean noop, not offline/port/usage"
  );
});

test("issue 50: a busy child is turn_in_flight, never runtime_offline", () => {
  const busy =
    'rpc command failed: {"success":false,"error":"Agent is already processing. Specify streamingBehavior (\'steer\' or \'followUp\') to queue the message."}';
  const reason = classifyFailure(busy);
  assert.equal(reason, "turn_in_flight");
  assert.notEqual(reason, "runtime_offline", "busy is not dead");
  // The handler contract: alive-but-busy queues (202), dead queues on spawn,
  // and runtime_offline is reserved for sessions that are actually gone.
  assert.equal(classifyFailure("rpc child is not running"), "runtime_offline");
});
