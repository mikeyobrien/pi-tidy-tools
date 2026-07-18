import { spawn } from "node:child_process";
import type { CodexQuotaSnapshot, CodexQuotaWindow } from "./types.js";

const MAX_OUTPUT_BYTES = 1_000_000;
export const DEFAULT_POLL_MS = 5 * 60_000;
export const DEFAULT_TIMEOUT_MS = 45_000;

export type CodexBarRunner = (signal: AbortSignal) => Promise<string>;

function quotaWindow(value: unknown): CodexQuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent = record.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent))
    return undefined;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(typeof record.windowMinutes === "number" &&
    Number.isFinite(record.windowMinutes)
      ? { windowMinutes: record.windowMinutes }
      : {}),
    ...(typeof record.resetsAt === "string"
      ? { resetsAt: record.resetsAt }
      : {}),
  };
}

export function parseCodexBarJson(text: string): CodexQuotaSnapshot {
  const decoded: unknown = JSON.parse(text);
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  const entry = entries.find(
    (value) =>
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).provider === "codex"
  ) as Record<string, unknown> | undefined;
  if (!entry) throw new Error("CodexBar returned no Codex provider");
  if (entry.error) throw new Error("CodexBar reported a provider error");

  const usage = entry.usage;
  if (!usage || typeof usage !== "object")
    throw new Error("CodexBar returned no usage snapshot");
  const usageRecord = usage as Record<string, unknown>;
  const primary = quotaWindow(usageRecord.primary);
  if (!primary) throw new Error("CodexBar returned no primary quota window");
  const secondary = quotaWindow(usageRecord.secondary);

  return {
    primary,
    ...(secondary ? { secondary } : {}),
    ...(typeof usageRecord.updatedAt === "string"
      ? { updatedAt: usageRecord.updatedAt }
      : {}),
  };
}

export function runCodexBar(
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  if (signal.aborted)
    return Promise.reject(
      signal.reason ?? new Error("CodexBar request aborted")
    );

  return new Promise((resolve, reject) => {
    const child = spawn(
      "codexbar",
      [
        "usage",
        "--provider",
        "codex",
        "--source",
        "cli",
        "--format",
        "json",
        "--json-only",
        "--no-color",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb", COLUMNS: "80" },
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const onAbort = () => {
      killGroup();
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("CodexBar request aborted")
      );
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(new Error(`CodexBar timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        killGroup();
        finish(new Error("CodexBar output exceeded 1 MB"));
        return;
      }
      stdout.push(chunk);
      // The static CodexBar binary can leave a proot helper alive on Android
      // after stdout already contains the complete JSON document. Treat a
      // parseable top-level payload as completion and reap the process group.
      try {
        JSON.parse(Buffer.concat(stdout).toString("utf8"));
        killGroup();
        finish();
      } catch {
        // More chunks are still required.
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 4_096) stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr)
          .toString("utf8")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        finish(
          new Error(`CodexBar exited ${code}${detail ? `: ${detail}` : ""}`)
        );
        return;
      }
      finish();
    });
  });
}

export class CodexBarPoller {
  private readonly runner: CodexBarRunner;
  private readonly intervalMs: number;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  snapshot?: CodexQuotaSnapshot;
  lastError?: string;

  constructor(
    runner: CodexBarRunner = runCodexBar,
    intervalMs = DEFAULT_POLL_MS
  ) {
    this.runner = runner;
    this.intervalMs = intervalMs;
  }

  async refresh(onUpdate?: () => void): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.controller = controller;
    let operation!: Promise<void>;
    operation = (async () => {
      try {
        this.snapshot = parseCodexBarJson(await this.runner(controller.signal));
        this.lastError = undefined;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.lastError =
            error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (this.controller === controller) this.controller = undefined;
        if (this.inFlight === operation) this.inFlight = undefined;
        if (!controller.signal.aborted) onUpdate?.();
      }
    })();
    this.inFlight = operation;
    return operation;
  }

  start(onUpdate: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.refresh(onUpdate),
      this.intervalMs
    );
    this.timer.unref?.();
    if (this.inFlight) {
      void this.inFlight.finally(() => {
        if (this.timer) void this.refresh(onUpdate);
      });
    } else {
      void this.refresh(onUpdate);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort(new Error("CodexBar polling stopped"));
  }
}
