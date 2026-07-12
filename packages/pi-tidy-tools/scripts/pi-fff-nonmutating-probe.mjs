#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function packageRootForCli(cliPath) {
  let current = dirname(realpathSync(cliPath));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest?.name === "@earendil-works/pi-coding-agent")
        return { root: current, manifest, cli: realpathSync(cliPath) };
    }
    current = dirname(current);
  }
  return undefined;
}

function findInstalledPi() {
  const candidates = [];
  if (process.env.PI_TIDY_PI_CLI)
    candidates.push(resolve(process.env.PI_TIDY_PI_CLI));
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, "pi");
    if (existsSync(candidate)) candidates.push(candidate);
  }
  for (const candidate of [...new Set(candidates)]) {
    const found = packageRootForCli(candidate);
    if (!found) continue;
    const relative = found.root.startsWith(`${repoRoot}${sep}`);
    if (!relative || process.env.PI_TIDY_PI_CLI) return found;
  }
  throw new Error(
    "Actual installed Pi CLI not found; set PI_TIDY_PI_CLI to its executable path"
  );
}

const { root: piRoot, manifest: piManifest, cli: piCli } = findInstalledPi();
const codingExport = piManifest?.exports?.["."]?.import;
const codingTarget =
  typeof codingExport === "string" ? codingExport : codingExport?.default;
if (typeof codingTarget !== "string")
  throw new Error("Installed Pi ESM export is unavailable");
const runningPi = await import(
  pathToFileURL(resolve(piRoot, codingTarget)).href
);
if (typeof runningPi.getAgentDir !== "function")
  throw new Error("Installed Pi getAgentDir is unavailable");
const agentDir = runningPi.getAgentDir();
const settingsPath = join(agentDir, "settings.json");
const before = await readFile(settingsPath);
const beforeStat = await stat(settingsPath);
const settings = JSON.parse(before.toString("utf8"));
const sourceOf = (entry) => (typeof entry === "string" ? entry : entry?.source);
const matches = (settings.packages ?? []).filter((entry) =>
  /^npm:(?:pi-fff|@ff-labs\/pi-fff)(?:@.+)?$/.test(sourceOf(entry) ?? "")
);
if (matches.length !== 1)
  throw new Error(
    `Expected exactly one user pi-fff identity, found ${matches.length}`
  );
const source = sourceOf(matches[0]);

const piRequire = createRequire(join(piRoot, "package.json"));
const tui = piRequire.resolve("@earendil-works/pi-tui");
const typebox = piRequire.resolve("typebox");
const aliases = {
  "@earendil-works/pi-coding-agent": resolve(piRoot, codingTarget),
  "@mariozechner/pi-coding-agent": resolve(piRoot, codingTarget),
  "@earendil-works/pi-tui": tui,
  "@mariozechner/pi-tui": tui,
  "@sinclair/typebox": typebox,
  "typebox/compile": piRequire.resolve("typebox/compile"),
  "@sinclair/typebox/compile": piRequire.resolve("typebox/compile"),
  "typebox/value": piRequire.resolve("typebox/value"),
  "@sinclair/typebox/value": piRequire.resolve("typebox/value"),
};
const jitiManifestPath = piRequire.resolve("jiti/package.json");
const jitiManifest = JSON.parse(await readFile(jitiManifestPath, "utf8"));
const staticExport = jitiManifest?.exports?.["./static"]?.import;
const staticTarget =
  typeof staticExport === "string" ? staticExport : staticExport?.default;
if (typeof staticTarget !== "string")
  throw new Error("Installed Pi Jiti static export is unavailable");
const { createJiti } = await import(
  pathToFileURL(resolve(dirname(jitiManifestPath), staticTarget)).href
);
const adapterPath = resolve(here, "../pi-fff/adapter.ts");
// Product loading identifies the concrete running Pi from argv[1]. Recreate
// that host boundary so adapter imports and transitive peers cannot fall back
// to the workspace's independently installed dependency tree.
process.argv[1] = piCli;
const { buildPiFffRegistrationPlan } = await createJiti(import.meta.url, {
  moduleCache: false,
  interopDefault: true,
  alias: aliases,
}).import(adapterPath);

const api = {
  events: { on() {}, emit() {} },
  getFlag() {
    return undefined;
  },
};
for (const method of [
  "registerTool",
  "registerCommand",
  "registerShortcut",
  "registerFlag",
  "registerMessageRenderer",
  "registerEntryRenderer",
  "registerProvider",
  "unregisterProvider",
  "on",
])
  api[method] = () => {
    throw new Error(`real registration escaped probe: ${method}`);
  };
for (const method of [
  "sendMessage",
  "sendUserMessage",
  "appendEntry",
  "setSessionName",
  "setLabel",
  "exec",
  "setActiveTools",
  "setModel",
  "setThinkingLevel",
  "shutdown",
  "abort",
  "compact",
])
  api[method] = () => {
    throw new Error(`mutation escaped probe: ${method}`);
  };
const built = await buildPiFffRegistrationPlan({
  cwd: process.cwd(),
  agentDir,
  api,
  selection: { scope: "user", entry: { source, extensions: [] } },
});
if (!built.ok)
  throw new Error(`${built.diagnostic.code}: ${built.diagnostic.detail}`);
const after = await readFile(settingsPath);
const afterStat = await stat(settingsPath);
if (
  !before.equals(after) ||
  beforeStat.mtimeMs !== afterStat.mtimeMs ||
  beforeStat.size !== afterStat.size ||
  beforeStat.ino !== afterStat.ino
)
  throw new Error("settings changed during nonmutating probe");
console.log(
  JSON.stringify(
    {
      ok: true,
      piInstallation: piRoot,
      piVersion: piManifest.version,
      source,
      packageIdentity: built.plan.packageIdentity,
      profile: built.plan.profile,
      version: built.plan.piFffVersion,
      status: built.plan.status,
      captureMode: built.plan.captureMode,
      registrations: built.plan.trace.map((call) =>
        call.method === "registerTool"
          ? `${call.method}:${call.args[0]?.name}`
          : `${call.method}:${String(call.args[0])}`
      ),
      settingsUnchanged: true,
    },
    null,
    2
  )
);
