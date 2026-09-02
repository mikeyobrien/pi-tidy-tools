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
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_ROTATE_BYTES = 2_000_000;

export interface TranscriptStore {
  append(bot: string, entry: unknown): void;
  load(bot: string): unknown[];
  /** Issue 122: rewrite the journal (entry mutation, e.g. completion
   * summaries attached after append). Best-effort like every store here. */
  save(bot: string, entries: unknown[]): void;
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

    save(bot: string, entries: unknown[]): void {
      // Issue 122: rewrite the current generation only — the rotated
      // previous generation is history and stays untouched. Entries already
      // held by the previous generation are filtered out so the next
      // load() (previous + current) never yields duplicates.
      try {
        mkdirSync(dir, { recursive: true });
        let previousIds: Set<string> | null = null;
        try {
          if (
            existsSync(current(bot)) &&
            statSync(current(bot)).size >= capBytes
          ) {
            rmSync(previous(bot), { force: true });
            renameSync(current(bot), previous(bot));
          }
          if (existsSync(previous(bot))) {
            previousIds = new Set(
              readFileSync(previous(bot), "utf8")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                  try {
                    return String(
                      (JSON.parse(line) as { id?: unknown }).id ?? ""
                    );
                  } catch {
                    return "";
                  }
                })
            );
          }
        } catch {
          // Rotation/index of the previous generation is best-effort.
        }
        const toWrite =
          previousIds !== null
            ? entries.filter((entry) => {
                const id = (entry as { id?: unknown }).id;
                return typeof id !== "string" || !previousIds?.has(id);
              })
            : entries;
        writeFileSync(
          current(bot),
          toWrite.map((entry) => JSON.stringify(entry)).join("\n") +
            (toWrite.length > 0 ? "\n" : "")
        );
      } catch {
        // Journal writes are best-effort.
      }
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
    if (!Number.isInteger(limit) || limit <= 0)
      // Issue 180: reject fractional/garbage limits — "2.7" used to pass
      // isFinite and silently truncate. Integers only.
      return { ok: false, error: "limit must be a positive integer" };
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
