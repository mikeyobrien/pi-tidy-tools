/**
 * Transcript `delivering` lifecycle (issue 74 + sticky-flag P0).
 *
 * `delivering:true` means "not yet accepted by the child" (queued follow-up
 * or the accept-ack window). It must never stay true forever:
 *   - agent_start / turn_start clear the matching entry
 *   - settle / idle+empty-pending clear leftovers
 *   - age ≥ STALE expires even an unknown timeout (issue 149)
 *
 * Journal appends write the flag once; callers must persist clears via
 * `transcripts.save` or the next boot rehydrates forever-true bubbles.
 */

/** Matches the prompt-class guard — a flag older than this is sticky. */
export const DEFAULT_STALE_DELIVERING_MS = 10 * 60_000;

export interface DeliveringFlag {
  id: string;
  delivering?: boolean;
  ts: string;
}

export function deliveringAgeMs(entry: { ts: string }, now: number): number {
  const ts = Date.parse(entry.ts);
  if (Number.isNaN(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - ts);
}

export function isStaleDelivering(
  entry: DeliveringFlag,
  now: number,
  maxAgeMs: number = DEFAULT_STALE_DELIVERING_MS
): boolean {
  return entry.delivering === true && deliveringAgeMs(entry, now) >= maxAgeMs;
}

export function listStaleDelivering<T extends DeliveringFlag>(
  entries: readonly T[],
  now: number,
  maxAgeMs: number = DEFAULT_STALE_DELIVERING_MS
): T[] {
  return entries.filter((entry) => isStaleDelivering(entry, now, maxAgeMs));
}

export interface ReconcileDeliveringOptions {
  now?: number;
  pendingIds?: Iterable<string>;
  activeDeliveryId?: string | null;
  streaming?: boolean;
  /** True at agent_settled / interrupted-turn recovery — queued follow-ups stay. */
  settled?: boolean;
  maxAgeMs?: number;
}

/**
 * Clear sticky `delivering` flags in place. Returns the entries that flipped.
 *
 * Keep:
 *   - pending-journal ids (queued follow-ups; turn_start pops them)
 *   - the accept-window id until settle or stale (issue 149 unknown timeout)
 * Expire:
 *   - any flag older than maxAgeMs
 *   - non-pending leftovers once the turn settled or the child is idle
 */
export function reconcileDelivering<T extends DeliveringFlag>(
  entries: T[],
  opts: ReconcileDeliveringOptions = {}
): T[] {
  const now = opts.now ?? Date.now();
  const pending = new Set(opts.pendingIds ?? []);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_DELIVERING_MS;
  const cleared: T[] = [];
  for (const entry of entries) {
    if (entry.delivering !== true) continue;
    const queued = pending.has(entry.id);
    const accepting = entry.id === opts.activeDeliveryId;
    if (isStaleDelivering(entry, now, maxAgeMs)) {
      entry.delivering = false;
      cleared.push(entry);
      continue;
    }
    if (queued) continue;
    if (accepting && !opts.settled) continue;
    if (opts.settled || !opts.streaming) {
      entry.delivering = false;
      cleared.push(entry);
    }
  }
  return cleared;
}
