/**
 * Durable outbound queue (issue 34): messages accepted against a busy bot are
 * journalled at `.fleet/pending/<bot>.jsonl` (best-effort, JSONL idiom) and
 * replayed on spawn/boot exactly once, in order. A daemon restart mid-queue
 * must not drop operator messages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PendingMessage {
  /** Transcript entry id — the identity used to clear `delivering`. */
  id: string;
  text: string;
  origin: "operator" | "bot" | "routine" | "system";
  originFrom?: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  /** Issue 76: surfaced on the roster queue item when a producer carries it. */
  filename?: string;
  ts: string;
}

export interface PendingStore {
  append(bot: string, message: PendingMessage): void;
  load(bot: string): PendingMessage[];
  /** Delivered: drop the message line, keep the rest in order. */
  remove(bot: string, id: string): void;
  /** Bot removed: its pending journal goes with it (documented). */
  drop(bot: string): void;
}

export function createPendingStore(dir: string): PendingStore {
  const file = (bot: string) => join(dir, `${bot}.jsonl`);

  /**
   * Issue 143 (hound pass 2): per-line tolerance — ONE torn line must never
   * drop the whole operator queue (the old single try/catch returned [] and
   * the next append physically deleted the surviving rows). Well-formed
   * rows survive; torn lines are skipped LOUDLY (transcripts.ts idiom).
   */
  const readAll = (bot: string): PendingMessage[] => {
    let raw: string;
    try {
      raw = readFileSync(file(bot), "utf8");
    } catch {
      return [];
    }
    const messages: PendingMessage[] = [];
    let torn = 0;
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        messages.push(JSON.parse(line) as PendingMessage);
      } catch {
        torn++;
      }
    }
    if (torn > 0) {
      console.error(
        `[pending] ${bot}: skipped ${torn} torn journal line(s) — well-formed rows kept`
      );
    }
    return messages;
  };

  const writeAll = (bot: string, messages: PendingMessage[]): void => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        file(bot),
        messages.map((m) => JSON.stringify(m)).join("\n") +
          (messages.length > 0 ? "\n" : "")
      );
    } catch {
      // Journal is best-effort; the in-memory queue still drives delivery.
    }
  };

  return {
    append(bot: string, message: PendingMessage): void {
      try {
        mkdirSync(dir, { recursive: true });
        const current = existsSync(file(bot)) ? readAll(bot) : [];
        writeAll(bot, [...current, message]);
      } catch {
        // Best-effort: a failed journal write must never block the send path.
      }
    },

    load(bot: string): PendingMessage[] {
      return readAll(bot);
    },

    remove(bot: string, id: string): void {
      writeAll(
        bot,
        readAll(bot).filter((m) => m.id !== id)
      );
    },

    drop(bot: string): void {
      try {
        writeAll(bot, []);
      } catch {
        // Best-effort.
      }
    },
  };
}
