#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const die = (message, code = 1) => { console.error(`focused-plan: ${message}`); process.exit(code); };
const safePath = (value) => { if (!value || value.startsWith("/") || value.includes("\\")) die(`path must be repository-relative: ${value}`); const normalized = posix.normalize(value); if (normalized !== value.replace(/\/$/, "") || normalized === "." || normalized === ".." || normalized.startsWith("../")) die(`path must be normalized and repository-relative: ${value}`); return normalized; };
const execute = (args, options = {}) => { const { raw = false, ...spawnOptions } = options; const result = spawnSync("git", args, { encoding: "utf8", ...spawnOptions }); if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`); return raw ? result.stdout : result.stdout.trim(); };
const sameSet = (left, right) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

const [outputArg, ...rawPaths] = process.argv.slice(2);
if (!outputArg || !rawPaths.length) die("usage: focused-plan.mjs <output.json> <ticket-file ...>", 2);
const paths = rawPaths.map(safePath); if (new Set(paths).size !== paths.length) die("ticket paths must be unique");
const root = execute(["rev-parse", "--show-toplevel"]); if (resolve(root) !== resolve(".")) die("run from the repository root");
const parent = execute(["rev-parse", "HEAD"]), tempDir = await mkdtemp(join(tmpdir(), "build-focused-plan-")), index = join(tempDir, "index");
try {
  const env = { ...process.env, GIT_INDEX_FILE: index }; execute(["read-tree", parent], { env }); execute(["add", "-A", "--", ...paths], { env });
  const files = execute(["diff", "--cached", "--name-only", "-z", parent], { env, raw: true }).split("\0").filter(Boolean); if (!sameSet(files, paths)) throw new Error(`focused diff paths differ: expected ${paths.join(", ")}; got ${files.join(", ")}`);
  execute(["diff", "--cached", "--check", parent], { env }); const tree = execute(["write-tree"], { env }), plan = { schemaVersion: 1, parent, tree, files };
  await writeFile(resolve(outputArg), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" }); console.log(JSON.stringify({ ok: true, command: "focused-plan", output: resolve(outputArg), ...plan }));
} catch (error) { die(error instanceof Error ? error.message : String(error)); }
finally { await rm(tempDir, { recursive: true, force: true }); }
