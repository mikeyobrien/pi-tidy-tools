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
