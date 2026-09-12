import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCompactFailure,
  classifyCompactRefusal,
  classifyFailure,
  isRetryable,
} from "../src/reasons.ts";

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
    classifyCompactRefusal("Nothing to compact (session too small)"),
    "nothing_to_compact"
  );
  assert.equal(
    classifyFailure("Nothing to compact (session too small)"),
    "delivery_failed",
    "the delivery classifier is the wrong layer — compact paths must not use it"
  );
});

test("issue 79: Already compacted is a terminal compact no-op", () => {
  for (const message of [
    "Already compacted",
    'rpc command failed: {"success":false,"error":"Already compacted"}',
    "Native RPC command was rejected: Already compacted",
  ]) {
    assert.equal(classifyCompactRefusal(message), "already_compacted", message);
  }
  assert.equal(classifyCompactRefusal("mystery"), undefined);
  // The delivery classifier still falls through — that is the overnight
  // loop if compact paths forget to consult classifyCompactRefusal first.
  assert.equal(classifyFailure("Already compacted"), "delivery_failed");
  assert.ok(!isRetryable("delivery_failed"));
});

test("abort mid-summarization is summarization_aborted, not delivery_failed", () => {
  const live = "Turn prefix summarization failed: This operation was aborted";
  const rpc = `rpc command failed: {"success":false,"error":"${live}"}`;
  const end =
    "Compaction failed: Turn prefix summarization failed: This operation was aborted";
  assert.equal(classifyCompactFailure(live), "summarization_aborted");
  assert.equal(classifyCompactFailure(rpc), "summarization_aborted");
  assert.equal(classifyCompactFailure(end), "summarization_aborted");
  assert.equal(
    classifyCompactFailure("Already compacted"),
    "already_compacted"
  );
  assert.equal(classifyCompactFailure("mystery"), undefined);
  assert.equal(
    classifyFailure(
      "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."
    ),
    "compaction_in_progress"
  );
  assert.ok(isRetryable("compaction_in_progress"));
  assert.equal(classifyFailure(live), "delivery_failed");
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
