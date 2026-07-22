import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as revisionModule from "../revision.js";

test("resolves package version and immutable Git source revision", () => {
  const root = "/checkout/packages/pi-tidy-memory";
  const resolveMemoryRevision = (revisionModule as any).resolveMemoryRevision;

  const revision = resolveMemoryRevision?.({
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
