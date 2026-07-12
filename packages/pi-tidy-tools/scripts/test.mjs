import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const typescript = require.resolve("typescript/bin/tsc");
const output = ".test-dist";
// c8 keeps V8 coverage JSON under NODE_V8_COVERAGE and remaps via source maps;
// leave the compile tree in place until that report finishes.
const keepDist = Boolean(process.env.NODE_V8_COVERAGE);
rmSync(output, { recursive: true, force: true });
try {
  execFileSync(process.execPath, [typescript, "-p", "tsconfig.test.json"], {
    stdio: "inherit",
  });
  const tests = readdirSync(join(output, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join(output, "test", name));
  execFileSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
} finally {
  if (!keepDist) rmSync(output, { recursive: true, force: true });
}
