import { createHash } from "node:crypto";
import { object, nonempty, ProtocolError } from "./protocol.ts";
import type { JsonObject } from "./journal.ts";

const scopeKeys = [
  "bindingId",
  "instanceId",
  "operationId",
  "turnId",
  "interactionId",
  "optionsDigest",
  "revision",
];
export interface PermissionRecord {
  descriptor: JsonObject;
  resolution?: JsonObject;
  decisionOperationId?: string;
}
export type PermissionProjection =
  { request: JsonObject } | { resolution: JsonObject };
function fail(): never {
  throw new ProtocolError(
    "invalid_permission",
    "Invalid exact permission descriptor"
  );
}
function scope(value: JsonObject): JsonObject {
  if (
    !scopeKeys.every(
      (key) => nonempty(value[key]) && String(value[key]).length <= 512
    )
  )
    fail();
  return Object.fromEntries(scopeKeys.map((key) => [key, value[key]]));
}
export function permissionKey(value: JsonObject): string {
  if (
    !["bindingId", "instanceId", "interactionId"].every((key) =>
      nonempty(value[key])
    )
  )
    fail();
  return (
    "permission_v1:" +
    createHash("sha256")
      .update(
        JSON.stringify([value.bindingId, value.instanceId, value.interactionId])
      )
      .digest("hex")
  );
}
export function permissionRequest(value: JsonObject): JsonObject {
  const result = scope(value);
  if (
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt ||
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > 32
  )
    fail();
  const ids = new Set<string>();
  const options = value.options.map((option) => {
    if (
      !object(option) ||
      !nonempty(option.id) ||
      option.id.length > 512 ||
      !nonempty(option.label) ||
      option.label.length > 1024 ||
      !["allow-once", "deny"].includes(String(option.kind)) ||
      ids.has(option.id)
    )
      fail();
    ids.add(option.id);
    return { id: option.id, label: option.label, kind: String(option.kind) };
  });
  if (!options.some((option) => option.kind === "deny")) fail();
  Object.assign(result, { expiresAt: value.expiresAt, options });
  for (const key of ["title", "message"])
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].length > 16384) fail();
      result[key] = value[key];
    }
  return result;
}
export function permissionResolution(
  value: JsonObject,
  descriptor: JsonObject
): JsonObject {
  const result = scope(value);
  if (
    !scopeKeys.every((key) => result[key] === descriptor[key]) ||
    !["applied", "expired", "cancelled", "unknown"].includes(
      String(value.status)
    )
  )
    fail();
  result.status = value.status;
  if (value.optionId !== undefined) {
    if (
      !(descriptor.options as JsonObject[]).some(
        (option) => option.id === value.optionId
      )
    )
      fail();
    result.optionId = value.optionId;
  }
  if (value.status === "applied" && !nonempty(value.optionId)) fail();
  return result;
}
export function matchPermissionDecision(
  descriptor: JsonObject,
  value: JsonObject
): void {
  for (const key of [...scopeKeys, "expiresAt"])
    if (
      value[key === "operationId" ? "targetOperationId" : key] !==
      descriptor[key]
    )
      throw new ProtocolError(
        "permission_conflict",
        "Decision differs from the retained permission descriptor"
      );
  if (
    !(descriptor.options as JsonObject[]).some(
      (option) => option.id === value.optionId
    )
  )
    fail();
}
