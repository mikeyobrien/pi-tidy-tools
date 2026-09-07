import { constants } from "node:fs";
import { open, realpath, lstat, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, sep, join } from "node:path";
import { ProtocolError } from "@mobrienv/pi-tidy-bots/plugin-sdk";

export interface PiHistoryIdentity {
  file: string;
  sessionId: string;
  cwd: string;
  size: number;
  sha256: string;
}
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const unavailable = () =>
  new ProtocolError(
    "continuity_unverified",
    "Exact native history is unavailable or changed"
  );

/** Adapter-only validation. The gateway never parses native session files.
 * Capture only after native settlement; verify again immediately before launch.
 * This checks retained bytes, not the native runtime's eventual load semantics.
 */
export async function inspectPiHistory(
  sessionDir: string,
  file: string,
  sessionId: string,
  workspace: string,
  expected?: PiHistoryIdentity
): Promise<PiHistoryIdentity> {
  try {
    if (!isAbsolute(file) || !sessionId || sessionId.includes("\0"))
      throw unavailable();
    const [root, actual, cwd] = await Promise.all([
      realpath(sessionDir),
      realpath(file),
      realpath(workspace),
    ]);
    const path = relative(root, actual);
    if (
      actual !== file ||
      !path ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      throw unavailable();
    const handle = await open(
      actual,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > MAX_HISTORY_BYTES
      )
        throw unavailable();
      await handle.sync();
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset
        );
        if (!result.bytesRead) throw unavailable();
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(actual);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        !current.isFile() ||
        current.dev !== after.dev ||
        current.ino !== after.ino
      )
        throw unavailable();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.endsWith("\n")) throw unavailable();
      const lines = text.slice(0, -1).split("\n");
      const header = JSON.parse(lines[0]);
      if (
        !header ||
        header.type !== "session" ||
        header.version !== 3 ||
        header.id !== sessionId ||
        header.cwd !== cwd
      )
        throw unavailable();
      // Pi can skip malformed trailing entries; restoration must not silently lose them.
      for (const line of lines.slice(1)) {
        const entry = JSON.parse(line);
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.type !== "string"
        )
          throw unavailable();
      }
      const identity = {
        file: actual,
        sessionId,
        cwd,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      if (
        expected &&
        (expected.file !== identity.file ||
          expected.sessionId !== identity.sessionId ||
          expected.cwd !== identity.cwd ||
          expected.size !== identity.size ||
          expected.sha256 !== identity.sha256)
      )
        throw unavailable();
      return identity;
    } finally {
      await handle.close();
    }
  } catch {
    throw unavailable();
  }
}

export interface PiRuntimeSettings {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

/** Compare effective native settings, never the requested startup defaults. */
export function piRuntimeSettings(state: unknown): PiRuntimeSettings {
  const value = state as {
    model?: { provider?: unknown; id?: unknown };
    thinkingLevel?: unknown;
  } | null;
  const valid = (text: unknown): text is string =>
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= 512 &&
    !text.includes("\0");
  if (
    !valid(value?.model?.provider) ||
    !valid(value?.model?.id) ||
    !valid(value?.thinkingLevel)
  )
    throw unavailable();
  return {
    provider: value.model.provider,
    modelId: value.model.id,
    thinkingLevel: value.thinkingLevel,
  };
}

export function samePiSettings(
  state: unknown,
  expected: PiRuntimeSettings
): boolean {
  const actual = piRuntimeSettings(state);
  return (
    actual.provider === expected.provider &&
    actual.modelId === expected.modelId &&
    actual.thinkingLevel === expected.thinkingLevel
  );
}

export interface PiHistoryCheckpoint {
  version: 1;
  bindingId: string;
  conversationId: string;
  messageCount: number;
  settings: PiRuntimeSettings;
  history: PiHistoryIdentity;
}

/** Publish only after the native history has been inspected and synced. */
export async function savePiCheckpoint(
  dataDir: string,
  checkpoint: PiHistoryCheckpoint
): Promise<void> {
  const temporary = join(dataDir, `.pi-history-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(checkpoint));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(dataDir, "pi-history.json"));
    const dir = await open(dataDir, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadPiCheckpoint(
  dataDir: string,
  bindingId: string,
  conversationId: string,
  nativeReference: unknown,
  workspace: string
): Promise<PiHistoryCheckpoint> {
  try {
    const handle = await open(
      join(dataDir, "pi-history.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let checkpoint: PiHistoryCheckpoint;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > 16384
      )
        throw unavailable();
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw unavailable();
      checkpoint = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead)
        )
      );
    } finally {
      await handle.close();
    }
    if (
      !checkpoint ||
      checkpoint.version !== 1 ||
      checkpoint.bindingId !== bindingId ||
      checkpoint.conversationId !== conversationId ||
      !Number.isSafeInteger(checkpoint.messageCount) ||
      checkpoint.messageCount < 1 ||
      !checkpoint.settings ||
      !samePiSettings(
        {
          model: {
            provider: checkpoint.settings.provider,
            id: checkpoint.settings.modelId,
          },
          thinkingLevel: checkpoint.settings.thinkingLevel,
        },
        checkpoint.settings
      ) ||
      !checkpoint.history ||
      nativeReference !== `pi:${checkpoint.history.sessionId}`
    )
      throw unavailable();
    await inspectPiHistory(
      join(dataDir, "native-sessions"),
      checkpoint.history.file,
      checkpoint.history.sessionId,
      workspace,
      checkpoint.history
    );
    return checkpoint;
  } catch {
    throw unavailable();
  }
}
