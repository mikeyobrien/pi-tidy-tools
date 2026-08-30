import { readFileSync } from "node:fs";
import {
  readEnvFile,
  resolveConfigPath,
  type HonchoBackendConfig,
} from "../config.js";
import type {
  BackendFactory,
  BackendFactoryContext,
  MemoryBackend,
  MemoryHealth,
  MemoryRecord,
  RecallInput,
  RecallOutput,
  ReflectInput,
  ReflectOutput,
  RetainInput,
  RetainOutput,
} from "../types.js";

interface HonchoBackendOptions {
  config: HonchoBackendConfig;
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESULTS = 100;
const MAX_MEMORY_CHARS = 8_000;
const MAX_REFLECT_CHARS = 32_000;
const MAX_QUERY_CHARS = 10_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REASONING_LEVELS = new Set(["low", "mid", "high"]);
const RECALL_MODES = new Set(["dialectic", "search", "hybrid"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizePath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function sanitizedError(status: number, operation: string): Error {
  if (status === 401 || status === 403)
    return new Error(`Honcho ${operation} authentication failed (${status})`);
  if (status === 404)
    return new Error(
      `Honcho ${operation} endpoint, workspace, or session was not found (404)`
    );
  return new Error(`Honcho ${operation} failed with HTTP ${status}`);
}

/**
 * Honcho session ids must match ^[a-zA-Z0-9_-]+$ while resolved bank ids may
 * contain dots and colons (for example "pi::pi-tidy-tools"), so map every run
 * of unsafe characters to a single dash and clamp the length.
 */
export function honchoSessionId(raw: string): string {
  const collapsed = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = collapsed.length > 0 ? collapsed : "default";
  return safe.slice(0, 128).replace(/-+$/, "");
}

function assertSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId))
    throw new Error(
      `Honcho session id ${JSON.stringify(sessionId.slice(0, 32))} is invalid`
    );
  return sessionId;
}

interface HonchoFileConfig {
  baseUrl?: unknown;
  apiKey?: unknown;
  workspace?: unknown;
  peerName?: unknown;
  aiPeer?: unknown;
}

function readHonchoFileConfig(path: string | undefined): HonchoFileConfig {
  if (!path) return {};
  const raw = JSON.parse(
    readFileSync(resolveConfigPath(path), "utf8")
  ) as unknown;
  return object(raw) ? raw : {};
}

function resolveHonchoApiKey(
  config: HonchoBackendConfig,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (config.apiKeyEnv) {
    const direct = env[config.apiKeyEnv];
    if (direct) return direct;
    if (config.envFile) return readEnvFile(config.envFile)[config.apiKeyEnv];
    return undefined;
  }
  return undefined;
}

export class HonchoBackend implements MemoryBackend {
  readonly type = "honcho";
  readonly label = "Honcho";
  readonly capabilities = new Set<"health" | "recall" | "retain" | "reflect">([
    "health",
    "recall",
    "retain",
    "reflect",
  ]);

  private readonly config: HonchoBackendConfig;
  private readonly baseUrl: string;
  private readonly workspace: string;
  private readonly userPeer: string;
  private readonly aiPeer: string;
  private readonly apiKey: string | undefined;
  private readonly knownSessions = new Set<string>();
  private sessionOverride: string | undefined;

  constructor(private readonly options: HonchoBackendOptions) {
    const file = readHonchoFileConfig(options.config.configFile);
    const baseUrl = text(options.config.baseUrl) ?? text(file.baseUrl);
    if (!baseUrl)
      throw new Error(
        "Honcho backend requires baseUrl in the backend config or configFile"
      );
    const parsedUrl = new URL(baseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      parsedUrl.hostname
    );
    this.config = options.config;
    this.baseUrl = baseUrl;
    const workspace = text(options.config.workspace) ?? text(file.workspace);
    if (!workspace)
      throw new Error(
        "Honcho backend requires workspace in the backend config or configFile"
      );
    this.workspace = workspace;
    this.userPeer =
      text(options.config.userPeer) ?? text(file.peerName) ?? "user";
    this.aiPeer = text(options.config.aiPeer) ?? text(file.aiPeer) ?? "pi";
    this.apiKey =
      resolveHonchoApiKey(options.config, options.env) ?? text(file.apiKey);
    if (this.apiKey && parsedUrl.protocol === "http:" && !loopback) {
      throw new Error("authenticated Honcho requires HTTPS except on loopback");
    }
  }

