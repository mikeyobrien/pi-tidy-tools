import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { formatMemoryRevision, resolveMemoryRevision } from "../revision.js";

test("resolves package version and immutable Git source revision", () => {
  const root = "/checkout/packages/pi-tidy-memory";

  const revision = resolveMemoryRevision({
    moduleUrl: pathToFileURL(`${root}/revision.ts`).href,
    readFile(path: string) {
      assert.equal(path, `${root}/package.json`);
      return JSON.stringify({
        name: "@mobrienv/pi-tidy-memory",
        version: "0.1.0",
      });
    },
    git(cwd: string) {
      assert.equal(cwd, root);
      return "ABCDEF0123456789ABCDEF0123456789ABCDEF01\n";
    },
  });

  assert.deepEqual(revision, {
    packageVersion: "0.1.0",
    sourceRevision: "abcdef0123456789abcdef0123456789abcdef01",
  });
});

test("sanitizes malformed or absent package and source metadata", () => {
  const moduleUrl = pathToFileURL(
    "/checkout/packages/pi-tidy-memory/revision.ts"
  ).href;

  const malformed = resolveMemoryRevision({
    moduleUrl,
    readFile: () =>
      JSON.stringify({
        name: "@mobrienv/pi-tidy-memory",
        version: "not-a-version",
      }),
    git: () => "https://user:credential@example.com/private.git",
  });
  assert.deepEqual(malformed, {
    packageVersion: "unknown",
    sourceRevision: "unavailable",
  });
  assert.doesNotMatch(
    formatMemoryRevision(malformed),
    /credential|example\.com/
  );

  assert.deepEqual(
    resolveMemoryRevision({
      moduleUrl,
      readFile: () => {
        throw new Error("missing manifest");
      },
      git: () => {
        throw new Error("missing git metadata");
      },
    }),
    {
      packageVersion: "unknown",
      sourceRevision: "unavailable",
    }
  );
});
