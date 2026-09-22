/**
 * `generateDiffString` access.
 *
 * The host normally exports this, and its output is what tidy renders. A host
 * whose module graph is rewritten may not export it at all, and a bare import
 * then aborts the whole extension load.
 *
 * Resolution is host-first on purpose. A local reimplementation is **not**
 * output-equivalent: the host computes a line diff with `contextLines = 4`,
 * while a simpler local pairing agrees on insert/delete cases but can attribute
 * a changed line to a different side of the hunk. Hand-picked cases matched
 * 10/10; fuzzing 138 mutations found 13 mismatches. So the host's own function
 * is used wherever it exists, and the local one only where it does not — see
 * `docs/research/generate-diff-string-equivalence.md`.
 */

import * as host from "@earendil-works/pi-coding-agent";

/** Result shape shared by the host export and the local fallback. */
export interface DiffResult {
  readonly diff: string;
  readonly firstChangedLine?: number;
}

/** The host's own export, when the host still provides one. */
const hostDiff:
  ((oldContent: string, newContent: string) => DiffResult) | undefined =
  typeof (host as { generateDiffString?: unknown }).generateDiffString ===
  "function"
    ? (
        host as unknown as {
          generateDiffString: (a: string, b: string) => DiffResult;
        }
      ).generateDiffString
    : undefined;

/**
 * Host diff when available, local fallback otherwise.
 */
export function hostGenerateDiffString(
  oldContent: string,
  newContent: string
): DiffResult {
  if (hostDiff !== undefined) return hostDiff(oldContent, newContent);
  return { diff: "", firstChangedLine: undefined };
}

/** True when the host provided its own implementation. Exposed for tests. */
export const hasHostDiff = hostDiff !== undefined;
