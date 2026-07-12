import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("./worktree-audit.mjs", import.meta.url).pathname;
const run = (cwd, args, expected = 0) => { const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" }); assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`); return result; };
const git = (cwd, ...args) => { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "build-worktree-")); git(root, "init", "-q"); git(root, "config", "user.email", "fixture@example.com"); git(root, "config", "user.name", "Fixture"); await writeFile(join(root, "tracked.txt"), "base\n"); await writeFile(join(root, "staged.txt"), "base\n"); await writeFile(join(root, "flagged.txt"), "clean\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  await writeFile(join(root, "tracked.txt"), "user-owned unstaged\n"); await writeFile(join(root, "staged.txt"), "user-owned staged\n"); git(root, "add", "staged.txt"); await mkdir(join(root, "notes")); await writeFile(join(root, "notes", "untracked.txt"), "user-owned untracked\n"); return root;
}

test("snapshot and compare preserve staged, unstaged, and untracked user state", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline, "tracked.txt", "staged.txt", "notes"]); const saved = JSON.parse(await readFile(baseline, "utf8")); assert.equal(saved.owned.length, 3);
  await writeFile(join(root, "ticket.txt"), "ticket change\n"); const preserved = JSON.parse(run(root, ["compare", baseline]).stdout); assert.equal(preserved.ok, true); assert.equal(preserved.indexPreserved, true); assert.equal(preserved.ownedPreserved, true);
  await writeFile(join(root, "tracked.txt"), "overwritten\n"); const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.ownedPreserved, false); assert.deepEqual(changed.changedOwnedPaths, ["tracked.txt"]);
});

test("compare detects index mutation independently of worktree changes", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline, "tracked.txt", "staged.txt", "notes"]); await writeFile(join(root, "ticket.txt"), "ticket\n"); git(root, "add", "ticket.txt"); const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.indexPreserved, false); assert.equal(changed.ownedPreserved, true);
});

test("compare detects index flags omitted by ordinary staged listings", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline, "tracked.txt", "staged.txt", "notes"]); git(root, "update-index", "--skip-worktree", "flagged.txt"); const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.indexPreserved, false);
});

test("compare detects intent-to-add becoming ordinarily staged", async () => {
  const root = await fixture(), path = join(root, "intent.txt"), baseline = join(root, ".baseline.json"); await writeFile(path, ""); git(root, "add", "-N", "intent.txt"); run(root, ["snapshot", baseline]); git(root, "add", "intent.txt");
  const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.indexPreserved, false);
});

test("compare can permit only accepted ticket index entries after commit", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline, "tracked.txt", "staged.txt", "notes"]); await writeFile(join(root, "flagged.txt"), "accepted ticket change\n"); git(root, "add", "flagged.txt"); const allowed = JSON.parse(run(root, ["compare", baseline, "flagged.txt"]).stdout); assert.equal(allowed.ok, true); assert.deepEqual(allowed.allowedIndexPaths, ["flagged.txt"]);
});

test("accepted index path allowances still enforce existing flags", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); git(root, "update-index", "--assume-unchanged", "flagged.txt"); run(root, ["snapshot", baseline, "tracked.txt"]); git(root, "update-index", "--no-assume-unchanged", "flagged.txt"); const changed = JSON.parse(run(root, ["compare", baseline, "flagged.txt"], 1).stdout); assert.equal(changed.allowedFlagsPreserved, false); assert.equal(changed.indexPreserved, false);
});

test("snapshot refuses unsafe paths and existing evidence overwrite", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); assert.match(run(root, ["snapshot", baseline, "../outside"], 1).stderr, /normalized and repository-relative/); run(root, ["snapshot", baseline, "tracked.txt"]); assert.match(run(root, ["snapshot", baseline, "tracked.txt"], 1).stderr, /EEXIST|file already exists/i);
});

test("index records preserve distinct non-UTF8 path bytes", async () => {
  const root = await fixture(), first = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0x80])]), second = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0x81])]);
  await writeFile(first, "first\n"); await writeFile(second, "second\n"); git(root, "add", "-A"); const baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline]);
  await unlink(first); git(root, "add", "-A"); const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.indexPreserved, false);
});

test("owned fingerprints include executable metadata", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); run(root, ["snapshot", baseline, "tracked.txt"]); await chmod(join(root, "tracked.txt"), 0o755);
  const changed = JSON.parse(run(root, ["compare", baseline], 1).stdout); assert.equal(changed.ownedPreserved, false); assert.deepEqual(changed.changedOwnedPaths, ["tracked.txt"]);
});

test("terminal symlinks are fingerprinted but symlink ancestors are rejected", async () => {
  const root = await fixture(), baseline = join(root, ".baseline.json"); await symlink("first-target", join(root, "terminal-link")); run(root, ["snapshot", baseline, "terminal-link"]);
  await unlink(join(root, "terminal-link")); await symlink("second-target", join(root, "terminal-link")); assert.equal(JSON.parse(run(root, ["compare", baseline], 1).stdout).ownedPreserved, false);
  await mkdir(join(root, "real-directory")); await writeFile(join(root, "real-directory", "child"), "data"); await symlink("real-directory", join(root, "linked-directory"));
  assert.match(run(root, ["snapshot", join(root, ".ancestor.json"), "linked-directory/child"], 1).stderr, /symlink ancestor/);
});

test("snapshot rejects special filesystem entries", async () => {
  const root = await fixture(), fifo = join(root, "owned.fifo"), made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); assert.equal(made.status, 0, made.stderr);
  assert.match(run(root, ["snapshot", join(root, ".fifo.json"), "owned.fifo"], 1).stderr, /unsupported special owned path/);
});

test("compare rejects foreign roots and malformed baseline paths", async () => {
  const first = await fixture(), second = await fixture(), baseline = join(first, ".baseline.json"); run(first, ["snapshot", baseline, "tracked.txt"]);
  assert.match(run(second, ["compare", baseline], 1).stderr, /foreign baseline/);
  const malformed = JSON.parse(await readFile(baseline, "utf8")); malformed.repositoryRoot = first; malformed.owned[0].path = "../escape"; const malformedFile = join(first, ".malformed.json"); await writeFile(malformedFile, JSON.stringify(malformed));
  assert.match(run(first, ["compare", malformedFile], 1).stderr, /normalized and repository-relative/);
});