  private workspacePath(suffix = ""): string {
    return `/v3/workspaces/${encodeURIComponent(this.workspace)}${suffix}`;
  }

  private sessionPath(suffix = ""): string {
    return this.workspacePath(
      `/sessions/${encodeURIComponent(this.sessionId())}${suffix}`
    );
  }

  /** Session id: dynamic bank id when injected, else the configured static id. */
  private sessionId(): string {
    if (this.sessionOverride) return this.sessionOverride;
    const bankId = text(this.config.bankId);
    const raw =
      bankId ?? text(this.config.staticSessionId) ?? `${this.aiPeer}-default`;
    return assertSessionId(honchoSessionId(raw));
  }

  private reasoningLevel(): string {
    const level = this.config.reasoningLevel;
    return level && REASONING_LEVELS.has(level) ? level : "low";
  }

  private recallMode(): "dialectic" | "search" | "hybrid" {
    const mode = this.config.recallMode;
    return mode && RECALL_MODES.has(mode)
      ? (mode as "dialectic" | "search" | "hybrid")
      : "hybrid";
  }

  private async request(
    path: string,
    init: RequestInit,
    operation: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted)
      throw signal.reason ?? new Error(`Honcho ${operation} cancelled`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Honcho ${operation} timed out`)),
      this.options.timeoutMs
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body !== undefined)
        headers.set("Content-Type", "application/json");
      if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
      const response = await this.options.fetch(
        normalizePath(this.baseUrl, path),
        {
          ...init,
          headers,
          signal: controller.signal,
        }
      );
      if (!response.ok) throw sanitizedError(response.status, operation);
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        await response.body?.cancel();
        throw new Error(
          `Honcho ${operation} response exceeded ${MAX_RESPONSE_BYTES} bytes`
        );
      }
      const body = await this.readBoundedBody(response, operation);
      return body ? (JSON.parse(body) as unknown) : {};
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(
          `Honcho ${operation} timed out after ${this.options.timeoutMs}ms`
        );
      }
      if (signal?.aborted)
        throw signal.reason ?? new Error(`Honcho ${operation} cancelled`);
      if (error instanceof SyntaxError)
        throw new Error(`Honcho ${operation} returned invalid JSON`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async readBoundedBody(
    response: Response,
    operation: string
  ): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(
            `Honcho ${operation} response exceeded ${MAX_RESPONSE_BYTES} bytes`
          );
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      reader.releaseLock();
    }
  }

  private searchRecord(value: unknown): MemoryRecord | undefined {
    if (!object(value) || !text(value.content)) return undefined;
    return {
      id: text(value.id) ?? "unknown",
      text: (value.content as string).slice(0, MAX_MEMORY_CHARS),
      kind: "message",
      ...(text(value.peer_id)
        ? { context: `peer ${value.peer_id as string}` }
        : {}),
      ...(text(value.created_at)
        ? { occurredAt: value.created_at as string }
        : {}),
      ...(text(value.session_id)
        ? { metadata: { session: value.session_id as string } }
        : {}),
    };
  }

  private async dialectic(
    query: string,
    operation: string,
    signal?: AbortSignal
  ): Promise<string> {
    const body = {
      query: query.slice(0, MAX_QUERY_CHARS),
      target: this.userPeer,
      reasoning_level: this.reasoningLevel(),
    };
    const value = await this.request(
      this.workspacePath(`/peers/${encodeURIComponent(this.aiPeer)}/chat`),
      { method: "POST", body: JSON.stringify(body) },
      operation,
      signal
    );
    if (!object(value))
      throw new Error(`Honcho ${operation} returned an invalid response`);
    return text(value.content) ?? "";
  }

  private async search(
    query: string,
    signal?: AbortSignal
  ): Promise<MemoryRecord[]> {
    const value = await this.request(
      this.workspacePath(`/peers/${encodeURIComponent(this.aiPeer)}/search`),
      {
        method: "POST",
        body: JSON.stringify({
          query: query.slice(0, MAX_QUERY_CHARS),
          limit: 8,
        }),
      },
      "recall search",
      signal
    );
    if (!Array.isArray(value))
      throw new Error("Honcho recall search returned an invalid response");
    return value
      .slice(0, MAX_RESULTS)
      .map((item) => this.searchRecord(item))
      .filter((item): item is MemoryRecord => item !== undefined);
  }

  private async createSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      this.workspacePath("/sessions"),
      {
        method: "POST",
        body: JSON.stringify({
          id: sessionId,
          peers: { [this.userPeer]: {}, [this.aiPeer]: {} },
        }),
      },
      "session setup",
      signal
    );
  }

  private async ensureSession(signal?: AbortSignal): Promise<string> {
    if (this.knownSessions.has(this.sessionId())) return this.sessionId();
    const primary = this.sessionId();
    try {
      await this.createSession(primary, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("(404)")) throw error;
      // A recently deleted session id stays shadowed by a tombstone for a
      // while; retry once, then fall back to a unique suffixed session.
      try {
        await this.createSession(primary, signal);
      } catch {
        const suffixed = honchoSessionId(
          `${primary}-${Date.now().toString(36)}`
        );
        await this.createSession(suffixed, signal);
        this.sessionOverride = suffixed;
      }
    }
    this.knownSessions.add(this.sessionId());
    return this.sessionId();
  }

  async health(signal?: AbortSignal): Promise<MemoryHealth> {
    await this.request(
      "/health",
      { method: "GET" },
      "health check",
      signal
    );
    return {
      ok: true,
      message: `workspace ${this.workspace} reachable (peers ${this.userPeer}/${this.aiPeer})`,
    };
  }

  async recall(input: RecallInput, signal?: AbortSignal): Promise<RecallOutput> {
    const mode = this.recallMode();
    if (mode === "dialectic") {
      const content = await this.dialectic(input.query, "recall", signal);
      return {
        memories: content
          ? [
              {
                id: "dialectic",
                text: content.slice(0, MAX_MEMORY_CHARS),
                kind: "dialectic",
              },
            ]
          : [],
      };
    }
    if (mode === "search") {
      return { memories: await this.search(input.query, signal) };
    }
    const failures: unknown[] = [];
    let synthesized: MemoryRecord | undefined;
    try {
      const content = await this.dialectic(input.query, "recall", signal);
      if (content)
        synthesized = {
          id: "dialectic",
          text: content.slice(0, MAX_MEMORY_CHARS),
          kind: "dialectic",
        };
    } catch (error) {
      failures.push(error);
    }
    let hits: MemoryRecord[] = [];
    try {
      hits = await this.search(input.query, signal);
    } catch (error) {
      failures.push(error);
    }
    if (!synthesized && hits.length === 0 && failures.length > 0) {
      const message = failures
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure)
        )
        .join("; ");
      throw new Error(`Honcho recall failed: ${message}`);
    }
    return {
      memories: [...(synthesized ? [synthesized] : []), ...hits].slice(
        0,
        MAX_RESULTS
      ),
    };
  }

  async retain(input: RetainInput, signal?: AbortSignal): Promise<RetainOutput> {
    await this.ensureSession(signal);
    const metadata: Record<string, string> = {
      ...(input.context ? { context: input.context } : {}),
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.tags?.length ? { tags: input.tags.join(",") } : {}),
      ...(input.metadata ?? {}),
    };
    const value = await this.request(
      this.sessionPath("/messages"),
      {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              peer_id: this.aiPeer,
              content: input.content,
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            },
          ],
        }),
      },
      "retain",
      signal
    );
    if (!Array.isArray(value) || value.length === 0)
      throw new Error("Honcho retain returned an invalid response");
    return { accepted: value.length, deferred: false };
  }

  async reflect(
    input: ReflectInput,
    signal?: AbortSignal
  ): Promise<ReflectOutput> {
    const content = await this.dialectic(input.query, "reflect", signal);
    if (!content) throw new Error("Honcho reflect returned no content");
    return { text: content.slice(0, MAX_REFLECT_CHARS) };
  }
}

export function createHonchoFactory(timeoutMs: number): BackendFactory {
  return {
    type: "honcho",
    create(config: unknown, context: BackendFactoryContext): MemoryBackend {
      return new HonchoBackend({
        config: config as HonchoBackendConfig,
        fetch: context.fetch,
        env: context.env,
        timeoutMs,
      });
    },
  };
}
