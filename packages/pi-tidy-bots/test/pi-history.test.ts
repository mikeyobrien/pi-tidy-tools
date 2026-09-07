import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
  link,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPiHistory,
  savePiCheckpoint,
  loadPiCheckpoint,
} from "../backends/pi/history.ts";
import { rpcSpawnArgs } from "../src/rpc.ts";

test("Pi history retains an exact identity and rejects changed or incomplete history", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tidy-pi-history-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  await mkdir(sessions);
  const file = join(sessions, "history.jsonl");
  const header = { type: "session", version: 3, id: "native-one", cwd: dir };
  const text =
    JSON.stringify(header) +
    "\n" +
    JSON.stringify({
      type: "message",
      id: "one",
      parentId: null,
      message: { role: "user", content: "hello" },
    }) +
    "\n";
  await writeFile(file, text);
  const inspect = () => inspectPiHistory(sessions, file, header.id, dir);
  const first = await inspect();
  assert.deepEqual(
    await inspectPiHistory(sessions, file, header.id, dir, first),
    first
  );
  await writeFile(file, text.replace("hello", "other"));
  await assert.rejects(
    inspectPiHistory(sessions, file, header.id, dir, first),
    { code: "continuity_unverified" }
  );
  for (const invalid of [
    "",
    "{}\n",
    text.slice(0, -1),
    text + "{broken}\n",
    text.replace('"version":3', '"version":2'),
    text.replace('"native-one"', '"native-two"'),
    text.replace(JSON.stringify(dir), '"/other-workspace"'),
  ]) {
    await writeFile(file, invalid);
    await assert.rejects(inspect(), { code: "continuity_unverified" });
  }
  await rm(file);
  await assert.rejects(inspect(), { code: "continuity_unverified" });
  await assert.rejects(realpath(file), { code: "ENOENT" });
});

test("Pi history rejects symlinks, hardlinks, escaped paths and oversized files", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tidy-pi-history-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  await mkdir(sessions);
  const outside = join(dir, "outside.jsonl"),
    file = join(sessions, "history.jsonl");
  const bytes =
    JSON.stringify({ type: "session", version: 3, id: "one", cwd: dir }) + "\n";
  await writeFile(outside, bytes);
  await assert.rejects(inspectPiHistory(sessions, outside, "one", dir), {
    code: "continuity_unverified",
  });
  await symlink(outside, file);
  await assert.rejects(inspectPiHistory(sessions, file, "one", dir), {
    code: "continuity_unverified",
  });
  await rm(file);
  await link(outside, file);
  await assert.rejects(inspectPiHistory(sessions, file, "one", dir), {
    code: "continuity_unverified",
  });
  await rm(file);
  await writeFile(file, bytes);
  await truncate(file, 64 * 1024 * 1024 + 1);
  await assert.rejects(inspectPiHistory(sessions, file, "one", dir), {
    code: "continuity_unverified",
  });
});

test("exact Pi launch selects only the verified file and rejects ambiguous resume", () => {
  const options = {
    name: "pi",
    sessionDir: "/owned/sessions",
    resume: false,
    approve: false,
    bridgePath: "/owned/bridge.mjs",
    sessionFile: "/owned/sessions/exact.jsonl",
  };
  const args = rpcSpawnArgs(options);
  assert.equal(args.includes("--continue"), false);
  assert.equal(args[args.indexOf("--session") + 1], options.sessionFile);
  assert.throws(() => rpcSpawnArgs({ ...options, resume: true }));
  assert.throws(() =>
    rpcSpawnArgs({ ...options, sessionFile: "relative.jsonl" })
  );
  assert.throws(() => rpcSpawnArgs({ ...options, sessionFile: "/bad\0file" }));
});

test("Pi retained checkpoints require complete scoped runtime settings", async (t) => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "tidy-pi-settings-"))
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "native-sessions");
  await mkdir(sessions);
  const file = join(sessions, "history.jsonl");
  await writeFile(
    file,
    JSON.stringify({ type: "session", version: 3, id: "one", cwd: dir }) + "\n"
  );
  const checkpoint = {
    version: 1 as const,
    bindingId: "binding",
    conversationId: "conversation",
    messageCount: 1,
    settings: {
      provider: "fixture",
      modelId: "saved-model",
      thinkingLevel: "medium",
    },
    history: await inspectPiHistory(sessions, file, "one", dir),
  };
  await savePiCheckpoint(dir, checkpoint);
  const load = () =>
    loadPiCheckpoint(dir, "binding", "conversation", "pi:one", dir);
  assert.deepEqual(await load(), checkpoint);
  for (const settings of [
    undefined,
    null,
    {},
    { ...checkpoint.settings, provider: "" },
    { ...checkpoint.settings, modelId: null },
    { ...checkpoint.settings, thinkingLevel: "" },
  ]) {
    await writeFile(
      join(dir, "pi-history.json"),
      JSON.stringify({ ...checkpoint, settings })
    );
    await assert.rejects(load(), { code: "continuity_unverified" });
  }
});
