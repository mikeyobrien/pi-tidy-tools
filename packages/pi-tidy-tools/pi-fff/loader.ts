import { existsSync, readFileSync, realpathSync } from "node:fs";
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

export interface ResolveRunningPiAliasesOptions {
	/** Bare-specifier resolution used only when the live process entry is not Pi itself; hermetic tests stub bundled runtimes. */
	readonly resolveModule?: (specifier: string) => string;
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const defaultResolveModule = (specifier: string): string => import.meta.resolve(specifier);

function findPackageRoot(entry: string): string {
	let current = dirname(entry);
	while (current !== dirname(current)) {
		if (existsSync(join(current, "package.json"))) return current;
		current = dirname(current);
	}
	throw new Error("running Pi package root is unavailable");
}

function readManifestAt(root: string): any {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function piRootFromEntry(entry: string): string | undefined {
	try {
		const candidate = findPackageRoot(entry);
		return readManifestAt(candidate)?.name === PI_PACKAGE_NAME ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function piRootFromProcessEntry(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	// npm links the Pi CLI bin outside the package tree; probe both the link and its target.
	for (const candidate of [resolve(entry), safeRealpath(resolve(entry))]) {
		const root = piRootFromEntry(candidate);
		if (root) return root;
	}
	return undefined;
}

/** Resolve aliases from the concrete Pi installation that loaded tidy. */
export function resolveRunningPiAliases(options: ResolveRunningPiAliasesOptions = {}): { aliases: PiFffLoaderAliases; jitiEntry: string } {
	let piRoot = piRootFromProcessEntry();
	let resolvedCodingAgent: string | undefined;
	if (!piRoot) {
		// Tests and SDK hosts may not have Pi as argv[1]; use normal ESM identity.
		// Bundled Pi runtimes (0.84.3+) resolve no bare specifier from tidy's own directory.
		try {
			resolvedCodingAgent = fileURLToPath((options.resolveModule ?? defaultResolveModule)(PI_PACKAGE_NAME));
			piRoot = piRootFromEntry(resolvedCodingAgent);
		} catch {
			// Unresolvable from this directory; the fail-closed check below reports it.
		}
	}
	if (!piRoot) throw new Error(`running Pi package root is unavailable: ${PI_PACKAGE_NAME} was not reachable from the process entry or module resolution`);
	const piManifest = readManifestAt(piRoot);
	const codingExport = piManifest?.exports?.["."]?.import;
	const codingTarget = typeof codingExport === "string" ? codingExport : codingExport?.default;
	const codingFallback = resolvedCodingAgent
		?? (typeof piManifest?.main === "string" ? resolve(piRoot, piManifest.main) : join(piRoot, "index.js"));
	const codingAgent = typeof codingTarget === "string" ? resolve(piRoot, codingTarget) : codingFallback;
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
export function createRunningPiFffLoader(options: ResolveRunningPiAliasesOptions = {}): { loader: PiFffModuleLoader; aliases: PiFffLoaderAliases } {
	const { aliases, jitiEntry } = resolveRunningPiAliases(options);
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
