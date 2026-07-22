import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const packagePath = join("packages", "pi-tidy-memory");

function gitHead(repository) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

function isContained(repository, target) {
  const targetRelative = relative(repository, target);
  return (
    targetRelative.length > 0 &&
    !targetRelative.startsWith("..") &&
    !isAbsolute(targetRelative)
  );
}

export async function embedMemoryRevision({
  repository,
  target,
  git = gitHead,
}) {
  const requestedRepository = resolve(repository);
  const requestedTarget = resolve(target);
  if (relative(requestedRepository, requestedTarget) !== packagePath) {
    throw new Error("target must be the intended memory package directory");
  }

  const canonicalRepository = await realpath(requestedRepository);
  const canonicalTarget = await realpath(requestedTarget);
  if (!isContained(canonicalRepository, canonicalTarget)) {
    throw new Error(
      "memory package directory must remain inside the repository"
    );
  }
  const canonicalExpected = await realpath(
    join(canonicalRepository, packagePath)
  );
  if (canonicalTarget !== canonicalExpected) {
    throw new Error("target must be the intended memory package directory");
  }

  const revision = git(canonicalRepository).trim().toLowerCase();
  if (!revisionPattern.test(revision)) {
    throw new Error(
      "source revision must be a full 40- or 64-character hex hash"
    );
  }

  const output = join(canonicalTarget, "source-revision.json");
  const handle = await open(
    output,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o644
  );
  try {
    await handle.writeFile(
      `${JSON.stringify({ sourceRevision: revision }, null, 2)}\n`,
      "utf8"
    );
  } finally {
    await handle.close();
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (!process.argv[2]) {
    throw new Error("usage: embed-memory-revision.mjs <package-directory>");
  }
  const repository = resolve(dirname(scriptPath), "..");
  await embedMemoryRevision({ repository, target: process.argv[2] });
}
