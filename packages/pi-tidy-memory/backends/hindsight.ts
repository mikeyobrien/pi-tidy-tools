import { resolveApiKey, type HindsightBackendConfig } from "../config.js";
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

interface HindsightBackendOptions {
  config: HindsightBackendConfig;
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESULTS = 100;
const MAX_MEMORY_CHARS = 8_000;
const MAX_REFLECT_CHARS = 32_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function memory(value: unknown): MemoryRecord | undefined {
  if (!object(value) || !text(value.text)) return undefined;
  return {
    id: text(value.id) ?? "unknown",
    text: (value.text as string).slice(0, MAX_MEMORY_CHARS),
    ...(text(value.type) ? { kind: value.type as string } : {}),
    ...(text(value.context) ? { context: value.context as string } : {}),
    ...(text(value.occurred_start)
      ? { occurredAt: value.occurred_start as string }
      : {}),
    ...(Array.isArray(value.tags)
      ? {
          tags: value.tags.filter(
            (tag): tag is string => typeof tag === "string"
          ),
        }
      : {}),
    ...(object(value.metadata)
      ? {
          metadata: Object.fromEntries(
            Object.entries(value.metadata).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          ),
        }
      : {}),
  };
}

function normalizePath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function sanitizedError(status: number, operation: string): Error {
  if (status === 401 || status === 403)
    return new Error(
      `Hindsight ${operation} authentication failed (${status})`
    );
  if (status === 404)
    return new Error(
      `Hindsight ${operation} endpoint or bank was not found (404)`
    );
  return new Error(`Hindsight ${operation} failed with HTTP ${status}`);
}

export class HindsightBackend implements MemoryBackend {
  readonly type = "hindsight";
  readonly label = "Hindsight";
  readonly capabilities = new Set<"health" | "recall" | "retain" | "reflect">([
    "health",
    "recall",
    "retain",
    "reflect",
  ]);

  constructor(private readonly options: HindsightBackendOptions) {}

  private async request(
    path: string,
    init: RequestInit,
    operation: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted)
      throw signal.reason ?? new Error(`Hindsight ${operation} cancelled`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Hindsight ${operation} timed out`)),
      this.options.timeoutMs
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const apiKey = resolveApiKey(this.options.config, this.options.env);
      if (this.options.config.apiKeyEnv && !apiKey) {
        throw new Error(
          `Hindsight credential ${this.options.config.apiKeyEnv} is unavailable`
        );
      }
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body !== undefined)
        headers.set("Content-Type", "application/json");
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      const response = await this.options.fetch(
        normalizePath(this.options.config.baseUrl, path),
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
          `Hindsight ${operation} response exceeded ${MAX_RESPONSE_BYTES} bytes`
        );
      }
      const body = await this.readBoundedBody(response, operation);
      return body ? (JSON.parse(body) as unknown) : {};
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(
          `Hindsight ${operation} timed out after ${this.options.timeoutMs}ms`
        );
      }
      if (signal?.aborted)
        throw signal.reason ?? new Error(`Hindsight ${operation} cancelled`);
      if (error instanceof SyntaxError)
        throw new Error(`Hindsight ${operation} returned invalid JSON`);
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
            `Hindsight ${operation} response exceeded ${MAX_RESPONSE_BYTES} bytes`
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

  private bankPath(suffix = ""): string {
    return `/v1/default/banks/${encodeURIComponent(this.options.config.bankId)}${suffix}`;
  }

  async health(signal?: AbortSignal): Promise<MemoryHealth> {
    const value = await this.request(
      "/health",
      { method: "GET" },
      "health check",
      signal
    );
    if (!object(value) || typeof value.status !== "string")
      throw new Error("Hindsight health check returned an invalid response");
    const ok =
      value.status === "healthy" &&
      (value.database === undefined || value.database === "connected");
    return {
      ok,
      message: ok
        ? "healthy; database connected"
        : (text(value.status) ?? "unhealthy"),
    };
  }

  async recall(
    input: RecallInput,
    signal?: AbortSignal
  ): Promise<RecallOutput> {
    const body = {
      query: input.query,
      max_tokens: input.maxTokens,
      budget: input.budget ?? this.options.config.recallBudget ?? "mid",
      types: input.types ?? this.options.config.recallTypes,
      prefer_observations: true,
      ...(input.tags?.length
        ? { tags: input.tags, tags_match: "all_strict" }
        : {}),
    };
    const value = await this.request(
      this.bankPath("/memories/recall"),
      { method: "POST", body: JSON.stringify(body) },
      "recall",
      signal
    );
    if (!object(value) || !Array.isArray(value.results))
      throw new Error("Hindsight recall returned an invalid response");
    return {
      memories: value.results
        .slice(0, MAX_RESULTS)
        .map(memory)
        .filter((item): item is MemoryRecord => item !== undefined),
    };
  }

  async retain(
    input: RetainInput,
    signal?: AbortSignal
  ): Promise<RetainOutput> {
    const item = {
      content: input.content,
      ...(input.context ? { context: input.context } : {}),
      ...(input.occurredAt ? { timestamp: input.occurredAt } : {}),
      ...(input.documentId ? { document_id: input.documentId } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const value = await this.request(
      this.bankPath("/memories"),
      {
        method: "POST",
        body: JSON.stringify({
          items: [item],
          async: this.options.config.asyncRetain ?? true,
        }),
      },
      "retain",
      signal
    );
    if (
      !object(value) ||
      value.success !== true ||
      typeof value.bank_id !== "string" ||
      typeof value.items_count !== "number" ||
      typeof value.async !== "boolean"
    )
      throw new Error("Hindsight retain returned an invalid response");
    const operationId =
      text(value.operation_id) ??
      (Array.isArray(value.operation_ids)
        ? text(value.operation_ids[0])
        : undefined);
    return {
      accepted: value.items_count,
      deferred: value.async,
      ...(operationId ? { operationId } : {}),
    };
  }

  async reflect(
    input: ReflectInput,
    signal?: AbortSignal
  ): Promise<ReflectOutput> {
    const value = await this.request(
      this.bankPath("/reflect"),
      {
        method: "POST",
        body: JSON.stringify({
          query: input.query,
          budget: input.budget ?? "low",
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
          ...(input.tags?.length
            ? { tags: input.tags, tags_match: "all_strict" }
            : {}),
          include: { facts: {} },
        }),
      },
      "reflect",
      signal
    );
    if (!object(value) || !text(value.text))
      throw new Error("Hindsight reflect returned an invalid response");
    const basedOn =
      object(value.based_on) && Array.isArray(value.based_on.memories)
        ? value.based_on.memories
            .map(memory)
            .filter((item): item is MemoryRecord => item !== undefined)
        : undefined;
    return {
      text: (value.text as string).slice(0, MAX_REFLECT_CHARS),
      ...(basedOn ? { memories: basedOn } : {}),
    };
  }
}

export function createHindsightFactory(timeoutMs: number): BackendFactory {
  return {
    type: "hindsight",
    create(config: unknown, context: BackendFactoryContext): MemoryBackend {
      return new HindsightBackend({
        config: config as HindsightBackendConfig,
        fetch: context.fetch,
        env: context.env,
        timeoutMs,
      });
    },
  };
}
