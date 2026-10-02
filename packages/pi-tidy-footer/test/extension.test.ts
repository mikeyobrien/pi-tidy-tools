import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexBarPoller } from "../codexbar.js";
import { createFooterExtension } from "../index.js";
import { ResourceMonitor } from "../resources.js";

// Keep the suite hermetic: never read the developer's real footer config.
process.env.PI_TIDY_FOOTER_CONFIG = "/nonexistent/pi-tidy-footer.json";

const quotaJson = JSON.stringify({
  provider: "codex",
  usage: {
    primary: { usedPercent: 3, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10_080 },
  },
});

test("extension installs a responsive footer and exposes controls", async () => {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getThinkingLevel() {
      return "max";
    },
  };
  const footerFactories: any[] = [];
  const notifications: Array<[string, string]> = [];
  const ctx: any = {
    mode: "tui",
    cwd: "/home/me/project",
    model: {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      contextWindow: 272_000,
    },
    getContextUsage: () => ({
      tokens: 75_000,
      contextWindow: 272_000,
      percent: 27.6,
    }),
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: [] } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [],
            usage: { input: 1200, output: 34, cacheRead: 500, cacheWrite: 20 },
          },
        },
      ],
    },
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setFooter(factory: any) {
        footerFactories.push(factory);
      },
      notify(text: string, level: string) {
        notifications.push([text, level]);
      },
    },
  };
  let polls = 0;
  const poller = new CodexBarPoller(async () => {
    polls += 1;
    return quotaJson;
  }, 60_000);
  createFooterExtension({ poller })(pi as any);

  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("model_select"));
  assert.ok(handlers.has("thinking_level_select"));
  assert.ok(commands.has("tidy-footer"));
  assert.equal(
    commands.get("tidy-footer").description,
    "Control or inspect the responsive footer"
  );
  assert.deepEqual(
    new Set(handlers.keys()),
    new Set([
      "session_start",
      "model_select",
      "thinking_level_select",
      "message_end",
      "session_shutdown",
    ])
  );

  handlers.get("session_start")![0]!({}, ctx);
  await poller.refresh();
  assert.equal(typeof footerFactories.at(-1), "function");

  let renders = 0;
  let disposed = 0;
  const component = footerFactories.at(-1)(
    {
      requestRender: () => {
        renders += 1;
      },
    },
    ctx.ui.theme,
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([["memory", "🧠 ready"]]),
      onBranchChange: (_callback: () => void) => () => {
        disposed += 1;
      },
    }
  );
  component.invalidate();
  const lines = component.render(52);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith("sol/max"));
  assert.ok(lines[1].includes("5h 3%"));
  assert.ok(lines[1].endsWith("ctx 28%"));
  const wide = component.render(120);
  assert.ok(wide[1].includes("↑1.2k"));
  assert.ok(wide[1].includes("↓34"));

  handlers.get("thinking_level_select")![0]!({}, ctx);
  handlers.get("message_end")![0]!({}, ctx);
  handlers.get("model_select")![0]!({ model: { provider: "anthropic" } }, ctx);
  handlers.get("model_select")![0]!(
    { model: { provider: "openai-codex" } },
    ctx
  );
  assert.ok(renders >= 4);

  component.dispose();
  assert.equal(disposed, 1);

  await commands.get("tidy-footer").handler("status", ctx);
  assert.deepEqual(notifications.at(-1), [
    "Responsive footer on; 5h 3%, 7d 20%; resources off",
    "info",
  ]);
  await commands.get("tidy-footer").handler("refresh", ctx);
  assert.deepEqual(notifications.at(-1), ["CodexBar quotas refreshed", "info"]);
  await commands.get("tidy-footer").handler("unknown", ctx);
  assert.deepEqual(notifications.at(-1), [
    "Usage: /tidy-footer [status|refresh|on|default]",
    "warning",
  ]);
  await commands.get("tidy-footer").handler("default", ctx);
  assert.equal(footerFactories.at(-1), undefined);
  assert.deepEqual(notifications.at(-1), [
    "Default Pi footer restored",
    "info",
  ]);
  await commands.get("tidy-footer").handler("status", ctx);
  assert.deepEqual(notifications.at(-1), [
    "Responsive footer off; 5h 3%, 7d 20%; resources off",
    "info",
  ]);
  const pollsWhileEnabled = polls;
  handlers.get("model_select")![0]!(
    { model: { provider: "openai-codex" } },
    ctx
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, pollsWhileEnabled);
  await commands.get("tidy-footer").handler("on", ctx);
  assert.equal(typeof footerFactories.at(-1), "function");
  assert.deepEqual(notifications.at(-1), ["Responsive footer enabled", "info"]);

  handlers.get("session_shutdown")![0]!({}, ctx);
});

