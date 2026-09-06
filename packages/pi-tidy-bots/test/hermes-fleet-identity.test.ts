import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Hermes fleet identity survives native MCP thread and retry boundaries", () => {
  const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
  const python =
    process.env.TIDY_TEST_PYTHON ??
    (existsSync(candidate) ? candidate : "/usr/bin/python3");
  const result = spawnSync(
    python,
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("./hermes_fleet_identity_test.py", import.meta.url)
      ),
    ],
    { encoding: "utf8", timeout: 10000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 7 tests/);
});
