import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  CORE_METHODS,
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  nonempty,
  object,
  ProtocolError,
  validateCapabilities,
  validateLimits,
  type CapabilityDescriptor,
  type JsonObject,
  type ProtocolLimits,
  type RpcMessage,
} from "../gateway/protocol.ts";
import { PluginStore, type EventInput } from "./store.ts";

export interface PluginInitialization extends JsonObject {
  bindingId: string;
  instanceId: string;
  leaseGeneration: number;
  config: JsonObject;
  workspace: string;
  dataDir: string;
  limits: ProtocolLimits;
}
export interface HostCallInput extends JsonObject {
  name: string;
  callId: string;
  arguments: JsonObject;
}
export interface PluginContext {
  initialization: PluginInitialization;
  store: PluginStore;
  signal: AbortSignal;
  emit(event: EventInput): void;
  hostCall(call: HostCallInput): Promise<unknown>;
  /** Lifecycle metadata only. Never activate a child until record returns started.
   * Retain the launch ID before spawning; lost responses require inspection.
   */
  ownedProcess(
    method: "prepare" | "record" | "inspect" | "stopped",
    params: JsonObject
  ): Promise<unknown>;
}
export type NativeHandler = (
  params: JsonObject,
  context: PluginContext
) => Promise<unknown> | unknown;
export interface PluginOptions {
  identity: { id: string; version: string };
  runtime: { name: string; version: string; transport?: string };
  capabilities: CapabilityDescriptor;
  handlers: Record<string, NativeHandler> & {
    "session.open": NativeHandler;
    "operation.submit": NativeHandler;
  };
  onInitialize?: (context: PluginContext) => Promise<void> | void;
  onClose?: (
    info: {
      reason: string;
      mode: "drain" | "interrupt";
      ownership: "owned" | "attached";
      deadline: number;
    },
    context: PluginContext
  ) =>
    | Promise<{ ownedResourcesStopped?: boolean }>
    | { ownedResourcesStopped?: boolean };
  ownership?: "owned" | "attached";
  input?: Readable;
  output?: Writable;
}
interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}
const optionalCapabilities = (
  cap: CapabilityDescriptor
): Record<string, boolean> => ({
  "operation.steer": cap.operations.steer,
  "session.compact": cap.configuration.compact,
  "session.configure": cap.configuration.model || cap.configuration.thinking,
  "session.import": cap.sessions.import,
});
const mutationMethods = new Set([
  "session.open",
  "operation.submit",
  "operation.cancel",
  "interaction.respond",
  "operation.steer",
  "session.compact",
  "session.configure",
  "session.import",
]);

