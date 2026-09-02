/**
 * Issue 132: grok-build image provider (provider #1).
 *
 * AUTH (reused from npm:@ramarivera/pi-grok-build's evidence, not
 * reinvented): XAI_API_KEY or GROK_CODE_XAI_API_KEY env, else the Grok CLI
 * auth cache ~/.grok/auth.json — entries whose issuer is auth.x.ai carry a
 * valid xAI access token in `key`. Precedence and paths match that package
 * (src/xai-api.ts), including PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE.
 *
 * GENERATION: POST https://api.x.ai/v1/images/generations with
 * model grok-imagine-image-quality, prompt, n, aspect_ratio, resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ImageGenerateRequest,
  ImageGenerateResult,
  ImageProvider,
  GeneratedImage,
} from "../types.js";

const XAI_BASE_URL = "https://api.x.ai";
export const GROK_IMAGE_MODEL = "grok-imagine-image-quality";
export const DEFAULT_GROK_AUTH_PATH = join(homedir(), ".grok", "auth.json");

export const GROK_ASPECTS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export const GROK_RESOLUTIONS = ["1k", "2k"] as const;

interface GrokAuthEntry {
  issuer?: string;
  key?: string;
  expiresAt?: string | number;
}

/** Cached SuperGrok/Grok-CLI token usable as an xAI bearer (grok-build's
 * documented evidence — issuer auth.x.ai, non-empty key). */
export function getCachedGrokXaiToken(
  authPath: string = DEFAULT_GROK_AUTH_PATH
): string | undefined {
  if (!existsSync(authPath)) return undefined;
  try {
    const data = JSON.parse(
      readFileSync(authPath, "utf8")
    ) as Record<string, GrokAuthEntry>;
    for (const entry of Object.values(data)) {
      if (entry.issuer === "https://auth.x.ai" && entry.key) return entry.key;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** grok-build's auth path exactly: env keys first, then the CLI cache. */
export function getXaiApiKey(
  env: NodeJS.ProcessEnv = process.env,
  authPath: string = DEFAULT_GROK_AUTH_PATH
): string | undefined {
  if (env.XAI_API_KEY) return env.XAI_API_KEY;
  if (env.GROK_CODE_XAI_API_KEY) return env.GROK_CODE_XAI_API_KEY;
  if (env.PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE === "1") return undefined;
  return getCachedGrokXaiToken(authPath);
}

const EXT_BY_MEDIA: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function grokBuildProvider(): ImageProvider {
  return {
    id: "grok-build",
    aspects: GROK_ASPECTS,
    resolutions: GROK_RESOLUTIONS,
    maxCount: 4,
    async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
      const key = getXaiApiKey();
      if (!key) {
        return {
          ok: false,
          code: "missing_auth",
          message:
            "xAI credentials not found: set XAI_API_KEY (or GROK_CODE_XAI_API_KEY) or authenticate the Grok CLI so ~/.grok/auth.json carries an auth.x.ai token.",
        };
      }
      try {
        const res = await fetch(`${XAI_BASE_URL}/v1/images/generations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: GROK_IMAGE_MODEL,
            prompt: request.prompt,
            n: request.count,
            ...(request.aspect ? { aspect_ratio: request.aspect } : {}),
            ...(request.resolution ? { resolution: request.resolution } : {}),
          }),
        });
        if (!res.ok) {
          return {
            ok: false,
            code: "provider_failure",
            message: `xAI image generation failed: HTTP ${res.status}`,
          };
        }
        const data = (await res.json()) as {
          data?: Array<{ url?: string; b64_json?: string }>;
        };
        const images: GeneratedImage[] = [];
        for (const item of data.data ?? []) {
          if (item.b64_json) {
            images.push({
              buffer: Buffer.from(item.b64_json, "base64"),
              mediaType: "image/png",
            });
            continue;
          }
          if (item.url) {
            const download = await fetch(item.url);
            if (!download.ok) {
              return {
                ok: false,
                code: "provider_failure",
                message: `Failed to download generated image: HTTP ${download.status}`,
              };
            }
            const mediaType =
              download.headers.get("content-type")?.split(";")[0] ?? "";
            images.push({
              buffer: Buffer.from(await download.arrayBuffer()),
              mediaType:
                mediaType in EXT_BY_MEDIA ? mediaType : "image/png",
            });
          }
        }
        if (images.length === 0) {
          return {
            ok: false,
            code: "provider_failure",
            message: "Provider returned no images.",
          };
        }
        return { ok: true, images };
      } catch (error) {
        return {
          ok: false,
          code: "provider_failure",
          message: `xAI image generation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
