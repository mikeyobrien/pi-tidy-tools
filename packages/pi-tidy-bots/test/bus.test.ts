import assert from "node:assert/strict";
import test from "node:test";
import { coerceBusBehavior } from "../src/daemon.ts";

test("coerceBusBehavior accepts the enum values and omission", () => {
  assert.deepEqual(coerceBusBehavior(undefined), {
    ok: true,
    behavior: undefined,
  });
  assert.deepEqual(coerceBusBehavior("steer"), { ok: true, behavior: "steer" });
  assert.deepEqual(coerceBusBehavior("followUp"), {
    ok: true,
    behavior: "followUp",
  });
});

test("coerceBusBehavior rejects anything outside the enum", () => {
  assert.equal(coerceBusBehavior("interrupt").ok, false);
  assert.equal(coerceBusBehavior("Steer").ok, false);
  assert.equal(coerceBusBehavior("").ok, false);
  assert.equal(coerceBusBehavior(7).ok, false);
  assert.equal(coerceBusBehavior(null).ok, false);
});
