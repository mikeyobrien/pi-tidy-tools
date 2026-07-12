import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import extension, {
  buildToolBlock,
  buildTurnDiffBlock,
  fitToolLine,
  formatElapsed,
  withReasoning,
} from "../index.js";

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
    registerCommand: (name: string, options: any) =>
      registrations.commands.set(name, options),
    registerShortcut: (name: string) => registrations.shortcuts.push(name),
    registerMessageRenderer: (name: string) =>
      registrations.renderers.push(name),
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

interface ExtensionHarness {
  events: Map<string, (event?: any) => Promise<any>>;
  commands: Map<string, any>;
  shortcuts: Map<string, any>;
  renderers: Map<string, (message: any) => any>;
  tools: Map<string, any>;
  messages: any[];
}

function registerEnabledExtension(): ExtensionHarness {
  const harness: ExtensionHarness = {
    events: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
    renderers: new Map(),
    tools: new Map(),
    messages: [],
  };
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    extension({
      on: (name: string, handler: any) => harness.events.set(name, handler),
      registerCommand: (name: string, options: any) =>
        harness.commands.set(name, options),
      registerShortcut: (name: string, options: any) =>
        harness.shortcuts.set(name, options),
      registerMessageRenderer: (name: string, renderer: any) =>
        harness.renderers.set(name, renderer),
      registerTool: (tool: any) => harness.tools.set(tool.name, tool),
      sendMessage: (message: any) => harness.messages.push(message),
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  return harness;
}

const withoutAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m/g, "");
const renderedLines = (component: any, width = 200): string[] =>
  component.render(width).map((line: string) => withoutAnsi(line).trimEnd());

test("restored settled tools clear timers started during call hydration", () => {
  const tools = new Map<string, any>();
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    extension({
      on() {},
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  const originalSetInterval = globalThis.setInterval,
    originalClearInterval = globalThis.clearInterval;
  const timer = { unref() {} };
  let cleared = false;
  globalThis.setInterval = (() => timer) as any;
  globalThis.clearInterval = ((value: unknown) => {
    if (value === timer) cleared = true;
  }) as any;
  try {
    const bash = tools.get("bash");
    const args = {
      command: "echo restored",
      reasoning: "check restored output",
    };
    const context = {
      isPartial: true,
      toolCallId: "restored",
      invalidate() {},
      state: {},
      args,
    };
    const theme = { bg: (_name: string, text: string) => text };
    bash.renderCall(args, theme, context);
    bash.renderResult(
      { content: [{ type: "text", text: "done" }] },
      { isPartial: false, expanded: false },
      theme,
      { ...context, isPartial: false, isError: false }
    );
    assert.equal(cleared, true);
    const restored = bash.renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          piTidyElapsedMs: 7_000,
          piTidyCompletedAt: Date.now() - 3_780_000,
        },
      },
      { isPartial: false, expanded: false },
      theme,
      { ...context, toolCallId: "reloaded", isPartial: false, isError: false }
    );
    assert.match(
      restored
        .render(200)
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, ""),
      /done in 7s/
    );
    assert.match(
      restored
        .render(200)
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, ""),
      /\(1h3m ago\)/
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("tool results persist elapsed duration for reload", async () => {
  const handlers = new Map<string, (event: any) => Promise<any>>();
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    extension({
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool() {},
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    await handlers.get("tool_execution_start")!({
      toolName: "bash",
      toolCallId: "duration",
      args: { command: "npm test" },
    });
    now = 8_000;
    const patch = await handlers.get("tool_result")!({
      toolName: "bash",
      toolCallId: "duration",
      details: { existing: true },
    });
    assert.deepEqual(patch.details, {
      existing: true,
      piTidyElapsedMs: 7_000,
      piTidyCompletedAt: 8_000,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("reasoning is the first schema field so it streams before large arguments", () => {
  const schema = withReasoning({
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  });
  assert.deepEqual(Object.keys(schema.properties), [
    "reasoning",
    "path",
    "content",
  ]);
  assert.deepEqual(schema.required, ["reasoning", "path", "content"]);
});

test("running tools show compact human-readable elapsed time", () => {
  assert.equal(formatElapsed(0), "<1s");
  assert.equal(formatElapsed(9_900), "9s");
  assert.equal(formatElapsed(64_000), "1m 04s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  const block = buildToolBlock(
    "bash",
    { command: "sleep 5", reasoning: "wait for service" },
    {},
    {
      isPartial: true,
      elapsedMs: 5_000,
    }
  );
  assert.match(block[1].replace(/\x1b\[[0-9;]*m/g, ""), /→ 5s$/);
});

test("failed bash summaries retain the command and report duration", () => {
  const block = buildToolBlock(
    "bash",
    { command: "npm test", reasoning: "run the suite" },
    { content: [{ type: "text", text: "Command failed with exit code 1" }] },
    { isError: true, elapsedMs: 2_100 }
  );
  const plain = block.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(plain[1], /npm test → error in 2s$/);
});

test("settled bash summaries report duration instead of output line count", () => {
  const block = buildToolBlock(
    "bash",
    {
      command: "printf 'one\\ntwo\\n'",
      reasoning: "run fixture",
    },
    { content: [{ type: "text", text: "one\ntwo" }] },
    { elapsedMs: 2_400 }
  );
  const plain = block[1].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /done in 2s$/);
  assert.doesNotMatch(plain, /lines/);
});

test("tool blocks support default reasoning and result layouts with durable ages", () => {
  const args = { path: "index.ts", reasoning: "update the renderer" };
  const result = {
    content: [{ type: "text", text: "Successfully replaced text" }],
    details: { diff: "+new\n-old" },
  };
  const plain = (mode: "default" | "reasoning" | "result") =>
    buildToolBlock("edit", args, result, {
      mode,
      completedAt: 1_000,
      now: 3_781_000,
    }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const defaultBlock = plain("default");
  assert.equal(defaultBlock.length, 2);
  assert.match(defaultBlock[0], /update the renderer \(1h3m ago\)$/);
  assert.match(defaultBlock[1], /index\.ts → \+1\/-1$/);
  const reasoningBlock = plain("reasoning");
  assert.equal(reasoningBlock.length, 1);
  assert.match(reasoningBlock[0], /update the renderer \(1h3m ago\) → \+1\/-1$/);
  const resultBlock = plain("result");
  assert.equal(resultBlock.length, 1);
  assert.match(resultBlock[0], /index\.ts \(1h3m ago\) → \+1\/-1$/);
  assert.doesNotMatch(resultBlock[0], /update the renderer/);
});

test("tool ages stay compact from fresh output through old sessions", () => {
  const plainAge = (ageMs: number) =>
    buildToolBlock(
      "read",
      { path: "a.ts", reasoning: "inspect fixture" },
      { content: [{ type: "text", text: "one" }] },
      { completedAt: 10_000, now: 10_000 + ageMs }
    )[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plainAge(0), /\(<1m ago\)$/);
  assert.match(plainAge(59 * 60_000), /\(59m ago\)$/);
  assert.match(plainAge((24 + 2) * 60 * 60_000), /\(1d2h ago\)$/);
  assert.match(plainAge((365 + 60) * 24 * 60 * 60_000), /\(1y2mo ago\)$/);
  const legacy = buildToolBlock(
    "read",
    { path: "a.ts", reasoning: "inspect fixture" },
    { content: [{ type: "text", text: "one" }] }
  )[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(legacy, / ago\)/);
});

test("expanded writes show numbered content instead of the generic success message", () => {
  const block = buildToolBlock(
    "write",
    {
      path: "notes.txt",
      content: "alpha\nbeta\n",
      reasoning: "create notes",
    },
    {
      content: [
        { type: "text", text: "Successfully wrote 11 bytes to notes.txt" },
      ],
    },
    { expanded: true }
  );
  const plain = block.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(plain[1], /notes\.txt → 2 lines$/);
  assert.match(plain[2], /1 alpha$/);
  assert.match(plain[3], /2 beta$/);
  assert.doesNotMatch(plain.slice(2).join("\n"), /Successfully wrote/);
});

test("expanded writes preserve trailing spaces, blank lines, and empty files", () => {
  const result = {
    content: [{ type: "text", text: "Successfully wrote file" }],
  };
  const spaced = buildToolBlock(
    "write",
    {
      path: "space.txt",
      content: "alpha   \n\n",
      reasoning: "write spacing fixture",
    },
    result,
    { expanded: true }
  ).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(spaced[2], /1 alpha   $/);
  assert.match(spaced[3], /2 $/);
  const empty = buildToolBlock(
    "write",
    {
      path: "empty.txt",
      content: "",
      reasoning: "create empty fixture",
    },
    result,
    { expanded: true }
  ).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(empty[2], /\(empty file\)$/);
});

test("expanded write and edit use code-relative tab stops without losing whitespace", () => {
  const plain = (lines: string[]) =>
    lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const write = plain(
    buildToolBlock(
      "write",
      {
        path: "tabs.ts",
        content: "\talpha  \n \tbeta\n\n  \n        gamma\n\t  delta\n",
        reasoning: "write whitespace fixture",
      },
      { content: [{ type: "text", text: "Successfully wrote file" }] },
      { expanded: true }
    )
  );
  const edit = plain(
    buildToolBlock(
      "edit",
      {
        path: "tabs.ts",
        reasoning: "edit whitespace fixture",
      },
      {
        content: [{ type: "text", text: "Successfully replaced text" }],
        details: {
          diff: "  1 \talpha  \n  2  \tbeta\n  3 \n  4   \n- 5 \told\n+ 5 \tnew\n  6         gamma",
        },
      },
      { expanded: true }
    )
  );

  assert.doesNotMatch(write.join("\n"), /\t/);
  assert.doesNotMatch(edit.join("\n"), /\t/);
  assert.ok(write[2].endsWith(`1 ${" ".repeat(8)}alpha  `));
  assert.ok(write[3].endsWith(`2 ${" ".repeat(8)}beta`));
  assert.ok(write[4].endsWith("3 "));
  assert.ok(write[5].endsWith("4   "));
  assert.ok(write[6].endsWith(`5 ${" ".repeat(8)}gamma`));
  assert.ok(write[7].endsWith(`6 ${" ".repeat(10)}delta`));
  assert.ok(edit[2].endsWith(`  1 ${" ".repeat(8)}alpha  `));
  assert.ok(edit[3].endsWith(`  2 ${" ".repeat(8)}beta`));
  assert.ok(edit[4].endsWith("  3 "));
  assert.ok(edit[5].endsWith("  4   "));
  assert.ok(edit[6].endsWith(`- 5 ${" ".repeat(8)}old`));
  assert.ok(edit[7].endsWith(`+ 5 ${" ".repeat(8)}new`));
  assert.ok(edit[8].endsWith(`  6 ${" ".repeat(8)}gamma`));
});

test("write execution returns diffs for new files and overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tidy-write-diff-"));
  const target = join(root, "new.txt");
  const tools = new Map<string, any>();
  const previous = process.env.PI_TIDY_TOOLS;
  process.env.PI_TIDY_TOOLS = "on";
  try {
    extension({
      on() {},
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
    const write = tools.get("write");
    const created = await write.execute("create", {
      path: target,
      content: "alpha\n",
      reasoning: "create fixture",
    });
    assert.match(created.details.diff, /\+1 alpha/);
    const overwritten = await write.execute("overwrite", {
      path: target,
      content: "beta\n",
      reasoning: "replace fixture",
    });
    assert.match(overwritten.details.diff, /-1 alpha/);
    assert.match(overwritten.details.diff, /\+1 beta/);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
    await rm(root, { recursive: true, force: true });
  }
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
      registerCommand: (name: string, options: any) =>
        commands.set(name, options),
      registerShortcut() {},
      registerMessageRenderer() {},
      registerTool() {},
      sendMessage: (message: any) => messages.push(message),
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_TOOLS;
    else process.env.PI_TIDY_TOOLS = previous;
  }
  await events.get("tool_execution_start")!({
    toolName: "edit",
    toolCallId: "1",
    args: { path: "a.ts" },
  });
  await events.get("tool_execution_end")!({
    toolName: "edit",
    toolCallId: "1",
    isError: false,
    result: { details: { diff: "+a" } },
  });
  await events.get("turn_end")!();
  await commands.get("diff").handler("", { ui: { notify() {} } });
  assert.equal(messages.length, 1);
  await events.get("turn_end")!();
  const notices: string[] = [];
  await commands.get("diff").handler("", {
    ui: { notify: (message: string) => notices.push(message) },
  });
  assert.equal(messages.length, 1);
  assert.match(notices[0], /No file changes/);
});

test("grep summaries report matches and distinct files", () => {
  const result = {
    content: [
      {
        type: "text",
        text: "src/a.ts:2:first\nsrc/a.ts:8:second\nsrc/b.ts:4:third",
      },
    ],
  };
  const block = buildToolBlock(
    "grep",
    { pattern: "needle", path: "src", reasoning: "find usages" },
    result
  );
  const plainSummary = block[1].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plainSummary, /3 matches in 2 files/);
});

test("narrow grep lines always preserve the match and file summary", () => {
  const result = {
    content: [
      {
        type: "text",
        text: "src/a.ts:2:first\nsrc/a.ts:8:second\nsrc/b.ts:4:third",
      },
    ],
  };
  const block = buildToolBlock(
    "grep",
    {
      pattern: "an-extremely-long-pattern-that-will-not-fit",
      path: "an/extremely/long/search/path",
      reasoning: "find usages",
    },
    result
  );
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
  assert.deepEqual(registrations.events, [
    "tool_execution_start",
    "tool_execution_end",
    "tool_result",
    "turn_end",
  ]);
  assert.deepEqual(registrations.shortcuts, ["ctrl+shift+o"]);
  assert.deepEqual(registrations.renderers, ["minimal-turn-diff"]);
  assert.deepEqual(registrations.tools, [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
  ]);
});

test("status reports an active environment override without reloading", async () => {
  const registrations = loadWith("off");
  const notices: string[] = [];
  let reloads = 0;
  await registrations.commands.get("tidy").handler("status", {
    ui: { notify: (message: string) => notices.push(message) },
    reload: async () => {
      reloads++;
    },
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
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { env }
    );
    assert.equal(stdout.trim(), "1");
    const saved = JSON.parse(
      await readFile(join(home, ".pi", "agent", "pi-tidy-tools.json"), "utf8")
    );
    assert.deepEqual(saved, { enabled: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registered renderers summarize native result shapes for every owned tool", () => {
  const { tools } = registerEnabledExtension();
  const backgrounds: string[] = [];
  const theme = {
    bg: (name: string, text: string) => {
      backgrounds.push(name);
      return text;
    },
  };
  const render = (name: string, args: any, result: any, context: any = {}) =>
    renderedLines(
      tools.get(name).renderResult(result, {}, theme, { args, ...context })
    );

  assert.deepEqual(
    render(
      "read",
      { path: "a.ts", reasoning: "inspect source" },
      { output: "one\ntwo" }
    ),
    ["  ┊ ✓ 📖 read inspect source", "  ┊   a.ts → 2 lines"]
  );
  assert.deepEqual(
    render(
      "write",
      { path: "data.bin" },
      { output: "Successfully wrote 42 bytes" }
    ),
    ["  ┊ ✓ ✏️ write data.bin", "  ┊   data.bin → 42b"]
  );
  assert.deepEqual(
    render(
      "write",
      { path: "one.txt", content: "one" },
      { message: "written" }
    ),
    ["  ┊ ✓ ✏️ write one.txt", "  ┊   one.txt → 1 line"]
  );
  assert.deepEqual(
    render(
      "edit",
      { path: "a.ts", reasoning: "apply update" },
      { message: "ok" }
    ),
    ["  ┊ ✓ ✏️ edit apply update", "  ┊   a.ts → applied"]
  );
  assert.deepEqual(
    render(
      "edit",
      { path: "a.ts" },
      { isError: true, details: { error: "replacement missing" } }
    ),
    ["  ┊ ✗ ✏️ edit a.ts", "  ┊   a.ts → replacement missing"]
  );
  assert.deepEqual(
    render(
      "bash",
      { command: "exit 2" },
      {
        content: [{ type: "text", text: "Command failed with exit code: 2" }],
        details: { piTidyElapsedMs: 1_200 },
      }
    ),
    ["  ┊ ✓ ⚡ bash exit 2", "  ┊   exit 2 → exit 2 in 1s"]
  );
  assert.deepEqual(
    render(
      "grep",
      { pattern: "none" },
      {
        partialResult: {
          content: [{ type: "text", text: "No matches found" }],
        },
      }
    ),
    ["  ┊ ✓ 📖 grep none", "  ┊   none → 0 matches in 0 files"]
  );
  assert.deepEqual(
    render(
      "grep",
      { pattern: "one", path: "src" },
      {
        content: [{ type: "text", text: "src/a.ts:1:one" }],
      }
    ),
    ["  ┊ ✓ 📖 grep one in src", "  ┊   one in src → 1 match in 1 file"]
  );
  assert.deepEqual(
    render("find", { pattern: "*.ts" }, { message: "a.ts\nb.ts" }),
    ["  ┊ ✓ 📖 find *.ts", "  ┊   *.ts → 2 files"]
  );
  assert.deepEqual(
    render(
      "ls",
      { path: "missing" },
      { error: "not found" },
      { isError: true }
    ),
    ["  ┊ ✗ 📖 ls missing", "  ┊   missing → not found"]
  );
  assert.deepEqual(
    new Set(backgrounds),
    new Set(["toolSuccessBg", "toolErrorBg"])
  );
});

test("registered renderers expose expanded native details and empty partial slots", () => {
  const { tools } = registerEnabledExtension();
  const theme = { bg: (_name: string, text: string) => text };
  const bash = tools.get("bash");
  const partial = bash.renderResult({}, { isPartial: true }, theme, {});
  assert.deepEqual(partial.render(80), []);

  const expandedBash = renderedLines(
    bash.renderResult({ message: "first\nsecond" }, { expanded: true }, theme, {
      args: { command: "printf one\nprintf two", reasoning: "run commands" },
    })
  );
  assert.deepEqual(expandedBash, [
    "  ┊ ✓ ⚡ bash run commands",
    "  ┊   printf one printf two → done in <1s",
    "  ┊   $ printf one",
    "  ┊     printf two",
    "  ┊   first",
    "  ┊   second",
  ]);

  const expandedEdit = renderedLines(
    tools.get("edit").renderResult(
      {
        details: { diff: "@@ -1 +1 @@\n-old\n+new" },
        content: [{ type: "text", text: "changed" }],
      },
      { expanded: true },
      theme,
      { args: { path: "a.ts", reasoning: "change value" } }
    )
  );
  assert.deepEqual(expandedEdit, [
    "  ┊ ✓ ✏️ edit change value",
    "  ┊   a.ts → +1/-1",
    "  ┊   @@ -1 +1 @@",
    "  ┊   -old",
    "  ┊   +new",
  ]);

  const expandedWrite = renderedLines(
    tools
      .get("write")
      .renderResult({ message: "written" }, { expanded: true }, theme, {
        args: { path: "one.txt", content: "one", reasoning: "write value" },
      })
  );
  assert.deepEqual(expandedWrite, [
    "  ┊ ✓ ✏️ write write value",
    "  ┊   one.txt → 1 line",
    "  ┊   1 one",
  ]);
});

test("registered call and event lifecycle owns timers and turn-local diffs", async () => {
  const harness = registerEnabledExtension();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers: object[] = [];
  const cleared: object[] = [];
  globalThis.setInterval = (() => {
    const timer = { unref() {} };
    timers.push(timer);
    return timer;
  }) as any;
  globalThis.clearInterval = ((timer: object) => {
    cleared.push(timer);
  }) as any;
  const theme = { bg: (_name: string, text: string) => text };
  try {
    const bash = harness.tools.get("bash");
    assert.deepEqual(
      bash.renderCall({}, theme, { isPartial: false }).render(80),
      []
    );
    const context = { isPartial: true, toolCallId: "live", invalidate() {} };
    const live = bash.renderCall(
      { command: "sleep 1", reasoning: "wait briefly" },
      theme,
      context
    );
    assert.equal(timers.length, 1);
    assert.deepEqual(renderedLines(live), [
      "  ┊ · ⚡ bash wait briefly",
      "  ┊   sleep 1 → <1s",
    ]);
    bash.renderCall(
      { command: "sleep 1", reasoning: "wait briefly" },
      theme,
      context
    );
    assert.equal(timers.length, 1);
    await harness.events.get("tool_execution_end")!({
      toolName: "bash",
      toolCallId: "live",
    });
    assert.deepEqual(cleared, [timers[0]]);

    bash.renderCall({ command: "sleep 2" }, theme, {
      ...context,
      toolCallId: "aborted",
    });
    await harness.events.get("tool_execution_start")!({
      toolName: "edit",
      toolCallId: "failed",
      args: { path: "failed.ts" },
    });
    await harness.events.get("tool_execution_start")!({
      toolName: "edit",
      toolCallId: "failed",
      args: { path: "ignored.ts" },
    });
    await harness.events.get("tool_execution_end")!({
      toolName: "edit",
      toolCallId: "failed",
      isError: true,
    });
    await harness.events.get("tool_execution_end")!({
      toolName: "write",
      toolCallId: "unknown",
      isError: false,
      result: {},
    });
    await harness.events.get("tool_execution_start")!({
      toolName: "edit",
      toolCallId: "changed",
      args: { path: "changed.ts" },
    });
    await harness.events.get("tool_execution_end")!({
      toolName: "edit",
      toolCallId: "changed",
      isError: false,
      result: { details: { diff: "@@ -1 +1 @@\n-old\n+new" } },
    });
    assert.equal(
      await harness.events.get("tool_result")!({
        toolName: "foreign",
        toolCallId: "x",
      }),
      undefined
    );
    assert.equal(
      await harness.events.get("tool_result")!({
        toolName: "read",
        toolCallId: "missing",
      }),
      undefined
    );
    await harness.events.get("turn_end")!();
    assert.ok(cleared.includes(timers[1]));

    await harness.commands.get("diff").handler("", { ui: { notify() {} } });
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(
      {
        customType: harness.messages[0].customType,
        display: harness.messages[0].display,
        content: withoutAnsi(harness.messages[0].content),
        rows: harness.messages[0].details.rows.map(withoutAnsi),
      },
      {
        customType: "minimal-turn-diff",
        display: true,
        content:
          "◆ last turn diff (2 files)\n✏️ (unknown)\n(new file / full overwrite — no line diff)\n\n✏️ changed.ts\n@@ -1 +1 @@\n-old\n+new",
        rows: [
          "◆ last turn diff (2 files)",
          "✏️ (unknown)",
          "(new file / full overwrite — no line diff)",
          "",
          "✏️ changed.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
      }
    );
    await harness.shortcuts
      .get("ctrl+shift+o")
      .handler({ ui: { notify() {} } });
    assert.deepEqual(harness.messages[1], harness.messages[0]);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("registered message renderer fits stored and restored recap rows", () => {
  const renderer =
    registerEnabledExtension().renderers.get("minimal-turn-diff")!;
  const stored = renderer({
    details: {
      rows: ["a very long line without a summary", "long target → result"],
    },
  });
  const storedLines = renderedLines(stored, 12);
  assert.deepEqual(storedLines, ["a very long…", "lo… → result"]);
  const tiny = renderedLines(stored, 3);
  assert.equal(tiny[1], "→ …");
  const restored = renderer({ content: "first\nsecond" });
  assert.deepEqual(renderedLines(restored, 80), ["first", "second"]);
  assert.deepEqual(renderedLines(restored, 0), ["…", "…"]);
});

test("registered non-write execution strips reasoning before native delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tidy-read-"));
  const target = join(root, "fixture.txt");
  try {
    await writeFile(target, "alpha\nbeta\n", "utf8");
    const read = registerEnabledExtension().tools.get("read");
    const result = await read.execute("read", {
      path: target,
      reasoning: "inspect fixture",
    });
    assert.match(result.content[0].text, /alpha/);
    assert.doesNotMatch(result.content[0].text, /inspect fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result mode keeps native schemas and management commands preserve state", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-tidy-result-home-"));
  const configPath = join(home, ".pi", "agent", "pi-tidy-tools.json");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ enabled: true, mode: "result", sibling: "kept" }),
    "utf8"
  );
  const script = `
		const { default: extension } = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
		const commands = new Map(), tools = new Map(), notices = [];
		extension({
			on() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
			registerCommand(name, options) { commands.set(name, options); },
			registerTool(tool) { tools.set(tool.name, tool); }
		});
		let reloads = 0;
		const context = { ui: { notify(message) { notices.push(message); } }, reload: async () => { reloads++; } };
		await commands.get("tidy").handler("status", context);
		await commands.get("tidy").handler("nonsense", context);
		await commands.get("tidy").handler("on", context);
		await commands.get("tidy").handler("mode result", context);
		await commands.get("tidy").handler("mode default", context);
		await commands.get("tidy").handler("off", context);
		const read = tools.get("read");
		console.log(JSON.stringify({
			hasReasoning: Object.hasOwn(read.parameters.properties, "reasoning"),
			guidelines: read.promptGuidelines,
			notices,
			reloads
		}));
	`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.PI_TIDY_TOOLS;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { env }
    );
    const observed = JSON.parse(stdout.trim());
    assert.equal(observed.hasReasoning, false);
    assert.deepEqual(observed.guidelines, []);
    assert.equal(observed.reloads, 2);
    assert.ok(
      observed.notices.some((notice: string) => /mode result/.test(notice))
    );
    assert.ok(observed.notices.some((notice: string) => /Usage:/.test(notice)));
    assert.ok(
      observed.notices.some((notice: string) => /already on/.test(notice))
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved, {
      enabled: false,
      mode: "default",
      sibling: "kept",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("environment overrides reject persistent state changes", async () => {
  const registrations = loadWith("off");
  const notices: string[] = [];
  const context = {
    ui: { notify: (message: string) => notices.push(message) },
    reload: async () => assert.fail("must not reload"),
  };
  await registrations.commands.get("tidy").handler("wat", context);
  await registrations.commands.get("tidy").handler("on", context);
  assert.match(notices[0], /Usage:/);
  assert.match(notices[1], /overrides persistent settings/);
});

test("fitToolLine preserves exact content or the useful result tail", () => {
  assert.deepEqual(
    [
      fitToolLine("abcdef", 99),
      fitToolLine("abcdef", 4),
      fitToolLine("  long target   → result", 15),
      fitToolLine("head → verylongtail", 5),
      fitToolLine("head → result", 12),
      fitToolLine("→ result", 8),
      fitToolLine("head → result", 3),
    ].map(withoutAnsi),
    [
      "abcdef",
      "abc…",
      "  lon… → result",
      "→ ve…",
      "he… → result",
      "→ result",
      "→ …",
    ]
  );
});

test("formatElapsed renders exact boundary values", () => {
  assert.deepEqual(
    [
      0, 999, 1_000, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_720_000,
    ].map(formatElapsed),
    [
      "<1s",
      "<1s",
      "1s",
      "59s",
      "1m 00s",
      "1m 01s",
      "59m 59s",
      "1h 00m",
      "1h 02m",
    ]
  );
});

test("withReasoning clones schemas and prepends its exact required contract", () => {
  const parameters = {
    type: "object",
    title: "native schema",
    properties: { path: { type: "string" } },
    required: ["path", "reasoning", "path"],
  };
  const schema = withReasoning(parameters);
  assert.deepEqual(schema, {
    type: "object",
    title: "native schema",
    properties: {
      reasoning: {
        type: "string",
        description:
          'Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. "confirm executionStarted is a timestamp", "fix the map leak from review", "retry match after previous miss".',
      },
      path: { type: "string" },
    },
    required: ["reasoning", "path"],
  });
  assert.deepEqual(parameters.properties, { path: { type: "string" } });
  assert.deepEqual(withReasoning(undefined), {
    properties: {
      reasoning: {
        type: "string",
        description:
          'Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. "confirm executionStarted is a timestamp", "fix the map leak from review", "retry match after previous miss".',
      },
    },
    required: ["reasoning"],
  });
});

test("buildToolBlock renders exact collapsed summaries across native shapes", () => {
  const plain = (
    name: string,
    args: Record<string, unknown>,
    result: any,
    opts: any = {}
  ) => buildToolBlock(name, args, result, opts).map(withoutAnsi);
  assert.deepEqual(
    plain(
      "read",
      { path: "  src/\n file.ts ", reasoning: "  inspect\n   source " },
      { output: "a\nb" }
    ),
    ["  ┊ ✓ 📖 read inspect source", "  ┊   src/ file.ts → 2 lines"]
  );
  assert.deepEqual(
    plain(
      "grep",
      { pattern: "needle", path: "src", reasoning: "" },
      {
        output: "src/a.ts:10:x\nsrc/a.ts-11-context\n--\nsrc/b.ts:200:y",
      }
    ),
    [
      "  ┊ ✓ 📖 grep needle in src",
      "  ┊   needle in src → 2 matches in 2 files",
    ]
  );
  assert.deepEqual(
    plain(
      "find",
      { pattern: "*.ts", path: "src", reasoning: "find files" },
      { message: "a.ts\n\nb.ts\n" }
    ),
    ["  ┊ ✓ 📖 find find files", "  ┊   *.ts in src → 2 files"]
  );
  assert.deepEqual(
    plain(
      "ls",
      { path: "src", reasoning: "list source" },
      { output: "a\n\nb" }
    ),
    ["  ┊ ✓ 📖 ls list source", "  ┊   src → 2 entries"]
  );
  assert.deepEqual(
    plain(
      "edit",
      { path: "a.ts", reasoning: "change value" },
      {
        details: { diff: "+++ b/a.ts\n--- a/a.ts\n+one\n-two\ncontext" },
      }
    ),
    ["  ┊ ✓ ✏️ edit change value", "  ┊   a.ts → +1/-1"]
  );
  assert.deepEqual(
    plain(
      "bash",
      { command: "echo hi", reasoning: "run command" },
      { output: "exit code: 12" },
      { elapsedMs: 1_000 }
    ),
    ["  ┊ ✓ ⚡ bash run command", "  ┊   echo hi → exit 12 in 1s"]
  );
  assert.deepEqual(
    plain("other", {}, { output: "one\ntwo" }, { isError: true }),
    ["  ┊ ✗ ◆ other ", "  ┊   → one"]
  );
});

test("buildToolBlock renders exact layout and expansion boundaries", () => {
  const result = {
    details: {
      diff: "@@ -1 +1 @@\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\n context\tvalue",
    },
  };
  assert.deepEqual(
    buildToolBlock(
      "edit",
      { path: "a.ts", reasoning: "change value" },
      result,
      {
        expanded: true,
        mode: "reasoning",
      }
    ).map(withoutAnsi),
    [
      "  ┊ ✓ ✏️ edit change value → +1/-1",
      "  ┊   @@ -1 +1 @@",
      "  ┊   --- a/a.ts",
      "  ┊   +++ b/a.ts",
      "  ┊   -old",
      "  ┊   +new",
      `  ┊    context${" ".repeat(8)}value`,
    ]
  );
  assert.deepEqual(
    buildToolBlock(
      "read",
      {},
      { message: "first\nsecond\n" },
      {
        expanded: true,
        mode: "result",
      }
    ).map(withoutAnsi),
    ["  ┊ ✓ 📖 read → 3 lines", "  ┊   first", "  ┊   second"]
  );
  assert.deepEqual(
    buildToolBlock(
      "write",
      { path: "empty", content: "", reasoning: "clear file" },
      {},
      {
        expanded: true,
        isPartial: true,
      }
    ).map(withoutAnsi),
    ["  ┊ · ✏️ write clear file", "  ┊   empty → <1s"]
  );
});

test("buildTurnDiffBlock renders exact singular, separators, and diff semantics", () => {
  assert.deepEqual(
    buildTurnDiffBlock([
      {
        tool: "edit",
        path: "src/a.ts",
        diff: "@@ -1 +1 @@\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n context\n\n",
      },
    ]).map(withoutAnsi),
    [
      "◆ last turn diff (1 file)",
      "✏️ src/a.ts",
      "@@ -1 +1 @@",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "-old",
      "+new",
      " context",
    ]
  );
  assert.deepEqual(
    buildTurnDiffBlock([
      { tool: "write", path: "new.txt", diff: "  " },
      { tool: "edit", path: "b.ts", diff: "+x" },
    ]).map(withoutAnsi),
    [
      "◆ last turn diff (2 files)",
      "✏️ new.txt",
      "(new file / full overwrite — no line diff)",
      "",
      "✏️ b.ts",
      "+x",
    ]
  );
});

test("registered APIs expose exact completions and reason-first tool metadata", () => {
  const harness = registerEnabledExtension();
  const tidy = harness.commands.get("tidy");
  assert.equal(tidy.description, "Manage pi-tidy-tools state and layout mode");
  assert.deepEqual(tidy.getArgumentCompletions(" MODE R"), [
    { value: "mode reasoning", label: "mode reasoning" },
    { value: "mode result", label: "mode result" },
  ]);
  assert.deepEqual(tidy.getArgumentCompletions("missing"), []);
  assert.equal(
    harness.commands.get("diff").description,
    "Show file changes (edit/write diffs) from the last turn"
  );
  assert.equal(
    harness.shortcuts.get("ctrl+shift+o").description,
    "Show file changes from the last turn"
  );
  for (const [name, tool] of harness.tools) {
    assert.equal(tool.name, name);
    assert.equal(tool.label, name);
    assert.equal(tool.renderShell, "self");
    assert.deepEqual(tool.promptGuidelines, [
      `Always pass a \"reasoning\" phrase to ${name}: state the GOAL/intent, not the file or command (those are shown already).`,
    ]);
    assert.equal(Object.keys(tool.parameters.properties)[0], "reasoning");
    assert.equal(tool.parameters.required[0], "reasoning");
  }
});
