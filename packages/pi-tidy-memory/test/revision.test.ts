import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { formatMemoryRevision, resolveMemoryRevision } from "../revision.js";

const root = "/checkout/packages/pi-tidy-memory";
const moduleUrl = pathToFileURL(`${root}/revision.ts`).href;

function metadataReader(sourceRevision: unknown, version = "0.1.0") {
  return (path: string): string => {
    if (path === `${root}/package.json`) {
      return JSON.stringify({
        name: "@mobrienv/pi-tidy-memory",
        version,
      });
    }
    if (path === `${root}/source-revision.json`) {
      return JSON.stringify({ sourceRevision });
    }
    throw new Error(`unexpected metadata path: ${path}`);
  };
}

test("resolves package version and embedded immutable source revision", () => {
  const revision = resolveMemoryRevision({
    moduleUrl,
    readFile: metadataReader("ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
  });

  assert.deepEqual(revision, {
    packageVersion: "0.1.0",
    sourceRevision: "abcdef0123456789abcdef0123456789abcdef01",
  });
});

test("sanitizes malformed or absent package and embedded source metadata", () => {
  const malformed = resolveMemoryRevision({
    moduleUrl,
    readFile: metadataReader(
      "https://user:credential@example.com/private.git",
      "not-a-version"
    ),
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
      readFile(path: string) {
        if (path === `${root}/package.json`) {
          return JSON.stringify({
            name: "@mobrienv/pi-tidy-memory",
            version: "0.1.0",
          });
        }
        throw new Error("missing embedded source revision");
      },
    }),
    {
      packageVersion: "0.1.0",
      sourceRevision: "unavailable",
    }
  );

  assert.deepEqual(
    resolveMemoryRevision({
      moduleUrl,
      readFile: () => {
        throw new Error("missing manifest");
      },
    }),
    {
      packageVersion: "unknown",
      sourceRevision: "unavailable",
    }
  );
});
