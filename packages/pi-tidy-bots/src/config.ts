import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";

export interface BotRoutine {
  name: string;
  schedule: string;
  prompt: string;
}

export interface BotConfig {
  name: string;
  dir: string;
  model?: string;
  title?: string;
  avatar: string;
  routes?: string[];
  approve: boolean;
  routines: BotRoutine[];
}

export interface FleetConfig {
  dir: string;
  port: number;
  host: string;
  bots: BotConfig[];
}

export class ConfigError extends Error {}

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const DEFAULT_PORT = 4317;

export type ToolOutputMode = "off" | "reasons" | "full";
const TOOL_OUTPUT_MODES: ToolOutputMode[] = ["off", "reasons", "full"];

/** Normalize a tool-output preference; unknown values fall back to "reasons". */
export function normalizeToolOutput(value: unknown): ToolOutputMode {
  return typeof value === "string" &&
    (TOOL_OUTPUT_MODES as string[]).includes(value)
    ? (value as ToolOutputMode)
    : "reasons";
}

/** Load and validate a fleet manifest. Fails fast, naming the bot and field. */
export function loadFleetConfig(
  fleetDir: string,
  overrides: { port?: number; host?: string } = {}
): FleetConfig {
  const dir = resolve(fleetDir);
  const manifestPath = join(dir, "bots.toml");
  if (!existsSync(manifestPath)) {
    throw new ConfigError(`no bots.toml in fleet dir ${dir}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`bots.toml parse error: ${(error as Error).message}`);
  }

  const botsRaw = doc.bot;
  if (!Array.isArray(botsRaw) || botsRaw.length === 0) {
    throw new ConfigError("bots.toml must define at least one [[bot]] table");
  }

  const seen = new Set<string>();
  const bots: BotConfig[] = [];
  for (const [index, raw] of botsRaw.entries()) {
    const where = `[[bot]] #${index + 1}`;
    const table = (raw ?? {}) as Record<string, unknown>;
    const name = String(table.name ?? "");
    if (!NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `${where}: name "${name}" must match ${NAME_PATTERN}`
      );
    }
    if (seen.has(name)) {
      throw new ConfigError(`${where}: duplicate bot name "${name}"`);
    }
    seen.add(name);
    const relDir = String(table.dir ?? name);
    const botDir = resolve(dir, relDir);
    if (!isDirectory(botDir)) {
      throw new ConfigError(
        `${where} (${name}): dir "${relDir}" does not exist`
      );
    }
    if (!existsSync(join(botDir, "AGENTS.md"))) {
      throw new ConfigError(
        `${where} (${name}): missing AGENTS.md in "${relDir}"`
      );
    }
    const routes = Array.isArray(table.routes)
      ? table.routes.map((value) => String(value))
      : undefined;
    // Action pills are removed (issue 15); a manifest still carrying the row is
    // stale config — fail fast instead of silently ignoring it.
    if (table.actions !== undefined) {
      throw new ConfigError(
        `${where} (${name}): "actions" is no longer supported — remove the row from bots.toml`
      );
    }
    const routines = Array.isArray(table.routines)
      ? table.routines.map(parseRoutine)
      : [];
    bots.push({
      name,
      dir: botDir,
      model: table.model === undefined ? undefined : String(table.model),
      title: table.title === undefined ? undefined : String(table.title),
      avatar: table.avatar === undefined ? "🤖" : String(table.avatar),
      routes,
      approve: table.approve === undefined ? true : table.approve === true,
      routines,
    });
  }

  const fleet = (doc.fleet ?? {}) as Record<string, unknown>;
  return {
    dir,
    port:
      overrides.port ??
      (typeof fleet.port === "number" ? fleet.port : DEFAULT_PORT),
    host:
      overrides.host ??
      (typeof fleet.host === "string" ? fleet.host : "127.0.0.1"),
    bots,
  };
}

/** Reconcile diff for hot onboarding: which bots to add, remove, respawn. */
export function diffFleet(
  current: BotConfig[],
  next: BotConfig[]
): {
  added: BotConfig[];
  removed: BotConfig[];
  changed: BotConfig[];
  untouched: BotConfig[];
} {
  const currentByName = new Map(current.map((bot) => [bot.name, bot]));
  const nextByName = new Map(next.map((bot) => [bot.name, bot]));
  const added: BotConfig[] = [];
  const changed: BotConfig[] = [];
  const untouched: BotConfig[] = [];
  for (const bot of next) {
    const existing = currentByName.get(bot.name);
    if (!existing) {
      added.push(bot);
      continue;
    }
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const differs =
      existing.dir !== bot.dir ||
      !same(existing.model, bot.model) ||
      !same(existing.routes, bot.routes);
    (differs ? changed : untouched).push(bot);
  }
  const removed = current.filter((bot) => !nextByName.has(bot.name));
  return { added, removed, changed, untouched };
}

/** Pure routing check: unknown_target outranks route_forbidden. */
export function checkRoute(
  fromName: string,
  targetName: string,
  bots: BotConfig[]
):
  | { ok: true; target: BotConfig }
  | { ok: false; reason: "unknown_target" | "route_forbidden" } {
  const from = bots.find((bot) => bot.name === fromName);
  if (!from) return { ok: false, reason: "unknown_target" };
  const target = bots.find((bot) => bot.name === targetName);
  if (!target) return { ok: false, reason: "unknown_target" };
  if (from.routes && !from.routes.includes(targetName)) {
    return { ok: false, reason: "route_forbidden" };
  }
  return { ok: true, target };
}

function parseRoutine(raw: unknown): BotRoutine {
  const table = (raw ?? {}) as Record<string, unknown>;
  const name = String(table.name ?? "routine");
  const schedule = String(table.schedule ?? "");
  if (schedule.length === 0) {
    throw new ConfigError(`routine "${name}": schedule is required`);
  }
  const prompt = String(table.prompt ?? "");
  if (prompt.length === 0) {
    throw new ConfigError(`routine "${name}": prompt is required`);
  }
  return { name, schedule, prompt };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