test("commands report pending and failed CodexBar state", async () => {
  const commands = new Map<string, any>();
  const pi = {
    on() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getThinkingLevel() {
      return "off";
    },
  };
  const poller = new CodexBarPoller(async () => {
    throw new Error("offline");
  });
  createFooterExtension({ poller })(pi as any);
  const notices: Array<[string, string]> = [];
  const ctx: any = {
    ui: {
      setFooter() {},
      notify(text: string, level: string) {
        notices.push([text, level]);
      },
    },
  };
  await commands.get("tidy-footer").handler("status", ctx);
  assert.match(notices.at(-1)![0], /pending/);
  await commands.get("tidy-footer").handler("refresh", ctx);
  assert.deepEqual(notices.at(-1), ["CodexBar: offline", "warning"]);
  await commands.get("tidy-footer").handler("status", ctx);
  assert.match(notices.at(-1)![0], /unavailable: offline/);
});

test("command aliases and model lifecycle call the poller exactly", async () => {
  const handlers = new Map<string, Function>();
  let command: any;
  const calls: string[] = [];
  const poller: any = {
    snapshot: {
      primary: { usedPercent: 12.4, windowMinutes: 42 },
      secondary: { usedPercent: 56.6, windowMinutes: 10_080 },
    },
    start(callback: () => void) {
      calls.push("start");
      callback();
    },
    stop() {
      calls.push("stop");
    },
    async refresh(callback: () => void) {
      calls.push("refresh");
      callback();
    },
  };
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, value: any) {
      command = value;
    },
    getThinkingLevel: () => "off",
  };
  createFooterExtension({ poller })(pi as any);
  const footers: any[] = [];
  const notices: Array<[string, string]> = [];
  const ctx: any = {
    mode: "tui",
    model: { provider: "anthropic" },
    ui: {
      setFooter(value: any) {
        footers.push(value);
      },
      notify(text: string, level: string) {
        notices.push([text, level]);
      },
    },
  };

  await command.handler("   ", ctx);
  assert.deepEqual(notices.at(-1), [
    "Responsive footer on; 5h 12%, 7d 57%; resources off",
    "info",
  ]);
  await command.handler(" OFF ", ctx);
  assert.deepEqual(calls, ["stop"]);
  assert.equal(footers.at(-1), undefined);
  await command.handler("auto", ctx);
  assert.equal(typeof footers.at(-1), "function");
  assert.deepEqual(notices.at(-1), ["Responsive footer enabled", "info"]);

  handlers.get("model_select")!({ model: { provider: "openai-codex" } }, ctx);
  assert.deepEqual(calls, ["stop", "start", "refresh"]);
  handlers.get("model_select")!({ model: { provider: "anthropic" } }, ctx);
  assert.deepEqual(calls, ["stop", "start", "refresh", "stop"]);

  handlers.get("session_shutdown")!();
  assert.deepEqual(calls, ["stop", "start", "refresh", "stop", "stop"]);

  poller.snapshot = { secondary: { usedPercent: 9.6, windowMinutes: 10_080 } };
  await command.handler("status", ctx);
  assert.deepEqual(notices.at(-1), [
    "Responsive footer on; 7d 10%; resources off",
    "info",
  ]);
  poller.snapshot = undefined;
  poller.lastError = "offline";
  await command.handler("status", ctx);
  assert.deepEqual(notices.at(-1), [
    "Responsive footer on; CodexBar unavailable: offline; resources off",
    "info",
  ]);
});

