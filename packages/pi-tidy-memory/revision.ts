import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MEMORY_PACKAGE_NAME = "@mobrienv/pi-tidy-memory";

export interface MemoryRevision {
  packageVersion: string;
  sourceRevision: string;
}

export interface MemoryRevisionDependencies {
  moduleUrl?: string;
  readFile?: (path: string) => string;
  git?: (cwd: string) => string;
}

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function defaultGit(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
}

export function resolveMemoryRevision(
  dependencies: MemoryRevisionDependencies = {}
): MemoryRevision {
  const readFile =
    dependencies.readFile ?? ((path) => readFileSync(path, "utf8"));
  const moduleDirectory = dirname(
    fileURLToPath(dependencies.moduleUrl ?? import.meta.url)
  );
  let packageRoot: string | undefined;
  let packageVersion = "unknown";
  for (const candidate of [moduleDirectory, dirname(moduleDirectory)]) {
    try {
      const manifest = JSON.parse(readFile(join(candidate, "package.json")));
      if (
        manifest?.name === MEMORY_PACKAGE_NAME &&
        typeof manifest.version === "string" &&
        manifest.version.length <= 64 &&
        VERSION.test(manifest.version)
      ) {
        packageRoot = candidate;
        packageVersion = manifest.version;
        break;
      }
    } catch {
      // Source installs keep package.json beside this module; builds keep it one level up.
    }
  }
  if (!packageRoot) return { packageVersion, sourceRevision: "unavailable" };
  try {
    const revision = (dependencies.git ?? defaultGit)(packageRoot)
      .trim()
      .toLowerCase();
    return {
      packageVersion,
      sourceRevision: GIT_REVISION.test(revision) ? revision : "unavailable",
    };
  } catch {
    return { packageVersion, sourceRevision: "unavailable" };
  }
}

export function formatMemoryRevision(revision: MemoryRevision): string {
  return `package=${MEMORY_PACKAGE_NAME}@${revision.packageVersion} source=${revision.sourceRevision}`;
}
