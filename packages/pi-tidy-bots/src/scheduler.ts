// Time-driven layer of the fleet daemon (issue 94). Pure move out of
// daemon.ts: routine scheduling, cron ticking, and compaction policy.
// daemon.ts re-exports moved symbols so imports/tests are unchanged.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDue, minuteKey, parseCron } from "./cron.ts";

/**
 * Boot-time routine validation. A schedule parseCron rejects can never fire —
 * every scheduler tick throws and the catch skips the row — so surface each
 * one as a warning naming bot, routine, schedule, and reason. Fail-soft: the
 * fleet still boots and valid routines keep firing.
 */
export function routineBootWarnings(
  routines: { bot: string; name: string; schedule: string }[]
): string[] {
  const warnings: string[] = [];
  for (const routine of routines) {
    try {
      parseCron(routine.schedule);
    } catch {
      warnings.push(
        `routine "${routine.name}" for bot "${routine.bot}": schedule "${routine.schedule}" will never fire [reason: invalid cron]`
      );
    }
  }
  return warnings;
}

/**
 * One scheduler tick. A routine that is due but cannot fire (bot session null
 * or dead) is journaled as `skipped` [reason: bot_offline] and does not consume
 * its minute key — the next tick within the same minute retries. Only a
 * successful fire consumes the key and journals `fired`.
 */
export function runSchedulerTick<
  R extends { bot: string; name: string; schedule: string; enabled: boolean },
>(
  now: Date,
  deps: {
    routines: R[];
    firedKeys: Set<string>;
    fireRoutine: (routine: R, manual: boolean) => boolean;
    journal: (record: Record<string, unknown>) => void;
  }
): void {
  const minute = minuteKey(now);
  for (const routine of deps.routines) {
    if (!routine.enabled) continue;
    const key = `${routine.bot}:${routine.name}:${minute}`;
    if (deps.firedKeys.has(key)) continue;
    try {
      if (!isDue(now, routine.schedule)) continue;
    } catch {
      continue;
    }
    if (!deps.fireRoutine(routine, false)) {
      deps.journal({
        key,
        bot: routine.bot,
        routine: routine.name,
        status: "skipped",
        reason: "bot_offline",
        schedule: routine.schedule,
      });
      continue;
    }
    deps.firedKeys.add(key);
    deps.journal({
      key,
      bot: routine.bot,
      routine: routine.name,
      status: "fired",
      schedule: routine.schedule,
    });
  }
}

export type BusBehavior = "steer" | "followUp";
/**
 * Idempotency guard (issue 33): a clientMessageId may be claimed once per
 * bot. Unknown/absent ids always claim. Returns false on duplicate.
 */
export function journalCompaction(
  fleetDir: string,
  bot: string,
  data: {
    tokensBefore?: number;
    fill?: number;
    trigger: "threshold" | "idle" | "force";
    preambleChars?: number;
    /** Issue 43 amendment: failures are journaled, never silent. */
    success?: boolean;
    error?: string;
    escalated?: "session-reset";
    /** Fallback summarizer used when the context exceeded the window. */
    summarizer?: string;
  }
): void {
  try {
    const dir = join(fleetDir, ".fleet");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "compactions.jsonl"),
      `${JSON.stringify({ bot, ts: new Date().toISOString(), ...data })}\n`
    );
  } catch {
    // Best-effort, like every .fleet journal.
  }
}

// ── Issue 43 item 2: auto-compaction policy ───────────
export const COMPACT_TRIGGER = 0.6;
export const COMPACT_CEILING = 0.75;
export const COMPACT_SOFT_FLOOR = 0.45;
export const COMPACT_HYSTERESIS_TURNS = 10;
export const COMPACT_HYSTERESIS_MS = 30 * 60_000;

export interface CompactPolicyInput {
  fill?: number;
  turnsSinceCompact: number;
  lastCompactAt?: number;
  /** Pending question cards or undelivered handoff completions block. */
  hasPending: boolean;
  force?: boolean;
  idle?: boolean;
  now: number;
}

export function shouldAutoCompact(input: CompactPolicyInput): boolean {
  if (input.hasPending) return false;
  if (input.fill === undefined) return false;
  if (!input.force && input.lastCompactAt !== undefined) {
    // Hysteresis: both windows must clear (whichever is longer).
    const withinTurns = input.turnsSinceCompact < COMPACT_HYSTERESIS_TURNS;
    const withinMs = input.now - input.lastCompactAt < COMPACT_HYSTERESIS_MS;
    if (withinTurns || withinMs) return false;
  }
  if (input.force) return true;
  const floor = input.idle ? COMPACT_SOFT_FLOOR : COMPACT_TRIGGER;
  return input.fill >= floor;
}
