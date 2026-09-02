/** Typed delivery-failure reasons (wire contract: [reason: <code>] / JSON reason fields). */
export type Reason =
  | "unknown_target"
  | "route_forbidden"
  | "action_forbidden"
  | "turn_in_flight"
  | "runtime_offline"
  | "delivery_timeout"
  | "rpc_prompt_timeout"
  | "context_overflow"
  | "provider_quota_limit"
  | "provider_rate_limit"
  | "provider_server_error"
  | "provider_auth_or_access"
  | "delivery_failed";

const RULES: [Reason, string[]][] = [
  [
    "provider_quota_limit",
    ["quota", "billing", "insufficient credits", "exceeded your"],
  ],
  ["provider_rate_limit", ["rate limit", "429", "too many requests"]],
  [
    "provider_auth_or_access",
    ["unauthorized", "invalid api key", "authentication", "401", "403"],
  ],
  [
    "context_overflow",
    ["context", "too large", "overflow", "token limit", "maximum.*tokens"],
  ],
  ["runtime_offline", ["offline", "not running", "closed", "exited", "dead"]],
  ["turn_in_flight", ["already processing"]],
  // Issue 149: prompt-class timeout = UNKNOWN (accepted-and-running is
  // possible under the accept-ack contract) — never a plain failure.
  ["rpc_prompt_timeout", ["rpc_prompt_timeout"]],
];

/** Failures where one retry can actually help. Everything else fails fast. */
export const RETRYABLE: Reason[] = [
  "runtime_offline",
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
];

export function classifyFailure(message: string): Reason {
  const lowered = message.toLowerCase();
  for (const [reason, needles] of RULES) {
    for (const needle of needles) {
      if (lowered.includes(needle)) return reason;
    }
  }
  return "delivery_failed";
}

export function isRetryable(reason: string): boolean {
  return (RETRYABLE as string[]).includes(reason);
}
