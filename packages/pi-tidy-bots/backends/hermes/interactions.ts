import { randomUUID } from "node:crypto";
import {
  type PluginContext,
  ProtocolError,
} from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  object,
  nonempty,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import { HermesPermissionRequest } from "./permissions.ts";
import type { HermesSessionOptions } from "./session.ts";

type Receipt = Parameters<
  NonNullable<HermesSessionOptions["onPermissionConsumed"]>
>[0];
type Result = { status: "applied" | "expired" | "cancelled" | "unknown" };
interface PendingPermission {
  request: HermesPermissionRequest;
  deadline: number;
  native: (result: unknown) => void;
  control: Promise<Result>;
  finishControl: (result: Result) => void;
  decisionOperationId?: string;
  optionId?: string;
  result?: Result;
  cleanup(): void;
}

/** A live native future is never restored from spool history. The SDK owns
 * durable control reservations and the event spool; this object only joins
 * those identities to the current process's native permission futures.
 */
export class HermesInteractions {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly bindingId: string;
  private readonly instanceId: string;
  private readonly timeout: number;
  private closed = false;
  constructor(
    private readonly ctx: PluginContext,
    private readonly options: {
      timeoutMs?: number;
      onFailure: (error: ProtocolError) => void;
    }
  ) {
    this.bindingId = ctx.initialization.bindingId;
    this.instanceId = ctx.initialization.instanceId;
    this.timeout = options.timeoutMs ?? 50_000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 55_000
    )
      throw new ProtocolError(
        "invalid_config",
        "Permission timeout must precede the native 60-second deadline"
      );
    ctx.signal.addEventListener("abort", this.abort, { once: true });
    if (ctx.signal.aborted) this.close();
  }

  readonly onPermission: HermesSessionOptions["onPermission"] = async (
    params,
    id,
    turn,
    signal
  ) => {
    const tidy = object(params._meta) ? params._meta.tidy : undefined;
    if (this.closed || signal.aborted)
      return { outcome: { outcome: "cancelled" } };
    if (
      !object(tidy) ||
      !nonempty(tidy.permissionId) ||
      tidy.permissionId.length > 128 ||
      this.pending.has(tidy.permissionId) ||
      this.pending.size >= 4096 ||
      [...this.pending.values()].filter((entry) => !entry.result).length >= 256
    )
      throw new ProtocolError(
        "invalid_permission",
        "Invalid or reused native permission identity"
      );
    const permissionId = tidy.permissionId;
    const deadline = Date.now() + this.timeout;
    const request = new HermesPermissionRequest(
      {
        bindingId: this.bindingId,
        instanceId: this.instanceId,
        ...turn,
        interactionId: permissionId,
        revision: randomUUID(),
      },
      params.options,
      deadline,
      id
    );
    let native!: PendingPermission["native"];
    const response = new Promise<unknown>((resolve) => {
      native = resolve;
    });
    let finishControl!: PendingPermission["finishControl"];
    const control = new Promise<Result>((resolve) => {
      finishControl = resolve;
    });
    const retire = (status: "expired" | "cancelled") => {
      try {
        this.settle(entry, entry.optionId ? "unknown" : status);
      } catch {
        this.options.onFailure(
          new ProtocolError(
            "native_observation_gap",
            "Permission resolution could not be retained"
          )
        );
      }
    };
    const aborted = () => retire("cancelled");
    const timer = setTimeout(() => retire("expired"), this.timeout);
    const entry: PendingPermission = {
      request,
      deadline,
      native,
      control,
      finishControl,
      cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
      },
    };
    this.pending.set(permissionId, entry);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      this.emit(entry, "interaction.requested", {
        ...request.descriptor,
        kind: "permission",
        title: "Permission required",
      });
    } catch (error) {
      entry.cleanup();
      request.close();
      entry.result = { status: "unknown" };
      native({ outcome: { outcome: "cancelled" } });
      finishControl(entry.result);
      throw error;
    }
    return response;
  };

  /** Call only from the SDK interaction.respond handler. Check the retained
   * immutable reservation again so a direct caller cannot bypass durability.
   */
  async respond(params: JsonObject): Promise<unknown> {
    if (!nonempty(params.operationId) || !nonempty(params.payloadDigest))
      throw new ProtocolError(
        "invalid_request",
        "Permission control requires a durable operation identity"
      );
    const key = `operation:${params.operationId}`;
    const existing = this.ctx.store.reservation(key);
    if (!existing || existing.method !== "interaction.respond")
      throw new ProtocolError(
        "durability_required",
        "SDK must reserve the permission control before native dispatch"
      );
    const reservation = this.ctx.store.reserve(
      key,
      "interaction.respond",
      params.payloadDigest,
      params
    );
    if (reservation.settled) return reservation.result;
    const entry = nonempty(params.interactionId)
      ? this.pending.get(params.interactionId)
      : undefined;
    if (!entry || this.closed) return { status: "expired" };
    if (
      entry.decisionOperationId &&
      entry.decisionOperationId !== params.operationId
    )
      throw new ProtocolError(
        "payload_conflict",
        "A different control already owns this native permission"
      );
    if (entry.result) return entry.result;
    const decision = entry.request.decide(params);
    if (!decision.duplicate) {
      entry.decisionOperationId = params.operationId;
      entry.optionId = String(params.optionId);
      entry.native(decision.response.result);
    }
    return entry.control;
  }

  readonly onPermissionConsumed = (receipt: Receipt): void => {
    const entry = this.pending.get(receipt.permissionId);
    const descriptor = entry?.request.descriptor;
    if (
      !entry ||
      !descriptor ||
      !entry.decisionOperationId ||
      descriptor.operationId !== receipt.operationId ||
      descriptor.turnId !== receipt.turnId ||
      entry.optionId !== receipt.optionId ||
      this.closed
    )
      throw new ProtocolError(
        "invalid_permission",
        "Native receipt does not match the reserved decision"
      );
    if (entry.result?.status === "applied") return;
    if (entry.result || Date.now() >= entry.deadline) {
      if (!entry.result) this.settle(entry, "unknown");
      throw new ProtocolError(
        "interaction_expired",
        "Native receipt arrived after the live permission closed"
      );
    }
    this.settle(entry, "applied");
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ctx.signal.removeEventListener("abort", this.abort);
    let failed = false;
    for (const entry of this.pending.values()) {
      try {
        this.settle(entry, entry.optionId ? "unknown" : "cancelled");
      } catch {
        failed = true;
      }
    }
    if (failed)
      this.options.onFailure(
        new ProtocolError(
          "native_observation_gap",
          "Permission shutdown observations could not be retained"
        )
      );
  }

  private readonly abort = () => this.close();

  private emit(
    entry: PendingPermission,
    type: string,
    payload: JsonObject
  ): void {
    const descriptor = entry.request.descriptor;
    this.ctx.emit({
      type,
      operationId: String(descriptor.operationId),
      turnId: String(descriptor.turnId),
      interactionId: String(descriptor.interactionId),
      payload,
    });
  }

  private settle(entry: PendingPermission, status: Result["status"]): void {
    if (entry.result) return;
    entry.cleanup();
    entry.request.close();
    try {
      this.emit(entry, "interaction.resolved", {
        ...entry.request.descriptor,
        kind: "permission",
        status,
        ...(entry.optionId ? { optionId: entry.optionId } : {}),
      });
      entry.result = { status };
    } catch (error) {
      entry.result = { status: "unknown" };
      throw error;
    } finally {
      entry.native({ outcome: { outcome: "cancelled" } });
      entry.finishControl(entry.result!);
    }
  }
}
