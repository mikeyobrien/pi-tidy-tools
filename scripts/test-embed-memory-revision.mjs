import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { embedMemoryRevision } from "./embed-memory-revision.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";

async function temporaryRepository() {
  const repository = await mkdtemp(join(tmpdir(), "tidy-memory-revision-"));
  const target = join(repository, "packages", "pi-tidy-memory");
  await mkdir(target, { recursive: true });
  return { repository, target };
}

test("embeds the checked-out full revision only in the intended package", async () => {
  const { repository, target } = await temporaryRepository();
  try {
    await embedMemoryRevision({
      repository,
      target,
      git: () => revision,
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(target, "source-revision.json"), "utf8")),
      { sourceRevision: revision }
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("rejects a memory package symlink that escapes the repository", async () => {
  const repository = await mkdtemp(join(tmpdir(), "tidy-memory-revision-"));
  const outside = await mkdtemp(join(tmpdir(), "tidy-memory-outside-"));
  try {
    await mkdir(join(repository, "packages"), { recursive: true });
    await symlink(outside, join(repository, "packages", "pi-tidy-memory"));
    await assert.rejects(
      embedMemoryRevision({
        repository,
        target: join(repository, "packages", "pi-tidy-memory"),
        git: () => revision,
      }),
      /inside the repository/
    );
    await assert.rejects(readFile(join(outside, "source-revision.json")));
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects alternate paths even when they resolve to the intended package", async () => {
  const { repository, target } = await temporaryRepository();
  const alias = join(repository, "memory-alias");
  try {
    await symlink(target, alias);
    await assert.rejects(
      embedMemoryRevision({ repository, target: alias, git: () => revision }),
      /intended memory package directory/
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
