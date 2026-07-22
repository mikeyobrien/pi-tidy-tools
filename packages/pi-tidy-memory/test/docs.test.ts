import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function read(relativePath: string): Promise<string> {
  return readFile(join(packageDir, relativePath), "utf8");
}

const documentationFiles = [
  "README.md",
  "CHANGELOG.md",
  "docs/architecture.md",
  "docs/backends.md",
  "docs/operations.md",
];

test("shipped documentation stays deployment-neutral", async () => {
  for (const relativePath of documentationFiles) {
    const content = await read(relativePath);
    const withoutPackageIdentity = content
      .replaceAll("@mobrienv/pi-tidy-memory", "@scope/pi-tidy-memory")
      .replaceAll("mobrienv-pi-tidy-memory", "scope-pi-tidy-memory");
    assert.doesNotMatch(
      withoutPackageIdentity,
      /\bmobrienv\b/i,
      `${relativePath} must not hard-code an operator bank or identity`
    );
    assert.doesNotMatch(
      withoutPackageIdentity,
      /(?:\bhomelab\.env\b|~\/\.pi\/agent\/git\/github\.com\/|\/home\/[^/<\s]+|https?:\/\/[^\s)`]+\.lan\b)/i,
      `${relativePath} must not hard-code a private deployment path or backend`
    );
  }
});

test("README documents compatibility and explicit local-path installs", async () => {
  const readme = await read("README.md");
  assert.match(readme, /^## Compatibility$/m);
  assert.match(readme, /explicit local path/i);
});

test("operations defines staged activation and an external receipt", async () => {
  const operations = await read("docs/operations.md");
  assert.match(operations, /^## Two-phase activation$/m);
  assert.match(operations, /^## Installation receipt$/m);
  assert.match(operations, /"artifactSha256"/);
  assert.match(operations, /"sourceRevision"/);
  assert.match(operations, /autoRetain: false/);
  assert.match(operations, /asyncRetain: false/);
  assert.match(operations, /owner's explicit approval/i);
  assert.match(operations, /fresh Pi process/i);
  assert.match(operations, /GET \/memories\/list\?limit=0/);
  assert.match(operations, /ephemeral bank/i);
});

test("bank guidance distinguishes continuity from isolation", async () => {
  const backends = await read("docs/backends.md");
  assert.match(backends, /different users/i);
  assert.match(backends, /provenance/i);
  assert.match(backends, /one static bank/i);
});

test("changelog has an Unreleased section", async () => {
  const changelog = await read("CHANGELOG.md");
  assert.match(changelog, /^## Unreleased$/m);
});
