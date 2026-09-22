/**
 * `generateDiffString` access.
 *
 * The host normally exports this, and its output is what tidy renders. A host
 * whose module graph is rewritten may not export it at all, and a bare import
 * then aborts the whole extension load.
 *
 * Resolution is host-first on purpose. The local fallback is **not**
 * output-equivalent: the host computes a line diff with `contextLines = 4`,
 * while this pairing can attribute a changed line to a different side of a
 * hunk. Hand-picked cases matched 10/10; fuzzing 138 mutations found 13
 * mismatches. So the host's own function is used wherever it exists, and the
 * local one only where it does not — see
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
  | ((oldContent: string, newContent: string) => DiffResult)
  | undefined =
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
  return fallbackGenerateDiffString(oldContent, newContent);
}

/** True when the host provided its own implementation. Exposed for tests. */
export const hasHostDiff = hostDiff !== undefined;

const ADDED = 1;
const REMOVED = -1;
const COMMON = 0;

interface Segment {
  readonly kind: number;
  readonly lines: readonly string[];
}

function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function segment(
  oldLines: readonly string[],
  newLines: readonly string[]
): Segment[] {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const width = newCount + 1;
  const lcs = new Int32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      lcs[i * width + j] =
        oldLines[i] === newLines[j]
          ? lcs[(i + 1) * width + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + (j + 1)]!);
    }
  }

  const segments: Segment[] = [];
  let pendingKind = COMMON;
  let pendingLines: string[] = [];
  const flush = () => {
    if (pendingLines.length > 0) {
      segments.push({ kind: pendingKind, lines: pendingLines });
      pendingLines = [];
    }
  };
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      if (pendingKind !== COMMON) flush();
      pendingKind = COMMON;
      pendingLines.push(newLines[j]!);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + (j + 1)]!) {
      if (pendingKind !== REMOVED) flush();
      pendingKind = REMOVED;
      pendingLines.push(oldLines[i]!);
      i++;
    } else {
      if (pendingKind !== ADDED) flush();
      pendingKind = ADDED;
      pendingLines.push(newLines[j]!);
      j++;
    }
  }
  if (i < oldCount) {
    if (pendingKind !== REMOVED) flush();
    pendingKind = REMOVED;
    pendingLines.push(...oldLines.slice(i));
  }
  if (j < newCount) {
    if (pendingKind !== ADDED) flush();
    pendingKind = ADDED;
    pendingLines.push(...newLines.slice(j));
  }
  flush();
  return segments;
}

/**
 * Local fallback, used only where the host exports no `generateDiffString`.
 * Not output-equivalent to the host on adjacent insert/delete sequences.
 */
export function fallbackGenerateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4
): DiffResult {
  const oldLines = toLines(oldContent);
  const newLines = toLines(newContent);
  const segments = segment(oldLines, newLines);
  const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
  const output: string[] = [];
  let firstChangedLine: number | undefined;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index]!;
    if (current.kind === COMMON) {
      const previous = segments[index - 1];
      const next = segments[index + 1];
      const leading = previous !== undefined && previous.kind !== COMMON;
      const trailing = next !== undefined && next.kind !== COMMON;
      if (!leading && !trailing) {
        oldLineNum += current.lines.length;
        newLineNum += current.lines.length;
        continue;
      }
      const keepHead = leading ? contextLines : 0;
      const keepTail = trailing ? contextLines : 0;
      const total = current.lines.length;
      if (total > keepHead + keepTail) {
        const skipped = total - keepHead - keepTail;
        for (const line of current.lines.slice(0, keepHead)) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const line of current.lines.slice(total - keepTail)) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        for (const line of current.lines) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      }
      continue;
    }
    if (current.kind === ADDED) {
      firstChangedLine ??= newLineNum;
      for (const line of current.lines) {
        output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
        newLineNum++;
      }
      continue;
    }
    firstChangedLine ??= newLineNum;
    for (const line of current.lines) {
      output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
      oldLineNum++;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}
