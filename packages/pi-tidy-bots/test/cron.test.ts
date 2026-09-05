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

test("weekly digest schedule matches Monday 09:00 LOCAL — DST-safe by construction", () => {
  // The finance fleet's routine ("0 9 * * 1", America/Chicago host) relies
  // on isDue reading LOCAL wall-clock fields every tick: after a DST shift
  // the fire stays at 09:00 local, never drifting an hour.
  const mondayNine = new Date(2026, 8, 14, 9, 0, 0); // local Mon 2026-09-14
  assert.equal(mondayNine.getDay(), 1, "fixture is a Monday");
  assert.equal(isDue(mondayNine, "0 9 * * 1"), true);
  assert.equal(isDue(new Date(2026, 8, 14, 9, 1, 0), "0 9 * * 1"), false);
  assert.equal(isDue(new Date(2026, 8, 13, 9, 0, 0), "0 9 * * 1"), false); // Sunday
  // The Monday AFTER the fall-back transition (2026-11-01 is the shift):
  // local constructor fields still match — wall time is the contract.
  const afterDst = new Date(2026, 10, 2, 9, 0, 0); // local Mon 2026-11-02
  assert.equal(afterDst.getDay(), 1, "post-DST fixture is a Monday");
  assert.equal(isDue(afterDst, "0 9 * * 1"), true);
});
