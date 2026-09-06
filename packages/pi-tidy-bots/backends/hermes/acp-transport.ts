import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  ProtocolError,
  object,
  nonempty,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

type Id = string | number;
export class AcpRequestError extends Error {
  constructor(readonly code: number) {
    // Native error messages/data can contain credentials or private reasoning.
    super("Native ACP request returned a correlated error");
    this.name = "AcpRequestError";
  }
}
export interface AcpTransportOptions {
  input: Writable;
  output: Readable;
  onNotification: (method: string, params: JsonObject) => void;
  onRequest: (
    method: string,
    params: JsonObject,
    id: Id,
    signal: AbortSignal
  ) => Promise<unknown>;
  onFailure: (error: ProtocolError) => void;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  maxNativeRequestIds?: number;
  requestTimeoutMs?: number;
}
function validId(id: unknown): id is Id {
  return (
    (nonempty(id) && id.length <= 512) ||
    (typeof id === "number" && Number.isSafeInteger(id))
  );
}

/** ACP 0.9 JSON-RPC framing; lifecycle/ownership stays with the native supervisor.
 * A failed or timed-out stream cannot be reused or automatically replayed.
 * Completion of a pipe write never establishes native execution or approval.
 */
export class AcpTransport {
  private readonly maxFrameBytes: number;
  private readonly maxPending: number;
  private readonly maxNativeIds: number;
  private readonly timeout: number;
  private readonly bytes: Buffer;
  private size = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly prefix = randomUUID();
  private counter = 0;
  private failure?: ProtocolError;
  private readonly abort = new AbortController();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly nativeIds = new Set<Id>();
  private activeNative = 0;
  private queuedBytes = 0;

