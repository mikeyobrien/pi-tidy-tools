#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const agentDir = getAgentDir();
const settingsPath = join(agentDir, "settings.json");
const before = await readFile(settingsPath);
const beforeStat = await stat(settingsPath);
const settings = JSON.parse(before.toString("utf8"));
const sourceOf = (entry) => typeof entry === "string" ? entry : entry?.source;
const matches = (settings.packages ?? []).filter((entry) => /^npm:(?:pi-fff|@ff-labs\/pi-fff)(?:@.+)?$/.test(sourceOf(entry) ?? ""));
if (matches.length !== 1) throw new Error(`Expected exactly one user pi-fff identity, found ${matches.length}`);
const source = sourceOf(matches[0]);

const require = createRequire(import.meta.url);
let piRoot = dirname(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname);
while (true) {
	try { await stat(join(piRoot, "package.json")); break; } catch { piRoot = dirname(piRoot); }
}
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(piRequire.resolve("jiti")).href);
const adapterPath = resolve(dirname(new URL(import.meta.url).pathname), "../pi-fff/adapter.ts");
const { buildPiFffRegistrationPlan } = await createJiti(import.meta.url, { moduleCache: false, interopDefault: true }).import(adapterPath);

const api = { events: { on() {}, emit() {} }, getFlag() { return undefined; } };
for (const method of ["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider", "unregisterProvider", "on"]) api[method] = () => { throw new Error(`real registration escaped probe: ${method}`); };
for (const method of ["sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "setLabel", "exec", "setActiveTools", "setModel", "setThinkingLevel", "shutdown", "abort", "compact"]) api[method] = () => { throw new Error(`mutation escaped probe: ${method}`); };
const built = await buildPiFffRegistrationPlan({
	cwd: process.cwd(), agentDir, api,
	selection: { scope: "user", entry: { source, extensions: [] } },
});
if (!built.ok) throw new Error(`${built.diagnostic.code}: ${built.diagnostic.detail}`);
const after = await readFile(settingsPath);
const afterStat = await stat(settingsPath);
if (!before.equals(after) || beforeStat.mtimeMs !== afterStat.mtimeMs || beforeStat.size !== afterStat.size || beforeStat.ino !== afterStat.ino) throw new Error("settings changed during nonmutating probe");
console.log(JSON.stringify({
	ok: true, source, packageIdentity: built.plan.packageIdentity, profile: built.plan.profile,
	version: built.plan.piFffVersion, status: built.plan.status, captureMode: built.plan.captureMode,
	registrations: built.plan.trace.map((call) => call.method === "registerTool" ? `${call.method}:${call.args[0]?.name}` : `${call.method}:${String(call.args[0])}`),
	settingsUnchanged: true,
}, null, 2));
