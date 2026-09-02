// pi-tidy-bots in-session bridge extension.
// Loaded by the fleet runtime into every bot session (`pi -e <package>/src/bridge.ts`).
// Registers the message_agent tool (fleet handoffs) and the /bots-reload command
// (persona hot-apply). Expects PI_TIDY_BOTS_* env from the runtime.
//
// Non-coupling contract (ADR 0002): this extension provides ORCHESTRATION
// only — routed messages, reload. It never sets or changes the child's
// working directory, never assumes a project or fleet dir, and injects no
// scope. Bots are uncoupled by default; scoping is the operator's opt-in via
// steering, AGENTS.md, or the manifest's explicit `dir`.
import { Type } from "typebox";

interface BridgeDeps {
  daemonUrl: string;
  selfName: string;
  childSecret: string;
}

function deps(): BridgeDeps | null {
  const daemonUrl = process.env.PI_TIDY_BOTS_DAEMON_URL ?? "";
  const selfName = process.env.PI_TIDY_BOTS_NAME ?? "";
  const childSecret = process.env.PI_TIDY_BOTS_CHILD_SECRET ?? "";
  if (daemonUrl.length === 0 || selfName.length === 0) return null;
  return { daemonUrl, selfName, childSecret };
}

// Issue 62: bots are disclosed skills-style — name + description, where the
// description IS the recommendation. The message_agent target parameter
// enumerates every bot from the live runtime config (never hardcoded), so
// roster changes propagate via /bots-reload and hot-reconcile respawns.
//
// Pure and exported for unit tests; the async wiring below fetches the roster
// from the daemon before the tool is registered.
export function composeTargetDescription(
  bots: { name: string; title?: string; description?: string }[]
): string {
  const lines = bots.map(
    (bot) => `- ${bot.name} — ${bot.description ?? bot.title ?? ""}`
  );
  return (
    "Teammate bot name in this fleet (pick exactly one name):\n" +
    lines.join("\n")
  );
}

