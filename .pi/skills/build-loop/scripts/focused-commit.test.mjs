import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("./focused-commit.mjs", import.meta.url).pathname;
const planCli = new URL("./focused-plan.mjs", import.meta.url).pathname;
const auditCli = new URL("./worktree-audit.mjs", import.meta.url).pathname;
const invokeScript = (script, cwd, args, expected = 0, env = process.env) => { const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env }); assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`); return result; };
const invoke = (cwd, args, expected = 0, env = process.env) => invokeScript(cli, cwd, args.includes("--accepted-plan") ? args : [args[0], "--accepted-plan", join(cwd, ".accepted-plan.json"), ...args.slice(1)], expected, env);
const git = (cwd, ...args) => { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "focused-commit-")); git(root, "init", "-q"); git(root, "config", "user.email", "fixture@example.com"); git(root, "config", "user.name", "Fixture"); await writeFile(join(root, "ticket.txt"), "base ticket\n"); await writeFile(join(root, "staged.txt"), "base staged\n"); await writeFile(join(root, "unstaged.txt"), "base unstaged\n"); git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "update-index", "--assume-unchanged", "ticket.txt");
  await writeFile(join(root, "ticket.txt"), "ticket change\n"); await writeFile(join(root, "new-ticket.txt"), "new ticket file\n"); await writeFile(join(root, "staged.txt"), "user staged\n"); git(root, "add", "staged.txt"); await writeFile(join(root, "unstaged.txt"), "user unstaged\n"); await mkdir(join(root, "notes")); await writeFile(join(root, "notes", "user.txt"), "user untracked\n"); const message = join(root, ".message"); await writeFile(message, "Implement ticket\n"); invokeScript(planCli, root, [join(root, ".accepted-plan.json"), "ticket.txt", "new-ticket.txt"]); return { root, message };
}

async function faultingGit(root, mode, concurrentRef = "") {
  const bin = join(root, "fake-bin"); await mkdir(bin); const wrapper = join(bin, "git");
  await writeFile(wrapper, `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2), real = process.env.REAL_GIT;\nconst updatingHead = args[0] === "update-ref" && args[1] === "HEAD" && args.length === 4;\nif (updatingHead && process.env.FAULT_MODE === "update-ref-fault") process.exit(73);\nif (updatingHead && process.env.FAULT_MODE === "concurrent-ref") spawnSync(real, ["update-ref", "HEAD", process.env.CONCURRENT_REF, args[3]], { stdio: "inherit", env: process.env });\nconst result = spawnSync(real, args, { stdio: "inherit", env: process.env });\nprocess.exit(result.status ?? 1);\n`); await chmod(wrapper, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(), FAULT_MODE: mode, CONCURRENT_REF: concurrentRef };
}

test("focused commit includes exact ticket files and preserves unrelated user state", async () => {
  const { root, message } = await fixture(), baseline = join(root, ".baseline.json"), beforeStaged = git(root, "diff", "--cached", "--binary", "--", "staged.txt"), beforeUnstaged = await readFile(join(root, "unstaged.txt"), "utf8"), beforeUntracked = await readFile(join(root, "notes", "user.txt"), "utf8");
  invokeScript(auditCli, root, ["snapshot", baseline, "staged.txt", "unstaged.txt", "notes"]); assert.match(git(root, "ls-files", "-v", "--", "ticket.txt"), /^h /); const result = JSON.parse(invoke(root, [message, "ticket.txt", "new-ticket.txt"]).stdout); assert.equal(result.ok, true); assert.deepEqual(result.files.sort(), ["new-ticket.txt", "ticket.txt"]); assert.match(result.sha, /^[a-f0-9]{40,64}$/);
  assert.equal(git(root, "show", "--pretty=format:", "--name-only", "HEAD").trim().split("\n").sort().join(","), "new-ticket.txt,ticket.txt"); const audit = JSON.parse(invokeScript(auditCli, root, ["compare", baseline, "ticket.txt", "new-ticket.txt"]).stdout); assert.equal(audit.ok, true); assert.match(git(root, "ls-files", "-v", "--", "ticket.txt"), /^h /); assert.equal(git(root, "diff", "--cached", "--binary", "--", "staged.txt"), beforeStaged); assert.equal(await readFile(join(root, "unstaged.txt"), "utf8"), beforeUnstaged); assert.equal(await readFile(join(root, "notes", "user.txt"), "utf8"), beforeUntracked); assert.match(git(root, "status", "--short"), /^M  staged\.txt/m); assert.match(git(root, "status", "--short"), /^ M unstaged\.txt/m); assert.match(git(root, "status", "--short"), /^\?\? notes\//m);
});

test("focused commit rejects a file set that does not equal the actual delta", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(); const result = invoke(root, [message, "ticket.txt", "new-ticket.txt", "unchanged.txt"], 1); assert.match(result.stderr, /focused diff paths differ|pathspec/); assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
});

test("focused commit rejects traversal before touching Git state", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(); assert.match(invoke(root, [message, "../outside"], 1).stderr, /normalized and repository-relative/); assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
});

test("failed final HEAD update restores the original index", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(), indexBefore = await readFile(join(root, ".git", "index"));
  const result = invoke(root, [message, "ticket.txt", "new-ticket.txt"], 1, await faultingGit(root, "update-ref-fault"));
  assert.match(result.stderr, /original index restored/); assert.equal(git(root, "rev-parse", "HEAD").trim(), head); assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
});

test("HEAD CAS loss preserves the concurrent update and restores the index", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(), tree = git(root, "rev-parse", "HEAD^{tree}").trim();
  const concurrent = git(root, "commit-tree", tree, "-p", head, "-m", "concurrent").trim(), indexBefore = await readFile(join(root, ".git", "index"));
  const result = invoke(root, [message, "ticket.txt", "new-ticket.txt"], 1, await faultingGit(root, "concurrent-ref", concurrent));
  assert.match(result.stderr, /original index restored/); assert.equal(git(root, "rev-parse", "HEAD").trim(), concurrent); assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
});

test("failed final HEAD update preserves index work staged before invocation", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(); await writeFile(join(root, "concurrent.txt"), "preserved index work\n"); git(root, "add", "concurrent.txt");
  invoke(root, [message, "ticket.txt", "new-ticket.txt"], 1, await faultingGit(root, "update-ref-fault"));
  assert.equal(git(root, "rev-parse", "HEAD").trim(), head); assert.match(git(root, "status", "--short"), /^A  concurrent\.txt$/m); assert.match(git(root, "status", "--short"), /^M  staged\.txt$/m);
});

test("successful index installation preserves preexisting index work", async () => {
  const { root, message } = await fixture(); await writeFile(join(root, "concurrent.txt"), "preserved index work\n"); git(root, "add", "concurrent.txt");
  const result = JSON.parse(invoke(root, [message, "ticket.txt", "new-ticket.txt"]).stdout);
  assert.equal(result.ok, true); assert.match(git(root, "status", "--short"), /^A  concurrent\.txt$/m); assert.match(git(root, "status", "--short"), /^M  staged\.txt$/m);
});

test("optional post-commit preservation audit runs before installation", async () => {
  const { root, message } = await fixture(), baseline = join(root, ".baseline.json"); invokeScript(auditCli, root, ["snapshot", baseline, "staged.txt", "unstaged.txt", "notes"]);
  const result = JSON.parse(invoke(root, [message, "--audit-baseline", baseline, "ticket.txt", "new-ticket.txt"]).stdout);
  assert.equal(result.audited, true);
});

test("accepted plan rejects same-path changes after mechanical approval", async () => {
  const { root, message } = await fixture(), head = git(root, "rev-parse", "HEAD").trim(); await writeFile(join(root, "ticket.txt"), "changed after approval\n");
  assert.match(invoke(root, [message, "ticket.txt", "new-ticket.txt"], 1).stderr, /differs from the mechanically accepted plan/); assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
});

test("failed post-commit preservation audit rolls back HEAD and index", async () => {
  const { root, message } = await fixture(), baseline = join(root, ".baseline.json"), head = git(root, "rev-parse", "HEAD").trim(); invokeScript(auditCli, root, ["snapshot", baseline, "unstaged.txt"]);
  const indexBefore = await readFile(join(root, ".git", "index")); await writeFile(join(root, "unstaged.txt"), "concurrent overwrite\n");
  assert.match(invoke(root, [message, "--audit-baseline", baseline, "ticket.txt", "new-ticket.txt"], 1).stderr, /preservation audit failed/);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), head); assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
});
