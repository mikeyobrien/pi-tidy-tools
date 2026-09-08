#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

if (process.argv[2] !== "app-server") process.exit(2);

const home = process.env.CODEX_HOME;
if (!home || !home.startsWith("/")) process.exit(3);
mkdirSync(home, { recursive: true });
const storePath = join(home, "threads.json");
const threads = existsSync(storePath)
  ? JSON.parse(readFileSync(storePath, "utf8"))
  : {};
const pending = new Map();
let counter = 0;

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const persist = () => writeFileSync(storePath, JSON.stringify(threads));
const thread = (id, cwd) => ({
  id,
  sessionId: id,
  cwd,
  ephemeral: false,
  cliVersion: "0.145.0",
  createdAt: 1,
  updatedAt: 1,
  modelProvider: "fixture",
  preview: "",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
});

const completeTurn = (id, request, text, status = "completed") => {
  const nativeTurnId = `turn-${++counter}`;
  const item = {
    id: `item-${counter}`,
    type: "agentMessage",
    text,
  };
  send({
    id,
    result: {
      turn: { id: nativeTurnId, items: [], status: "inProgress" },
    },
  });
  send({
    method: "turn/started",
    params: {
      threadId: request.threadId,
      turn: { id: nativeTurnId, items: [], status: "inProgress" },
    },
  });
  send({
    method: "item/started",
    params: {
      threadId: request.threadId,
      turnId: nativeTurnId,
      startedAtMs: 1,
      item,
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: request.threadId,
      turnId: nativeTurnId,
      itemId: item.id,
      delta: text,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: request.threadId,
      turnId: nativeTurnId,
      item,
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: request.threadId,
      turn: { id: nativeTurnId, items: [item], status },
    },
  });
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    send({
      id,
      result: {
        userAgent: "codex-fixture/0.145.0",
        platformOs: "macos",
        platformFamily: "unix",
        codexHome: existsSync(join(home, "lie-home"))
          ? "/tmp/tidy-codex-wrong-home"
          : home,
      },
    });
    return;
  }
  if (method === "thread/start") {
    if (params.ephemeral === true) {
      send({ id, error: { code: -32602, message: "ephemeral_forbidden" } });
      return;
    }
    const idValue = `thr-fixture-${++counter}`;
    threads[idValue] = thread(idValue, params.cwd ?? process.cwd());
    persist();
    send({
      id,
      result: {
        thread: threads[idValue],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: threads[idValue].cwd,
        model: "fixture",
        modelProvider: "fixture",
        sandbox: { type: "workspaceWrite" },
      },
    });
    return;
  }
  if (method === "thread/resume") {
    const existing = threads[params.threadId];
    if (!existing) {
      send({ id, error: { code: -32004, message: "thread_not_found" } });
      return;
    }
    send({
      id,
      result: {
        thread: existing,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: existing.cwd,
        model: "fixture",
        modelProvider: "fixture",
        sandbox: { type: "workspaceWrite" },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const existing = threads[params.threadId];
    if (!existing) {
      send({ id, error: { code: -32004, message: "thread_not_found" } });
      return;
    }
    const text = Array.isArray(params.input)
      ? params.input.map((part) => part.text ?? "").join("")
      : "";
    if (text.includes("[cancel-hold]")) {
      const nativeTurnId = `turn-${++counter}`;
      pending.set(nativeTurnId, { id, threadId: params.threadId, text });
      send({
        id,
        result: {
          turn: { id: nativeTurnId, items: [], status: "inProgress" },
        },
      });
      send({
        method: "turn/started",
        params: {
          threadId: params.threadId,
          turn: { id: nativeTurnId, items: [], status: "inProgress" },
        },
      });
      return;
    }
    completeTurn(id, params, `codex:${text}`);
    return;
  }
  if (method === "turn/interrupt") {
    const held = pending.get(params.turnId);
    if (!held) {
      send({ id, error: { code: -32004, message: "turn_not_found" } });
      return;
    }
    pending.delete(params.turnId);
    send({ id, result: { turn: { id: params.turnId, items: [], status: "interrupted" } } });
    send({
      method: "turn/completed",
      params: {
        threadId: held.threadId,
        turn: { id: params.turnId, items: [], status: "interrupted" },
      },
    });
    return;
  }
  send({ id, error: { code: -32601, message: "method_not_found" } });
});
