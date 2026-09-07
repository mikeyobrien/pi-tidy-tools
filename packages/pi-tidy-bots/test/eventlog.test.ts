import assert from "node:assert/strict";
import test from "node:test";
import { resolveSinceCursor } from "../src/eventlog.ts";

test("resolveSinceCursor collapses impossible cursors to full replay", () => {
  // Fresh boot: the daemon's counter restarted low while a client kept a
  // high-water mark from a previous generation. 55 > 41 → replay everything.
  assert.equal(resolveSinceCursor(55, 41), 0);
  // Normal continuation: strictly-after semantics preserved.
  assert.equal(resolveSinceCursor(40, 41), 40);
  assert.equal(resolveSinceCursor(0, 41), 0);
  // Garbage cursors degrade to full replay, never to a silent void.
  assert.equal(resolveSinceCursor(Number.NaN, 41), 0);
  assert.equal(resolveSinceCursor(-5, 41), 0);
});
