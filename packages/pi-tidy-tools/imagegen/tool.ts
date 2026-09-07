/**
 * Issue 132: the `generate_image` pi tool — provider-abstracted, scoped,
 * focused. Parameters are deliberately NOT raw provider passthrough: prompt
 * (required), aspect/resolution (provider-constrained enums), count
 * (default 1). Output files land under .fleet/images/<bot>/ and the tool
 * returns PATHS only — never base64 (issue 86's pipeline renders from
 * paths). Errors are typed and clean; no stack traces.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getImageProvider, DEFAULT_IMAGE_PROVIDER } from "./registry.js";
import type { ImageProvider } from "./types.js";

const EXT_BY_MEDIA: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface GenerateImageDeps {
  /** Provider id override (tests); env PI_TIDY_IMAGE_PROVIDER wins in prod. */
  providerId?: string;
  /** Output root override (tests); defaults to the fleet/env-derived path. */
  outputRoot?: string;
  /** Injectable fetch-time clock/secrets are not needed here. */
}

function resolveOutputRoot(override?: string): string {
  if (override) return override;
  const fleetDir = process.env.PI_TIDY_FLEET_DIR;
  const bot = process.env.PI_TIDY_BOTS_NAME ?? "pi";
  if (fleetDir) return join(fleetDir, ".fleet", "images", bot);
  return join(process.cwd(), ".fleet", "images", bot);
}

export function buildGenerateImageTool(deps: GenerateImageDeps = {}) {
  return {
    name: "generate_image",
    label: "generate_image",
    description:
      "Generate images from a text prompt via the fleet's configured image " +
      "provider (default: grok-build). Returns local file PATHS under " +
      ".fleet/images/ — never inline image data. Use for diagrams, mockups, " +
      "visual assets; do not use for photo editing.",
    promptSnippet:
      "generate_image creates image files from a prompt and returns their paths.",
    parameters: buildParameters(),
    async execute(
      _toolCallId: string,
      params: {
        prompt: string;
        aspect?: string;
        resolution?: string;
        count?: number;
      }
    ) {
      const providerId =
        deps.providerId ??
        process.env.PI_TIDY_IMAGE_PROVIDER ??
        DEFAULT_IMAGE_PROVIDER;
      const provider = getImageProvider(providerId);
      if (!provider) {
        return failure(
          "provider_failure",
          `Unknown image provider "${providerId}".`
        );
      }
      if (
        params.aspect &&
        provider.aspects &&
        !provider.aspects.includes(params.aspect)
      ) {
        return failure(
          "unsupported_size",
          `Unsupported aspect "${params.aspect}" for ${provider.id}. Allowed: ${provider.aspects.join(", ")}.`
        );
      }
      if (
        params.resolution &&
        provider.resolutions &&
        !provider.resolutions.includes(params.resolution)
      ) {
        return failure(
          "unsupported_size",
          `Unsupported resolution "${params.resolution}" for ${provider.id}. Allowed: ${provider.resolutions.join(", ")}.`
        );
      }
      const count = params.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > provider.maxCount) {
        return failure(
          "unsupported_size",
          `count must be an integer 1..${provider.maxCount} for ${provider.id}.`
        );
      }

      const result = await provider.generate({
        prompt: params.prompt,
        aspect: params.aspect,
        resolution: params.resolution,
        count,
      });
      if (!result.ok) return failure(result.code, result.message);

      const root = resolveOutputRoot(deps.outputRoot);
      mkdirSync(root, { recursive: true });
      const written: { path: string; mediaType: string }[] = [];
      for (let index = 0; index < result.images.length; index++) {
        const image = result.images[index];
        const ext = EXT_BY_MEDIA[image.mediaType] ?? "png";
        const hash = createHash("sha256")
          .update(params.prompt)
          .update(String(index))
          .digest("hex")
          .slice(0, 8);
        const path = join(root, `${Date.now()}-${hash}.${ext}`);
        writeFileSync(path, image.buffer);
        written.push({ path, mediaType: image.mediaType });
      }
      return {
        content: [
          {
            type: "text",
            text: written.map((file) => file.path).join("\n"),
          },
        ],
        details: { images: written, provider: provider.id },
      };
    },
  };
}

function failure(code: string, message: string) {
  return {
    content: [{ type: "text", text: `${message} [reason: ${code}]` }],
    details: { error: code, message },
  };
}

/** Parameter schema varies by provider constraints (kept as plain shape so
 * tests can register fake providers without schema imports). */
import { Type } from "typebox";
function buildParameters() {
  return Type.Object({
    prompt: Type.String({ description: "What to draw, in plain prose." }),
    aspect: Type.Optional(
      Type.String({
        description:
          "Aspect ratio, provider-constrained (grok: 1:1, 16:9, 9:16, 4:3, 3:4, …).",
      })
    ),
    resolution: Type.Optional(
      Type.String({
        description: "Resolution tier, provider-constrained (grok: 1k | 2k).",
      })
    ),
    count: Type.Optional(
      Type.Number({
        description: "How many images (default 1, max per provider).",
      })
    ),
  });
}

export type { ImageProvider };
