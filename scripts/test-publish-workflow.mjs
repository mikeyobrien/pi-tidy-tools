import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/publish.yml",
  import.meta.url
);

async function workflow() {
  return readFile(workflowUrl, "utf8");
}

test("npm publish workflow uses a hardened tokenless OIDC boundary", async () => {
  const source = await workflow();

  assert.match(source, /permissions:\s+contents: read\s+id-token: write/s);
  assert.match(source, /environment: npm/);
  assert.doesNotMatch(source, /workflow_dispatch:/);
  assert.match(source, /^          persist-credentials: false$/m);
  assert.match(source, /^          package-manager-cache: false$/m);
  assert.match(source, /npm 11\.5\.1 or newer is required/);
  assert.match(source, /^        run: npm ci --ignore-scripts$/m);
  assert.doesNotMatch(source, /^\s+cache:\s/m);
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(
    source,
    /pi-tidy-tools\|pi-tidy-subagents\|pi-tidy-memory\|pi-tidy-footer/
  );
  assert.doesNotMatch(source, /pi-tidy-tools\|pi-tidy-core/);
  assert.match(
    source,
    /^        run: npm publish --workspace "\$PACKAGE_NAME" --access public --provenance$/m
  );
});

test("every third-party action in the npm publish workflow is commit-pinned", async () => {
  const source = await workflow();
  const uses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1]
  );

  assert(uses.length > 0, "publish workflow must use reviewed actions");
  for (const action of uses) {
    assert.match(
      action,
      /^[^@\s]+@[0-9a-f]{40}$/,
      `${action} must be pinned to a full commit hash`
    );
  }
});
