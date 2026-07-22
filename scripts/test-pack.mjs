import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "pi-tidy-pack-"));
const packages = [
  { name: "@mobrienv/pi-tidy-tools", dir: "packages/pi-tidy-tools" },
  { name: "@mobrienv/pi-tidy-subagents", dir: "packages/pi-tidy-subagents" },
  { name: "@mobrienv/pi-tidy-memory", dir: "packages/pi-tidy-memory" },
  { name: "@mobrienv/pi-tidy-footer", dir: "packages/pi-tidy-footer" },
];

function readmeRelativeDocs(packageDir) {
  const readme = readFileSync(join(root, packageDir, "README.md"), "utf8");
  const docs = new Set();
  for (const match of readme.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].split("#")[0].split("?")[0];
    if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith("mailto:"))
      continue;
    const resolved = normalize(join(packageDir, href));
    const rel = relative(packageDir, resolved);
    if (rel.startsWith("..") || !rel.endsWith(".md")) continue;
    docs.add(rel.replaceAll("\\", "/"));
  }
  return [...docs].sort();
}

try {
  for (const { name, dir } of packages) {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--workspace", name, "--json", "--pack-destination", temp],
        { cwd: root, encoding: "utf8" }
      )
    );
    const tarball = join(temp, packed[0].filename);
    const listing = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8",
    });
    if (!listing.includes("package/vendor/pi-tidy-core/index.ts"))
      throw new Error(`${name} omitted its bundled tidy core`);
    if (name === "@mobrienv/pi-tidy-tools") {
      for (const file of [
        "package/tool-composition.ts",
        "package/pi-fff/adapter.ts",
        "package/pi-fff/controller.ts",
        "package/pi-fff/integration.ts",
        "package/pi-fff/loader.ts",
      ]) {
        if (!listing.includes(file))
          throw new Error(`${name} omitted runtime file ${file}`);
      }
      if (
        listing.includes("prototype") ||
        listing.includes("package/scripts/") ||
        listing.includes("pi-fff-installed")
      )
        throw new Error(`${name} shipped test/prototype files`);
    }
    if (name === "@mobrienv/pi-tidy-memory") {
      for (const file of [
        "package/types.ts",
        "package/runtime.ts",
        "package/revision.ts",
        "package/source-revision.json",
        "package/backends/hindsight.ts",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/revision.js",
        "package/scripts/smoke.mjs",
      ]) {
        if (!listing.includes(file))
          throw new Error(`${name} omitted runtime file ${file}`);
      }
      if (listing.includes("package/test/") || listing.includes("homelab.env"))
        throw new Error(`${name} shipped tests or credentials`);
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m=await import(${JSON.stringify(pathToFileURL(join(root, dir, "dist/index.js")).href)});if(typeof m.createMemoryExtension!=="function")process.exit(1)`,
        ],
        { cwd: root, stdio: "pipe" }
      );
    }
    if (name === "@mobrienv/pi-tidy-footer") {
      for (const file of [
        "package/types.ts",
        "package/layout.ts",
        "package/codexbar.ts",
        "package/dist/index.js",
        "package/dist/index.d.ts",
      ]) {
        if (!listing.includes(file))
          throw new Error(`${name} omitted runtime file ${file}`);
      }
      if (listing.includes("package/test/"))
        throw new Error(`${name} shipped tests`);
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m=await import(${JSON.stringify(pathToFileURL(join(root, dir, "dist/index.js")).href)});if(typeof m.createFooterExtension!=="function")process.exit(1)`,
        ],
        { cwd: root, stdio: "pipe" }
      );
    }

    for (const doc of readmeRelativeDocs(dir)) {
      if (!listing.includes(`package/${doc}`))
        throw new Error(`${name} README links to ${doc}, but pack omitted it`);
    }

    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
        encoding: "utf8",
      })
    );
    if (manifest.dependencies?.["@mobrienv/pi-tidy-core"])
      throw new Error(`${name} leaked a private workspace dependency`);
    if (name === "@mobrienv/pi-tidy-tools") {
      if (!manifest.dependencies?.semver)
        throw new Error(`${name} omitted semver runtime dependency`);
      if (
        manifest.dependencies?.["pi-fff"] ||
        manifest.peerDependencies?.["pi-fff"] ||
        manifest.bundledDependencies?.includes("pi-fff")
      )
        throw new Error(`${name} must not depend on, peer, or bundle pi-fff`);
      for (const peer of [
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
      ]) {
        if (manifest.peerDependencies?.[peer] !== ">=0.80.6")
          throw new Error(`${name} peer ${peer} must have no upper bound`);
      }
    }

    const installDir = join(temp, name.split("/").at(-1));
    mkdirSync(installDir);
    writeFileSync(join(installDir, "package.json"), '{"private":true}\n');
    execFileSync(
      "npm",
      [
        "install",
        tarball,
        "--ignore-scripts",
        ...(name === "@mobrienv/pi-tidy-memory" ? [] : ["--omit=peer"]),
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installDir, stdio: "pipe" }
    );
    const installedCore = join(
      installDir,
      "node_modules",
      ...name.split("/"),
      "vendor",
      "pi-tidy-core",
      "index.ts"
    );
    if (!readFileSync(installedCore, "utf8").includes("summarizeToolActivity"))
      throw new Error(`${name} installed without a usable tidy core`);
    if (name === "@mobrienv/pi-tidy-memory") {
      execFileSync(
        "npm",
        [
          "run",
          "smoke",
          "--prefix",
          join(installDir, "node_modules", ...name.split("/")),
        ],
        {
          cwd: root,
          stdio: "pipe",
        }
      );

      const installedPackage = join(
        installDir,
        "node_modules",
        ...name.split("/")
      );
      const agentDir = join(installDir, "pi-agent");
      const rpc = spawnSync(
        join(installDir, "node_modules", ".bin", "pi"),
        [
          "--mode",
          "rpc",
          "--offline",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "-e",
          join(installedPackage, "index.ts"),
        ],
        {
          cwd: installDir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: join(installDir, "home"),
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
          },
          input: [
            JSON.stringify({ id: "commands", type: "get_commands" }),
            JSON.stringify({
              id: "status",
              type: "prompt",
              message: "/tidy-memory status",
            }),
            "",
          ].join("\n"),
          encoding: "utf8",
          timeout: 30_000,
        }
      );
      if (rpc.error) throw rpc.error;
      if (rpc.status !== 0)
        throw new Error(
          `${name} failed Pi RPC load (${rpc.status}): ${rpc.stderr}`
        );
      const messages = rpc.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const commands = messages.find(
        (message) => message.id === "commands" && message.success === true
      )?.data?.commands;
      if (
        !Array.isArray(commands) ||
        !commands.some(
          (command) =>
            command.name === "tidy-memory" && command.source === "extension"
        )
      )
        throw new Error(`${name} Pi RPC load omitted /tidy-memory`);
      const notice = messages.find(
        (message) =>
          message.type === "extension_ui_request" &&
          message.method === "notify" &&
          message.message?.includes(`package=${name}@`) &&
          message.message?.includes("disabled (not configured)")
      );
      if (!notice)
        throw new Error(
          `${name} Pi RPC status omitted safe revision diagnostics`
        );
      if (
        !messages.some(
          (message) =>
            message.id === "status" &&
            message.command === "prompt" &&
            message.success === true
        )
      )
        throw new Error(`${name} Pi RPC /tidy-memory status did not complete`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
