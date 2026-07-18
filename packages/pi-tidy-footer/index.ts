import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CodexBarPoller } from "./codexbar.js";
import { renderFooter } from "./layout.js";
import type { FooterPalette, FooterSnapshot, FooterUsage } from "./types.js";

export { CodexBarPoller, parseCodexBarJson, runCodexBar } from "./codexbar.js";
export {
  alignSides,
  compactModelId,
  formatTokens,
  renderFooter,
  sanitizeStatus,
} from "./layout.js";
export type {
  CodexQuotaSnapshot,
  CodexQuotaWindow,
  FooterPalette,
  FooterSnapshot,
  FooterUsage,
} from "./types.js";

export interface FooterExtensionOptions {
  poller?: CodexBarPoller;
}

function collectUsage(ctx: ExtensionContext): FooterUsage {
  const usage: FooterUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const message = entry.message as AssistantMessage;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
  }
  return usage;
}

function palette(theme: ExtensionContext["ui"]["theme"]): FooterPalette {
  return {
    dim: (text) => theme.fg("dim", text),
    accent: (text) => theme.fg("accent", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
  };
}

export function createFooterExtension(options: FooterExtensionOptions = {}) {
  return function footerExtension(pi: ExtensionAPI): void {
    const poller = options.poller ?? new CodexBarPoller();
    let enabled = true;
    let requestRender: (() => void) | undefined;

    const install = (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui" || !enabled) return;

      ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => tui.requestRender();
        const unsubscribe = footerData.onBranchChange(requestRender);
        return {
          invalidate() {},
          dispose() {
            unsubscribe();
            requestRender = undefined;
          },
          render(width: number): string[] {
            const context = ctx.getContextUsage();
            const snapshot: FooterSnapshot = {
              cwd: ctx.cwd,
              branch: footerData.getGitBranch(),
              modelId: ctx.model?.id,
              provider: ctx.model?.provider,
              thinkingLevel: pi.getThinkingLevel(),
              contextPercent: context?.percent,
              contextWindow: context?.contextWindow ?? ctx.model?.contextWindow,
              usage: collectUsage(ctx),
              quota:
                ctx.model?.provider === "openai-codex"
                  ? poller.snapshot
                  : undefined,
              statuses: footerData.getExtensionStatuses(),
            };
            return renderFooter(snapshot, width, palette(theme));
          },
        };
      });

      if (ctx.model?.provider === "openai-codex") {
        poller.start(() => requestRender?.());
      }
    };

    pi.on("session_start", (_event, ctx) => install(ctx));

    pi.on("model_select", (event) => {
      if (event.model.provider === "openai-codex") {
        poller.start(() => requestRender?.());
        void poller.refresh(() => requestRender?.());
      } else {
        poller.stop();
      }
      requestRender?.();
    });

    pi.on("thinking_level_select", () => requestRender?.());
    pi.on("message_end", () => requestRender?.());

    pi.on("session_shutdown", () => {
      poller.stop();
      requestRender = undefined;
    });

    pi.registerCommand("tidy-footer", {
      description: "Control or inspect the responsive footer",
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase() || "status";
        if (action === "default" || action === "off") {
          enabled = false;
          poller.stop();
          ctx.ui.setFooter(undefined);
          ctx.ui.notify("Default Pi footer restored", "info");
          return;
        }
        if (action === "on" || action === "auto") {
          enabled = true;
          install(ctx);
          ctx.ui.notify("Responsive footer enabled", "info");
          return;
        }
        if (action === "refresh") {
          await poller.refresh(() => requestRender?.());
          ctx.ui.notify(
            poller.lastError
              ? `CodexBar: ${poller.lastError}`
              : "CodexBar quotas refreshed",
            poller.lastError ? "warning" : "info"
          );
          return;
        }
        if (action !== "status") {
          ctx.ui.notify(
            "Usage: /tidy-footer [status|refresh|on|default]",
            "warning"
          );
          return;
        }
        const source = poller.snapshot
          ? `5h ${Math.round(poller.snapshot.primary.usedPercent)}%${poller.snapshot.secondary ? `, 7d ${Math.round(poller.snapshot.secondary.usedPercent)}%` : ""}`
          : poller.lastError
            ? `CodexBar unavailable: ${poller.lastError}`
            : "CodexBar pending";
        ctx.ui.notify(
          `Responsive footer ${enabled ? "on" : "off"}; ${source}`,
          "info"
        );
      },
    });
  };
}

export default createFooterExtension();
