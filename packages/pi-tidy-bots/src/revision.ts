/**
 * Running-commit visibility (issue 39): resolve the git revision the daemon
 * runs from. Resolution walks up from the module directory to the nearest
 * `.git` (directory or worktree file) and shells out to git once. When git or
 * the repository is unavailable (packed installs) resolution degrades to
 * `undefined` — callers omit the field rather than lie.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Revision {
  full: string;
  short: string;
}

export function findRepoRoot(
  startDir: string,
  hasGit: (dir: string) => boolean = isGitRepo
): string | undefined {
  let current = startDir;
  for (;;) {
    if (hasGit(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isGitRepo(dir: string): boolean {
  const dotGit = join(dir, ".git");
  // Worktrees have a `.git` FILE pointing at the real gitdir; both count.
  return existsSync(dotGit);
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parse `git rev-parse HEAD` output into full + short, or undefined. */
export function parseRevision(output: string): Revision | undefined {
  const full = output.trim();
  if (!FULL_SHA.test(full)) return undefined;
  return { full, short: full.slice(0, 7) };
}

export function resolveRevision(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  run: (args: string[], cwd: string) => string = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
): Revision | undefined {
  try {
    const root = findRepoRoot(startDir);
    if (!root) return undefined;
    return parseRevision(run(["rev-parse", "--verify", "HEAD"], root));
  } catch {
    return undefined;
  }
}

/** Resolved once per process at import time. */
export const DAEMON_REVISION: Revision | undefined = resolveRevision();
