import assert from "node:assert/strict";
import test from "node:test";
import { fallbackGenerateDiffString } from "../host-diff.js";

test("the local diff fallback reports an added and removed line", () => {
  const diff = fallbackGenerateDiffString("alpha\n", "beta\n");
  assert.match(diff.diff, /-1 alpha/);
  assert.match(diff.diff, /\+1 beta/);
  assert.equal(diff.firstChangedLine, 1);
});
