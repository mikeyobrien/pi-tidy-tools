import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TidyMode } from "./config.js";
import { hostGenerateDiffString } from "./host-diff.js";
import { REASONING_PROPERTY, declaredSchema } from "./params-schema.js";
import { rawSchema } from "./schema-compat.js";

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

export type ComposedSourceTool<T extends SourceToolDefinition> = Omit<T, "execute" | "parameters"> & {
	parameters: any;
	promptGuidelines?: string[];
	execute: (id: string, params: any, signal: any, onUpdate: any, context: any) => any;
};

/**
 * Clone a JSON-schema params object and inject a required, first reasoning prop.
 *
 * Uses the host's real schema when it exposes a readable one. Where the host
 * exposes no readable schema — an opaque `parameters` value — tidy declares the
 * tool's argument set itself, because without a declared `reasoning` field the
 * model is never asked for one and the goal headline is silently absent.
 *
 * A tool tidy does not know gets a reasoning-only schema: the field is still
 * requested, and no argument names are invented that could conflict with the
 * host's real ones.
 */
export function withReasoning(parameters: any, name = "tool"): any {
	const schema = rawSchema(parameters);
	if (schema !== undefined) {
		const properties = { reasoning: REASONING_PROPERTY, ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
		const required = Array.from(new Set(["reasoning", ...((schema.required as string[] | undefined) ?? [])]));
		return { ...schema, properties, required };
	}
	const declared = declaredSchema(name, true);
	if (declared !== undefined) return declared;
	// Unknown tool: request reasoning without guessing at its arguments.
	return { properties: { reasoning: REASONING_PROPERTY }, required: ["reasoning"] };
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
	const sourceSchema = rawSchema(source.parameters);
	const sourceHasReasoning = sourceSchema !== undefined
		&& Object.hasOwn((sourceSchema.properties as Record<string, unknown> | undefined) ?? {}, "reasoning");
	if (!resultMode && sourceHasReasoning) {
		throw new Error(`${source.name} source schema reserves tidy-owned reasoning`);
	}
	const injectReasoning = !resultMode;
	const composed = {
		...source,
		parameters: injectReasoning ? withReasoning(source.parameters, source.name) : source.parameters,
		execute(this: SourceToolDefinition, id: string, params: any, signal: any, onUpdate: any, context: any) {
			const delegatedParams = injectReasoning ? stripReasoning(params).rest : params;
			return source.execute.call(source, id, delegatedParams, signal, onUpdate, context);
		},
	} as ComposedSourceTool<T>;
	if (!resultMode) composed.promptGuidelines = [...(source.promptGuidelines ?? []), options.reasoningGuideline];
	return composed;
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
						diff = hostGenerateDiffString(previous, content).diff;
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
