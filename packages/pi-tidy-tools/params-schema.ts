/**
 * Tool parameter schemas for hosts that do not expose a raw schema.
 *
 * Pi hands over each tool's `parameters` as a JSON Schema object, so tidy can
 * read the real field list and inject its `reasoning` field into it. A host
 * whose rewritten module graph exposes an opaque `parameters` function instead
 * cannot be read that way: calling it does not produce a schema.
 *
 * Without a schema to spread, `reasoning` is never declared, the model is never
 * asked for it, and the goal headline silently degrades to argument detail.
 * `declaredSchema` supplies the argument set directly so the headline survives.
 *
 * These mirror the host's own parameter names. Declaring a shape that does not
 * match the host's real contract is worse than declaring nothing: extra fields
 * are dropped and required ones arrive empty, so the call fails validation.
 */

/** JSON-Schema fragment for tidy's injected goal field. */
export const REASONING_PROPERTY = {
  type: "string",
  description:
    'Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. "confirm executionStarted is a timestamp", "fix the map leak from review", "retry match after previous miss".',
} as const;

interface FieldSpec {
  type: "string" | "number" | "boolean";
  description: string;
}

/** Argument sets per tool, mirroring the host's own tool parameters. */
const FIELDS: Record<string, Record<string, FieldSpec>> = {
  read: {
    path: { type: "string", description: "Path to the file to read." },
    offset: {
      type: "number",
      description: "Line to start reading from (1-based).",
    },
    limit: { type: "number", description: "Maximum number of lines to read." },
  },
  write: {
    path: {
      type: "string",
      description: "Path to the file to write (relative or absolute).",
    },
    content: { type: "string", description: "Content to write to the file." },
  },
  edit: {
    path: { type: "string", description: "Path to the file to edit." },
    oldText: { type: "string", description: "Text to replace." },
    newText: { type: "string", description: "Replacement text." },
    replaceAll: { type: "boolean", description: "Replace every occurrence." },
  },
  bash: {
    command: { type: "string", description: "Command to run." },
    timeout: { type: "number", description: "Timeout in seconds." },
    cwd: { type: "string", description: "Working directory." },
    pty: { type: "boolean", description: "Allocate a PTY." },
  },
  grep: {
    pattern: { type: "string", description: "Pattern to search for." },
    path: { type: "string", description: "File or directory to search." },
    glob: { type: "string", description: "Glob filter for files." },
    ignoreCase: { type: "boolean", description: "Case-insensitive match." },
  },
  find: {
    pattern: { type: "string", description: "Glob pattern to match files." },
    path: { type: "string", description: "Directory to search." },
  },
  ls: {
    path: { type: "string", description: "Directory to list." },
  },
};

/** Required fields per tool, matching the host's own requirements. */
const REQUIRED: Record<string, readonly string[]> = {
  read: ["path"],
  write: ["path", "content"],
  edit: ["path", "oldText", "newText"],
  bash: ["command"],
  grep: ["pattern"],
  find: ["pattern"],
  ls: [],
};

/**
 * Build a JSON Schema for a tool with tidy's `reasoning` field injected first.
 *
 * Returns `undefined` for an unknown tool, so a caller keeps whatever the host
 * supplied rather than inventing arguments for a tool it does not understand.
 */
export function declaredSchema(
  name: string,
  withReasoning: boolean
): Record<string, unknown> | undefined {
  const fields = FIELDS[name];
  if (!fields) return undefined;
  const properties: Record<string, unknown> = withReasoning
    ? { reasoning: REASONING_PROPERTY }
    : {};
  for (const [key, spec] of Object.entries(fields)) properties[key] = spec;
  const required = withReasoning
    ? ["reasoning", ...(REQUIRED[name] ?? [])]
    : [...(REQUIRED[name] ?? [])];
  return { type: "object", properties, required };
}
