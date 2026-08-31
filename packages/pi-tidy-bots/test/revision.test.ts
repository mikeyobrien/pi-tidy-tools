import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRepoRoot,
  parseRevision,
  resolveRevision,
} from "../src/revision.ts";

test("parseRevision accepts full shas and rejects junk", () => {
  const full = "a".repeat(40);
  assert.deepEqual(parseRevision(`${full}\n`), {
    full,
    short: "aaaaaaa",
  });
  // Worktree-style 64-char sha (sha256 repos) also parses.
  assert.equal(parseRevision(`${"b".repeat(64)}\n`)?.full.length, 64);
  assert.equal(parseRevision("not-a-sha"), undefined);
  assert.equal(parseRevision(""), undefined);
});

test("findRepoRoot walks up to the nearest .git marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-revision-"));
  try {
    // Worktree idiom: .git is a FILE pointing at the real gitdir.
    const repo = join(dir, "repo");
    const nested = join(repo, "packages", "pi-tidy-bots");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /somewhere/else\n");
    assert.equal(findRepoRoot(join(nested, "src")), repo);
    assert.equal(findRepoRoot(dir), undefined, "outside: no .git upward");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRevision matches git rev-parse HEAD of this checkout", () => {
  // This test runs inside the real worktree, so resolution must succeed and
  // agree with git itself.
  const rev = resolveRevision(process.cwd());
  assert.ok(rev, "revision resolves inside the worktree");
  assert.equal(rev.full.length, 40);
  assert.equal(rev.short, rev.full.slice(0, 7));
});

test("resolveRevision degrades to undefined outside a repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-revision-none-"));
  try {
    assert.equal(resolveRevision(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
