import { validateImage } from "./image-validation.ts";
import { ProtocolError, object } from "./protocol.ts";
import type { ArtifactUpload } from "./journal.ts";

export const MAX_PUBLIC_ARTIFACT_BYTES = 512 * 1024;
export const VALIDATED_MEDIA_TYPES = ["text/plain", "image/png", "image/jpeg"];

/** The public composer sends one base64 upload, never a filesystem path. */
export async function decodeArtifactUploads(
  value: unknown
): Promise<ArtifactUpload[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1)
    throw new ProtocolError(
      "invalid_payload",
      "The composer accepts one attachment"
    );
  return Promise.all(
    value.map(async (item) => {
      if (
        !object(item) ||
        Object.keys(item).some(
          (key) => !["name", "mediaType", "data"].includes(key)
        ) ||
        typeof item.mediaType !== "string" ||
        typeof item.data !== "string"
      )
        throw new ProtocolError("invalid_payload", "Invalid attachment fields");
      if (!VALIDATED_MEDIA_TYPES.includes(item.mediaType))
        throw new ProtocolError(
          "capability_unavailable",
          "Attachment type has no validated gateway decoder"
        );
      if (item.data.length > Math.ceil(MAX_PUBLIC_ARTIFACT_BYTES / 3) * 4)
        throw new ProtocolError(
          "resource_limit",
          "Attachment exceeds the upload limit"
        );
      const bytes = Buffer.from(item.data, "base64");
      if (!bytes.length || bytes.toString("base64") !== item.data)
        throw new ProtocolError(
          "invalid_payload",
          "Attachment requires canonical base64 bytes"
        );
      if (bytes.length > MAX_PUBLIC_ARTIFACT_BYTES)
        throw new ProtocolError(
          "resource_limit",
          "Attachment exceeds the upload limit"
        );
      if (item.mediaType !== "text/plain")
        await validateImage(bytes, item.mediaType);
      else
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error();
        } catch {
          throw new ProtocolError(
            "invalid_payload",
            "Text attachment is not valid UTF-8 text"
          );
        }
      if (item.name !== undefined && typeof item.name !== "string")
        throw new ProtocolError(
          "invalid_payload",
          "Attachment name must be a display label"
        );
      return {
        name:
          (item.name as string | undefined) ??
          (item.mediaType === "text/plain"
            ? "attachment.txt"
            : item.mediaType === "image/png"
              ? "image.png"
              : "image.jpg"),
        mediaType: item.mediaType,
        bytes,
      };
    })
  );
}
