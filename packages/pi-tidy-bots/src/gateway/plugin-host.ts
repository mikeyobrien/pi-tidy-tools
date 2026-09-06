import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import {
  ownedProcessIdentity,
  ownedGroupHasExited,
  type OwnedProcessIdentity,
} from "./process-ownership.ts";
import {
  CORE_METHODS,
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  nonempty,
  object,
  ProtocolError,
  validateCapabilities,
  validateEvent,
  validateLimits,
  type CapabilityDescriptor,
  type GatewayPluginEvent,
  type JsonObject,
  type ProtocolLimits,
  type RpcMessage,
} from "./protocol.ts";
import { digestArtifact, type PluginInstallation } from "./registry.ts";

export interface HostCall extends JsonObject {
  name: string;
  callId: string;
  arguments: JsonObject;
  bindingId: string;
  leaseGeneration: number;
}
export interface PluginHostOptions {
  installation: PluginInstallation;
  bindingId: string;
  leaseGeneration: number;
  config: JsonObject;
  workspace: string;
  dataDir: string;
  requireExistingData?: boolean;
  allowedEnv?: Record<string, string>;
  limits?: Partial<ProtocolLimits>;
  lastAcknowledgedSequence?: number;
  requiredCapabilities?: string[];
  onEvent: (event: GatewayPluginEvent) => Promise<number>;
  onHostCall?: (call: HostCall) => Promise<unknown>;
  onFailure?: (error: ProtocolError) => void;
  onLaunchPrepared?: (launchId: string) => void | Promise<void>;
  onLaunchRecorded?: (
    launchId: string,
    identity: OwnedProcessIdentity
  ) => void | Promise<void>;
  onLaunchStopped?: (launchId: string) => void | Promise<void>;
}
interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}
export class PluginHost {
  readonly instanceId = randomUUID();
  readonly limits: ProtocolLimits;
  readonly closed: Promise<void>;
  capabilities!: CapabilityDescriptor;
  runtime!: { name: string; version: string; transport?: string };
  health!: string;
  private child!: ChildProcessWithoutNullStreams;
  private endClosed!: () => void;
  private failClosed!: (error: unknown) => void;
  private readonly launchId = `tidy-launch-${randomUUID()}`;
  private control?: Writable;
  private state: "starting" | "ready" | "closing" | "closed" = "starting";
  private readonly pending = new Map<string, Pending>();
  private readonly reverseIds = new Set<string>();
  private counter = 0;
  private reversePending = 0;
  private readonly reverseTasks = new Set<Promise<void>>();
  private queuedEvents = 0;
  private queuedEventBytes = 0;
  private readonly unacknowledgedSequences = new Set<number>();
  private eventChain = Promise.resolve();
  private ack: number;
  private highestSeen: number;
  private failure?: ProtocolError;
  private stderrBytes = 0;
  private readonly options: PluginHostOptions;
  private constructor(options: PluginHostOptions) {
    this.options = options;
    this.limits = validateLimits(options.limits);
    this.ack = options.lastAcknowledgedSequence ?? 0;
    this.highestSeen = this.ack;
    if (
      !nonempty(options.bindingId) ||
      !Number.isSafeInteger(options.leaseGeneration) ||
      options.leaseGeneration < 1 ||
      !Number.isSafeInteger(this.ack) ||
      this.ack < 0
    )
      throw new ProtocolError(
        "invalid_config",
        "Invalid binding identity or sequence watermark"
      );
    this.closed = new Promise((resolve, reject) => {
      this.endClosed = resolve;
      this.failClosed = reject;
    });
    void this.closed.catch(() => {});
  }
  static async start(options: PluginHostOptions): Promise<PluginHost> {
    // Revalidate the pin immediately before process creation, not only registry loading.
    if (
      (await digestArtifact(options.installation.root)) !==
      options.installation.digest
    )
      throw new ProtocolError(
        "invalid_config",
        "Plugin artifact changed after registry validation"
      );
    if (
      !object(options.config) ||
      !options.installation.validateConfig(options.config)
    )
      throw new ProtocolError(
        "invalid_config",
        "Plugin configuration does not match its installed schema"
      );
    const host = new PluginHost(options);
    const workspace = await realpath(options.workspace);
    const namespaceFile = join(options.dataDir, ".gateway-namespace.json");
    let namespacePresent = false;
    try {
      const namespace = JSON.parse(await readFile(namespaceFile, "utf8"));
      if (
        !object(namespace) ||
        namespace.version !== 1 ||
        namespace.bindingId !== options.bindingId
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Plugin storage namespace differs from its binding"
        );
      namespacePresent = true;
    } catch (error) {
      if (!(object(error) && error.code === "ENOENT"))
        throw new ProtocolError(
          "corrupt_storage",
          "Plugin storage namespace is invalid"
        );
      if (options.requireExistingData)
        throw new ProtocolError(
          "corrupt_storage",
          "Established plugin storage namespace is missing"
        );
    }
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const dataDir = await realpath(options.dataDir);
    if (!namespacePresent) {
      const marker = await open(
        join(dataDir, ".gateway-namespace.json"),
        "wx",
        0o600
      );
      try {
        await marker.writeFile(
          JSON.stringify({ version: 1, bindingId: options.bindingId })
        );
        await marker.sync();
      } finally {
        await marker.close();
      }
      const directory = await open(dataDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.allowedEnv ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        name.startsWith("TIDY_")
      )
        throw new ProtocolError(
          "invalid_config",
          "Invalid allowlisted plugin environment"
        );
      env[name] = value;
    }
    Object.assign(env, {
      TIDY_BINDING_ID: options.bindingId,
      TIDY_INSTANCE_ID: host.instanceId,
      TIDY_LEASE_GENERATION: String(options.leaseGeneration),
      TIDY_WORKSPACE: workspace,
      TIDY_DATA_DIR: dataDir,
    });
    const activation = `${JSON.stringify({ activate: host.launchId, env })}\n`;
    if (Buffer.byteLength(activation) > 1024 * 1024)
      throw new ProtocolError(
        "resource_limit",
        "Plugin environment exceeds the activation frame limit"
      );
    await options.onLaunchPrepared?.(host.launchId);
    try {
      host.child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./owned-launcher.mjs", import.meta.url)),
          host.launchId,
          options.installation.executable,
          ...options.installation.args,
        ],
        {
          cwd: workspace,
          // Plugin loader/preload variables cannot execute code inside the trusted
          // launcher before its identity has been durably recorded.
          env: { PATH: "/usr/bin:/bin" },
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        }
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      await options.onLaunchStopped?.(host.launchId);
      throw error;
    }
    host.observe();
    try {
      host.control = host.child.stdio[3] as Writable | undefined;
      if (
        !host.control ||
        !host.child.stdin ||
        !host.child.stdout ||
        !host.child.stderr
      )
        throw new ProtocolError(
          "plugin_spawn",
          "Supervisor pipes could not be opened"
        );
      host.control.on("error", () =>
        host.isolate(
          new ProtocolError("plugin_pipe", "Supervisor control pipe failed")
        )
      );
      if (!host.child.pid)
        throw new ProtocolError("plugin_spawn", "Supervisor could not start");
      const identity = await ownedProcessIdentity(
        host.child.pid,
        host.launchId
      );
      await options.onLaunchRecorded?.(host.launchId, identity);
      if (host.state !== "starting")
        throw new ProtocolError(
          "plugin_spawn",
          "Supervisor stopped before activation"
        );
      host.control.write(activation);
      const result = await host.sendRequest(
        "initialize",
        {
          protocol: { major: 1, minMinor: 0, maxMinor: 0 },
          expectedPlugin: {
            id: options.installation.manifest.id,
            version: options.installation.manifest.version,
            digest: options.installation.digest,
          },
          instanceId: host.instanceId,
          bindingId: options.bindingId,
          leaseGeneration: options.leaseGeneration,
          config: structuredClone(options.config),
          workspace,
          dataDir,
          limits: host.limits,
        },
        host.limits.initializeTimeoutMs
      );
      if (!host.isReady)
        throw new ProtocolError(
          "initialize_failed",
          "Plugin became unavailable during initialization"
        );
      return host;
    } catch (error) {
      host.isolate(
        error instanceof ProtocolError
          ? error
          : new ProtocolError(
              "initialize_failed",
              "Plugin initialization failed"
            )
      );
      await host.closed;
      throw error;
    }
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get isReady(): boolean {
    return this.state === "ready";
  }
  get acknowledgedSequence(): number {
    return this.ack;
  }
  /** Raw stderr is deliberately never returned to clients or logs. */
  get diagnostics(): { stderrBytes: number; code?: string } {
    return { stderrBytes: this.stderrBytes, code: this.failure?.code };
  }
  private initialize(value: unknown): void {
    if (
      !object(value) ||
      !object(value.protocol) ||
      value.protocol.major !== 1 ||
      value.protocol.minor !== 0 ||
      !object(value.plugin) ||
      value.plugin.id !== this.options.installation.manifest.id ||
      value.plugin.version !== this.options.installation.manifest.version ||
      !object(value.runtime) ||
      !nonempty(value.runtime.name) ||
      !nonempty(value.runtime.version) ||
      !Array.isArray(value.methods) ||
      CORE_METHODS.some(
        (method) => !(value.methods as unknown[]).includes(method)
      ) ||
      !["ready", "degraded", "auth_required", "unavailable"].includes(
        String(value.health)
      )
    )
      throw new ProtocolError(
        "initialize_failed",
        "Plugin initialization identity, protocol, methods or health are invalid"
      );
    this.capabilities = validateCapabilities(value.capabilities);
    this.runtime = value.runtime as PluginHost["runtime"];
    this.health = String(value.health);
    for (const path of this.options.requiredCapabilities ?? []) {
      let current: unknown = this.capabilities;
      for (const part of path.split("."))
        current = object(current) ? current[part] : undefined;
      if (current !== true)
        throw new ProtocolError(
          "capability_unavailable",
          `Required capability ${path} is unavailable`
        );
    }
    if (
      this.capabilities.fleetTools &&
      !this.options.installation.manifest.requestedAccess.gatewayTools.some(
        (name) => name.startsWith("fleet.")
      )
    )
      throw new ProtocolError(
        "invalid_capabilities",
        "Fleet tools are not declared by the installed manifest"
      );
  }
  private observe(): void {
    const parser = new FrameDecoder(this.limits.maxFrameBytes);
    this.child.stdout?.on("data", (chunk: Buffer) => {
      if (this.state === "closed") return;
      try {
        parser.push(chunk, (message) => this.receive(message));
      } catch (error) {
        this.isolate(
          error instanceof ProtocolError
            ? error
            : new ProtocolError("invalid_frame", "Plugin protocol failed")
        );
      }
    });
    this.child.stdout?.on("end", () => {
      try {
        parser.finish();
      } catch (error) {
        this.isolate(error as ProtocolError);
      }
      if (this.state !== "closing" && this.state !== "closed")
        this.isolate(
          new ProtocolError("plugin_eof", "Plugin protocol pipe closed")
        );
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.stderrBytes + chunk.length
      );
    });
    this.child.stdin?.on("error", () =>
      this.isolate(new ProtocolError("plugin_pipe", "Plugin input pipe failed"))
    );
    this.child.on("error", () =>
      this.isolate(
        new ProtocolError("plugin_spawn", "Plugin process could not start")
      )
    );
    this.child.on("exit", () => this.control?.destroy());
    this.child.on("close", () => {
      if (this.state !== "closing" && !this.failure)
        this.isolate(new ProtocolError("plugin_exit", "Plugin process exited"));
      this.state = "closed";
      this.rejectPending(
        this.failure ??
          new ProtocolError("plugin_closed", "Plugin connection closed")
      );
      // An entered durable callback may still own the journal after process exit.
      // Callers can close storage only once all such callbacks have settled.
      void Promise.allSettled([this.eventChain, ...this.reverseTasks])
        .then(async () => {
          if (this.child.pid && !(await ownedGroupHasExited(this.child.pid)))
            throw new ProtocolError(
              "ownership_unreconciled",
              "Owned descendants survived supervisor shutdown"
            );
          await this.options.onLaunchStopped?.(this.launchId);
        })
        .then(this.endClosed, this.failClosed);
    });
  }
  private receive(message: RpcMessage): void {
    if (!message.method) {
      const pending = this.pending.get(message.id!);
      // Timed-out responses remain observationally ambiguous and cannot satisfy a later request.
      if (!pending) return;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new ProtocolError(
            object(message.error.data) && nonempty(message.error.data.code)
              ? message.error.data.code
              : "plugin_error",
            message.error.message
          )
        );
      else {
        if (pending.method === "initialize") {
          try {
            this.initialize(message.result);
            this.state = "ready";
          } catch (error) {
            pending.reject(error);
            throw error;
          }
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (this.state === "starting")
      throw new ProtocolError(
        "not_initialized",
        "Plugin called host before initialization completed"
      );
    if (message.method === "event" && message.id === undefined) {
      const event = validateEvent(message.params);
      this.assertBinding(event);
      const eventBytes = encodeFrame(message, this.limits.maxFrameBytes).length;
      this.queuedEventBytes += eventBytes;
      if (this.queuedEventBytes > this.limits.maxSpoolBytes)
        throw new ProtocolError(
          "resource_limit",
          "Plugin exceeded bounded event queue bytes"
        );
      if (++this.queuedEvents > this.limits.maxUnacknowledgedEvents)
        throw new ProtocolError(
          "resource_limit",
          "Plugin exceeded unacknowledged event credits"
        );
      if (event.sourceSequence > this.ack)
        this.unacknowledgedSequences.add(event.sourceSequence);
      if (
        this.unacknowledgedSequences.size > this.limits.maxUnacknowledgedEvents
      )
        throw new ProtocolError(
          "resource_limit",
          "Plugin exhausted unacknowledged sequence credits"
        );
      this.highestSeen = Math.max(this.highestSeen, event.sourceSequence);
      this.eventChain = this.eventChain
        .then(async () => {
          if (this.failure || this.state === "closed") return;
          const durable = await this.options.onEvent(event);
          if (
            !Number.isSafeInteger(durable) ||
            durable < this.ack ||
            durable > this.highestSeen
          )
            throw new ProtocolError(
              "invalid_ack",
              "Host returned an invalid durable sequence watermark"
            );
          if (this.failure || !this.child.stdin.writable) return;
          this.ack = durable;
          for (const sequence of this.unacknowledgedSequences)
            if (sequence <= durable)
              this.unacknowledgedSequences.delete(sequence);
          this.notify("events.ack", { sourceSequence: durable });
        })
        .catch(() =>
          this.isolate(
            new ProtocolError(
              "event_commit_failed",
              "Canonical event could not be durably committed"
            )
          )
        )
        .finally(() => {
          this.queuedEvents--;
          this.queuedEventBytes -= eventBytes;
        });
      return;
    }
    if (message.method === "host.call" && message.id !== undefined) {
      const task = this.handleCall(message);
      this.reverseTasks.add(task);
      void task.then(
        () => this.reverseTasks.delete(task),
        (error) => {
          this.reverseTasks.delete(task);
          this.isolate(
            error instanceof ProtocolError
              ? error
              : new ProtocolError(
                  "host_call_failed",
                  "Host response transport failed"
                )
          );
        }
      );
      return;
    }
    if (message.id !== undefined)
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    else
      throw new ProtocolError(
        "invalid_frame",
        "Unsupported plugin notification"
      );
  }
  private assertBinding(params: JsonObject): void {
    if (
      params.bindingId !== this.options.bindingId ||
      params.leaseGeneration !== this.options.leaseGeneration
    )
      throw new ProtocolError(
        "stale_binding",
        "Plugin output carries a stale binding lease"
      );
  }
  private async handleCall(message: RpcMessage): Promise<void> {
    const id = message.id!;
    let ownsId = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.state !== "ready")
        throw new ProtocolError(
          "plugin_closed",
          "Host service admission is closed"
        );
      if (this.reverseIds.has(id))
        throw new ProtocolError(
          "invalid_frame",
          "Duplicate live reverse RPC ID"
        );
      if (this.reversePending >= this.limits.maxPendingRequests)
        throw new ProtocolError("resource_limit", "Too many reverse requests");
      const value = message.params;
      if (!object(value))
        throw new ProtocolError(
          "invalid_frame",
          "Missing host call parameters"
        );
      this.assertBinding(value);
      if (
        !nonempty(value.name) ||
        !nonempty(value.callId) ||
        !object(value.arguments)
      )
        throw new ProtocolError("invalid_frame", "Malformed host service call");
      if (
        !this.options.onHostCall ||
        !this.options.installation.policy.gatewayTools?.includes(value.name) ||
        !this.options.installation.manifest.requestedAccess.gatewayTools.includes(
          value.name
        ) ||
        (value.name.startsWith("fleet.") && !this.capabilities.fleetTools)
      )
        throw new ProtocolError(
          "capability_unavailable",
          "Host service is not permitted for this binding"
        );
      if (
        ["fleet.send", "operator.enqueue"].includes(value.name) &&
        (!nonempty(value.actionId) ||
          !nonempty(value.payloadDigest) ||
          !nonempty(value.operationId) ||
          !nonempty(value.toolCallId))
      )
        throw new ProtocolError(
          "invalid_frame",
          "Mutating host call requires durable action and origin identity"
        );
      this.reverseIds.add(id);
      this.reversePending++;
      ownsId = true;
      deadline = setTimeout(
        () =>
          this.isolate(
            new ProtocolError(
              "host_call_timeout",
              "Host service disposition exceeded its deadline"
            )
          ),
        this.limits.commandTimeoutMs
      );
      const result = await this.options.onHostCall(value as HostCall);
      if (this.state === "ready") this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (this.state === "ready") {
        const code =
          error instanceof ProtocolError ? error.code : "host_failure";
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: code, data: { code } },
        });
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (ownsId && this.reverseIds.delete(id)) this.reversePending--;
    }
  }
  private write(message: RpcMessage): void {
    const frame = encodeFrame(message, this.limits.maxFrameBytes);
    if (this.state === "closed" || !this.child.stdin.writable)
      throw new ProtocolError(
        "plugin_closed",
        "Plugin connection is not writable"
      );
    if (
      this.child.stdin.writableLength + frame.length >
      this.limits.maxFrameBytes * 2
    )
      throw new ProtocolError(
        "resource_limit",
        "Plugin input pipe is backpressured"
      );
    this.child.stdin.write(frame);
  }
  private sendRequest(
    method: string,
    params: JsonObject,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.pending.size >= this.limits.maxPendingRequests)
      return Promise.reject(
        new ProtocolError("resource_limit", "Too many pending plugin requests")
      );
    if (this.counter >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(
        new ProtocolError(
          "resource_limit",
          "Connection request identity space exhausted"
        )
      );
    const id = `${this.instanceId}:${++this.counter}`;
    const message: RpcMessage = { jsonrpc: "2.0", id, method, params };
    // Preflight before reserving a timer, writing or crossing a native boundary.
    try {
      encodeFrame(message, this.limits.maxFrameBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProtocolError(
            "request_timeout",
            `${method} disposition is unknown after its deadline`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  /** Pre-admission whole-frame validation using the maximum future connection RPC ID width. */
  assertSubmitFits(
    params: JsonObject,
    maxRpcIdLength = this.instanceId.length + 17
  ): void {
    if (
      !Number.isSafeInteger(maxRpcIdLength) ||
      maxRpcIdLength < this.instanceId.length + 17 ||
      maxRpcIdLength > 256
    )
      throw new ProtocolError(
        "invalid_config",
        "Invalid future RPC ID byte allowance"
      );
    encodeFrame(
      {
        jsonrpc: "2.0",
        id: "r".repeat(maxRpcIdLength),
        method: "operation.submit",
        params: {
          ...params,
          bindingId: this.options.bindingId,
          leaseGeneration: this.options.leaseGeneration,
        },
      },
      this.limits.maxFrameBytes
    );
  }
  request(
    method: string,
    params: JsonObject = {},
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (this.state !== "ready")
      return Promise.reject(
        new ProtocolError("plugin_closed", "Plugin is not ready")
      );
    if (method === "initialize")
      return Promise.reject(
        new ProtocolError(
          "invalid_request",
          "Connection is already initialized"
        )
      );
    const optional: Record<string, boolean> = {
      "operation.steer": this.capabilities.operations.steer,
      "session.compact": this.capabilities.configuration.compact,
      "session.configure":
        this.capabilities.configuration.model ||
        this.capabilities.configuration.thinking,
      "session.import": this.capabilities.sessions.import,
    };
    if (
      optional[method] === false ||
      (method === "interaction.respond" &&
        this.capabilities.interactions.permissions === "none" &&
        !this.capabilities.interactions.questions)
    )
      return Promise.reject(
        new ProtocolError("capability_unavailable", `${method} is unavailable`)
      );
    const max = [
      "health",
      "operation.inspect",
      "session.snapshot",
      "events.replay",
    ].includes(method)
      ? this.limits.inspectTimeoutMs
      : this.limits.commandTimeoutMs;
    const timeout = options.timeoutMs ?? max;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > max)
      return Promise.reject(
        new ProtocolError("invalid_config", "Invalid request deadline")
      );
    return this.sendRequest(
      method,
      {
        ...params,
        bindingId: this.options.bindingId,
        leaseGeneration: this.options.leaseGeneration,
      },
      timeout
    );
  }
  notify(method: string, params: JsonObject): void {
    if (this.state !== "ready" && this.state !== "closing")
      throw new ProtocolError("plugin_closed", "Plugin is not ready");
    this.write({
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        bindingId: this.options.bindingId,
        leaseGeneration: this.options.leaseGeneration,
      },
    });
  }
  private rejectPending(error: ProtocolError): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  private stopSupervisor(): void {
    // Only a live private pipe requests signalling. The trusted group leader
    // signals itself; historical/reused numeric PIDs are never killed here.
    if (this.control?.writable)
      this.control.end(
        `shutdown:${Math.min(1_000, this.limits.shutdownTimeoutMs)}\n`
      );
  }
  private isolate(error: ProtocolError): void {
    if (this.failure || this.state === "closed") return;
    this.failure = error;
    this.state = "closing";
    this.rejectPending(error);
    try {
      this.options.onFailure?.(error);
    } catch {
      /* failure observers do not own supervision */
    }
    this.child.stdin?.destroy();
    this.stopSupervisor();
  }
  async close(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return this.closed;
    this.state = "closing";
    try {
      await this.sendRequest(
        "shutdown",
        {
          bindingId: this.options.bindingId,
          leaseGeneration: this.options.leaseGeneration,
          gracePeriodMs: this.limits.shutdownTimeoutMs,
        },
        this.limits.shutdownTimeoutMs
      );
    } catch {
      /* EOF and reaping still apply */
    }
    this.child.stdin.end();
    this.stopSupervisor();
    await this.closed;
  }
}