  constructor(private readonly options: AcpTransportOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.maxPending = options.maxPendingRequests ?? 256;
    this.maxNativeIds = options.maxNativeRequestIds ?? 65536;
    this.timeout = options.requestTimeoutMs ?? 15000;
    for (const [value, maximum] of [
      [this.maxFrameBytes, 1024 * 1024],
      [this.maxPending, 256],
      [this.maxNativeIds, 65536],
      [this.timeout, 3600000],
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new ProtocolError(
          "invalid_config",
          "Invalid ACP transport limit"
        );
    this.bytes = Buffer.allocUnsafe(this.maxFrameBytes - 1);
    options.output.on("data", this.receive);
    options.output.once("end", this.ended);
    options.output.once("close", this.ended);
    options.output.on("error", this.ioFailed);
    options.input.on("error", this.ioFailed);
    options.input.once("close", this.ended);
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.maxPending)
      return Promise.reject(
        new ProtocolError(
          "resource_limit",
          "ACP request capacity exhausted before dispatch"
        )
      );
    const id = `${this.prefix}:${++this.counter}`;
    let frame: Buffer;
    try {
      frame = this.frame({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("native_timeout"), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write(frame);
    });
  }
  notify(method: string, params: JsonObject): void {
    if (this.failure) throw this.failure;
    this.write(this.frame({ jsonrpc: "2.0", method, params }));
  }
  /** The owner must independently reap the child and all owned descendants. */
  close(): void {
    this.fail("native_closed");
  }

  private frame(message: JsonObject): Buffer {
    if (
      Object.hasOwn(message, "method") &&
      (!nonempty(message.method) || !object(message.params))
    )
      throw new ProtocolError(
        "invalid_payload",
        "ACP requires a method and object parameters"
      );
    let frame: Buffer;
    try {
      frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
    } catch {
      throw new ProtocolError(
        "invalid_payload",
        "ACP message is not serializable"
      );
    }
    if (frame.length > this.maxFrameBytes)
      throw new ProtocolError(
        "resource_limit",
        "ACP frame exceeds byte limit before dispatch"
      );
    return frame;
  }
  private write(frame: Buffer): void {
    if (this.failure) return;
    if (
      this.queuedBytes + frame.length >
      this.maxFrameBytes * this.maxPending
    ) {
      this.fail("resource_limit");
      return;
    }
    this.queuedBytes += frame.length;
    try {
      this.options.input.write(frame, (error) => {
        this.queuedBytes -= frame.length;
        if (error) this.fail("native_io_error");
      });
    } catch {
      this.fail("native_io_error");
    }
  }
  private readonly receive = (chunk: Buffer) => {
    if (this.failure) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error();
      let offset = 0;
      while (offset < chunk.length && !this.failure) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - offset;
        if (this.size + length + 1 > this.maxFrameBytes) {
          this.fail("resource_limit");
          return;
        }
        chunk.copy(this.bytes, this.size, offset, end);
        this.size += length;
        offset = end + 1;
        if (newline === -1) break;
        const value: unknown = JSON.parse(
          this.decoder.decode(this.bytes.subarray(0, this.size))
        );
        this.size = 0;
        this.message(value);
      }
    } catch {
      this.fail("native_protocol_error");
    }
  };
  private message(value: unknown): void {
    if (!object(value) || value.jsonrpc !== "2.0") throw new Error();
    const has = (key: string) => Object.hasOwn(value, key);
    if (has("id") && !validId(value.id)) throw new Error();
    if (has("method")) {
      if (
        !nonempty(value.method) ||
        has("result") ||
        has("error") ||
        (has("params") && !object(value.params))
      )
        throw new Error();
      const params = (value.params ?? {}) as JsonObject;
      if (!has("id")) {
        // Commit observations synchronously and in wire order. Permission
        // futures must not block a subsequent terminal notification/response.
        const observed: unknown = this.options.onNotification(
          value.method,
          params
        );
        if (observed instanceof Promise) {
          // TypeScript permits async functions where a void callback is
          // expected. Refuse that loophole instead of committing later frames
          // before an earlier observation reaches durable storage.
          void observed.catch(() => {});
          throw new Error();
        }
        return;
      }
      const id = value.id as Id;
      if (this.nativeIds.has(id)) throw new Error();
      if (
        this.nativeIds.size >= this.maxNativeIds ||
        this.activeNative >= this.maxPending
      ) {
        this.fail("resource_limit");
        return;
      }
      this.nativeIds.add(id);
      this.activeNative++;
      let response: Promise<unknown>;
      try {
        response = this.options.onRequest(
          value.method,
          params,
          id,
          this.abort.signal
        );
      } catch {
        this.activeNative--;
        this.fail("native_request_failed");
        return;
      }
      void Promise.resolve(response).then(
        (result) => {
          this.activeNative--;
          if (this.failure) return;
          // Undefined is not a JSON-RPC result; don't accidentally emit a frame
          // with neither result nor error after JSON serialization.
          if (result === undefined) {
            this.fail("native_request_failed");
            return;
          }
          try {
            this.write(this.frame({ jsonrpc: "2.0", id, result }));
          } catch {
            this.fail("native_request_failed");
          }
        },
        () => {
          this.activeNative--;
          this.fail("native_request_failed");
        }
      );
      return;
    }
    if (
      !has("id") ||
      has("params") ||
      has("result") === has("error") ||
      typeof value.id !== "string"
    )
      throw new Error();
    if (
      has("error") &&
      (!object(value.error) ||
        !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== "string")
    )
      throw new Error();
    const pending = this.pending.get(value.id);
    if (!pending) throw new Error();
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (has("error"))
      pending.reject(
        new AcpRequestError((value.error as JsonObject).code as number)
      );
    else pending.resolve(value.result);
  }
  private readonly ioFailed = () => this.fail("native_io_error");
  private readonly ended = () =>
    this.fail(this.size ? "native_truncated_frame" : "native_closed");
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = new ProtocolError(
      code,
      "Native ACP transport is unavailable; execution requires reconciliation"
    );
    this.abort.abort(this.failure);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.options.output.off("data", this.receive);
    try {
      this.options.onFailure(this.failure);
    } catch {
      /* Preserve the original transport failure. */
    }
  }
}
