/**
 * Fleet registry (issue 42): named fleets at `~/.pi/pi-tidy/fleets.json` so
 * everything can target by name instead of path-spelling. Orchestration
 * metadata only — never a scope coupling (ADR 0002).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FleetRecord {
  name: string;
  dir: string;
  port?: number;
  /** Token location relative to `dir` (convention: ".fleet/token"). */
  tokenFile?: string;
}

export function registryPath(home = homedir()): string {
  return join(home, ".pi", "pi-tidy", "fleets.json");
}

export function loadRegistry(path: string = registryPath()): FleetRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is FleetRecord =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as FleetRecord).name === "string" &&
        typeof (entry as FleetRecord).dir === "string"
    );
  } catch {
    return [];
  }
}

export function saveRegistry(path: string, records: FleetRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

/** Upsert by name (last writer wins). Returns the resulting registry. */
export function registerFleet(
  path: string,
  record: FleetRecord
): FleetRecord[] {
  const records = loadRegistry(path).filter(
    (existing) => existing.name !== record.name
  );
  records.push(record);
  saveRegistry(path, records);
  return records;
}

export function resolveFleetRecord(
  path: string,
  name: string
): FleetRecord | undefined {
  return loadRegistry(path).find((entry) => entry.name === name);
}

/** Entries whose directory no longer exists are dead. */
export function splitDead(records: FleetRecord[]): {
  alive: FleetRecord[];
  dead: FleetRecord[];
} {
  const alive = records.filter((entry) => existsSync(entry.dir));
  const dead = records.filter((entry) => !existsSync(entry.dir));
  return { alive, dead };
}

/** Remove dead entries; returns what was pruned. */
export function pruneRegistry(path: string): FleetRecord[] {
  const records = loadRegistry(path);
  const { alive, dead } = splitDead(records);
  if (dead.length > 0) saveRegistry(path, alive);
  return dead;
}

/** Remove one entry by name (used when a fleet dir is deleted outright). */
export function removeFleet(path: string, name: string): void {
  saveRegistry(
    path,
    loadRegistry(path).filter((entry) => entry.name !== name)
  );
}
