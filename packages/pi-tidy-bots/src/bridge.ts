// pi-tidy-bots in-session bridge extension.
// Loaded by the fleet runtime into every bot session (`pi -e <package>/src/bridge.ts`).
// Registers the message_agent tool (fleet handoffs) and the /bots-reload command
// (persona hot-apply). Expects PI_TIDY_BOTS_* env from the runtime.
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

export default function bridge(pi: any): void {
  const environment = deps();
  if (!environment) return;
  const { daemonUrl, selfName, childSecret } = environment;

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
      target: Type.String({ description: "Teammate bot name (e.g. forge)" }),
      message: Type.String({
        description: "Your composed message to the teammate",
      }),
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
