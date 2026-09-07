import { createHash } from "node:crypto";
import {
  ProtocolError,
  object,
  nonempty,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

/** Hermes 0.20.5 maps outcomes by option ID, not by ACP kind. */
export function hermesPermissionOptions(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new ProtocolError(
      "invalid_payload",
      "Invalid native permission options"
    );
  const ids = new Set<string>();
  const options: { id: string; label: string; kind: "allow-once" | "deny" }[] =
    [];
  const native = value.map((option) => {
    if (
      !object(option) ||
      !nonempty(option.optionId) ||
      !nonempty(option.kind) ||
      !nonempty(option.name) ||
      ids.has(option.optionId)
    )
      throw new ProtocolError(
        "invalid_payload",
        "Invalid native permission option identity"
      );
    ids.add(option.optionId);
    if (option.optionId === "allow_once" && option.kind === "allow_once")
      options.push({
        id: option.optionId,
        label: "Allow once",
        kind: "allow-once",
      });
    if (option.optionId === "deny" && option.kind === "reject_once")
      options.push({ id: option.optionId, label: "Deny", kind: "deny" });
    return { id: option.optionId, kind: option.kind, name: option.name };
  });
  if (!options.some((option) => option.kind === "deny"))
    throw new ProtocolError(
      "capability_unavailable",
      "Native request has no supported deny option"
    );
  return {
    options,
    optionsDigest: `sha256:${createHash("sha256").update(JSON.stringify(native)).digest("hex")}`,
  };
}

const identityKeys = [
  "bindingId",
  "instanceId",
  "operationId",
  "turnId",
  "interactionId",
  "revision",
] as const;

/** Live ACP-future guard. The SDK must durably reserve the decision before decide().
 * A selected response is dispatched at most once; pipe delivery is not evidence
 * that the native future consumed it. The caller retains unknown until proven. */
export class HermesPermissionRequest {
  private readonly descriptorJson: string;
  private gone = false;
  private choice?: string;
  private readonly deadline: number;
  constructor(
    identity: JsonObject,
    nativeOptions: unknown,
    expiresAt: number,
    private readonly nativeRequestId: string | number
  ) {
    if (
      !identityKeys.every((key) => nonempty(identity[key])) ||
      !(
        nonempty(nativeRequestId) ||
        (typeof nativeRequestId === "number" &&
          Number.isSafeInteger(nativeRequestId))
      ) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isFinite(new Date(expiresAt).getTime())
    )
      throw new ProtocolError(
        "invalid_payload",
        "Invalid permission scope or deadline"
      );
    const scope = Object.fromEntries(
      identityKeys.map((key) => [key, identity[key]])
    );
    this.deadline = expiresAt;
    this.descriptorJson = JSON.stringify({
      ...scope,
      ...hermesPermissionOptions(nativeOptions),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }
  get descriptor(): JsonObject {
    return JSON.parse(this.descriptorJson);
  }
  close(): void {
    this.gone = true;
  }
  decide(
    params: JsonObject,
    now = Date.now()
  ):
    | { duplicate: true }
    | {
        duplicate: false;
        response: {
          jsonrpc: "2.0";
          id: string | number;
          result: { outcome: { outcome: "selected"; optionId: string } };
        };
      } {
    const descriptor = this.descriptor;
    if (this.gone)
      throw new ProtocolError(
        "interaction_expired",
        "Native permission future is no longer live"
      );
    if (!Number.isFinite(now) || now >= this.deadline) {
      this.gone = true;
      throw new ProtocolError(
        "interaction_expired",
        "Native permission deadline has elapsed"
      );
    }
    if (
      !nonempty(params.operationId) ||
      params.operationId === params.targetOperationId
    )
      throw new ProtocolError(
        "invalid_payload",
        "Permission decision requires a distinct control identity"
      );
    for (const key of [...identityKeys, "optionsDigest", "expiresAt"])
      if (
        params[key === "operationId" ? "targetOperationId" : key] !==
        descriptor[key]
      )
        throw new ProtocolError(
          "stale_binding",
          "Permission decision does not match this native future"
        );
    if (
      !(descriptor.options as JsonObject[]).some(
        (option) => option.id === params.optionId
      )
    )
      throw new ProtocolError(
        "invalid_payload",
        "Permission option was not offered"
      );
    const optionId = String(params.optionId);
    if (this.choice !== undefined) {
      if (this.choice !== optionId)
        throw new ProtocolError(
          "payload_conflict",
          "A different permission decision was already reserved"
        );
      return { duplicate: true };
    }
    this.choice = optionId;
    return {
      duplicate: false,
      response: {
        jsonrpc: "2.0",
        id: this.nativeRequestId,
        result: { outcome: { outcome: "selected", optionId } },
      },
    };
  }
}
