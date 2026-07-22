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

test("README documents GA npm, compatibility, and explicit local-path installs", async () => {
  const readme = await read("README.md");
  assert.match(readme, /^## Compatibility$/m);
  assert.match(
    readme,
    /ESM-only; CommonJS consumers must use dynamic `import\(\)`/
  );
  assert.match(readme, /^## 1\.x stability contract$/m);
  assert.match(readme, /MemoryBackend` \/ `BackendFactory` integration seam/);
  assert.match(readme, /pi install npm:@mobrienv\/pi-tidy-memory/);
  assert.match(readme, /@mobrienv\/pi-tidy-memory@<version>/);
  assert.match(readme, /bounded, single-line `reasoning` phrase/);
  assert.match(readme, /12 words or fewer/);
  assert.match(readme, /64 characters or fewer/);
  assert.match(readme, /two-line why-and-result block/);
  assert.match(readme, /explicit local path/i);
  assert.doesNotMatch(readme, /experimental|not published/i);
});

test("operations defines staged activation and an external receipt", async () => {
  const operations = await read("docs/operations.md");
  assert.match(operations, /^## Two-phase activation$/m);
  assert.match(operations, /^## Installation receipt$/m);
  assert.match(operations, /^### Published npm package$/m);
  assert.match(operations, /"artifactSha256"/);
  assert.match(operations, /"sourceRevision"/);
  assert.match(operations, /autoRetain: false/);
  assert.match(operations, /asyncRetain: false/);
  assert.match(operations, /owner's explicit approval/i);
  assert.match(operations, /fresh Pi process/i);
  assert.match(operations, /GET \/memories\/list\?limit=0/);
  assert.match(operations, /ephemeral bank/i);
});

test("architecture documents display-only reasoning", async () => {
  const architecture = await read("docs/architecture.md");
  assert.match(architecture, /single-line model-facing `reasoning` phrase/);
  assert.match(architecture, /at\s+most 12 words and 64 characters/);
  assert.match(architecture, /stripped before\s+backend\s+execution/);
  assert.match(architecture, /obvious-credential redactor/);
});

test("bank guidance distinguishes continuity from isolation", async () => {
  const backends = await read("docs/backends.md");
  assert.match(backends, /different users/i);
  assert.match(backends, /provenance/i);
  assert.match(backends, /one static bank/i);
});

test("GA metadata and changelog identify the 1.0.0 public candidate", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("../../package-lock.json"));
  const changelog = await read("CHANGELOG.md");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(
    manifest.repository?.url,
    "git+https://github.com/mikeyobrien/pi-tidy-tools.git"
  );
  assert.equal(lock.packages["packages/pi-tidy-memory"].version, "1.0.0");
  assert.match(changelog, /^## \[Unreleased\]$/m);
  assert.match(changelog, /^## \[1\.0\.0\] - 2026-07-22$/m);
  assert.match(
    changelog,
    /^\[Unreleased\]: .*pi-tidy-memory-v1\.0\.0\.\.\.HEAD$/m
  );
  assert.match(changelog, /^\[1\.0\.0\]: .*\/tree\/pi-tidy-memory-v1\.0\.0$/m);
});