/** Language-neutral stdio runtime; adapter handlers alone know native commands or outcomes. */
export class PluginRuntime {
  readonly done: Promise<{ reason: string; cleanup: "complete" | "unknown" }>;
  private readonly options: PluginOptions;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly abort = new AbortController();
  private state: "waiting" | "initializing" | "ready" | "closing" | "closed" =
    "waiting";
  private cleanupOwnershipOpen = false;
  private context?: PluginContext;
  private store?: PluginStore;
  private limits: ProtocolLimits = DEFAULT_LIMITS;
  private finish!: (value: {
    reason: string;
    cleanup: "complete" | "unknown";
  }) => void;
  private readonly entered = new Set<Promise<void>>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly requestIds = new Set<string>();
  private readonly busyConversations = new Set<string>();
  private closing?: Promise<void>;
  private rpcCounter = 0;
  private queuedFrames = 0;
  private frameBytes = 0;
  private draining = false;
  private readonly onTerm = () => {
    void this.close("signal_sigterm");
  };
  private readonly onInterrupt = () => {
    void this.close("signal_sigint");
  };
  constructor(options: PluginOptions) {
    this.options = options;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    validateCapabilities(options.capabilities);
    if (
      !nonempty(options.identity.id) ||
      !nonempty(options.identity.version) ||
      !nonempty(options.runtime.name) ||
      !nonempty(options.runtime.version) ||
      typeof options.handlers["session.open"] !== "function" ||
      typeof options.handlers["operation.submit"] !== "function"
    )
      throw new ProtocolError(
        "invalid_config",
        "Plugin requires identity, runtime and core native handlers"
      );
    for (const [method, advertised] of Object.entries(
      optionalCapabilities(options.capabilities)
    ))
      if (advertised && !options.handlers[method])
        throw new ProtocolError(
          "invalid_capabilities",
          `${method} requires a native handler`
        );
    if (
      options.capabilities.operations.cancel !== "unsupported" &&
      !options.handlers["operation.cancel"]
    )
      throw new ProtocolError(
        "invalid_capabilities",
        "Cancellation requires a native handler"
      );
    if (
      (options.capabilities.interactions.permissions === "exact-request" ||
        options.capabilities.interactions.questions) &&
      !options.handlers["interaction.respond"]
    )
      throw new ProtocolError(
        "invalid_capabilities",
        "Interaction support requires an exact native handler"
      );
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    if (!options.input) {
      process.on("SIGTERM", this.onTerm);
      process.on("SIGINT", this.onInterrupt);
    }
    const parser = new FrameDecoder();
    this.input.on("data", (bytes: Buffer) => {
      if (this.state === "closed") return;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset),
            end = newline < 0 ? bytes.length : newline + 1;
          this.frameBytes += end - offset;
          if (
            this.frameBytes + (newline < 0 ? 1 : 0) >
            this.limits.maxFrameBytes
          )
            throw new ProtocolError(
              "resource_limit",
              "Full incoming frame exceeds negotiated byte limit"
            );
          parser.push(bytes.subarray(offset, end), (message) =>
            this.receive(message)
          );
          if (newline >= 0) this.frameBytes = 0;
          offset = end;
        }
      } catch {
        void this.close("invalid_protocol");
      }
    });
    this.input.on("end", () => {
      this.cleanupOwnershipOpen = false;
      try {
        parser.finish();
      } catch {
        /* EOF is uncertain regardless of partial framing. */
      }
      void this.close("parent_eof");
    });
    this.input.on("error", () => {
      this.cleanupOwnershipOpen = false;
      void this.close("parent_pipe_error");
    });
    this.output.on("error", () => {
      void this.close("parent_pipe_error");
    });
    this.output.on("drain", () => {
      try {
        this.flush();
      } catch {
        void this.close("event_delivery_failed");
      }
    });
  }
  private write(message: RpcMessage): void {
    const bytes = encodeFrame(message, this.limits.maxFrameBytes);
    if (
      this.state === "closed" ||
      this.output.destroyed ||
      !this.output.writable
    )
      throw new ProtocolError("parent_eof", "Host pipe is closed");
    if (
      this.output.writableLength + bytes.length >
      this.limits.maxFrameBytes * 2
    )
      throw new ProtocolError(
        "resource_limit",
        "Host pipe backpressure exceeded its bound"
      );
    this.output.write(bytes);
  }
  private receive(message: RpcMessage): void {
    if (
      this.state === "waiting" &&
      (message.method !== "initialize" || message.id === undefined)
    )
      throw new ProtocolError(
        "not_initialized",
        "Initialize must be the first host request"
      );
    if (!message.method) {
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new ProtocolError(
            object(message.error.data) && nonempty(message.error.data.code)
              ? message.error.data.code
              : "host_failure",
            "Host call returned an error"
          )
        );
      else pending.resolve(message.result);
      return;
    }
    if (this.state === "waiting") {
      if (message.method !== "initialize" || message.id === undefined)
        throw new ProtocolError(
          "not_initialized",
          "Initialize must be the first host request"
        );
      this.state = "initializing";
      this.track(this.initialize(message));
      return;
    }
    if (this.state === "closing") {
      if (message.method === "events.ack" && message.id === undefined) {
        this.fence(message.params);
        this.store!.acknowledge(Number(message.params!.sourceSequence));
        this.flush();
      } else if (message.id !== undefined)
        this.error(
          message.id,
          new ProtocolError("closing", "Plugin admission is closed")
        );
      return;
    }
    if (this.state !== "ready")
      throw new ProtocolError(
        "not_initialized",
        "Initialization has not completed"
      );
    if (message.method === "events.ack" && message.id === undefined) {
      this.fence(message.params);
      this.store!.acknowledge(Number(message.params!.sourceSequence));
      this.flush();
      return;
    }
    if (message.id === undefined)
      throw new ProtocolError(
        "invalid_request",
        "Host method requires a request ID"
      );
    if (this.requestIds.has(message.id))
      throw new ProtocolError(
        "invalid_request",
        "Duplicate live host request ID"
      );
    if (++this.queuedFrames > this.limits.maxPendingRequests)
      throw new ProtocolError(
        "resource_limit",
        "Too many concurrent host requests"
      );
    this.requestIds.add(message.id);
    this.track(
      this.dispatch(message).finally(() => {
        this.requestIds.delete(message.id!);
        this.queuedFrames--;
      })
    );
  }
  private track(task: Promise<void>): void {
    this.entered.add(task);
    void task.then(
      () => this.entered.delete(task),
      () => {
        this.entered.delete(task);
        void this.close("callback_failure");
      }
    );
  }
  private async initialize(message: RpcMessage): Promise<void> {
    try {
      const p = message.params;
      if (
        !object(p) ||
        !object(p.protocol) ||
        p.protocol.major !== 1 ||
        Number(p.protocol.minMinor) > 0 ||
        Number(p.protocol.maxMinor) < 0 ||
        !object(p.expectedPlugin) ||
        p.expectedPlugin.id !== this.options.identity.id ||
        p.expectedPlugin.version !== this.options.identity.version ||
        !nonempty(p.bindingId) ||
        !nonempty(p.instanceId) ||
        !Number.isSafeInteger(p.leaseGeneration) ||
        Number(p.leaseGeneration) < 1 ||
        !object(p.config) ||
        !nonempty(p.workspace) ||
        !nonempty(p.dataDir) ||
        !object(p.limits)
      )
        throw new ProtocolError(
          "invalid_config",
          "Incompatible initialization identity or configuration"
        );
      this.limits = validateLimits(p.limits);
      if (this.frameBytes > this.limits.maxFrameBytes)
        throw new ProtocolError(
          "resource_limit",
          "Initialize frame exceeds negotiated byte limit"
        );
      encodeFrame(message, this.limits.maxFrameBytes);
      for (const [name, expected] of Object.entries({
        TIDY_BINDING_ID: p.bindingId,
        TIDY_INSTANCE_ID: p.instanceId,
        TIDY_LEASE_GENERATION: String(p.leaseGeneration),
      }))
        if (process.env[name] !== undefined && process.env[name] !== expected)
          throw new ProtocolError(
            "stale_binding",
            "Initialization differs from private process identity"
          );
      if (
        process.env.TIDY_DATA_DIR &&
        realpathSync(p.dataDir) !== realpathSync(process.env.TIDY_DATA_DIR)
      )
        throw new ProtocolError(
          "invalid_config",
          "Initialization data directory differs from its private assignment"
        );
      this.store = new PluginStore(join(resolve(p.dataDir), "plugin.sqlite"), {
        bindingId: p.bindingId,
        instanceId: p.instanceId,
        leaseGeneration: Number(p.leaseGeneration),
        limits: this.limits,
      });
      const initialization = {
        ...p,
        limits: this.limits,
      } as PluginInitialization;
      this.context = {
        initialization,
        store: this.store,
        signal: this.abort.signal,
        emit: (event) => this.emit(event),
        hostCall: (call) => this.hostCall(call),
        ownedProcess: (method, params) => this.ownedProcess(method, params),
      };
      if (this.options.onInitialize) {
        const task = Promise.resolve().then(() =>
          this.options.onInitialize!(this.context!)
        );
        this.track(
          task.then(
            () => {},
            () => {}
          )
        );
        await this.deadline(
          task,
          this.limits.initializeTimeoutMs,
          "initialize_timeout"
        );
      }
      if (this.state !== "initializing") return;
      this.state = "ready";
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocol: { major: 1, minor: 0 },
          plugin: this.options.identity,
          runtime: this.options.runtime,
          methods: [
            ...CORE_METHODS,
            ...Object.keys(
              optionalCapabilities(this.options.capabilities)
            ).filter(
              (method) =>
                optionalCapabilities(this.options.capabilities)[method]
            ),
          ],
          capabilities: this.options.capabilities,
          health: this.store.observationGap ? "degraded" : "ready",
        },
      });
      this.flush();
    } catch (error) {
      this.error(message.id!, error);
      void this.close("initialize_failed");
    }
  }
  private fence(params: unknown): asserts params is JsonObject {
    const init = this.context!.initialization;
    if (
      !object(params) ||
      params.bindingId !== init.bindingId ||
      params.leaseGeneration !== init.leaseGeneration
    )
      throw new ProtocolError(
        "stale_binding",
        "Request binding or writer generation is stale"
      );
  }
  private error(id: string, error: unknown): void {
    if (this.state === "closed" || this.output.destroyed) return;
    const code =
      error instanceof ProtocolError
        ? error.code
        : object(error) && nonempty(error.code)
          ? error.code
          : "native_failure";
    try {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: code === "method_not_found" ? -32601 : -32000,
          message: code,
          data: { code },
        },
      });
    } catch {
      void this.close("parent_pipe_error");
    }
  }
  private async dispatch(message: RpcMessage): Promise<void> {
    try {
      this.fence(message.params);
      const params = message.params;
      const method = message.method!;
      if (method === "initialize")
        throw new ProtocolError(
          "invalid_request",
          "Connection is already initialized"
        );
      if (method === "shutdown") {
        // Do not include this shutdown request in its own callback-drain wait.
        queueMicrotask(() => {
          void this.close("shutdown", message.id);
        });
        return;
      }
      let result: unknown;
      if (method === "health")
        result = {
          status: this.store!.observationGap ? "degraded" : "ready",
          ...(this.store!.observationGap ? { code: "observation_gap" } : {}),
        };
      else if (method === "events.replay") {
        const after = Number(params.afterSourceSequence ?? params.after ?? 0);
        const replay = this.store!.replay(after);
        // Requests for already-acked events report an explicit gap; never invent history.
        for (const event of replay.events) {
          if (event.sourceSequence > this.store!.highestSent) {
            if (
              this.store!.highestSent - this.store!.acknowledged >=
              this.limits.maxUnacknowledgedEvents
            )
              break;
            if (event.sourceSequence !== this.store!.highestSent + 1) break;
            this.store!.markSent(event.sourceSequence);
          }
          this.write({ jsonrpc: "2.0", method: "event", params: event });
        }
        result = {
          gap: replay.gap,
          acknowledged: replay.acknowledged,
          watermark: replay.watermark,
        };
      } else if (
        method === "operation.inspect" &&
        !this.options.handlers[method]
      )
        result = this.store!.inspect(String(params.operationId));
      else if (method === "session.snapshot" && !this.options.handlers[method])
        result = {
          disposition: "unknown",
          observation: this.store!.observationGap
            ? "reconciliation_required"
            : "complete",
          lastSourceSequence: this.store!.watermark,
        };
      else if (method === "session.close") {
        if (params.mode !== "drain" && params.mode !== "interrupt")
          throw new ProtocolError(
            "invalid_request",
            "Session close requires drain or interrupt mode"
          );
        queueMicrotask(() => {
          void this.close("session_close", message.id, params.mode === "drain");
        });
        return;
      } else {
        const allowed = optionalCapabilities(this.options.capabilities)[method];
        if (
          allowed === false ||
          (method === "operation.cancel" &&
            this.options.capabilities.operations.cancel === "unsupported") ||
          (method === "interaction.respond" &&
            this.options.capabilities.interactions.permissions === "none" &&
            !this.options.capabilities.interactions.questions)
        )
          result = { status: "unsupported" };
        else {
          const handler = this.options.handlers[method];
          if (!handler)
            throw new ProtocolError(
              "method_not_found",
              "Unknown plugin method"
            );
          if (
            method === "session.open" &&
            params.mode === "load" &&
            !this.options.capabilities.sessions.load
          )
            throw new ProtocolError(
              "continuity_unverified",
              "Cold native session load is unavailable"
            );
          if (
            method === "session.open" &&
            params.mode !== "new" &&
            params.mode !== "load"
          )
            throw new ProtocolError(
              "invalid_request",
              "Session open requires explicit new/load mode"
            );
          if (
            method === "session.open" &&
            params.mode === "load" &&
            !nonempty(params.nativeReference)
          )
            throw new ProtocolError(
              "session_not_found",
              "Session load requires an exact native reference"
            );
          if (mutationMethods.has(method))
            result = await this.mutate(method, params, handler);
          else {
            const task = Promise.resolve().then(() =>
              handler(params, this.context!)
            );
            this.track(
              task.then(
                () => {},
                () => {}
              )
            );
            result = await this.deadline(
              task,
              this.limits.inspectTimeoutMs,
              "request_timeout"
            );
          }
        }
      }
      if (this.state === "ready" || this.draining)
        this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.error(message.id!, error);
    }
  }
  private async mutate(
    method: string,
    params: JsonObject,
    handler: NativeHandler
  ): Promise<unknown> {
    const identifier =
      method === "session.open" ? params.openId : params.operationId;
    if (!nonempty(identifier) || !nonempty(params.payloadDigest))
      throw new ProtocolError(
        "invalid_request",
        "Mutation requires an immutable operation key and digest"
      );
    if (
      (method === "operation.cancel" || method === "interaction.respond") &&
      (!nonempty(params.targetOperationId) ||
        params.targetOperationId === params.operationId)
    )
      throw new ProtocolError(
        "invalid_request",
        "Control requires a distinct exact target operation"
      );
    if (
      method === "interaction.respond" &&
      !["instanceId", "interactionId", "optionId"].every((key) =>
        nonempty(params[key])
      )
    )
      throw new ProtocolError(
        "invalid_request",
        "Interaction decision requires exact process, request and option identity"
      );
    const key = `${method === "session.open" ? "open" : "operation"}:${identifier}`;
    const existing = this.store!.reservation(key);
    const conversation = String(params.conversationId ?? "binding");
    if (
      !existing &&
      (method === "operation.submit" || method === "session.open") &&
      this.busyConversations.has(conversation)
    )
      throw new ProtocolError(
        "busy",
        "Native conversation already has an in-flight command"
      );
    const reservation = this.store!.reserve(
      key,
      method,
      params.payloadDigest,
      params
    );
    if (!reservation.created) return reservation.result;
    if (
      method === "interaction.respond" &&
      params.instanceId !== this.context!.initialization.instanceId
    ) {
      const result = { status: "stale" };
      this.store!.settle(key, result);
      return result;
    }
    this.busyConversations.add(conversation);
    // Deadline bounds the response, not the native handler. Its late result may be saved,
    // but it never permits automatic replay or closes storage beneath an entered write.
    const task = Promise.resolve().then(() => handler(params, this.context!));
    const save = task.then((result) => {
      if (this.state !== "closed") this.store!.settle(key, result);
      return result;
    });
    const tracked = save.then(
      () => {
        this.busyConversations.delete(conversation);
      },
      () => {
        /* An ambiguous native failure continues to block this conversation. */
      }
    );
    this.track(tracked);
    return this.deadline(
      save,
      this.limits.commandTimeoutMs,
      "request_timeout"
    ).catch((error) => {
      if (error instanceof ProtocolError && error.code === "request_timeout")
        return reservation.result;
      throw error;
    });
  }
  private emit(event: EventInput): void {
    if (this.state !== "ready" && this.state !== "closing")
      throw new ProtocolError(
        "not_initialized",
        "Plugin cannot emit before initialization or after close"
      );
    try {
      this.store!.append(event);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "observation_gap")
        this.store!.appendGap(
          typeof event.operationId === "string" ? event.operationId : undefined,
          typeof event.turnId === "string" ? event.turnId : undefined
        );
      this.flush();
      throw error;
    }
    this.flush();
  }
  private flush(): void {
    if (!this.store || (this.state !== "ready" && !this.draining)) return;
    const available =
      this.limits.maxUnacknowledgedEvents -
      (this.store.highestSent - this.store.acknowledged);
    if (available <= 0) return;
    for (const event of this.store.pending(this.store.highestSent, available)) {
      const frame = encodeFrame(
        { jsonrpc: "2.0", method: "event", params: event },
        this.limits.maxFrameBytes
      );
      if (
        this.output.writableLength + frame.length >
        this.limits.maxFrameBytes * 2
      )
        return;
      // Mark before pipe write: a crash leaves a replayable retained event, never a new ID.
      this.store.markSent(event.sourceSequence);
      this.write({ jsonrpc: "2.0", method: "event", params: event });
    }
  }
  private async ownedProcess(
    method: string,
    params: JsonObject
  ): Promise<unknown> {
    const service = `ownership.${method}`;
    const init = this.context?.initialization;
    const cleanup =
      this.state === "closing" &&
      this.cleanupOwnershipOpen &&
      (method === "inspect" || method === "stopped");
    if ((this.state !== "ready" && !cleanup) || !init)
      throw new ProtocolError(
        "parent_eof",
        "Ownership service admission is closed"
      );
    if (
      !["prepare", "record", "inspect", "stopped"].includes(method) ||
      !Array.isArray(init.ownershipServices) ||
      !init.ownershipServices.includes(service)
    )
      throw new ProtocolError(
        "capability_unavailable",
        "Host did not grant this ownership service"
      );
    if (this.pending.size >= this.limits.maxPendingRequests)
      throw new ProtocolError(
        "resource_limit",
        "Too many pending ownership requests"
      );
    const id = `${init.instanceId}:ownership:${++this.rpcCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProtocolError(
            "request_timeout",
            "Child ownership requires inspection; do not activate"
          )
        );
      }, this.limits.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method: service,
          params: {
            ...params,
            bindingId: init.bindingId,
            leaseGeneration: init.leaseGeneration,
          },
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private async hostCall(call: HostCallInput): Promise<unknown> {
    if (this.state !== "ready")
      throw new ProtocolError("parent_eof", "Host service admission is closed");
    if (!this.options.capabilities.fleetTools)
      throw new ProtocolError(
        "unsupported",
        "Plugin did not advertise host service tools"
      );
    if (
      ![
        "fleet.discover",
        "fleet.send",
        "operator.enqueue",
        "artifact.read",
      ].includes(call.name) ||
      !nonempty(call.callId) ||
      !object(call.arguments)
    )
      throw new ProtocolError("invalid_request", "Invalid host service call");
    const mutating =
      call.name === "fleet.send" || call.name === "operator.enqueue";
    let key: string | undefined;
    let uncertain: unknown;
    if (mutating) {
      if (
        !nonempty(call.actionId) ||
        !nonempty(call.payloadDigest) ||
        !nonempty(call.operationId) ||
        !nonempty(call.toolCallId)
      )
        throw new ProtocolError(
          "invalid_request",
          "Mutating host call needs action, operation, tool identity and immutable digest"
        );
      key = `action:${call.actionId}`;
      const reservation = this.store!.reserve(
        key,
        "host.call",
        call.payloadDigest,
        call
      );
      if (!reservation.created) return reservation.result;
      uncertain = reservation.result;
    }
    if (this.pending.size >= this.limits.maxPendingRequests)
      throw new ProtocolError(
        "resource_limit",
        "Too many pending host service requests"
      );
    const init = this.context!.initialization;
    const id = `${init.instanceId}:host:${++this.rpcCounter}`;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new ProtocolError(
              "request_timeout",
              "Host call disposition is unknown"
            )
          );
        }, this.limits.commandTimeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.write({
            jsonrpc: "2.0",
            id,
            method: "host.call",
            params: {
              ...call,
              bindingId: init.bindingId,
              leaseGeneration: init.leaseGeneration,
            },
          });
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
      if (key && !this.abort.signal.aborted) this.store!.settle(key, result);
      return result;
    } catch (error) {
      if (key) return uncertain;
      throw error;
    }
  }
  private deadline<T>(
    promise: Promise<T>,
    milliseconds: number,
    code: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProtocolError(code, "Native disposition deadline exceeded")
            ),
          milliseconds
        );
      }),
    ]).finally(() => clearTimeout(timer!));
  }
  close(
    reason = "shutdown",
    responseId?: string,
    drain = false
  ): Promise<void> {
    if (responseId === undefined) this.cleanupOwnershipOpen = false;
    return (this.closing ??= (async () => {
      this.state = "closing";
      this.draining = drain;
      // Only an orderly host request retains a live reply channel. Signals,
      // protocol failures and EOF still rely on independent host reconciliation.
      this.cleanupOwnershipOpen =
        responseId !== undefined &&
        (reason === "shutdown" || reason === "session_close");
      let clean = true;
      const deadline = Date.now() + this.limits.shutdownTimeoutMs;
      const stop = () => {
        this.draining = false;
        this.abort.abort(reason);
        if (!this.cleanupOwnershipOpen) this.input.pause();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new ProtocolError(
              "parent_eof",
              "Host pipe closed; native disposition is unknown"
            )
          );
        }
        this.pending.clear();
      };
      if (drain) {
        try {
          await this.deadline(
            Promise.allSettled([...this.entered]),
            Math.max(1, deadline - Date.now()),
            "shutdown_timeout"
          );
        } catch {
          clean = false;
        }
      }
      if (!drain || !clean) stop();
      try {
        const cleanup =
          this.context && this.options.onClose
            ? this.options.onClose(
                {
                  reason,
                  mode: drain ? "drain" : "interrupt",
                  ownership: this.options.ownership ?? "owned",
                  deadline,
                },
                this.context
              )
            : undefined;
        const results = await this.deadline(
          Promise.all([
            Promise.resolve(cleanup),
            Promise.allSettled([...this.entered]),
          ]),
          Math.max(1, deadline - Date.now()),
          "shutdown_timeout"
        );
        if (
          (this.options.ownership ?? "owned") === "owned" &&
          results[0]?.ownedResourcesStopped !== true
        )
          clean = false;
      } catch {
        clean = false;
      }
      this.cleanupOwnershipOpen = false;
      stop();
      if (responseId) {
        try {
          this.write({
            jsonrpc: "2.0",
            id: responseId,
            result: {
              closed: true,
              ownership: this.options.ownership ?? "owned",
              cleanup: clean ? "complete" : "unknown",
              ...((this.options.ownership ?? "owned") === "attached"
                ? { nativeOutcome: "unknown" }
                : {}),
            },
          });
        } catch {
          clean = false;
        }
      }
      this.state = "closed";
      process.removeListener("SIGTERM", this.onTerm);
      process.removeListener("SIGINT", this.onInterrupt);
      try {
        this.store?.close(clean);
      } catch {
        clean = false;
      }
      this.output.end();
      this.finish({ reason, cleanup: clean ? "complete" : "unknown" });
    })());
  }
}
export function runPlugin(options: PluginOptions): PluginRuntime {
  return new PluginRuntime(options);
}
