import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeArtifactUploads,
  MAX_PUBLIC_ARTIFACT_BYTES,
} from "../src/gateway/artifacts.ts";

test("text uploads preserve Unicode bytes and a supplied filename", async () => {
  const bytes = Buffer.from("🦋 café\n");
  const [upload] = await decodeArtifactUploads([
    {
      mediaType: "text/plain",
      name: "note.txt",
      data: bytes.toString("base64"),
    },
  ]);
  assert.deepEqual(upload.bytes, bytes);
  assert.equal(upload.name, "note.txt");
});
for (const [name, upload] of Object.entries({
  "noncanonical base64": { mediaType: "text/plain", data: "YQ" },
  "binary disguised as text": {
    mediaType: "text/plain",
    data: Buffer.from([0, 1, 2]).toString("base64"),
  },
  "invalid UTF8": {
    mediaType: "text/plain",
    data: Buffer.from([0xff]).toString("base64"),
  },
  "unvalidated format": { mediaType: "image/gif", data: "YQ==" },
  "path override": {
    mediaType: "text/plain",
    data: "YQ==",
    path: "/tmp/private",
  },
  "invalid name": { mediaType: "text/plain", data: "YQ==", name: 42 },
  "oversized bytes": {
    mediaType: "text/plain",
    data: Buffer.alloc(MAX_PUBLIC_ARTIFACT_BYTES + 1, 65).toString("base64"),
  },
})) {
  test(`upload admission rejects ${name}`, () =>
    assert.rejects(() => decodeArtifactUploads([upload])));
}
