import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
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
      constants.O_RDONLY | constants.O_NOFOLLOW
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
