import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import extension, { buildToolBlock, fitToolLine, formatElapsed } from "../index.js";

const execFileAsync = promisify(execFile);

interface Registrations {
	events: string[];
	commands: Map<string, any>;
	shortcuts: string[];
	renderers: string[];
	tools: string[];
}

function loadWith(value: string): Registrations {
	const registrations: Registrations = {
		events: [],
		commands: new Map(),
		shortcuts: [],
		renderers: [],
		tools: [],
	};
	const pi = {
		on: (name: string) => registrations.events.push(name),
		registerCommand: (name: string, options: any) => registrations.commands.set(name, options),
		registerShortcut: (name: string) => registrations.shortcuts.push(name),
		registerMessageRenderer: (name: string) => registrations.renderers.push(name),
		registerTool: (tool: any) => registrations.tools.push(tool.name),
	};
	const previous = process.env.PI_TIDY_TOOLS;
	process.env.PI_TIDY_TOOLS = value;
	try {
		extension(pi as any);
	} finally {
		if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
		else process.env.PI_TIDY_TOOLS = previous;
	}
	return registrations;
}

test("running tools show compact human-readable elapsed time", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(9_900), "9s");
	assert.equal(formatElapsed(64_000), "1m 04s");
	assert.equal(formatElapsed(3_720_000), "1h 02m");
	const block = buildToolBlock("bash", { command: "sleep 5", reasoning: "wait for service" }, {}, {
		isPartial: true,
		elapsedMs: 5_000,
	});
	assert.match(block[1].replace(/\x1b\[[0-9;]*m/g, ""), /→ 5s$/);
});

test("tool blocks support default reasoning and result layouts", () => {
	const args = { path: "index.ts", reasoning: "update the renderer" };
	const result = { content: [{ type: "text", text: "Successfully replaced text" }], details: { diff: "+new\n-old" } };
	const plain = (mode: "default" | "reasoning" | "result") => buildToolBlock("edit", args, result, { mode })
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const defaultBlock = plain("default");
	assert.equal(defaultBlock.length, 2);
	assert.match(defaultBlock[0], /update the renderer$/);
	assert.match(defaultBlock[1], /index\.ts → \+1\/-1$/);
	const reasoningBlock = plain("reasoning");
	assert.equal(reasoningBlock.length, 1);
	assert.match(reasoningBlock[0], /update the renderer → \+1\/-1$/);
	const resultBlock = plain("result");
	assert.equal(resultBlock.length, 1);
	assert.match(resultBlock[0], /index\.ts → \+1\/-1$/);
	assert.doesNotMatch(resultBlock[0], /update the renderer/);
});

test("expanded writes show numbered content instead of the generic success message", () => {
	const block = buildToolBlock("write", {
		path: "notes.txt",
		content: "alpha\nbeta\n",
		reasoning: "create notes",
	}, { content: [{ type: "text", text: "Successfully wrote 11 bytes to notes.txt" }] }, { expanded: true });
	const plain = block.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(plain[1], /notes\.txt → 2 lines$/);
	assert.match(plain[2], /1 alpha$/);
	assert.match(plain[3], /2 beta$/);
	assert.doesNotMatch(plain.slice(2).join("\n"), /Successfully wrote/);
});

