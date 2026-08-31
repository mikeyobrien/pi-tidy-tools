/**
 * Testable CLI core (issue 29): exit-code classes, structured errors, start
 * token resolution, and JSON payload shapes. The cli.ts wrapper owns stdio,
 * process.exit, and process-level wiring.
 */

export const EXIT = {
  ok: 0,
  usage: 1,
  conflict: 2,
  port: 3,
  runtime: 4,
} as const;

/** A CLI failure with its exit class and an optional remedy hint. */
export class CliError extends Error {
  exitCode: number;
  remedy?: string;

  constructor(
    message: string,
    options: { exitCode?: number; remedy?: string } = {}
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT.usage;
    this.remedy = options.remedy;
  }
}

/** One clean house-style line: `error: <message> [fix: <remedy>]`. */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const remedy =
    error instanceof CliError && error.remedy ? ` [fix: ${error.remedy}]` : "";
  return `error: ${message}${remedy}`;
}

/** Exit class for a start failure message (lock, port, runtime, auth). */
export function classifyStartFailure(message: string): number {
  const lowered = message.toLowerCase();
  if (lowered.includes("lock held") || lowered.includes("already exists"))
    return EXIT.conflict;
  if (
    lowered.includes("port") ||
    lowered.includes("eaddrinuse") ||
    lowered.includes("addrinuse")
  )
    return EXIT.port;
  return EXIT.runtime;
}

import {
  ensureStoredToken,
  isLoopbackHost,
  rotateStoredToken,
} from "./pairing.ts";

export interface StartTokenResolution {
  token?: string;
  rotated?: boolean;
}

/**
 * Issue 29 item 1+2: token resolution for `start`.
 * - `--rotate-token` mints a fresh stored token first.
 * - An explicit `--token` always wins and is persisted.
 * - A non-loopback bind (0.0.0.0 / LAN IP) auto-enables token auth: the stored
 *   token is reused, or minted when none exists. Loopback stays opt-in.
 */
export function resolveStartToken(opts: {
  fleetDir: string;
  host: string;
  explicitToken?: string;
  wantsQr: boolean;
  wantsRotate: boolean;
}): StartTokenResolution {
  if (opts.wantsRotate)
    return { token: rotateStoredToken(opts.fleetDir), rotated: true };
  if (opts.explicitToken)
    return {
      token: ensureStoredToken(opts.fleetDir, opts.explicitToken).token,
    };
  if (!isLoopbackHost(opts.host))
    return { token: ensureStoredToken(opts.fleetDir).token };
  if (opts.wantsQr)
    return { token: ensureStoredToken(opts.fleetDir, undefined, true).token };
  return {};
}

/** `init --json` payload. */
export function initJsonPayload(fleetDir: string): {
  fleetDir: string;
  created: boolean;
} {
  return { fleetDir, created: true };
}

/** `start --json` single readiness line payload. */
export function startReadinessPayload(
  url: string,
  port: number,
  pid: number,
  token?: string
): { url: string; port: number; pid: number; token?: string } {
  return token ? { url, port, pid, token } : { url, port, pid };
}

/** `--version --json` payload. */
export function versionJsonPayload(
  name: string,
  version: string
): { name: string; version: string } {
  return { name, version };
}

// ── Lifecycle helpers (issue 29 item 3) ────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `.fleet/daemon.pid` — written by a daemonized start child. */
export function daemonPidPath(fleetDir: string): string {
  return join(fleetDir, ".fleet", "daemon.pid");
}

export function readDaemonPid(fleetDir: string): number | undefined {
  try {
    const raw = readFileSync(daemonPidPath(fleetDir), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function readLockHolderPid(fleetDir: string): number | undefined {
  try {
    const lock = JSON.parse(
      readFileSync(join(fleetDir, ".fleet", "lock.json"), "utf8")
    ) as { pid?: unknown };
    return typeof lock.pid === "number" ? lock.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Which pid owns the fleet? The daemon pidfile wins over the lock holder. */
export function pickStopPid(
  fleetDir: string
): { pid: number; from: "daemon.pid" | "lock.json" } | undefined {
  const daemonPid = readDaemonPid(fleetDir);
  if (daemonPid) return { pid: daemonPid, from: "daemon.pid" };
  const lockPid = readLockHolderPid(fleetDir);
  if (lockPid) return { pid: lockPid, from: "lock.json" };
  return undefined;
}

/** True while the pid is alive (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `probe` is true or the deadline passes. */
export async function waitForReady(
  probe: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 150
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
