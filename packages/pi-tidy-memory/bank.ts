import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { HindsightBackendConfig } from "./config.js";

export const DYNAMIC_BANK_FIELDS = [
  "agent",
  "project",
  "session",
  "channel",
  "user",
] as const;

export type DynamicBankField = (typeof DYNAMIC_BANK_FIELDS)[number];

export interface BankResolutionContext {
  sessionId?: string;
}

export interface BankResolverDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  git?: (args: readonly string[], cwd: string) => string | undefined;
}

export interface BankResolution {
  bankId: string;
  source: "static" | "dynamic" | "directory-map";
}

const SAFE_BANK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_BANK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function defaultGit(args: readonly string[], cwd: string): string | undefined {
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function assertBankId(value: string, description: string): string {
  if (!SAFE_BANK_ID.test(value)) {
    throw new Error(
      `${description} resolved to an unsafe bank ID; use 1-128 letters, numbers, dots, underscores, colons, or hyphens`
    );
  }
  return value;
}

function projectLabel(
  cwd: string,
  resolveWorktrees: boolean,
  git: (args: readonly string[], cwd: string) => string | undefined
): string {
  if (resolveWorktrees) {
    const commonDir = git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd
    );
    if (commonDir) {
      const absolute = resolve(cwd, commonDir);
      const root = basename(absolute) === ".git" ? dirname(absolute) : absolute;
      const label = basename(root);
      if (label) return label;
    }
  }
  const topLevel = git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    cwd
  );
  const label = basename(topLevel ? resolve(cwd, topLevel) : cwd);
  return label || "root";
}

function mappedBankId(
  config: HindsightBackendConfig,
  cwd: string
): string | undefined {
  for (const [directory, bankId] of Object.entries(
    config.directoryBankMap ?? {}
  )) {
    if (resolve(directory) === cwd) return bankId;
  }
  return undefined;
}

function withPrefix(config: HindsightBackendConfig, bankId: string): string {
  return config.bankIdPrefix ? `${config.bankIdPrefix}::${bankId}` : bankId;
}

export class HindsightBankResolver {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly project: string | undefined;

  constructor(
    private readonly config: HindsightBackendConfig,
    dependencies: BankResolverDependencies = {}
  ) {
    this.cwd = resolve(dependencies.cwd ?? process.cwd());
    this.env = dependencies.env ?? process.env;
    const dynamicFields = config.dynamicBankGranularity ?? ["agent", "project"];
    if (config.dynamicBankId && dynamicFields.includes("project")) {
      const git = dependencies.git ?? defaultGit;
      this.project = projectLabel(
        this.cwd,
        config.resolveWorktrees ?? true,
        git
      );
    }
  }

  resolve(context: BankResolutionContext = {}): BankResolution {
    const mapped = mappedBankId(this.config, this.cwd);
    if (mapped) {
      return {
        bankId: assertBankId(
          withPrefix(this.config, mapped),
          "backend.directoryBankMap"
        ),
        source: "directory-map",
      };
    }

    if (!this.config.dynamicBankId) {
      return {
        bankId: assertBankId(
          withPrefix(this.config, this.config.bankId),
          "backend.bankId"
        ),
        source: "static",
      };
    }

    const values: Record<DynamicBankField, string | undefined> = {
      agent: this.env.HINDSIGHT_AGENT_NAME ?? this.config.agentName ?? "pi",
      project: this.project,
      session: context.sessionId ?? this.env.HINDSIGHT_SESSION_ID,
      channel: this.env.HINDSIGHT_CHANNEL_ID,
      user: this.env.HINDSIGHT_USER_ID,
    };
    const fields = this.config.dynamicBankGranularity ?? ["agent", "project"];
    const segments = fields.map((field) => {
      const value = values[field];
      if (!value) {
        const environment =
          field === "channel"
            ? "HINDSIGHT_CHANNEL_ID"
            : field === "user"
              ? "HINDSIGHT_USER_ID"
              : field === "session"
                ? "the active Pi session or HINDSIGHT_SESSION_ID"
                : `the ${field} resolver`;
        throw new Error(
          `dynamic bank field ${field} is unavailable; configure ${environment} or remove it from backend.dynamicBankGranularity`
        );
      }
      if (!SAFE_BANK_SEGMENT.test(value)) {
        throw new Error(
          `dynamic bank field ${field} must be 1-128 letters, numbers, dots, underscores, or hyphens`
        );
      }
      return value;
    });
    return {
      bankId: assertBankId(
        withPrefix(this.config, segments.join("::")),
        "dynamic bank"
      ),
      source: "dynamic",
    };
  }
}
