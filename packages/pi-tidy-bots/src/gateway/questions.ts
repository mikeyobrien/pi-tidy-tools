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
export interface QuestionRecord {
  descriptor: JsonObject;
  resolution?: JsonObject;
  decisionOperationId?: string;
}
export type QuestionProjection =
  { request: JsonObject } | { resolution: JsonObject };
function fail(): never {
  throw new ProtocolError(
    "invalid_question",
    "Invalid generic question descriptor"
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
export function questionKey(value: JsonObject): string {
  if (
    !["bindingId", "instanceId", "interactionId"].every((key) =>
      nonempty(value[key])
    )
  )
    fail();
  return (
    "question_v1:" +
    createHash("sha256")
      .update(
        JSON.stringify([value.bindingId, value.instanceId, value.interactionId])
      )
      .digest("hex")
  );
}
export function questionRequest(value: JsonObject): JsonObject {
  const result = scope(value);
  if (
    !["select", "confirm", "input", "editor"].includes(String(value.method)) ||
    typeof value.title !== "string" ||
    value.title.length > 16384
  )
    fail();
  result.kind = "question";
  result.method = value.method;
  result.title = value.title;
  if (value.message !== undefined) {
    if (typeof value.message !== "string" || value.message.length > 16384)
      fail();
    result.message = value.message;
  }
  if (value.placeholder !== undefined) {
    if (
      typeof value.placeholder !== "string" ||
      value.placeholder.length > 16384
    )
      fail();
    result.placeholder = value.placeholder;
  }
  if (value.prefill !== undefined) {
    if (
      value.method !== "editor" ||
      typeof value.prefill !== "string" ||
      value.prefill.length > 16384
    )
      fail();
    result.prefill = value.prefill;
  }
  if (value.method === "select") {
    if (
      !Array.isArray(value.options) ||
      value.options.length < 1 ||
      value.options.length > 128 ||
      !value.options.every((x) => typeof x === "string" && x.length <= 4096) ||
      new Set(value.options).size !== value.options.length
    )
      fail();
    result.options = value.options;
  } else if (value.options !== undefined) fail();
  if (value.expiresAt !== undefined) {
    if (
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt
    )
      fail();
    result.expiresAt = value.expiresAt;
  }
  return result;
}
export function questionResolution(
  value: JsonObject,
  descriptor: JsonObject
): JsonObject {
  const result = scope(value);
  if (
    !scopeKeys.every((key) => result[key] === descriptor[key]) ||
    !["expired", "unknown"].includes(String(value.status))
  )
    fail();
  result.kind = "question";
  result.status = value.status;
  if (value.transport !== undefined) {
    if (value.transport !== "submitted") fail();
    result.transport = "submitted";
  }
  if (value.consumption !== undefined) {
    if (value.consumption !== "unconfirmed") fail();
    result.consumption = "unconfirmed";
  }
  return result;
}
export function matchQuestionDecision(
  descriptor: JsonObject,
  value: JsonObject
): void {
  for (const key of [...scopeKeys, "expiresAt"])
    if (
      value[key === "operationId" ? "targetOperationId" : key] !==
      descriptor[key]
    )
      throw new ProtocolError(
        "question_conflict",
        "Decision differs from retained question descriptor"
      );
  if (value.kind !== "question") fail();
  const cancel = value.cancelled === true;
  if (cancel) {
    if (
      Object.keys(value).some(
        (k) =>
          [
            "kind",
            "operationId",
            "conversationId",
            "bindingId",
            "instanceId",
            "targetOperationId",
            "turnId",
            "interactionId",
            "optionsDigest",
            "expiresAt",
            "revision",
            "cancelled",
          ].includes(k) === false
      )
    )
      fail();
    return;
  }
  if (descriptor.method === "confirm") {
    if (typeof value.confirmed !== "boolean") fail();
  } else {
    if (typeof value.value !== "string" || value.value.length > 65536) fail();
    if (
      descriptor.method === "select" &&
      !(descriptor.options as string[]).includes(value.value as string)
    )
      fail();
  }
}
