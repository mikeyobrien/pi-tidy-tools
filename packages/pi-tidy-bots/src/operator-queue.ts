/**
 * Issue 159: the operator attention queue — a serialized, one-at-a-time
 * queue for whatever needs the operator (pending.ts / routines.jsonl
 * idioms). Journal: .fleet/operator-queue.jsonl rows
 * {id, title, receipts, source, addedAt, status: queued|pinged|cleared}.
 * The zero-or-one-pinged invariant is enforced on EVERY write.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface QueueReceipt {
  /** Short ref (issue number, hash, URL) shown with the item. */
  ref: string;
  /** One-line detail. */
  detail?: string;
}

export interface OperatorQueueItem {
  id: string;
  title: string;
  receipts: QueueReceipt[];
  /** Who enqueued (bot name, "daemon", "operator"). */
  source: string;
  addedAt: string;
  status: "queued" | "pinged" | "cleared";
  /** Set when promoted to pinged / cleared. */
  pingedAt?: string;
  clearedAt?: string;
}

export interface OperatorQueueView {
  pinged: OperatorQueueItem | null;
  queued: OperatorQueueItem[];
  counts: { pinged: number; queued: number; cleared: number };
}

export interface OperatorQueueStore {
  view(): OperatorQueueView;
  enqueue(input: {
    title: string;
    receipts?: QueueReceipt[];
    source: string;
  }): OperatorQueueItem;
  clear(
    id: string
  ): { cleared: OperatorQueueItem; promoted?: OperatorQueueItem } | null;
}

export function createOperatorQueueStore(fleetDir: string): OperatorQueueStore {
  const file = join(fleetDir, ".fleet", "operator-queue.jsonl");

  /** Per-line tolerant load (issue 143 idiom): torn lines skip loudly. */
  const loadAll = (): OperatorQueueItem[] => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const items: OperatorQueueItem[] = [];
    let torn = 0;
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        items.push(JSON.parse(line) as OperatorQueueItem);
      } catch {
        torn++;
      }
    }
    if (torn > 0) {
      console.error(
        `[operator-queue] skipped ${torn} torn journal line(s) — well-formed rows kept`
      );
    }
    return items;
  };

  const writeAll = (items: OperatorQueueItem[]): void => {
    try {
      mkdirSync(join(fleetDir, ".fleet"), { recursive: true });
      writeFileSync(
        file,
        items.map((item) => JSON.stringify(item)).join("\n") +
          (items.length > 0 ? "\n" : "")
      );
    } catch {
      // Journal writes are best-effort.
    }
  };

  /**
   * The invariant: zero-or-one pinged, ALWAYS. Used after any mutation —
   * replayed journals with a corrupted state (2 pinged) self-heal to 1.
   */
  const enforceInvariant = (
    items: OperatorQueueItem[]
  ): { items: OperatorQueueItem[]; repaired: boolean } => {
    const pinged = items.filter((item) => item.status === "pinged");
    if (pinged.length <= 1) return { items, repaired: false };
    // Demote extras back to queued (oldest pinged stays).
    let seen = false;
    let repaired = false;
    const next = items.map((item) => {
      if (item.status !== "pinged") return item;
      if (!seen) {
        seen = true;
        return item;
      }
      repaired = true;
      const { pingedAt, ...rest } = item;
      void pingedAt;
      return { ...rest, status: "queued" as const };
    });
    return { items: next, repaired };
  };

  const writeEnforced = (items: OperatorQueueItem[]): void => {
    const { items: enforced, repaired } = enforceInvariant(items);
    if (repaired)
      console.error(
        "[operator-queue] repaired corrupted state (multiple pinged → one)"
      );
    writeAll(enforced);
  };

  const view = (): OperatorQueueView => {
    const { items } = enforceInvariant(loadAll());
    const pinged = items.filter((item) => item.status === "pinged");
    const queued = items
      .filter((item) => item.status === "queued")
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    const cleared = items.filter((item) => item.status === "cleared");
    return {
      pinged: pinged[0] ?? null,
      queued,
      counts: {
        pinged: pinged.length,
        queued: queued.length,
        cleared: cleared.length,
      },
    };
  };

  const enqueue = (input: {
    title: string;
    receipts?: QueueReceipt[];
    source: string;
  }): OperatorQueueItem => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: OperatorQueueItem = {
      id,
      title: input.title,
      receipts: input.receipts ?? [],
      source: input.source,
      addedAt: new Date().toISOString(),
      status: "queued",
    };
    const items = loadAll();
    // Promote immediately when nothing is pinged — the operator sees the
    // first item without waiting for a clear that never comes.
    const hasPinged = enforceInvariant(items).items.some(
      (candidate) => candidate.status === "pinged"
    );
    if (!hasPinged) {
      item.status = "pinged";
      item.pingedAt = new Date().toISOString();
    }
    appendFileSync;
    writeEnforced([...items, item]);
    return item;
  };

  const clear = (
    id: string
  ): { cleared: OperatorQueueItem; promoted?: OperatorQueueItem } | null => {
    const items = enforceInvariant(loadAll()).items;
    const target = items.find((item) => item.id === id);
    if (!target || target.status === "cleared") return null;
    target.status = "cleared";
    target.clearedAt = new Date().toISOString();
    // Promote exactly one queued (oldest first) — the invariant's other half.
    let promoted: OperatorQueueItem | undefined;
    if (target.status !== undefined) {
      const nextQueued = items
        .filter((item) => item.status === "queued")
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt))[0];
      if (nextQueued) {
        nextQueued.status = "pinged";
        nextQueued.pingedAt = new Date().toISOString();
        promoted = nextQueued;
      }
    }
    writeEnforced(items);
    return { cleared: target, ...(promoted ? { promoted } : {}) };
  };

  void existsSync;
  return { view, enqueue, clear };
}
