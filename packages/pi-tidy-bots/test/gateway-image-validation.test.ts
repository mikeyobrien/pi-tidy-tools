import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { decodeArtifactUploads } from "../src/gateway/artifacts.ts";
import { validateImage } from "../src/gateway/image-validation.ts";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");
const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
const png: Buffer = PNG.sync.write({ width: 2, height: 1, data: pixels });
const jpg: Buffer = jpeg.encode({ width: 2, height: 1, data: pixels }, 80).data;

for (const [mediaType, bytes] of [
  ["image/png", png],
  ["image/jpeg", jpg],
] as const) {
  test(`image admission decodes ${mediaType} and retains original bytes`, async () => {
    const [upload] = await decodeArtifactUploads([
      { mediaType, data: bytes.toString("base64") },
    ]);
    assert.deepEqual(upload.bytes, bytes);
    assert.equal(upload.mediaType, mediaType);
  });
  test(`image admission rejects truncated ${mediaType}`, async () => {
    await assert.rejects(
      validateImage(bytes.subarray(0, bytes.length - 5), mediaType)
    );
  });
}
test("image admission rejects a forged MIME type, damaged CRC and oversized dimensions", async () => {
  await assert.rejects(validateImage(png, "image/jpeg"));
  const corrupt = Buffer.from(png);
  corrupt[29] ^= 1;
  await assert.rejects(validateImage(corrupt, "image/png"));
  const huge = Buffer.from(png);
  huge.writeUInt32BE(0x7fffffff, 16);
  await assert.rejects(validateImage(huge, "image/png"));
});
test("image admission refuses animated PNG instead of silently dropping frames", async () => {
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8);
  animation.write("acTL", 4);
  await assert.rejects(
    validateImage(
      Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]),
      "image/png"
    )
  );
});
test("image worker concurrency is bounded and capacity returns after settlement", async () => {
  const first = validateImage(png, "image/png");
  const second = validateImage(jpg, "image/jpeg");
  await assert.rejects(
    validateImage(png, "image/png"),
    (error: any) => error.code === "media_busy"
  );
  await Promise.all([first, second]);
  await validateImage(png, "image/png");
});
