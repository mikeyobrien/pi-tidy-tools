import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcSession, type RpcEvent, type RpcSpawnOptions } from "../src/rpc.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc/ui-parser-pi.mjs", import.meta.url)
);
function options(
  directory: string,
  onEvent: (event: RpcEvent) => void
): RpcSpawnOptions {
  return {
    name: "ui-parser",
    piBin: fixture,
    cwd: directory,
    sessionDir: join(directory, "sessions"),
    resume: false,
    approve: false,
    bridgePath: join(directory, "unused-bridge.ts"),
    daemonUrl: "http://legacy.invalid",
    childSecret: "unused",
    isolatedEnv: { PATH: dirname(process.execPath) },
    onEvent,
    onExit() {},
  };
}
async function withSession(run: (session: RpcSession) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "tidy-rpc-ui-"));
  const events: RpcEvent[] = [];
  const session = RpcSession.spawn(
    options(directory, (event) => events.push(event))
  );
  try {
    await run(session);
  } finally {
    const closed = once(session.process, "close");
    session.stop();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
  return events;
}
async function ask(
  session: RpcSession,
  mode: string,
  id: string,
  answer: Record<string, unknown>
) {
  const result = session.prompt(mode);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (session.process && !session.process.killed) {
        session.respondUi(id, answer);
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  await result;
}

test("RPC parser preserves editor prefill and finite native timeout", async () => {
  const events = await withSession(async (session) => {
    const pending = session.prompt("editor");
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.respondUi("ui-editor", { value: "done" });
    await pending;
  });
  const event = events.find((value) => value.kind === "ui_request");
  assert.equal(event?.kind, "ui_request");
  assert.equal(event?.id, "ui-editor");
  assert.equal(event?.method, "editor");
  assert.equal(event?.title, "Notes");
  assert.equal(event?.prefill, "seed");
});

test("RPC parser maps positive timeout and marks zero or invalid timeout", async () => {
  for (const [mode, id, expected, invalid] of [
    ["timeout", "ui-timeout", 250, false],
    ["timeout-zero", "ui-zero", undefined, false],
    ["timeout-bad", "ui-bad", undefined, true],
  ] as const) {
    const events = await withSession(async (session) => {
      const pending = session.prompt(mode);
      await new Promise((resolve) => setTimeout(resolve, 30));
      session.respondUi(id, { value: "ok" });
      await pending;
    });
    const event = events.find((value) => value.kind === "ui_request");
    assert.equal(event?.kind, "ui_request");
    assert.equal(event?.timeoutMs, expected);
    assert.equal(event?.invalidTimeout, invalid);
  }
});
