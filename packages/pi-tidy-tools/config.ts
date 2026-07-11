import { promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-tidy-tools.json");

export type TidyStateSource = "environment" | "file" | "default";

export interface TidyState {
	enabled: boolean;
	source: TidyStateSource;
}

export type TidyMode = "default" | "reasoning" | "result";

/** Parse the documented boolean forms; unknown values do not override config. */
export function parseEnabled(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "on":
		case "yes":
			return true;
		case "0":
		case "false":
		case "off":
		case "no":
			return false;
		default:
			return undefined;
	}
}

/** Resolve startup state. A valid environment override always wins. */
export function loadTidyState(options: { envValue?: string; configPath?: string } = {}): TidyState {
	const envValue = options.envValue ?? process.env.PI_TIDY_TOOLS;
	const envEnabled = parseEnabled(envValue);
	if (envEnabled !== undefined) return { enabled: envEnabled, source: "environment" };

	const configPath = options.configPath ?? CONFIG_PATH;
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		if (typeof parsed?.enabled === "boolean") return { enabled: parsed.enabled, source: "file" };
	} catch {
		// Missing, unreadable, and malformed config all preserve the enabled default.
	}
	return { enabled: true, source: "default" };
}

export function loadTidyMode(configPath = CONFIG_PATH): TidyMode {
	try {
		const mode = JSON.parse(readFileSync(configPath, "utf8"))?.mode;
		if (mode === "reasoning" || mode === "result") return mode;
	} catch {
		// Missing and malformed config preserve the default layout.
	}
	return "default";
}

async function updateConfig(update: Record<string, unknown>, configPath: string): Promise<void> {
	let current: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
	} catch {
		// Missing and malformed config are replaced with valid extension config.
	}
	const directory = dirname(configPath);
	const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.mkdir(directory, { recursive: true });
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`, "utf8");
		await fs.rename(temporaryPath, configPath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

/** Persist only extension-owned settings outside the package checkout. */
export async function saveTidyEnabled(enabled: boolean, configPath = CONFIG_PATH): Promise<void> {
	await updateConfig({ enabled }, configPath);
}

export async function saveTidyMode(mode: TidyMode, configPath = CONFIG_PATH): Promise<void> {
	await updateConfig({ mode }, configPath);
}
