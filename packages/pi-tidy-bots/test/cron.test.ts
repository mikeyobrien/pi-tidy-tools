import assert from "node:assert/strict";
import test from "node:test";
import { isDue, parseCron, minuteKey } from "../src/cron.ts";

test("cron matches minute, hour, wildcard fields", () => {
  const due = new Date(2026, 7, 31, 8, 0);
  assert.ok(isDue(due, "0 8 * * *"));
  assert.ok(!isDue(new Date(2026, 7, 31, 8, 1), "0 8 * * *"));
});

test("step and list fields", () => {
  assert.ok(isDue(new Date(2026, 7, 31, 8, 10), "*/5 * * * *"));
  assert.ok(!isDue(new Date(2026, 7, 31, 8, 12), "*/5 * * * *"));
  assert.ok(isDue(new Date(2026, 7, 31, 8, 0), "0 8,20 31 * *"));
  assert.throws(() => parseCron("* * * *"), /5 fields/);
});

test("minuteKey is stable and zero-padded", () => {
  assert.equal(minuteKey(new Date(2026, 7, 9, 8, 5)), "2026-08-09 08:05");
});
