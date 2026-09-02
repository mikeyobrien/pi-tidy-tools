/**
 * Issue 132: provider registry. open/closed by construction — providers
 * self-register at import; tests add fakes without touching core files.
 */
import type { ImageProvider } from "./types.js";

export const DEFAULT_IMAGE_PROVIDER = "grok-build";

const providers = new Map<string, ImageProvider>();

export function registerImageProvider(provider: ImageProvider): void {
  providers.set(provider.id, provider);
}

export function getImageProvider(id?: string): ImageProvider | undefined {
  return providers.get(id ?? DEFAULT_IMAGE_PROVIDER);
}

export function listImageProviders(): string[] {
  return [...providers.keys()];
}
