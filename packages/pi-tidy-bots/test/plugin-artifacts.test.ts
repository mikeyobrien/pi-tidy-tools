import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readArtifact } from "../src/plugin-sdk/artifacts.ts";
import type { PluginContext } from "../src/plugin-sdk/runtime.ts";
import { DEFAULT_LIMITS, type JsonObject } from "../src/gateway/protocol.ts";

function fixture(change: (value: JsonObject) => void = () => {}) {
  const bytes = Buffer.from("🦋 data ".repeat(5000));
  const descriptor: JsonObject = {
    type: "artifact",
    artifactId: "fixture",
    name: "note.txt",
    mediaType: "text/plain",
    size: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  const calls: JsonObject[] = [];
  const abort = new AbortController();
  const context = {
    signal: abort.signal,
    initialization: { limits: { ...DEFAULT_LIMITS, maxFrameBytes: 4096 } },
    hostCall: async (call: JsonObject) => {
      calls.push(call);
      const args = call.arguments as JsonObject;
      const end = Number(args.offset) + Number(args.limit);
      const value: JsonObject = {
        artifact: { ...descriptor },
        data: bytes.subarray(Number(args.offset), end).toString("base64"),
        nextOffset: end < bytes.length ? end : null,
      };
      change(value);
      return value;
    },
  } as unknown as Pick<PluginContext, "hostCall" | "initialization" | "signal">;
  return { bytes, descriptor, context, calls, abort };
}
test("SDK artifact reader preserves bytes across bounded chunks with fresh transport identities", async () => {
  const f = fixture();
  assert.deepEqual(
    Buffer.from(await readArtifact(f.context, "op", f.descriptor, 100000)),
    f.bytes
  );
  assert.ok(f.calls.length > 1);
  assert.equal(
    new Set(f.calls.map((call) => call.callId)).size,
    f.calls.length
  );
  assert.ok(
    f.calls.every(
      (call) =>
        call.operationId === "op" &&
        (call.arguments as JsonObject).artifactId === "fixture"
    )
  );
});
for (const kind of ["metadata", "cursor", "bytes", "oversized", "digest"]) {
  test(`SDK artifact reader rejects ${kind} without returning partial bytes`, async () => {
    const f = fixture((value) => {
      if (kind === "metadata") (value.artifact as JsonObject).name = "other";
      if (kind === "cursor") value.nextOffset = 0;
      if (kind === "bytes") value.data = "!";
      if (kind === "oversized") value.data = "A".repeat(2000);
      if (kind === "digest")
        value.data = Buffer.alloc(
          Buffer.from(String(value.data), "base64").length
        ).toString("base64");
    });
    await assert.rejects(readArtifact(f.context, "op", f.descriptor, 100000));
  });
}
test("SDK artifact reader refuses oversized references and aborted work before host access", async () => {
  const f = fixture();
  await assert.rejects(readArtifact(f.context, "op", f.descriptor, 2));
  f.abort.abort();
  await assert.rejects(readArtifact(f.context, "op", f.descriptor, 100000));
  assert.equal(f.calls.length, 0);
});
