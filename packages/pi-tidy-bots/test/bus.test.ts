import assert from "node:assert/strict";
import test from "node:test";
import { coerceBusBehavior, coerceMessageImages } from "../src/daemon.ts";

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

test("coerceMessageImages accepts one image and omission", () => {
  assert.deepEqual(coerceMessageImages(undefined), {
    ok: true,
    images: undefined,
  });
  assert.deepEqual(coerceMessageImages([]), { ok: true, images: undefined });
  const single = coerceMessageImages([
    { mediaType: "image/png", data: "aGk=" },
  ]);
  assert.equal(single.ok, true);
  if (single.ok)
    assert.deepEqual(single.images, [
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
});

test("coerceMessageImages rejects multi, empty, and malformed payloads", () => {
  assert.equal(
    coerceMessageImages([
      { mediaType: "image/png", data: "aGk=" },
      { mediaType: "image/png", data: "aGk=" },
    ]).ok,
    false,
    "cap: one image per message"
  );
  assert.equal(
    coerceMessageImages([{ mediaType: "", data: "aGk=" }]).ok,
    false
  );
  assert.equal(coerceMessageImages([{ mediaType: "image/png" }]).ok, false);
  assert.equal(coerceMessageImages(["nope"]).ok, false);
  assert.equal(coerceMessageImages("image.png").ok, false);
});
