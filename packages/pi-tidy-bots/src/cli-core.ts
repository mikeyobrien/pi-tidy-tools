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
  readStoredToken,
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
  // Issue 51: a stored token is sticky — restarts must preserve it (console
  // URLs survive `pi-tidy-bots restart`) instead of silently dropping auth
  // on loopback boots.
  const stored = readStoredToken(opts.fleetDir);
  if (stored) return { token: stored };
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

/**
 * Issue 135: does this command line look like a pi-tidy-bots daemon?
 * Matches the bin shim (`node .../pi-tidy-bots.mjs start …`) and the
 * source entry (`node --import tsx .../cli.ts start …`) — foreground or
 * daemonized.
 */
export function daemonCommandMatches(command: string): boolean {
  return /pi-tidy-bots(\.mjs)?|cli\.ts/.test(command) && /\bstart\b/.test(command);
}

export type DaemonIdentityCheck =
  | { kind: "match"; fleetDir: string }
  | { kind: "foreign-fleet"; fleetDir: string }
  | { kind: "unreachable" };

/**
 * Issue 154: identity fingerprint before ANY signal — the daemon serving
 * the fleet's configured port must report THIS fleet dir via /api/version.
 * A different fleet's daemon on the port (concurrent fleets, stale
 * registry) is a loud refusal, never a signal.
 */
export async function probeDaemonIdentity(
  port: number,
  expectedDir: string,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<DaemonIdentityCheck> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/version`);
    if (!res.ok) return { kind: "unreachable" };
    const payload = (await res.json()) as { fleetDir?: string };
    const reported = payload.fleetDir ? resolveLike(expectedDir, payload.fleetDir) : undefined;
    if (reported === expectedDir) return { kind: "match", fleetDir: payload.fleetDir ?? "" };
    return { kind: "foreign-fleet", fleetDir: payload.fleetDir ?? "" };
  } catch {
    return { kind: "unreachable" };
  }
}

function resolveLike(expectedDir: string, reported: string): string | undefined {
  // Compare resolved paths without importing node:path resolve twice.
  return reported.replace(/\/$/, "") === expectedDir.replace(/\/$/, "")
    ? expectedDir
    : undefined;
}

export type DaemonPidCheck =
  | { kind: "alive-daemon"; pid: number; command: string }
  | { kind: "foreign"; pid: number; command: string }
  | { kind: "dead"; pid: number };

/** Issue 135: verify a pid is alive AND ours before signalling it. */
export function verifyDaemonPid(
  pid: number,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", timeout: 5_000 })
): DaemonPidCheck {
  const command = (() => {
    try {
      return run("ps", ["-p", String(pid), "-o", "command="]).trim();
    } catch {
      return "";
    }
  })();
  if (command.length === 0) return { kind: "dead", pid };
  if (daemonCommandMatches(command))
    return { kind: "alive-daemon", pid, command };
  return { kind: "foreign", pid, command };
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

/** Small Levenshtein distance for did-you-mean suggestions. */
export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return rows[a.length][b.length];
}

/** Closest known flag within edit distance 3, else undefined. */
export function closestFlag(
  unknown: string,
  candidates: string[]
): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of candidates) {
    const distance = editDistance(unknown, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

// ── Port helpers (issue 51) ────────────────────────────

import { execFileSync } from "node:child_process";
import { Socket } from "node:net";

/** True while something accepts TCP connections on the port. */
export function isPortHeld(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const settle = (held: boolean) => {
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, host);
  });
}

/** Wait until the port is released (or the deadline passes). */
export async function waitPortReleased(
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isPortHeld(port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Health check: GET <url> and accept any HTTP response as "serving". */
export async function healthCheck(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.status < 600;
  } catch {
    return false;
  }
}

/** Issue 51: name the process(es) holding a TCP port (best-effort, POSIX tools). */
export function describePortHolder(
  port: number,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", timeout: 5_000 })
): string {
  try {
    // Listener state only: client connections to the port (e.g. the console
    // tab's sockets) must not be misattributed as the holder. A port can have
    // SEPARATE holders per address family (e.g. our daemon on 127.0.0.1 and a
    // foreign listener on [::]) — name them all, not an arbitrary first.
    const seen = new Set<string>();
    // NB: the `-i :<port>` space form silently ignores the port filter on
    // macOS lsof (returns every listener) — the glued `-iTCP:<port>` form
    // is required. `-nP` keeps it numeric and fast.
    const pids = run("lsof", ["-nP", "-t", "-sTCP:LISTEN", `-iTCP:${port}`])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .slice(0, 3);
    for (const pid of pids) {
      try {
        const command = run("ps", ["-p", pid, "-o", "command="]).trim();
        seen.add(`pid ${pid}: ${command.slice(0, 120)}`);
      } catch {
        seen.add(`pid ${pid}`);
      }
    }
    return seen.size > 0 ? `held by ${[...seen].join("; ")}` : "";
  } catch {
    return "";
  }
}
