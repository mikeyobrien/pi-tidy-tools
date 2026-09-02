/** Bounded event log with monotonic sequence numbers and since-cursor replay. */
export interface SequencedEvent {
  seq: number;
  payload: Record<string, unknown>;
}

export function createEventLog(max = 500) {
  let seq = 0;
  const buffer: SequencedEvent[] = [];

  return {
    /** Assign the next sequence number, store, and return the wire payload. */
    publish(event: Record<string, unknown>): SequencedEvent {
      seq += 1;
      const sequenced: SequencedEvent = { seq, payload: { ...event, seq } };
      buffer.push(sequenced);
      if (buffer.length > max) buffer.shift();
      return sequenced;
    },
    get current(): number {
      return seq;
    },
    /** Events strictly after the cursor (bounded by the buffer). */
    since(cursor: number): SequencedEvent[] {
      return buffer.filter((event) => event.seq > cursor);
    },
  };
}

/**
 * Resolve a client `since` cursor to a safe replay cursor for `since()`.
 * Non-finite or negative cursors resolve to 0; cursors ahead of the current
 * sequence clamp to current; cursors older than the buffer window are pulled
 * to the window floor (the bounded log can only replay what it still holds).
 */
export function resolveSinceCursor(since: number, current: number): number {
  if (!Number.isFinite(since) || since < 0) return 0;
  const floor = Math.max(0, current - 500);
  return Math.min(Math.max(since, floor), current);
}
