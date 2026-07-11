import { createWriteTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TidyMode } from "./config.js";

export interface SourceToolDefinition {
	name: string;
	parameters: any;
	execute: (this: SourceToolDefinition, ...args: any[]) => any;
	promptGuidelines?: string[];
	[key: string]: any;
}

export interface SourceToolCompositionOptions {
	mode: TidyMode;
	reasoningGuideline: string;
}

export type ComposedSourceTool<T extends SourceToolDefinition> = Omit<T, "execute" | "parameters" | "promptGuidelines"> & {
	parameters: any;
	promptGuidelines: string[];
	execute: (id: string, params: any, signal: any, onUpdate: any, context: any) => any;
};

/** Clone a JSON-schema params object and inject a required, first reasoning prop. */
export function withReasoning(parameters: any): any {
	const reasoning = {
		type: "string",
		description:
			"Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. \"confirm executionStarted is a timestamp\", \"fix the map leak from review\", \"retry match after previous miss\".",
	};
	const properties = { reasoning, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["reasoning", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
}

/** Remove only tidy's injected field, retaining all other argument identities. */
export function stripReasoning(params: any): { reasoning?: string; rest: any } {
	if (!params || typeof params !== "object" || !Object.hasOwn(params, "reasoning")) return { rest: params };
	const { reasoning, ...rest } = params;
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}

/**
 * Compose tidy's mode-specific schema and executor around a behavior-bearing
 * source definition. Unknown metadata is deliberately carried through.
 */
export function composeSourceTool<T extends SourceToolDefinition>(
	source: T,
	options: SourceToolCompositionOptions,
): ComposedSourceTool<T> {
	const resultMode = options.mode === "result";
	return {
		...source,
		parameters: resultMode ? source.parameters : withReasoning(source.parameters),
		promptGuidelines: resultMode
			? source.promptGuidelines ?? []
			: [...(source.promptGuidelines ?? []), options.reasoningGuideline],
		execute(this: SourceToolDefinition, id: string, params: any, signal: any, onUpdate: any, context: any) {
			const { rest } = stripReasoning(params);
			return source.execute.call(source, id, rest, signal, onUpdate, context);
		},
	} as ComposedSourceTool<T>;
}

/** Native write source with tidy's behavior-compatible per-call diff capture. */
export function createDiffingWriteTool(cwd: string): SourceToolDefinition {
	const source = createWriteTool(cwd) as SourceToolDefinition;
	return {
		...source,
		async execute(_id: string, params: any, signal: any, onUpdate: any, context: any) {
			let diff = "";
			const writeTool = createWriteTool(cwd, {
				operations: {
					mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }); },
					writeFile: async (path: string, content: string) => {
						let previous = "";
						try {
							previous = await readFile(path, "utf8");
						} catch (error: any) {
							if (error?.code !== "ENOENT") throw error;
						}
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, content, "utf8");
						diff = generateDiffString(previous, content).diff;
					},
				},
			});
			const result = await (writeTool.execute as (...args: any[]) => any).call(
				writeTool,
				_id,
				params,
				signal,
				onUpdate,
				context,
			);
			return { ...result, details: { ...(result.details ?? {}), diff } };
		},
	};
}