export default async function bridge(pi: any): Promise<void> {
  const environment = deps();
  if (!environment) return;
  const { daemonUrl, selfName, childSecret } = environment;

  // Live roster enumeration: the child secret bypasses token auth (see
  // daemon auth middleware), so a bot can read the fleet it belongs to.
  let targetDescription = "Teammate bot name in this fleet (e.g. forge)";
  try {
    const response = await fetch(`${daemonUrl}/api/fleet`, {
      headers: { "x-fleet-child": childSecret },
    });
    if (response.ok) {
      const data = (await response.json()) as {
        bots?: { name: string; title?: string; description?: string }[];
      };
      if (data.bots && data.bots.length > 0) {
        targetDescription = composeTargetDescription(data.bots);
      }
    }
  } catch {
    // Daemon unreachable (boot race): register with the generic fallback;
    // /bots-reload re-runs this extension and re-fetches.
  }

  pi.registerTool({
    name: "message_agent",
    label: "Message agent",
    description:
      "Send a composed message to a teammate bot in this fleet. Delivery is fire-and-forget: " +
      "you get an acknowledgement, finish your turn, and the teammate's reply arrives later " +
      "as a completion notification. Do not forward the operator's words verbatim — compose " +
      "your own message. Peer bots are for domain ownership; use subagents for throwaway work.",
    promptSnippet:
      "message_agent hands a task to a teammate bot (fire-and-forget handoff).",
    promptGuidelines: [
      "Use message_agent when a fix or task belongs to a teammate bot's domain; finish your turn after sending.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: targetDescription }),
      message: Type.String({
        description: "Your composed message to the teammate",
      }),
      images: Type.Optional(
        Type.Array(
          Type.Object({
            mediaType: Type.String({
              description: "MIME type, e.g. image/png",
            }),
            data: Type.String({
              description: "Base64 image bytes, no dataURL prefix",
            }),
          }),
          {
            description:
              "Optional images to attach (issue 75): every image rides the handoff prompt — no cap. Use for pixel-faithful dispatch (screenshots, builds).",
          }
        )
      ),
      behavior: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
          description:
            'Delivery behavior. "followUp": new work or the next task — queues until the current turn finishes, never interrupts. Use this unless you must change course now. ' +
            '"steer": redirect the CURRENT turn while it runs (corrections, priority changes, "stop because X") — only meaningful when the target is actively working; on an idle target it is delivered as a normal message. ' +
            "Omit for automatic: followUp when the target is busy, normal message when idle.",
        })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        target: string;
        message: string;
        images?: { mediaType: string; data: string }[];
        behavior?: "steer" | "followUp";
      }
    ) {
      let response: Response;
      try {
        response = await fetch(`${daemonUrl}/bus/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fleet-child": childSecret,
          },
          body: JSON.stringify({
            from: selfName,
            target: params.target,
            message: params.message,
            ...(params.images && params.images.length > 0
              ? { images: params.images }
              : {}),
            ...(params.behavior ? { behavior: params.behavior } : {}),
          }),
        });
      } catch (error) {
        return failed(
          `runtime_offline`,
          `Fleet bus unreachable: ${(error as Error).message}`
        );
      }
      const data = (await response.json().catch(() => ({}))) as {
        delivered?: boolean;
        reason?: string;
      };
      if (!response.ok || data.delivered !== true) {
        return failed(
          data.reason ?? "delivery_failed",
          `Delivery to ${params.target} failed.`
        );
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Delivered to ${params.target}. Fire-and-forget: finish your turn now; ` +
              `the reply arrives later as a completion notification.`,
          },
        ],
        details: { delivered: true, target: params.target },
      };
    },
  });

  // Issue 122: attach a one-line summary to this bot's latest peer-completion
  // entry — the receiving agent writes it during its turn; the daemon only
  // stores and serves it (summary-first rendering, issue 121).
  pi.registerTool({
    name: "completion_summary",
    label: "Completion summary",
    description:
      "Attach a one-line summary to the most recent completion entry on this " +
      "bot's transcript (a teammate's report that arrived as a Message from X). " +
      "Call it right after you finish reading/acting on a peer completion — the " +
      "summary is what the operator sees first. Keep it to one line.",
    promptSnippet:
      "completion_summary attaches your one-line summary to the latest peer completion.",
    promptGuidelines: [
      "After handling a teammate completion, attach a terse one-line summary with completion_summary.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        description: "One line, e.g. 'fixed the badge reason drop — re-landed as 93b927b'",
      }),
    }),
    async execute(_toolCallId: string, params: { summary: string }) {
      let response: Response;
      try {
        response = await fetch(
          `${daemonUrl}/api/bots/${selfName}/completion-summary`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-fleet-child": childSecret,
            },
            body: JSON.stringify({ summary: params.summary }),
          }
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Fleet bus unreachable: ${(error as Error).message} [reason: runtime_offline]`,
            },
          ],
          details: { attached: false, reason: "runtime_offline" },
        };
      }
      const data = (await response.json().catch(() => ({}))) as {
        attached?: boolean;
        error?: string;
      };
      if (!response.ok || data.attached !== true) {
        return {
          content: [
            {
              type: "text",
              text: `Summary not attached: ${data.error ?? response.status} [reason: ${data.error ?? "attach_failed"}]`,
            },
          ],
          details: { attached: false, reason: data.error ?? "attach_failed" },
        };
      }
      return {
        content: [
          { type: "text", text: "Summary attached to the latest completion entry." },
        ],
        details: { attached: true },
      };
    },
  });

  pi.registerCommand("bots-reload", {
    description:
      "Reload persona and context files without leaving the fleet session",
    handler: async (_args: unknown, ctx: any) => {
      await ctx.reload();
    },
  });

  function failed(reason: string, message: string) {
    return {
      content: [
        {
          type: "text",
          text: `${message} [reason: ${reason}]`,
        },
      ],
      details: { delivered: false, reason },
    };
  }
}
