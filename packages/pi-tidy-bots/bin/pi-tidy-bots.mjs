#!/usr/bin/env node
// pi-tidy-bots bin. Prefers native Node type stripping (22.18+); falls back to tsx.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const entry = new URL("../src/cli.ts", import.meta.url);
const entryUrl = pathToFileURL(entry.pathname);

try {
  const module = await import(entryUrl.href);
  await module.main();
} catch (error) {
  const code = /** @type {any} */ (error)?.code;
  if (
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"
  ) {
    const require = createRequire(import.meta.url);
    let tsxLoader;
    try {
      tsxLoader = require.resolve("tsx");
    } catch {
      console.error(
        "pi-tidy-bots requires tsx when native type stripping is unavailable."
      );
      process.exit(1);
    }
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoader, entry.pathname],
      {
        stdio: "inherit",
      }
    );
    process.exit(result.status ?? 1);
  }
  throw error;
}
