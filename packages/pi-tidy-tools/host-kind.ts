import * as host from "@earendil-works/pi-coding-agent";

/**
 * omp's coding-agent shim exports the transcript read-group component.
 * Pi does not. Used only to pick host-specific schemas and registration
 * shape; renderer argument order is detected separately by shape.
 */
export function isOmpHost(): boolean {
  return (
    typeof (host as { ReadToolGroupComponent?: unknown })
      .ReadToolGroupComponent === "function"
  );
}
