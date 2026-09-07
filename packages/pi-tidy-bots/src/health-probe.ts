/**
 * Fail-closed fleet health verdict. Used by `pi-tidy-bots health` and the
 * packaged `scripts/health-probe.sh`. Atlas's rook-tree copy at
 * `bots/atlas/health-probe.sh` is not this repo — Foreman should point it
 * here.
 */
import { pathToFileURL } from "node:url";
import {
  DEFAULT_STALE_DELIVERING_MS,
  deliveringAgeMs,
  listStaleDelivering,
  type DeliveringFlag,
} from "./delivering.ts";

export interface ContextSnapshot {
  inputTokens?: number | null;
  contextWindow?: number | null;
  overWindow?: boolean;
  fill?: number | null;
}

export interface BotHealthInput {
  name: string;
  transcript: DeliveringFlag[];
  context?: ContextSnapshot;
}

export interface StaleDeliveringReport {
  id: string;
  ts: string;
  ageMs: number;
}

export interface BotHealthVerdict {
  name: string;
  ok: boolean;
  staleDelivering: StaleDeliveringReport[];
  overBudget: boolean;
  inputTokens: number | null;
  contextWindow: number | null;
  reasons: string[];
}

export interface FleetHealthVerdict {
  ok: boolean;
  staleDeliveringMs: number;
  tokenBudget?: number;
  bots: BotHealthVerdict[];
}

export interface EvaluateFleetHealthOptions {
  now?: number;
  staleDeliveringMs?: number;
  tokenBudget?: number;
}

export function contextOverBudget(
  context: ContextSnapshot | undefined,
  tokenBudget?: number
): boolean {
  if (!context) return false;
  if (context.overWindow === true) return true;
  if (context.fill !== undefined && context.fill !== null && context.fill >= 1)
    return true;
  const tokens = context.inputTokens;
  if (tokens == null || !Number.isFinite(tokens)) return false;
  const budget =
    tokenBudget ??
    (context.contextWindow != null && context.contextWindow > 0
      ? context.contextWindow
      : undefined);
  return budget != null && tokens > budget;
}

export function evaluateBotHealth(
  bot: BotHealthInput,
  opts: EvaluateFleetHealthOptions = {}
): BotHealthVerdict {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleDeliveringMs ?? DEFAULT_STALE_DELIVERING_MS;
  const stale = listStaleDelivering(bot.transcript, now, staleMs).map(
    (entry) => ({
      id: entry.id,
      ts: entry.ts,
      ageMs: deliveringAgeMs(entry, now),
    })
  );
  const overBudget = contextOverBudget(bot.context, opts.tokenBudget);
  const reasons: string[] = [];
  if (stale.length > 0)
    reasons.push(
      `${stale.length} transcript delivering:true older than ${staleMs}ms`
    );
  if (overBudget) reasons.push("context over budget");
  return {
    name: bot.name,
    ok: stale.length === 0 && !overBudget,
    staleDelivering: stale,
    overBudget,
    inputTokens: bot.context?.inputTokens ?? null,
    contextWindow: bot.context?.contextWindow ?? null,
    reasons,
  };
}

export function evaluateFleetHealth(
  bots: BotHealthInput[],
  opts: EvaluateFleetHealthOptions = {}
): FleetHealthVerdict {
  const verdicts = bots.map((bot) => evaluateBotHealth(bot, opts));
  return {
    ok: verdicts.every((bot) => bot.ok),
    staleDeliveringMs: opts.staleDeliveringMs ?? DEFAULT_STALE_DELIVERING_MS,
    ...(opts.tokenBudget !== undefined
      ? { tokenBudget: opts.tokenBudget }
      : {}),
    bots: verdicts,
  };
}

export async function probeFleetHealth(input: {
  url: string;
  bots?: string[];
  token?: string;
  staleDeliveringMs?: number;
  tokenBudget?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<FleetHealthVerdict> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(new URL(path, input.url).href, { headers });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  };

  try {
    const health = (await get("/api/health")) as FleetHealthVerdict & {
      ok?: boolean;
      bots?: BotHealthVerdict[];
    };
    if (health && Array.isArray(health.bots) && typeof health.ok === "boolean")
      return health;
  } catch {
    // Pre-/api/health daemons: compose from transcript + context.
  }

  const roster = (await get("/api/fleet")) as {
    bots?: { name: string }[];
  };
  const names =
    input.bots && input.bots.length > 0
      ? input.bots
      : (roster.bots ?? []).map((bot) => bot.name);
  const snapshots: BotHealthInput[] = [];
  for (const name of names) {
    const [transcriptBody, context] = await Promise.all([
      get(`/api/bots/${encodeURIComponent(name)}/transcript`),
      get(`/api/bots/${encodeURIComponent(name)}/context`).catch(
        () => undefined
      ),
    ]);
    const transcript = Array.isArray(transcriptBody)
      ? transcriptBody
      : ((transcriptBody as { transcript?: unknown })?.transcript ?? []);
    snapshots.push({
      name,
      transcript: Array.isArray(transcript)
        ? (transcript as DeliveringFlag[])
        : [],
      context: context as ContextSnapshot | undefined,
    });
  }
  return evaluateFleetHealth(snapshots, {
    now: input.now,
    staleDeliveringMs: input.staleDeliveringMs,
    tokenBudget: input.tokenBudget,
  });
}

export function parseHealthProbeArgs(argv: string[]): {
  url: string;
  bots?: string[];
  token?: string;
  staleDeliveringMs?: number;
  tokenBudget?: number;
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index++;
      }
    } else positional.push(arg);
  }
  const staleMin = flags["stale-min"];
  const budget = flags["token-budget"];
  return {
    url: flags.url ?? positional[0] ?? "http://127.0.0.1:4317",
    ...(flags.bot ? { bots: [flags.bot] } : {}),
    ...(flags.token ? { token: flags.token } : {}),
    ...(staleMin !== undefined
      ? { staleDeliveringMs: Number(staleMin) * 60_000 }
      : {}),
    ...(budget !== undefined ? { tokenBudget: Number(budget) } : {}),
  };
}

export async function runHealthProbeCli(
  argv: string[],
  io: {
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {}
): Promise<number> {
  const args = parseHealthProbeArgs(argv);
  if (
    (args.staleDeliveringMs !== undefined &&
      !Number.isFinite(args.staleDeliveringMs)) ||
    (args.tokenBudget !== undefined && !Number.isFinite(args.tokenBudget))
  ) {
    (io.error ?? console.error)(
      JSON.stringify({
        ok: false,
        error: "stale-min and token-budget must be numbers",
      })
    );
    return 1;
  }
  try {
    const verdict = await probeFleetHealth({
      ...args,
      fetchImpl: io.fetchImpl,
    });
    const sink = verdict.ok
      ? (io.log ?? console.log)
      : (io.error ?? console.error);
    sink(JSON.stringify(verdict));
    return verdict.ok ? 0 : 1;
  } catch (error) {
    (io.error ?? console.error)(
      JSON.stringify({ ok: false, error: String(error) })
    );
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runHealthProbeCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(JSON.stringify({ ok: false, error: String(error) }));
      process.exit(1);
    }
  );
}
