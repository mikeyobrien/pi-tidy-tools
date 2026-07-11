import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PiFffLoaderAliases {
	codingAgent: string;
	tui: string;
	typebox: string;
	sinclairTypebox: string;
	readonly [specifier: string]: string;
}

export interface PiFffModuleLoader {
	load(entryPath: string, aliases: PiFffLoaderAliases): Promise<unknown>;
}

function findPackageRoot(entry: string): string {
	let current = dirname(entry);
	while (current !== dirname(current)) {
		if (existsSync(join(current, "package.json"))) return current;
		current = dirname(current);
	}
	throw new Error("running Pi package root is unavailable");
}

/** Resolve aliases from the concrete Pi installation that loaded tidy. */
export function resolveRunningPiAliases(): { aliases: PiFffLoaderAliases; jitiEntry: string } {
	let piRoot: string | undefined;
	try {
		const candidate = findPackageRoot(resolve(process.argv[1] ?? ""));
		const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		if (manifest?.name === "@earendil-works/pi-coding-agent") piRoot = candidate;
	} catch {
		// Tests and SDK hosts may not have Pi as argv[1]; use normal ESM identity.
	}
	const resolvedCodingAgent = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	piRoot ??= findPackageRoot(resolvedCodingAgent);
	const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
	const codingExport = piManifest?.exports?.["."]?.import;
	const codingTarget = typeof codingExport === "string" ? codingExport : codingExport?.default;
	const codingAgent = typeof codingTarget === "string" ? resolve(piRoot, codingTarget) : resolvedCodingAgent;
	const piRequire = createRequire(join(piRoot, "package.json"));
	const tui = piRequire.resolve("@earendil-works/pi-tui");
	const typebox = piRequire.resolve("typebox");
	const aliases: PiFffLoaderAliases = {
		codingAgent,
		tui,
		typebox,
		sinclairTypebox: typebox,
		"@earendil-works/pi-coding-agent": codingAgent,
		"@mariozechner/pi-coding-agent": codingAgent,
		"@earendil-works/pi-tui": tui,
		"@mariozechner/pi-tui": tui,
		"@sinclair/typebox": typebox,
		"typebox/compile": piRequire.resolve("typebox/compile"),
		"@sinclair/typebox/compile": piRequire.resolve("typebox/compile"),
		"typebox/value": piRequire.resolve("typebox/value"),
		"@sinclair/typebox/value": piRequire.resolve("typebox/value"),
	};
	const jitiManifestPath = piRequire.resolve("jiti/package.json");
	const jitiManifest = JSON.parse(readFileSync(jitiManifestPath, "utf8"));
	const staticExport = jitiManifest?.exports?.["./static"]?.import;
	const staticTarget = typeof staticExport === "string" ? staticExport : staticExport?.default;
	if (typeof staticTarget !== "string") throw new Error("running Pi Jiti static export is unavailable");
	return { aliases, jitiEntry: resolve(dirname(jitiManifestPath), staticTarget) };
}

/** Build an uncached loader using the running Pi installation's Jiti. */
export function createRunningPiFffLoader(): { loader: PiFffModuleLoader; aliases: PiFffLoaderAliases } {
	const { aliases, jitiEntry } = resolveRunningPiAliases();
	return {
		aliases,
		loader: {
			async load(entryPath, requestedAliases) {
				const loadedJiti = await import(pathToFileURL(jitiEntry).href) as { createJiti?: (...args: any[]) => any };
				if (typeof loadedJiti.createJiti !== "function") throw new Error("running Pi Jiti factory is unavailable");
				const jiti = loadedJiti.createJiti(import.meta.url, {
					moduleCache: false,
					interopDefault: true,
					alias: requestedAliases,
				});
				return jiti.import(entryPath, { default: true });
			},
		},
	};
}

export function readPackageVersionForEntry(entry: string): string {
	const root = findPackageRoot(resolve(entry));
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (typeof manifest.version !== "string") throw new Error("package version is unavailable");
	return manifest.version;
}
