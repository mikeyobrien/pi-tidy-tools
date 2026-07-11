import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.argv[2]) throw new Error("usage: bundle-core.mjs <package-directory>");
const target = resolve(process.argv[2]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(target, "vendor", "pi-tidy-core");
await mkdir(destination, { recursive: true });
await copyFile(join(repository, "packages", "pi-tidy-core", "index.ts"), join(destination, "index.ts"));
