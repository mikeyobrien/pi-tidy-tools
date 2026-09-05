import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
  /** Role label (legacy identity), kept for back-compat disclosure. */
  title?: string;
  /** Issue 62: recommendation-shaped disclosure, skills-style. Optional; falls back to title. */
  description?: string;
  avatar: string;
  routes?: string[];
  /** Issue 92: bot-scoped pi packages — installed project-local and loaded
   * via project trust at spawn. Omitted/invalid = current behavior. */
  packages?: string[];
  /** Issue 132: image provider override (fleet [image_provider] default). */
  imageProvider?: string;
  /** Per-bot extra pi extensions loaded after the fleet's own (absolute or
   * fleet-dir-relative paths). Composes with noExtensions: explicit -e flags
   * still load. */
  extensions?: string[];
  /** Tool allowlist passed to pi as --tools (exact registered tool names,
   * across built-in, extension, and custom tools). Omitted = no allowlist. */
  tools?: string[];
  /** Pass --no-builtin-tools: built-ins (bash/read/edit/...) off; extension
   * and custom tools stay unless also excluded via `tools`. */
  noBuiltinTools?: boolean;
  /** Pass --no-extensions: no extension/package discovery — inherited
   * global integrations stay out; the fleet's own -e flags still load. */
  noExtensions?: boolean;
  /** Pass --no-skills: no skill discovery for this bot. */
  noSkills?: boolean;
  approve: boolean;
  routines: BotRoutine[];
}

export interface FleetConfig {
  dir: string;
  port: number;
  host: string;
  bots: BotConfig[];
  /**
   * Issue 43 amendment: fallback summarizer model ("provider/id") used when
   * the context exceeds the SESSION model's window — the summary is prose;
   * any compliant model can write it. Optional; sane default applied by the
   * daemon.
   */
  compactFallbackModel?: string;
  /** Issue 80: consecutive empty-success turns before the roster flags the
   * bot degraded (health probes/wedge detection). Default 2. */
  emptyTurnAlertAfter?: number;
  /** Issue 132: default image provider id for the generate_image tool. */
  imageProvider?: string;
}

export class ConfigError extends Error {}

/**
 * Issue 62: disclosure text for a bot — description when present (it IS the
 * recommendation, skills-style), otherwise the legacy title. Never a config
 * error: missing description is valid, just less discoverable.
 */
export function botDisclosure(
  bot: Pick<BotConfig, "description" | "title">
): string {
  return bot.description ?? bot.title ?? "";
}

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const DEFAULT_PORT = 4317;

export type ToolOutputMode = "off" | "counts" | "reasons" | "full";
const TOOL_OUTPUT_MODES: ToolOutputMode[] = [
  "off",
  "counts",
  "reasons",
  "full",
];

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
    let botDirOverride: string;
    // Issue 41 (ADR 0002): fleet membership is orchestration, not scope.
    // `dir` omitted => the bot runs from the user home (global ~/.pi config
    // active), persona via title + global config + steering. An explicit dir
    // opts INTO scoping and keeps today's validation.
    if (table.dir === undefined) {
      botDirOverride = homedir();
    } else {
      const relDir = String(table.dir);
      const scoped = resolve(dir, relDir);
      if (!isDirectory(scoped)) {
        throw new ConfigError(
          `${where} (${name}): dir "${relDir}" does not exist`
        );
      }
      if (!existsSync(join(scoped, "AGENTS.md"))) {
        throw new ConfigError(
          `${where} (${name}): missing AGENTS.md in "${relDir}"`
        );
      }
      botDirOverride = scoped;
    }
    const botDir = botDirOverride;
    const routes = Array.isArray(table.routes)
      ? table.routes.map((value) => String(value))
      : undefined;
    const packages = Array.isArray(table.packages)
      ? table.packages.map((value) => String(value))
      : undefined;
    const imageProvider =
      typeof table.image_provider === "string" &&
      table.image_provider.length > 0
        ? table.image_provider
        : undefined;
    const tools = Array.isArray(table.tools)
      ? table.tools.map((value) => String(value))
      : undefined;
    const extensions = Array.isArray(table.extensions)
      ? table.extensions.map((value) => String(value))
      : undefined;
    if (tools && tools.some((tool) => tool.trim().length === 0)) {
      throw new ConfigError(
        `${where} (${name}): tools entries must be non-empty strings`
      );
    }
    const noBuiltinTools = table.no_builtin_tools === true;
    const noExtensions = table.no_extensions === true;
    const noSkills = table.no_skills === true;
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
      description:
        table.description === undefined ? undefined : String(table.description),
      avatar: table.avatar === undefined ? "" : String(table.avatar),
      routes,
      packages,
      ...(imageProvider ? { imageProvider } : {}),
      ...(extensions ? { extensions } : {}),
      ...(tools ? { tools } : {}),
      ...(noBuiltinTools ? { noBuiltinTools } : {}),
      ...(noExtensions ? { noExtensions } : {}),
      ...(noSkills ? { noSkills } : {}),
      approve: table.approve === undefined ? true : table.approve === true,
      routines,
    });
  }

  const fleet = (doc.fleet ?? {}) as Record<string, unknown>;
  const emptyTurnAlertAfter =
    fleet.empty_turn_alert_after === undefined
      ? undefined
      : Number(fleet.empty_turn_alert_after);
  if (
    emptyTurnAlertAfter !== undefined &&
    (!Number.isInteger(emptyTurnAlertAfter) || emptyTurnAlertAfter < 1)
  ) {
    throw new ConfigError(
      `[fleet]: empty_turn_alert_after must be an integer >= 1`
    );
  }
  return {
    dir,
    port:
      overrides.port ??
      (typeof fleet.port === "number" ? fleet.port : DEFAULT_PORT),
    host:
      overrides.host ??
      (typeof fleet.host === "string" ? fleet.host : "127.0.0.1"),
    bots,
    ...(emptyTurnAlertAfter !== undefined ? { emptyTurnAlertAfter } : {}),
    ...(typeof fleet.compactFallbackModel === "string" &&
    fleet.compactFallbackModel.length > 0
      ? { compactFallbackModel: fleet.compactFallbackModel }
      : {}),
    ...(typeof fleet.image_provider === "string" &&
    fleet.image_provider.length > 0
      ? { imageProvider: fleet.image_provider }
      : {}),
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
    // Issue 157: ANY config change counts — routines, packages, approve,
    // thinking, title, imageProvider… The old dir/model/routes-only diff
    // silently ignored manifest edits on existing bots (a routine added to
    // a live bot never registered; toggle 404'd; no log).
    const differs =
      existing.dir !== bot.dir ||
      !same(existing.model, bot.model) ||
      !same(existing.routes, bot.routes) ||
      !same(existing.routines, bot.routines) ||
      !same(existing.packages, bot.packages) ||
      !same(existing.approve, bot.approve) ||
      !same(existing.title, bot.title) ||
      !same(existing.avatar, bot.avatar) ||
      !same(existing.description, bot.description) ||
      !same(existing.imageProvider, bot.imageProvider) ||
      !same(existing.extensions, bot.extensions) ||
      !same(existing.tools, bot.tools) ||
      existing.noBuiltinTools !== bot.noBuiltinTools ||
      existing.noExtensions !== bot.noExtensions ||
      existing.noSkills !== bot.noSkills;
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