test("expanded writes preserve trailing spaces, blank lines, and empty files", () => {
	const result = { content: [{ type: "text", text: "Successfully wrote file" }] };
	const spaced = buildToolBlock("write", {
		path: "space.txt",
		content: "alpha   \n\n",
		reasoning: "write spacing fixture",
	}, result, { expanded: true }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(spaced[2], /1 alpha   $/);
	assert.match(spaced[3], /2 $/);
	const empty = buildToolBlock("write", {
		path: "empty.txt",
		content: "",
		reasoning: "create empty fixture",
	}, result, { expanded: true }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(empty[2], /\(empty file\)$/);
});

test("diff is cleared after a turn without file changes", async () => {
	const events = new Map<string, (event?: any) => Promise<void>>();
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const previous = process.env.PI_TIDY_TOOLS;
	process.env.PI_TIDY_TOOLS = "on";
	try {
		extension({
			on: (name: string, handler: any) => events.set(name, handler),
			registerCommand: (name: string, options: any) => commands.set(name, options),
			registerShortcut() {}, registerMessageRenderer() {}, registerTool() {},
			sendMessage: (message: any) => messages.push(message),
		} as any);
	} finally {
		if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
		else process.env.PI_TIDY_TOOLS = previous;
	}
	await events.get("tool_execution_start")!({ toolName: "edit", toolCallId: "1", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ toolName: "edit", toolCallId: "1", isError: false, result: { details: { diff: "+a" } } });
	await events.get("turn_end")!();
	await commands.get("diff").handler("", { ui: { notify() {} } });
	assert.equal(messages.length, 1);
	await events.get("turn_end")!();
	const notices: string[] = [];
	await commands.get("diff").handler("", { ui: { notify: (message: string) => notices.push(message) } });
	assert.equal(messages.length, 1);
	assert.match(notices[0], /No file changes/);
});

test("grep summaries report matches and distinct files", () => {
	const result = {
		content: [{
			type: "text",
			text: "src/a.ts:2:first\nsrc/a.ts:8:second\nsrc/b.ts:4:third",
		}],
	};
	const block = buildToolBlock("grep", { pattern: "needle", path: "src", reasoning: "find usages" }, result);
	const plainSummary = block[1].replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plainSummary, /3 matches in 2 files/);
});

test("narrow grep lines always preserve the match and file summary", () => {
	const result = {
		content: [{
			type: "text",
			text: "src/a.ts:2:first\nsrc/a.ts:8:second\nsrc/b.ts:4:third",
		}],
	};
	const block = buildToolBlock("grep", {
		pattern: "an-extremely-long-pattern-that-will-not-fit",
		path: "an/extremely/long/search/path",
		reasoning: "find usages",
	}, result);
	const fitted = fitToolLine(block[1], 38).replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(fitted, /3 matches in 2 files$/);
});

test("disabled startup keeps only the tidy management command", () => {
	const registrations = loadWith("off");
	assert.deepEqual([...registrations.commands.keys()], ["tidy"]);
	assert.deepEqual(registrations.events, []);
	assert.deepEqual(registrations.shortcuts, []);
	assert.deepEqual(registrations.renderers, []);
	assert.deepEqual(registrations.tools, []);
});

test("enabled startup preserves every optional registration", () => {
	const registrations = loadWith("on");
	assert.deepEqual([...registrations.commands.keys()], ["tidy", "diff"]);
	assert.deepEqual(registrations.events, ["tool_execution_start", "tool_execution_end", "turn_end"]);
	assert.deepEqual(registrations.shortcuts, ["ctrl+shift+o"]);
	assert.deepEqual(registrations.renderers, ["minimal-turn-diff"]);
	assert.deepEqual(registrations.tools, ["read", "write", "edit", "bash", "grep", "find", "ls"]);
});

test("status reports an active environment override without reloading", async () => {
	const registrations = loadWith("off");
	const notices: string[] = [];
	let reloads = 0;
	await registrations.commands.get("tidy").handler("status", {
		ui: { notify: (message: string) => notices.push(message) },
		reload: async () => { reloads++; },
	});
	assert.match(notices[0], /off, mode default \(PI_TIDY_TOOLS override\)/);
	assert.equal(reloads, 0);
});

test("a successful state change persists and reloads exactly once", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-tidy-home-"));
	const script = `
		const { default: extension } = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
		const commands = new Map();
		const pi = {
			on() {}, registerShortcut() {}, registerMessageRenderer() {}, registerTool() {},
			registerCommand(name, options) { commands.set(name, options); }
		};
		extension(pi);
		let reloads = 0;
		await commands.get("tidy").handler("off", {
			ui: { notify() {} },
			reload: async () => { reloads++; }
		});
		console.log(reloads);
	`;
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	delete env.PI_TIDY_TOOLS;
	try {
		const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { env });
		assert.equal(stdout.trim(), "1");
		const saved = JSON.parse(await readFile(join(home, ".pi", "agent", "pi-tidy-tools.json"), "utf8"));
		assert.deepEqual(saved, { enabled: false });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
