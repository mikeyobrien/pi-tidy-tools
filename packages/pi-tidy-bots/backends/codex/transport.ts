import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  ProtocolError,
  object,
  nonempty,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

type Id = string | number;
export class CodexRequestError extends Error {
  constructor(
    readonly code: number,
    readonly nativeMessage?: string
  ) {
    super("Native Codex request returned a correlated error");
    this.name = "CodexRequestError";
  }
}
export interface CodexTransportOptions {
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

/** Codex app-server JSON-RPC over LF frames. Wire omits `jsonrpc`. */
export class CodexTransport {
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

  constructor(private readonly options: CodexTransportOptions) {
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
          "Invalid Codex transport limit"
        );
    this.bytes = Buffer.allocUnsafe(this.maxFrameBytes - 1);
    options.output.on("data", this.receive);
    options.output.once("end", this.ended);
    options.output.once("close", this.ended);
    options.output.on("error", this.ioFailed);
    options.input.on("error", this.ioFailed);
    options.input.once("close", this.ended);
  }

  request(
    method: string,
    params: JsonObject,
    timeoutMs = this.timeout
  ): Promise<unknown> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 3600000
    )
      return Promise.reject(
        new ProtocolError("invalid_config", "Invalid Codex request deadline")
      );
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.maxPending)
      return Promise.reject(
        new ProtocolError(
          "resource_limit",
          "Codex request capacity exhausted before dispatch"
        )
      );
    const id = `${this.prefix}:${++this.counter}`;
    let frame: Buffer;
    try {
      frame = this.frame({ id, method, params });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("native_timeout"), timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write(frame);
    });
  }
  respond(id: Id, result: unknown): void {
    if (this.failure) throw this.failure;
    this.write(this.frame({ id, result: object(result) ? result : {} }));
  }
  reject(id: Id, code: number, message: string): void {
    if (this.failure) throw this.failure;
    this.write(
      this.frame({
        id,
        error: { code, message: "native_request_rejected" },
      })
    );
    void message;
  }
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
        "Codex requires a method and object parameters"
      );
    let frame: Buffer;
    try {
      frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
    } catch {
      throw new ProtocolError(
        "invalid_payload",
        "Codex message is not serializable"
      );
    }
    if (frame.length > this.maxFrameBytes)
      throw new ProtocolError(
        "resource_limit",
        "Codex frame exceeds byte limit before dispatch"
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
    if (!object(value)) throw new Error();
    if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0")
      throw new Error();
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
        const observed: unknown = this.options.onNotification(
          value.method,
          params
        );
        if (observed instanceof Promise) {
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
      void response.then(
        (result) => {
          this.activeNative--;
          try {
            this.respond(id, result);
          } catch {
            this.fail("native_io_error");
          }
        },
        () => {
          this.activeNative--;
          try {
            this.reject(id, -32603, "native_request_failed");
          } catch {
            this.fail("native_io_error");
          }
        }
      );
      return;
    }
    if (!has("id")) throw new Error();
    const pending = this.pending.get(String(value.id));
    if (!pending) throw new Error();
    this.pending.delete(String(value.id));
    clearTimeout(pending.timer);
    if (has("error")) {
      const error = object(value.error) ? value.error : {};
      pending.reject(
        new CodexRequestError(
          Number.isSafeInteger(error.code) ? Number(error.code) : -32000,
          nonempty(error.message) ? error.message : undefined
        )
      );
      return;
    }
    if (!has("result")) throw new Error();
    pending.resolve(value.result);
  }
  private readonly ended = () => this.fail("native_closed");
  private readonly ioFailed = () => this.fail("native_io_error");
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = new ProtocolError(code, "Codex transport failed");
    this.options.output.off("data", this.receive);
    this.abort.abort();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.options.onFailure(this.failure);
  }
}
