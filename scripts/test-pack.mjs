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

  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (manifest.dependencies?.["@mobrienv/pi-tidy-core"]) throw new Error(`${name} leaked a private workspace dependency`);

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
