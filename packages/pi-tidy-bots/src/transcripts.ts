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
 * Boot merge (issue 20 item 7, fixed by verifier FAIL): journal first, then
 * the child's hot history.
 *
 * Dedupe is a MULTISET on role+text — never on ts. The journal's ts is the
 * daemon append time while the child's mapped ts differs by milliseconds, so
 * a ts-aware key never matches and restarts duplicate history. Multiset
 * counting keeps genuinely repeated messages (e.g. two "ok" acks) intact.
 * The merged output is sorted by ts so chronology survives the merge.
 */
export function mergeTranscriptHistory<
  T extends { ts: string; role: string; text: string },
>(journaled: T[], incoming: T[]): T[] {
  const persisted = new Map<string, number>();
  for (const entry of journaled) {
    const key = `${entry.role}\u0000${entry.text}`;
    persisted.set(key, (persisted.get(key) ?? 0) + 1);
  }
  const merged = [...journaled];
  for (const entry of incoming) {
    const key = `${entry.role}\u0000${entry.text}`;
    const remaining = persisted.get(key) ?? 0;
    if (remaining > 0) {
      persisted.set(key, remaining - 1); // already journalled — skip.
    } else {
      merged.push(entry);
    }
  }
  return merged.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
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
