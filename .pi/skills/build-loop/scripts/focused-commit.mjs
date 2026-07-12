#!/usr/bin/env node
import { copyFile, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const die = (message, code = 1) => { console.error(`focused-commit: ${message}`); process.exit(code); };
const safePath = (value) => { if (!value || value.startsWith("/") || value.includes("\\")) die(`path must be repository-relative: ${value}`); const normalized = posix.normalize(value); if (normalized !== value.replace(/\/$/, "") || normalized === "." || normalized === ".." || normalized.startsWith("../")) die(`path must be normalized and repository-relative: ${value}`); return normalized; };
const execute = (args, options = {}) => { const { raw = false, ...spawnOptions } = options; const result = spawnSync("git", args, { encoding: "utf8", ...spawnOptions }); if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`); return raw ? result.stdout : result.stdout.trim(); };
const sameSet = (left, right) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

const argv = process.argv.slice(2), messageFile = argv.shift();
let acceptedPlanPath = null, auditBaseline = null;
while (argv[0]?.startsWith("--")) {
  const option = argv.shift(), value = argv.shift(); if (!value) die(`${option} requires a file`, 2);
  if (option === "--accepted-plan") acceptedPlanPath = value;
  else if (option === "--audit-baseline") auditBaseline = value;
  else die(`unknown option: ${option}`, 2);
}
if (!messageFile || !acceptedPlanPath || !argv.length) die("usage: focused-commit.mjs <message-file> --accepted-plan <plan.json> [--audit-baseline <baseline.json>] <ticket-file ...>", 2);
const paths = argv.map(safePath); if (new Set(paths).size !== paths.length) die("ticket paths must be unique");
const message = await readFile(resolve(messageFile), "utf8"); if (!message.trim()) die("commit message must be non-empty");
let acceptedPlan; try { acceptedPlan = JSON.parse(await readFile(resolve(acceptedPlanPath), "utf8")); } catch (error) { die(`invalid accepted plan: ${error.message}`); }
if (!acceptedPlan || acceptedPlan.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/.test(acceptedPlan.parent) || !/^[a-f0-9]{40,64}$/.test(acceptedPlan.tree) || !Array.isArray(acceptedPlan.files) || Object.keys(acceptedPlan).sort().join(",") !== "files,parent,schemaVersion,tree") die("invalid accepted plan schema");
const root = execute(["rev-parse", "--show-toplevel"]); if (resolve(root) !== resolve(".")) die("run from the repository root");
const oldHead = execute(["rev-parse", "HEAD"]), gitIndex = resolve(execute(["rev-parse", "--git-path", "index"])), indexLock = `${gitIndex}.lock`;
const tempDir = await mkdtemp(join(tmpdir(), "build-focused-commit-")), commitIndex = join(tempDir, "commit.index"), nextIndex = join(tempDir, "next.index"), originalIndex = join(tempDir, "original.index"), restoreIndex = join(tempDir, "restore.index");
let sha = null, lockHandle = null, ownsIndexLock = false, hadIndex = true;

try {
  const commitEnv = { ...process.env, GIT_INDEX_FILE: commitIndex };
  execute(["read-tree", oldHead], { env: commitEnv });
  execute(["add", "-A", "--", ...paths], { env: commitEnv });
  const actual = execute(["diff", "--cached", "--name-only", "-z", oldHead], { env: commitEnv, raw: true }).split("\0").filter(Boolean);
  if (!sameSet(actual, paths)) throw new Error(`focused diff paths differ: expected ${paths.join(", ")}; got ${actual.join(", ")}`);
  execute(["diff", "--cached", "--check", oldHead], { env: commitEnv });
  const tree = execute(["write-tree"], { env: commitEnv });
  if (acceptedPlan.parent !== oldHead || acceptedPlan.tree !== tree || !sameSet(acceptedPlan.files, actual) || !sameSet(acceptedPlan.files, paths)) throw new Error("focused tree differs from the mechanically accepted plan");
  sha = execute(["commit-tree", tree, "-p", oldHead, "-F", resolve(messageFile)]);

  lockHandle = await open(indexLock, "wx"); ownsIndexLock = true;
  try {
    try { await stat(gitIndex); await copyFile(gitIndex, originalIndex); await copyFile(gitIndex, nextIndex); }
    catch (error) { if (error?.code === "ENOENT") { hadIndex = false; execute(["read-tree", oldHead], { env: { ...process.env, GIT_INDEX_FILE: nextIndex } }); } else throw error; }
    const indexEnv = { ...process.env, GIT_INDEX_FILE: nextIndex };
    const priorTags = new Map(execute(["ls-files", "-v", "-z", "--", ...paths], { env: indexEnv, raw: true }).split("\0").filter(Boolean).map((record) => [record.slice(2), record[0]]));
    execute(["reset", "-q", sha, "--", ...paths], { env: indexEnv });
    for (const [path, tag] of priorTags) {
      if (!execute(["ls-files", "--", path], { env: indexEnv })) continue;
      if (tag.toLowerCase() === tag) execute(["update-index", "--assume-unchanged", "--", path], { env: indexEnv });
      if (tag.toLowerCase() === "s") execute(["update-index", "--skip-worktree", "--", path], { env: indexEnv });
    }
    if (auditBaseline) {
      const auditCli = new URL("./worktree-audit.mjs", import.meta.url).pathname;
      const result = spawnSync(process.execPath, [auditCli, "compare", resolve(auditBaseline), ...paths], { cwd: root, env: indexEnv, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`post-commit preservation audit failed: ${(result.stderr || result.stdout).trim()}`);
    }
    await rename(nextIndex, gitIndex);
    try { execute(["update-ref", "HEAD", sha, oldHead]); }
    catch (error) {
      if (hadIndex) { await copyFile(originalIndex, restoreIndex); await rename(restoreIndex, gitIndex); }
      else await rm(gitIndex, { force: true });
      throw new Error(`HEAD changed before focused commit installation; original index restored (${error.message})`);
    }
    await lockHandle.close(); lockHandle = null;
    try { await rm(indexLock, { force: true }); ownsIndexLock = false; } catch {}
  } catch (error) {
    if (lockHandle) { await lockHandle.close(); lockHandle = null; }
    if (ownsIndexLock) { await rm(indexLock, { force: true }); ownsIndexLock = false; }
    throw error;
  }
  console.log(JSON.stringify({ ok: true, command: "focused-commit", sha, parent: oldHead, files: actual, audited: Boolean(auditBaseline) }));
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
} finally {
  if (lockHandle) await lockHandle.close().catch(() => {});
  if (ownsIndexLock) await rm(indexLock, { force: true }).catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
}
