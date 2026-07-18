import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MemoryBudget } from "./types.js";

export const MEMORY_CONFIG_VERSION = 1 as const;
export const MEMORY_CONFIG_RELATIVE = join("pi-tidy-memory", "config.json");

export interface HindsightBackendConfig {
  type: "hindsight";
  baseUrl: string;
  bankId: string;
  apiKeyEnv?: string;
  envFile?: string;
  recallBudget?: MemoryBudget;
  recallTypes?: string[];
  asyncRetain?: boolean;
}

export interface GenericBackendConfig extends Record<string, unknown> {
  type: string;
}

export type MemoryBackendConfig = HindsightBackendConfig | GenericBackendConfig;

export interface MemoryConfig {
  version: typeof MEMORY_CONFIG_VERSION;
  enabled: boolean;
  backend: MemoryBackendConfig;
  requestTimeoutMs: number;
  lifecycle: {
    autoRecall: boolean;
    autoRetain: boolean;
    maxRecallTokens: number;
    maxRetainChars: number;
  };
}

export interface ConfigLoadResult {
  config?: MemoryConfig;
  path: string;
  error?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BANK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BUDGETS = new Set<MemoryBudget>(["low", "mid", "high"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("backend.baseUrl is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("backend.baseUrl must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("backend.baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "backend.baseUrl must not contain credentials, a query, or a fragment"
    );
  }
  return url.toString().replace(/\/$/, "");
}

function parseHindsight(value: unknown): HindsightBackendConfig {
  if (!object(value) || value.type !== "hindsight") {
    throw new Error("backend.type must be hindsight");
  }
  if (typeof value.bankId !== "string" || !BANK_ID.test(value.bankId)) {
    throw new Error("backend.bankId must be 1-128 safe identifier characters");
  }
  if (
    value.apiKeyEnv !== undefined &&
    (typeof value.apiKeyEnv !== "string" || !ENV_NAME.test(value.apiKeyEnv))
  ) {
    throw new Error("backend.apiKeyEnv must be an environment variable name");
  }
  if (value.envFile !== undefined && typeof value.envFile !== "string") {
    throw new Error("backend.envFile must be a path");
  }
  if (
    value.apiKey !== undefined ||
    value.token !== undefined ||
    value.headers !== undefined
  ) {
    throw new Error(
      "inline credentials are forbidden; use apiKeyEnv and optional envFile"
    );
  }
  const baseUrl = parseBaseUrl(value.baseUrl);
  const parsedUrl = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsedUrl.hostname
  );
  if (value.apiKeyEnv && parsedUrl.protocol === "http:" && !loopback) {
    throw new Error(
      "authenticated Hindsight requires HTTPS except on loopback"
    );
  }
  const recallBudget =
    typeof value.recallBudget === "string" &&
    BUDGETS.has(value.recallBudget as MemoryBudget)
      ? (value.recallBudget as MemoryBudget)
      : "mid";
  const recallTypes = Array.isArray(value.recallTypes)
    ? value.recallTypes.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    : ["observation", "world", "experience"];
  return {
    type: "hindsight",
    baseUrl,
    bankId: value.bankId,
    ...(value.apiKeyEnv ? { apiKeyEnv: value.apiKeyEnv } : {}),
    ...(value.envFile ? { envFile: value.envFile } : {}),
    recallBudget,
    recallTypes,
    asyncRetain: bool(value.asyncRetain, true),
  };
}

export function memoryConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, MEMORY_CONFIG_RELATIVE);
}

export function resolveConfigPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(homedir(), path);
}

function parseBackend(value: unknown): MemoryBackendConfig {
  if (
    !object(value) ||
    typeof value.type !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.type)
  ) {
    throw new Error("backend.type must be a safe backend identifier");
  }
  if (value.type === "hindsight") return parseHindsight(value);
  return { ...value, type: value.type };
}

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  if (!object(raw)) throw new Error("config must be a JSON object");
  if (raw.version !== MEMORY_CONFIG_VERSION)
    throw new Error(`config.version must be ${MEMORY_CONFIG_VERSION}`);
  const lifecycle = object(raw.lifecycle) ? raw.lifecycle : {};
  return {
    version: MEMORY_CONFIG_VERSION,
    enabled: bool(raw.enabled, true),
    backend: parseBackend(raw.backend),
    requestTimeoutMs: boundedInt(raw.requestTimeoutMs, 15_000, 1_000, 60_000),
    lifecycle: {
      autoRecall: bool(lifecycle.autoRecall, false),
      autoRetain: bool(lifecycle.autoRetain, false),
      maxRecallTokens: boundedInt(lifecycle.maxRecallTokens, 1_024, 128, 4_096),
      maxRetainChars: boundedInt(lifecycle.maxRetainChars, 16_000, 256, 64_000),
    },
  };
}

export function loadMemoryConfig(
  agentDir: string = getAgentDir()
): ConfigLoadResult {
  const path = memoryConfigPath(agentDir);
  try {
    return {
      config: parseMemoryConfig(JSON.parse(readFileSync(path, "utf8"))),
      path,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      path,
      error:
        code === "ENOENT"
          ? "not configured"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

export function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  const text = readFileSync(resolveConfigPath(path), "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function resolveApiKey(
  config: HindsightBackendConfig,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!config.apiKeyEnv) return undefined;
  const direct = env[config.apiKeyEnv];
  if (direct) return direct;
  if (!config.envFile) return undefined;
  return readEnvFile(config.envFile)[config.apiKeyEnv];
}

export function sanitizedConfigSummary(
  result: ConfigLoadResult,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!result.config)
    return `disabled (${result.error ?? "not configured"}) at ${result.path}`;
  const { config } = result;
  if (config.backend.type !== "hindsight") {
    return [
      `${config.enabled ? "enabled" : "disabled"} backend=${config.backend.type}`,
      `autoRecall=${config.lifecycle.autoRecall}`,
      `autoRetain=${config.lifecycle.autoRetain}`,
    ].join(" ");
  }
  const backend = config.backend as HindsightBackendConfig;
  let auth = "none";
  if (backend.apiKeyEnv) {
    try {
      auth = `${backend.apiKeyEnv}:${resolveApiKey(backend, env) ? "present" : "missing"}`;
    } catch {
      auth = `${backend.apiKeyEnv}:unreadable`;
    }
  }
  return [
    `${config.enabled ? "enabled" : "disabled"} backend=${backend.type}`,
    `host=${new URL(backend.baseUrl).host}`,
    `bank=${backend.bankId}`,
    `auth=${auth}`,
    `autoRecall=${config.lifecycle.autoRecall}`,
    `autoRetain=${config.lifecycle.autoRetain}`,
  ].join(" ");
}
