import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "pi-tidy-pack-"));
const packages = ["@mobrienv/pi-tidy-tools", "@mobrienv/pi-tidy-subagents"];
try {
 for (const name of packages) {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--workspace", name, "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const tarball = join(temp, packed[0].filename);
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (!listing.includes("package/vendor/pi-tidy-core/index.ts")) throw new Error(`${name} omitted its bundled tidy core`);
  if (name === "@mobrienv/pi-tidy-tools") {
   for (const file of ["package/tool-composition.ts", "package/pi-fff/adapter.ts", "package/pi-fff/controller.ts", "package/pi-fff/integration.ts", "package/pi-fff/loader.ts"]) {
    if (!listing.includes(file)) throw new Error(`${name} omitted runtime file ${file}`);
   }
   if (listing.includes("prototype") || listing.includes("package/scripts/") || listing.includes("pi-fff-installed")) throw new Error(`${name} shipped test/prototype files`);
  }

  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (manifest.dependencies?.["@mobrienv/pi-tidy-core"]) throw new Error(`${name} leaked a private workspace dependency`);
  if (name === "@mobrienv/pi-tidy-tools") {
   if (!manifest.dependencies?.semver) throw new Error(`${name} omitted semver runtime dependency`);
   if (manifest.dependencies?.["pi-fff"] || manifest.peerDependencies?.["pi-fff"] || manifest.bundledDependencies?.includes("pi-fff")) throw new Error(`${name} must not depend on, peer, or bundle pi-fff`);
   for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    if (manifest.peerDependencies?.[peer] !== ">=0.80.6") throw new Error(`${name} peer ${peer} must have no upper bound`);
   }
  }

  const installDir = join(temp, name.split("/").at(-1));
  mkdirSync(installDir);
  writeFileSync(join(installDir, "package.json"), '{"private":true}\n');
  execFileSync("npm", ["install", tarball, "--ignore-scripts", "--omit=peer", "--package-lock=false", "--no-audit", "--no-fund"], { cwd: installDir, stdio: "pipe" });
  const installedCore = join(installDir, "node_modules", ...name.split("/"), "vendor", "pi-tidy-core", "index.ts");
  if (!readFileSync(installedCore, "utf8").includes("summarizeToolActivity")) throw new Error(`${name} installed without a usable tidy core`);
 }
} finally {
 rmSync(temp, { recursive: true, force: true });
}
