import assert from "node:assert/strict";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { composeSourceTool } from "../tool-composition.js";

const guideline = "Always explain the goal.";

test("native source composition preserves metadata and result-mode schema identity", () => {
	const source = createReadTool(process.cwd());
	const composed = composeSourceTool(source, { mode: "result", reasoningGuideline: guideline });

	assert.equal(composed.parameters, source.parameters);
	assert.equal(composed.name, source.name);
	assert.equal(composed.label, source.label);
	assert.equal(composed.description, source.description);
	assert.equal(composed.executionMode, source.executionMode);
	assert.equal(composed.prepareArguments, source.prepareArguments);
	assert.deepEqual(composed.promptGuidelines, []);
	assert.equal((source as any).promptGuidelines, undefined);
});

test("reasoning composition retains alternate metadata and prompt guidance", () => {
	const marker = Symbol("alternate metadata");
	const source = {
		name: "read",
		label: "alternate read",
		description: "Reads through an alternate source.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, alternate: { type: "boolean" } },
			required: ["path"],
		},
		promptSnippet: "Use alternate paths.",
		promptGuidelines: ["Keep alternate paths intact."],
		marker,
		execute() {},
	};
	const composed = composeSourceTool(source, { mode: "default", reasoningGuideline: guideline });

	assert.equal(composed.marker, marker);
	assert.equal(composed.promptSnippet, source.promptSnippet);
	assert.deepEqual(composed.promptGuidelines, [source.promptGuidelines[0], guideline]);
	assert.deepEqual(Object.keys(composed.parameters.properties), ["reasoning", "path", "alternate"]);
	assert.deepEqual(composed.parameters.required, ["reasoning", "path"]);
	assert.notEqual(composed.parameters, source.parameters);
});

test("composed execution preserves receiver and argument identities", async () => {
	const signal = new AbortController().signal;
	const update = () => {};
	const context = { cwd: "/alternate" };
	const result = { content: [{ type: "text", text: "alternate result" }], details: { source: true } };
	let observed: unknown[] = [];
	const source = {
		name: "grep",
		parameters: { type: "object", properties: {}, required: [] },
		execute(this: unknown, ...args: unknown[]) {
			observed = [this, ...args];
			return result;
		},
	};
	const composed = composeSourceTool(source, { mode: "default", reasoningGuideline: guideline });
	const params = { pattern: "needle", extra: { identity: true }, reasoning: "find alternate matches" };

	const actual = await composed.execute("call-1", params, signal, update, context);

	assert.equal(actual, result);
	assert.equal(observed[0], source);
	assert.equal(observed[1], "call-1");
	assert.deepEqual(observed[2], { pattern: "needle", extra: params.extra });
	assert.equal((observed[2] as typeof params).extra, params.extra);
	assert.equal(observed[3], signal);
	assert.equal(observed[4], update);
	assert.equal(observed[5], context);
});

test("result-mode execution passes the original parameter object", () => {
	const promptGuidelines = ["Preserve source guidance."];
	const params = { path: "alternate.ts" };
	let observedParams: unknown;
	const source = {
		name: "read",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		promptGuidelines,
		execute(_id: string, received: unknown) { observedParams = received; },
	};
	const composed = composeSourceTool(source, { mode: "result", reasoningGuideline: guideline });

	composed.execute("call-result", params, undefined, undefined, undefined);

	assert.equal(observedParams, params);
	assert.equal(composed.promptGuidelines, promptGuidelines);
});

test("composed execution propagates source errors unchanged", () => {
	const failure = new Error("alternate failure");
	const source = {
		name: "find",
		parameters: { type: "object", properties: {}, required: [] },
		execute() { throw failure; },
	};
	const composed = composeSourceTool(source, { mode: "result", reasoningGuideline: guideline });

	assert.throws(() => composed.execute("call-2", {}, undefined, undefined, undefined), (error) => error === failure);
});
