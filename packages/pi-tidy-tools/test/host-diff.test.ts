import assert from "node:assert/strict";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { hasHostDiff, hostGenerateDiffString } from "../host-diff.js";

test("the host's own diff implementation is preferred where it exists", () => {
  // A local reimplementation is not output-equivalent to the host's: the two
  // can attribute a changed line to different sides of a hunk. Whenever the
  // host exports one, that implementation must be the one tidy renders.
  assert.equal(hasHostDiff, true);
});

test("diff output matches the host implementation exactly", () => {
  const before = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  const after = "alpha\nBETA\ngamma\ndelta\nepsilon\n";

  assert.deepEqual(
    hostGenerateDiffString(before, after),
    generateDiffString(before, after)
  );
});

test("diff output matches the host on a multi-line change region", () => {
  // Hand-picked substitutions agree between implementations; change regions
  // with adjacent inserts and deletes are where a naive pairing diverges.
  const before = "b\n:\nd\ne\nf\n";
  const after = "d\nx\nd\ne\nf\n";

  assert.deepEqual(
    hostGenerateDiffString(before, after),
    generateDiffString(before, after)
  );
});
