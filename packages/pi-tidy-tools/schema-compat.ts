/**
 * Host-schema access.
 *
 * Pi exposes a tool's `parameters` as a raw JSON Schema object. A host that
 * instead exposes a builder function (or any non-schema value) yields
 * `undefined` here, so callers can tell "no readable schema" apart from
 * "an empty schema" and avoid silently spreading a non-object.
 */

/** A raw JSON Schema is a plain object carrying a type or composition keyword. */
export function rawSchema(
  parameters: unknown
): Record<string, unknown> | undefined {
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  )
    return undefined;
  const schema = parameters as Record<string, unknown>;
  const looksLikeSchema =
    "type" in schema ||
    "properties" in schema ||
    "anyOf" in schema ||
    "allOf" in schema ||
    "oneOf" in schema;
  return looksLikeSchema ? schema : undefined;
}
