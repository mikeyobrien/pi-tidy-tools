import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (manifest.name !== "@mobrienv/pi-tidy-memory") {
  throw new Error("smoke check loaded the wrong package");
}
if (
  !Array.isArray(manifest.pi?.extensions) ||
  manifest.pi.extensions.length !== 1 ||
  manifest.pi.extensions[0] !== "./index.ts"
) {
  throw new Error("native Pi adapter entry is not configured");
}
for (const path of [
  "index.ts",
  "revision.ts",
  "source-revision.json",
  "dist/index.js",
  "dist/revision.js",
]) {
  await readFile(join(root, path));
}

const embedded = JSON.parse(
  await readFile(join(root, "source-revision.json"), "utf8")
);
const sourceRevision = embedded?.sourceRevision?.toLowerCase?.() ?? "";
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceRevision)) {
  throw new Error("package omitted a valid embedded source revision");
}

const revisionModule = await import(
  pathToFileURL(join(root, "dist", "revision.js")).href
);
const revision = revisionModule.resolveMemoryRevision();
if (revision.packageVersion !== manifest.version) {
  throw new Error("compiled package revision does not match package.json");
}
if (revision.sourceRevision !== sourceRevision) {
  throw new Error("compiled package revision does not match embedded source");
}
if (
  revisionModule.formatMemoryRevision(revision) !==
  `package=@mobrienv/pi-tidy-memory@${manifest.version} source=${sourceRevision}`
) {
  throw new Error("compiled revision status is invalid");
}

const extensionModule = await import(
  pathToFileURL(join(root, "dist", "index.js")).href
);
if (typeof extensionModule.createMemoryExtension !== "function") {
  throw new Error("compiled extension entry is not loadable");
}

console.log(
  `pi-tidy-memory package smoke ok: version=${manifest.version} source=${sourceRevision} adapter=./index.ts`
);
