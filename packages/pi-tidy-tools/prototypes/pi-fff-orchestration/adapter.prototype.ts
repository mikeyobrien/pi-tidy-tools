// PROTOTYPE — throw this adapter away after issue #10 is decided.
//
// Question: can pi-tidy-tools load an installed-but-filtered pi-fff package,
// capture its read/grep execution, forward the rest of its ExtensionAPI calls,
// and register one composite pair without a duplicate-registration failure?

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildToolBlock, withReasoning } from "../../index.ts";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const reportPath = process.env.PI_FFF_PROTOTYPE_REPORT;
const expectedMarker = process.env.PI_FFF_PROTOTYPE_MARKER ?? "PI_FFF_PROTOTYPE_MARKER";
const query = process.env.PI_FFF_PROTOTYPE_QUERY ?? "orchestration-marker";

const report: any = {
	prototype: true,
	scope: process.env.PI_FFF_PROTOTYPE_SCOPE,
	resolution: {},
	filter: {},
	registrations: { captured: [], forwarded: [], calls: [] },
	composites: [],
	startup: { settled: false },
	execution: { attempted: false },
};

function saveReport(): void {
	if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function findPackageRoot(modulePath: string): string {
	let current = dirname(modulePath);
	while (current !== dirname(current)) {
		const manifest = join(current, "package.json");
		if (existsSync(manifest)) return current;
		current = dirname(current);
	}
	throw new Error(`Could not find package root above ${modulePath}`);
}

function candidates(cwd: string): Array<{ scope: "project" | "user"; root: string }> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
	return [
		{ scope: "project", root: join(cwd, ".pi", "npm", "node_modules", "pi-fff") },
		{ scope: "user", root: join(agentDir, "npm", "node_modules", "pi-fff") },
	];
}

function stripReasoning(input: any): any {
	if (!input || typeof input !== "object") return input;
	const { reasoning: _reasoning, ...rest } = input;
	return rest;
}

function tidyComposite(name: string, tool: any): any {
	return {
		...tool,
		name,
		label: name,
		parameters: withReasoning(tool.parameters),
		promptGuidelines: [
			...(tool.promptGuidelines ?? []),
			`Always pass a reasoning phrase to ${name}: state the goal, not the file or pattern.`,
		],
		renderShell: "self",
		execute: (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) =>
			tool.execute(id, stripReasoning(params), signal, onUpdate, ctx),
		renderCall: (args: any, _theme: any, context: any) =>
			new Text(buildToolBlock(name, args ?? {}, {}, { isPartial: context?.isPartial ?? true }).join("\n"), 0, 0),
		renderResult: (result: any, options: any, _theme: any, context: any) =>
			new Text(buildToolBlock(name, context?.args ?? {}, result, {
				isError: context?.isError ?? false,
				isPartial: options?.isPartial ?? false,
				expanded: options?.expanded ?? false,
			}).join("\n"), 0, 0),
	};
}

export default async function piFffOrchestrationPrototype(pi: ExtensionAPI) {
	try {
		const expectedScope = process.env.PI_FFF_PROTOTYPE_SCOPE;
		const found = candidates(process.cwd()).find((candidate) => existsSync(join(candidate.root, "package.json")));
		if (!found) throw new Error("No installed pi-fff package found in project or user npm roots");

		const manifest = JSON.parse(readFileSync(join(found.root, "package.json"), "utf8"));
		report.resolution = {
			found: true,
			scope: found.scope,
			expectedScope,
			matchedExpectedScope: found.scope === expectedScope,
			packageRoot: found.root,
			version: manifest.version,
			entryExists: existsSync(join(found.root, "index.ts")),
		};

		const settingsPath = process.env.PI_FFF_PROTOTYPE_SETTINGS;
		const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
		const packageEntry = (settings.packages ?? []).find((entry: any) =>
			typeof entry === "object" && String(entry.source).startsWith("npm:pi-fff"));
		report.filter = {
			settingsPath,
			packagePresent: Boolean(packageEntry),
			extensions: packageEntry?.extensions,
			extensionFiltered: Array.isArray(packageEntry?.extensions) && packageEntry.extensions.length === 0,
		};

		const piEntry = realpathSync(process.argv[1]!);
		const piRoot = findPackageRoot(piEntry);
		const piRequire = createRequire(join(piRoot, "package.json"));
		const { createJiti } = piRequire("jiti") as { createJiti: (...args: any[]) => any };
		const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
		const loaded = await jiti.import(join(found.root, "index.ts"));
		const factory = (loaded as any).default ?? loaded;
		if (typeof factory !== "function") throw new Error("pi-fff default export is not a factory");

		const captured = new Map<string, any>();
		const registrationMethods = new Set([
			"registerTool", "registerCommand", "registerShortcut", "registerFlag",
			"registerMessageRenderer", "registerEntryRenderer", "registerProvider", "on",
		]);
		const proxy = new Proxy(pi as any, {
			get(target, property, receiver) {
				if (property === "registerTool") {
					return (tool: any) => {
						report.registrations.calls.push({ method: "registerTool", name: tool.name });
						if (tool.name === "read" || tool.name === "grep") {
							captured.set(tool.name, tool);
							report.registrations.captured.push(tool.name);
							return;
						}
						report.registrations.forwarded.push({ method: "registerTool", name: tool.name });
						return target.registerTool(tool);
					};
				}
				const value = Reflect.get(target, property, receiver);
				if (typeof property === "string" && registrationMethods.has(property) && typeof value === "function") {
					return (...args: any[]) => {
						const name = typeof args[0] === "string" ? args[0] : undefined;
						report.registrations.calls.push({ method: property, name });
						report.registrations.forwarded.push({ method: property, name });
						return value.apply(target, args);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		await factory(proxy);
		for (const name of ["read", "grep"]) {
			const tool = captured.get(name);
			if (!tool) throw new Error(`pi-fff did not register ${name}`);
			const composite = tidyComposite(name, tool);
			pi.registerTool(composite);
			report.composites.push({
				name,
				executeOwner: "pi-fff",
				schemaOwner: "pi-tidy-tools",
				renderOwner: "pi-tidy-tools",
				reasoningRequired: composite.parameters?.required?.includes("reasoning") ?? false,
			});
		}

		pi.on("session_start", async (_event, ctx) => {
			report.startup.activeTools = pi.getActiveTools();
			report.startup.allTools = pi.getAllTools().map((tool) => tool.name);
			report.startup.readCount = report.startup.allTools.filter((name: string) => name === "read").length;
			report.startup.grepCount = report.startup.allTools.filter((name: string) => name === "grep").length;
			report.execution.attempted = true;
			try {
				const read = captured.get("read");
				const result = await read.execute(
					"prototype-read",
					{ path: query },
					new AbortController().signal,
					undefined,
					ctx,
				);
				const text = result?.content?.find((item: any) => item?.type === "text")?.text ?? "";
				report.execution = {
					attempted: true,
					succeeded: text.includes(expectedMarker),
					query,
					resolvedMarker: text.includes(expectedMarker),
					resultPreview: String(text).split("\n").slice(0, 3).join("\n"),
				};
			} catch (error) {
				report.execution = { attempted: true, succeeded: false, error: error instanceof Error ? error.message : String(error) };
			}
			report.startup.settled = true;
			saveReport();
		});

		report.factoryLoaded = true;
		saveReport();
	} catch (error) {
		report.error = error instanceof Error ? error.stack ?? error.message : String(error);
		saveReport();
		throw error;
	}
}
