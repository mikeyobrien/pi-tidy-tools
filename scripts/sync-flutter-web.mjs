#!/usr/bin/env node
/**
 * Sync a Flutter web build into the daemon's static mount (issue 60).
 *
 * Usage: node scripts/sync-flutter-web.mjs <path-to-flutter-build/web>
 *
 * Copies the build tree to packages/pi-tidy-bots/public/app/ byte-identical
 * (consumers never need the Flutter SDK — the files are committed). Pairs
 * with mason's base-href="/app/" build.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
const target = resolve("packages/pi-tidy-bots/public/app");

if (!source || !existsSync(source)) {
  console.error(
    `usage: node scripts/sync-flutter-web.mjs <flutter-build-web-dir>`
  );
  console.error(`source not found: ${source || "<missing argument>"}`);
  process.exit(1);
}
if (!existsSync(join(source, "index.html"))) {
  console.error(`refusing: ${source} has no index.html (not a web build?)`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      files++;
      bytes += statSync(path).size;
    }
  }
};
walk(target);
console.log(`synced ${files} files (${bytes} bytes) -> ${target}`);
console.log("commit the mounted tree; /app/ serves it after a daemon restart");
