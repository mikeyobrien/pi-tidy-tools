import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "pi-tidy-footer.json"
);

export const DEFAULT_MOUNTS: readonly string[] = ["/", "/tmp"];
export const DEFAULT_WARN_PERCENT = 85;

/** Config path redirect for hermetic tests and sandboxed runs; unset means the user path. */
export function defaultConfigPath(): string {
  return process.env.PI_TIDY_FOOTER_CONFIG ?? CONFIG_PATH;
}

export interface ResourceConfig {
  enabled: boolean;
  mounts: string[];
  warnPercent: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the optional resource segment. It stays off unless the config file
 * sets `resources.enabled: true`; invalid fields fall back to their defaults.
 * Read at the point of use so a config edit applies on the next install.
 */
export function loadResourceConfig(
  configPath = defaultConfigPath()
): ResourceConfig {
  let section: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (isRecord(parsed) && isRecord(parsed.resources))
      section = parsed.resources;
  } catch {
    // Missing, unreadable, and malformed config keep the segment off.
  }
  const mounts = Array.isArray(section.mounts)
    ? section.mounts.filter(
        (mount): mount is string =>
          typeof mount === "string" && mount.trim() !== ""
      )
    : [];
  const warn = section.warnPercent;
  return {
    enabled: section.enabled === true,
    mounts: mounts.length > 0 ? mounts : [...DEFAULT_MOUNTS],
    warnPercent:
      typeof warn === "number" &&
      Number.isFinite(warn) &&
      warn > 0 &&
      warn <= 100
        ? warn
        : DEFAULT_WARN_PERCENT,
  };
}
