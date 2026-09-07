import { createHash, randomUUID } from "node:crypto";
import { object, ProtocolError, type JsonObject } from "../gateway/protocol.ts";
import type { PluginContext } from "./runtime.ts";

/** Read admitted bytes without exposing paths or trusting transport metadata. */
export async function readArtifact(
  context: Pick<PluginContext, "hostCall" | "signal" | "initialization">,
  operationId: string,
  descriptor: JsonObject,
  maxBytes: number
): Promise<Uint8Array> {
  const fields = ["type", "artifactId", "name", "mediaType", "sha256", "size"];
  if (
    !operationId.trim() ||
    descriptor.type !== "artifact" ||
    Object.keys(descriptor).some((key) => !fields.includes(key)) ||
    !fields.every((key) => key in descriptor) ||
    !["artifactId", "name", "mediaType"].every(
      (key) =>
        typeof descriptor[key] === "string" &&
        String(descriptor[key]).length > 0
    ) ||
    typeof descriptor.sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(descriptor.sha256) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024 ||
    typeof descriptor.size !== "number" ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size > maxBytes
  )
    throw new ProtocolError(
      "invalid_payload",
      "Invalid or oversized artifact reference"
    );
  const chunkSize = Math.min(
    65536,
    Math.floor(context.initialization.limits.maxFrameBytes / 8)
  );
  if (chunkSize < 256)
    throw new ProtocolError(
      "resource_limit",
      "Artifact transport budget is too small"
    );
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.size) {
    context.signal.throwIfAborted();
    const limit = Math.min(chunkSize, descriptor.size - offset);
    const result = await context.hostCall({
      name: "artifact.read",
      callId: randomUUID(),
      operationId,
      arguments: { artifactId: descriptor.artifactId, offset, limit },
    });
    context.signal.throwIfAborted();
    if (
      !object(result) ||
      !object(result.artifact) ||
      Object.keys(result.artifact).length !== fields.length ||
      fields.some(
        (key) => (result.artifact as JsonObject)[key] !== descriptor[key]
      ) ||
      typeof result.data !== "string" ||
      result.data.length > Math.ceil(limit / 3) * 4
    )
      throw new ProtocolError(
        "invalid_artifact",
        "Artifact response differs from admitted metadata"
      );
    const bytes = Buffer.from(result.data, "base64");
    if (
      bytes.length !== limit ||
      bytes.toString("base64") !== result.data ||
      result.nextOffset !==
        (offset + limit < descriptor.size ? offset + limit : null)
    )
      throw new ProtocolError(
        "invalid_artifact",
        "Artifact response has an invalid range"
      );
    chunks.push(bytes);
    offset += limit;
  }
  const bytes = Buffer.concat(chunks);
  if (
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
    descriptor.sha256
  )
    throw new ProtocolError(
      "invalid_artifact",
      "Artifact bytes differ from their admitted digest"
    );
  return bytes;
}
