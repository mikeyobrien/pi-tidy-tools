/**
 * Durable per-bot transcripts (issue 20 item 7): append-only JSONL at
 * `.fleet/transcripts/<bot>.jsonl`, same idiom as routines.jsonl. Size-capped
 * with a single rotation generation. Persistence is best-effort — the hot
 * in-memory buffer stays the source of truth for the live console.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_ROTATE_BYTES = 2_000_000;

export interface TranscriptStore {
  append(bot: string, entry: unknown): void;
  load(bot: string): unknown[];
}

export function createTranscriptStore(
  dir: string,
  capBytes: number = DEFAULT_ROTATE_BYTES
): TranscriptStore {
  const current = (bot: string) => join(dir, `${bot}.jsonl`);
  const previous = (bot: string) => join(dir, `${bot}.jsonl.1`);

  return {
    append(bot: string, entry: unknown): void {
      try {
        mkdirSync(dir, { recursive: true });
        try {
          if (
            existsSync(current(bot)) &&
            statSync(current(bot)).size >= capBytes
          ) {
            rmSync(previous(bot), { force: true });
            renameSync(current(bot), previous(bot));
          }
        } catch {
          // Rotation is best-effort; never block the append.
        }
        appendFileSync(current(bot), `${JSON.stringify(entry)}\n`);
      } catch {
        // Transcript persistence is best-effort, like the routines journal.
      }
    },

    load(bot: string): unknown[] {
      const out: unknown[] = [];
      for (const file of [previous(bot), current(bot)]) {
        try {
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
              out.push(JSON.parse(line));
            } catch {
              // Skip torn lines (crash mid-write).
            }
          }
        } catch {
          // Missing generation: nothing persisted at that layer.
        }
      }
      return out;
    },
  };
}

/**
 * Boot merge (issue 20 item 7): journal first, then the child's hot history —
 * entries already persisted (same ts + role + text) are not duplicated.
 */
export function mergeTranscriptHistory<
  T extends { ts: string; role: string; text: string },
>(journaled: T[], incoming: T[]): T[] {
  const seen = new Set(
    journaled.map((e) => `${e.ts}\u0000${e.role}\u0000${e.text}`)
  );
  return [
    ...journaled,
    ...incoming.filter(
      (e) => !seen.has(`${e.ts}\u0000${e.role}\u0000${e.text}`)
    ),
  ];
}

/**
 * Pagination for GET /api/bots/:name/transcript. No query = the full hot
 * transcript (existing behavior). `before` (ISO ts) filters older entries and
 * returns the most recent `limit` (default 50) of what remains; `limit` alone
 * returns the last `limit` entries.
 */
export function paginateTranscript<T extends { ts: string }>(
  entries: T[],
  query: { before?: string; limit?: string }
): { ok: true; entries: T[] } | { ok: false; error: string } {
  let list = entries;
  let limit: number | undefined;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isFinite(limit) || limit <= 0)
      return { ok: false, error: "limit must be a positive number" };
  }
  if (query.before !== undefined) {
    const ts = Date.parse(query.before);
    if (Number.isNaN(ts))
      return { ok: false, error: "before must be an ISO timestamp" };
    list = list.filter((entry) => Date.parse(entry.ts) < ts);
    list = list.slice(-(limit ?? 50));
  } else if (limit !== undefined) {
    list = list.slice(-limit);
  }
  return { ok: true, entries: list };
}
