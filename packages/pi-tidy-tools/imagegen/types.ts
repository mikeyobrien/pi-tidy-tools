/**
 * Issue 132: provider-abstracted image generation.
 *
 * One scoped tool (`generate_image`) with a real provider seam — grok-build
 * is provider #1, not a special case. Adding provider B = implement
 * ImageProvider + register + a config key; zero core edits.
 */

export interface ImageGenerateRequest {
  prompt: string;
  /** Provider-constrained aspect ratio (e.g. "1:1", "16:9"). */
  aspect?: string;
  /** Provider-constrained resolution (e.g. "1k", "2k"). */
  resolution?: string;
  count: number;
}

export interface GeneratedImage {
  buffer: Buffer;
  mediaType: string;
}

export type ImageProviderError =
  "missing_auth" | "provider_failure" | "unsupported_size";

export type ImageGenerateResult =
  | { ok: true; images: GeneratedImage[] }
  | { ok: false; code: ImageProviderError; message: string };

/** A pluggable image generation provider. */
export interface ImageProvider {
  id: string;
  /** Allowed aspect values (validated before generate). */
  aspects?: readonly string[];
  /** Allowed resolution values (validated before generate). */
  resolutions?: readonly string[];
  maxCount: number;
  generate(request: ImageGenerateRequest): Promise<ImageGenerateResult>;
}