test("non-TUI sessions do not install a footer or poll CodexBar", async () => {
  const handlers = new Map<string, Function>();
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    getThinkingLevel() {
      return "off";
    },
  };
  let polls = 0;
  createFooterExtension({
    poller: new CodexBarPoller(async () => {
      polls += 1;
      return quotaJson;
    }),
  })(pi as any);
  let installed = false;
  handlers.get("session_start")!(
    {},
    {
      mode: "print",
      ui: {
        setFooter: () => {
          installed = true;
        },
      },
    }
  );
  handlers.get("model_select")!(
    { model: { provider: "openai-codex" } },
    {
      mode: "print",
      ui: { setFooter() {} },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installed, false);
  assert.equal(polls, 0);
});

test("resource segment follows config and samples off the render path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-footer-ext-"));
  const configPath = join(dir, "pi-tidy-footer.json");
  writeFileSync(
    configPath,
    JSON.stringify({ resources: { enabled: true, mounts: ["/tmp"] } })
  );
  const handlers = new Map<string, Function>();
  let command: any;
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, value: any) {
      command = value;
    },
    getThinkingLevel: () => "off",
  };
  let samples = 0;
  const monitor = new ResourceMonitor({
    loadavg: () => {
      samples += 1;
      return [0.5, 0, 0];
    },
    cpuCount: () => 2,
    totalMemory: () => 8 * 2 ** 30,
    availableMemory: async () => 6 * 2 ** 30,
    disk: async () => ({ blockPercent: 16, inodePercent: 100 }),
  });
  const poller: any = { start() {}, stop() {}, async refresh() {} };
  createFooterExtension({ poller, resources: monitor, configPath })(pi as any);
  const footers: any[] = [];
  const notices: Array<[string, string]> = [];
  const ctx: any = {
    mode: "tui",
    cwd: "/home/me/project",
    model: { id: "claude", provider: "anthropic" },
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setFooter(value: any) {
        footers.push(value);
      },
      notify(text: string, level: string) {
        notices.push([text, level]);
      },
    },
  };
  try {
    handlers.get("session_start")!({}, ctx);
    assert.equal(monitor.running, true);
    await monitor.refresh();
    let renders = 0;
    const component = footers.at(-1)(
      { requestRender: () => (renders += 1) },
      ctx.ui.theme,
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => {},
      }
    );
    const before = samples;
    const lines = component.render(60);
    assert.equal(samples, before, "render reads only the cached sample");
    assert.match(lines[1], /^! \/tmp 100%i/);
    const wide = component.render(120);
    assert.match(wide[1], /cpu 25% · mem 2\.0\/8\.0G/);
    await monitor.refresh(() => renders++);
    assert.ok(renders >= 1);

    await command.handler("status", ctx);
    assert.deepEqual(notices.at(-1), [
      "Responsive footer on; CodexBar pending; resources on (/tmp; warn 85%)",
      "info",
    ]);

    await command.handler("default", ctx);
    assert.equal(monitor.running, false);
    await command.handler("on", ctx);
    assert.equal(monitor.running, true);

    writeFileSync(
      configPath,
      JSON.stringify({ resources: { enabled: false } })
    );
    handlers.get("session_start")!({}, ctx);
    assert.equal(monitor.running, false);
    assert.equal(monitor.snapshot, undefined);
    await command.handler("status", ctx);
    assert.match(notices.at(-1)![0], /; resources off$/);

    writeFileSync(configPath, JSON.stringify({ resources: { enabled: true } }));
    handlers.get("session_start")!({}, ctx);
    assert.equal(monitor.running, true);
    handlers.get("session_shutdown")!();
    assert.equal(monitor.running, false);
  } finally {
    monitor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
