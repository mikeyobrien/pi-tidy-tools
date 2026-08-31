import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

export interface FleetLockHolder {
  pid: number;
  birth: string;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface AcquiredLock {
  holder: FleetLockHolder;
  release(): void;
}

export interface LockOptions {
  staleMs?: number;
  heartbeatMs?: number;
  host?: string;
}

const DEFAULT_STALE_MS = 8_000;
const DEFAULT_HEARTBEAT_MS = 2_000;

function lockPath(fleetDir: string): string {
  return join(fleetDir, ".fleet", "lock.json");
}

function readHolder(fleetDir: string): FleetLockHolder | null {
  const path = lockPath(fleetDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FleetLockHolder;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.heartbeatAt !== "string"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function isFresh(holder: FleetLockHolder, staleMs: number): boolean {
  const age = Date.now() - Date.parse(holder.heartbeatAt);
  return Number.isFinite(age) && age < staleMs;
}

/** Atomically replace the lock file, then verify we still own it (race loser detects theft). */
function writeHolder(fleetDir: string, holder: FleetLockHolder): boolean {
  const path = lockPath(fleetDir);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder, null, 2));
  renameSync(tmp, path);
  const current = readHolder(fleetDir);
  return current !== null && current.birth === holder.birth;
}

/**
 * Acquire the fleet session-ownership lock. Refuses while a fresh holder exists;
 * takes over a stale one (dead owner). Heartbeats every `heartbeatMs`.
 */
export function acquireFleetLock(
  fleetDir: string,
  options: LockOptions = {}
): { ok: true; lock: AcquiredLock } | { ok: false; holder: FleetLockHolder } {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  mkdirSync(join(fleetDir, ".fleet"), { recursive: true });

  const existing = readHolder(fleetDir);
  if (existing && isFresh(existing, staleMs)) {
    return { ok: false, holder: existing };
  }

  const holder: FleetLockHolder = {
    pid: process.pid,
    birth: randomUUID(),
    host: options.host ?? "local",
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  if (!writeHolder(fleetDir, holder)) {
    const winner = readHolder(fleetDir);
    return { ok: false, holder: winner ?? existing ?? holder };
  }

  const timer = setInterval(() => {
    holder.heartbeatAt = new Date().toISOString();
    writeHolder(fleetDir, holder);
  }, heartbeatMs);
  timer.unref?.();

  return {
    ok: true,
    lock: {
      holder,
      release(): void {
        clearInterval(timer);
        const current = readHolder(fleetDir);
        if (current && current.birth === holder.birth) {
          rmSync(lockPath(fleetDir), { force: true });
        }
      },
    },
  };
}
