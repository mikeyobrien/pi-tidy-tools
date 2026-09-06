import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { PluginContext } from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  FrameDecoder,
  encodeFrame,
  nonempty,
  object,
  ProtocolError,
  type JsonObject,
  type RpcMessage,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

interface Prompt {
  operationId: string;
  turnId: string;
  promptId: string;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const valid = (value: unknown): value is string =>
  nonempty(value) &&
  Boolean(value.trim()) &&
  value.length <= 256 &&
  !value.includes("\0");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () =>
  new ProtocolError(
    "native_fleet_unavailable",
    "Pi fleet bridge is unavailable"
  );

/** Binding-private FD 3 service. Caller reserves the operation before activate.
 * A native prompt nonce scopes calls; native IDs, never transport IDs, scope
 * durable actions. Unknown host replies remain the SDK's retained uncertainty.
 */
export class PiFleetBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly parser: FrameDecoder;
  private sessionId?: string;
  private prompt?: Prompt;
  private opening = false;
  private closed = false;
  private inflight = 0;
  private readonly abort = () => this.close();
  constructor(
    private readonly stream: Duplex,
    private readonly ctx: Pick<
      PluginContext,
      "initialization" | "hostCall" | "signal"
    >,
    private readonly hooks: {
      onFailure(): void;
      onActivity(
        scope: { operationId: string; turnId: string },
        tool: { toolCallId: string; name: string }
      ): void;
    }
  ) {
    this.parser = new FrameDecoder(ctx.initialization.limits.maxFrameBytes);
    stream.on("data", (bytes: Buffer) => {
      try {
        this.parser.push(bytes, (message) => this.receive(message));
      } catch {
        this.fail();
      }
    });
    stream.on("error", () => this.fail());
    stream.on("end", () => this.fail());
    stream.on("close", () => this.fail());
    ctx.signal.addEventListener("abort", this.abort, { once: true });
    if (ctx.signal.aborted) this.close();
  }
  async initialize(): Promise<string> {
    if (this.opening || this.closed) throw unavailable();
    this.opening = true;
    try {
      const result = await this.request("initialize", {
        limits: this.ctx.initialization.limits,
      });
      if (
        this.closed ||
        !object(result) ||
        result.bridgeVersion !== 1 ||
        !valid(result.nativeSessionId) ||
        JSON.stringify(result.tools) !==
          JSON.stringify(["fleet_discover", "fleet_send"])
      )
        throw unavailable();
      this.sessionId = result.nativeSessionId;
      return this.sessionId;
    } catch (error) {
      this.fail();
      throw error;
    }
  }
  async activate(operationId: string, turnId: string): Promise<void> {
    if (
      this.closed ||
      !this.sessionId ||
      this.prompt ||
      !valid(operationId) ||
      !valid(turnId)
    )
      throw unavailable();
    const prompt = { operationId, turnId, promptId: randomUUID() };
    this.prompt = prompt;
    try {
      const result = await this.request("activate", {
        nativeSessionId: this.sessionId,
        promptId: prompt.promptId,
      });
      if (
        this.closed ||
        !object(result) ||
        result.status !== "armed" ||
        result.promptId !== prompt.promptId
      )
        throw unavailable();
    } catch (error) {
      this.fail();
      throw error;
    }
  }
  finishPrompt(operationId: string): void {
    if (this.prompt?.operationId !== operationId) {
      this.fail();
      return;
    }
    this.prompt = undefined;
  }
  async rejectPrompt(operationId: string): Promise<void> {
    if (!this.prompt || this.prompt.operationId !== operationId)
      throw unavailable();
    try {
      const result = await this.request("disarm", {
        promptId: this.prompt.promptId,
      });
      if (this.closed || !object(result) || result.status !== "disarmed")
        throw unavailable();
      this.prompt = undefined;
    } catch (error) {
      this.fail();
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.prompt = undefined;
    this.ctx.signal.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(unavailable());
    }
    this.pending.clear();
    this.stream.destroy();
  }
  private fail(): void {
    if (this.closed) return;
    this.close();
    this.hooks.onFailure();
  }
  private write(message: RpcMessage): void {
    if (this.closed) throw unavailable();
    const max = this.ctx.initialization.limits.maxFrameBytes;
    const frame = encodeFrame(message, max);
    if (this.stream.writableLength + frame.length > 2 * max)
      throw unavailable();
    this.stream.write(frame);
  }
  private request(method: string, params: JsonObject): Promise<unknown> {
    if (
      this.closed ||
      this.pending.size >= this.ctx.initialization.limits.maxPendingRequests
    )
      return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable());
        this.fail();
      }, this.ctx.initialization.limits.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch {
        this.fail();
      }
    });
  }
  private receive(message: RpcMessage): void {
    if (this.closed) return;
    if (!message.method) {
      const pending = this.pending.get(message.id!);
      if (!pending) throw unavailable();
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(unavailable());
      else pending.resolve(message.result);
      return;
    }
    if (
      message.method !== "fleet.call" ||
      !message.id ||
      this.seen.has(message.id) ||
      this.seen.size >= 4096 ||
      this.inflight >= this.ctx.initialization.limits.maxPendingRequests
    )
      throw unavailable();
    this.seen.add(message.id);
    this.inflight++;
    void this.call(message.params)
      .then(
        (result) => {
          if (!this.closed)
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              result: result ?? { status: "unknown" },
            });
        },
        () => {
          if (!this.closed)
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message:
                  "Fleet tool unavailable; task completion is not confirmed",
              },
            });
        }
      )
      .catch(() => this.fail())
      .finally(() => {
        this.inflight--;
      });
  }
  private async call(params: unknown): Promise<unknown> {
    const prompt = this.prompt;
    if (
      !prompt ||
      !object(params) ||
      this.closed ||
      this.ctx.signal.aborted ||
      params.nativeSessionId !== this.sessionId ||
      params.promptId !== prompt.promptId ||
      !valid(params.nativeToolCallId) ||
      !["fleet.send", "fleet.discover"].includes(String(params.name)) ||
      !object(params.arguments) ||
      Object.keys(params).some(
        (key) =>
          ![
            "nativeSessionId",
            "promptId",
            "nativeToolCallId",
            "name",
            "arguments",
          ].includes(key)
      )
    )
      throw unavailable();
    const args = params.arguments;
    if (
      params.name === "fleet.discover"
        ? Object.keys(args).length !== 0
        : Object.keys(args).length !== 2 ||
          !valid(args.target) ||
          !nonempty(args.text) ||
          !args.text.trim() ||
          Buffer.byteLength(args.text) > 65536
    )
      throw unavailable();
    const arguments_: JsonObject =
      params.name === "fleet.send"
        ? { target: args.target, text: args.text }
        : {};
    this.hooks.onActivity(
      {
        operationId: prompt.operationId,
        turnId: prompt.turnId,
      },
      { toolCallId: params.nativeToolCallId, name: String(params.name) }
    );
    const actionId = `pi-fleet-${digest({ bindingId: this.ctx.initialization.bindingId, operationId: prompt.operationId, toolCallId: params.nativeToolCallId })}`;
    return this.ctx.hostCall({
      name: String(params.name),
      callId: params.name === "fleet.send" ? actionId : randomUUID(),
      arguments: arguments_,
      operationId: prompt.operationId,
      toolCallId: params.nativeToolCallId,
      ...(params.name === "fleet.send"
        ? {
            actionId,
            payloadDigest: `sha256:${digest({ name: params.name, arguments: arguments_, operationId: prompt.operationId, toolCallId: params.nativeToolCallId })}`,
          }
        : {}),
    });
  }
}
