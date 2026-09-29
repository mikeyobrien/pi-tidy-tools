/**
 * pi-tidy-tools — tidy, reason-first tool output for pi.
 *
 * Model (per-tool 2-line block): each built-in tool renders its OWN compact
 * block inline in the transcript, in execution order, via the tool-renderer
 * path (renderShell: "self"). No collector, no above-editor widget, no
 * turn-end stamping — pi already renders tool components inline; we just make
 * them tight.
 *
 *     ✏️ edit put reasoning on line 1, detail on line 2
 *       index.ts → +28/-14
 *     ⚡ bash run the typecheck
 *       npx tsc --noEmit → done (1 lines)
 *
 * Line 1: {running mark?} {icon} {name} {reasoning headline}
 * Line 2:   {dim arg/command detail} → {colored summary}
 *
 * Why this beats the spacer floor: pi bakes a Spacer(1) inside every tool's
 * ToolExecutionComponent, so N default cards = N blank lines. BUT in
 * `renderShell: "self"` mode, ToolExecutionComponent.render() skips that baked
 * spacer — it emits ONE leading blank + the self-rendered content, and returns
 * [] when content is empty. So each tool = 1 separator + 2 tight lines.
 *
 * `reasoning`: built-in tools have no reasoning of their own, so we inject a
 * REQUIRED `reasoning` string param into each wrapped tool. The model must fill
 * it with the GOAL/intent behind the call (not the file or command, which are
 * already shown); we strip it before delegating and render it as the line-1
 * headline. If ever absent, line 1 falls back to the arg detail.
 *
 * C-o (app.tools.expand) expansion: renderResult receives `{ expanded }`.
 * Collapsed shows the 2-line block; expanded appends the tool's real output —
 * a colored line-numbered diff for code edits (details.diff), else raw content.
 *
 * MCP / foreign tools: NOT overridden — we only own the built-in factories, so
 * we can't re-register a foreign tool's rendering without its execute fn. They
 * keep their default inline card.
 *
 * Usage:  pi -e ./index.ts     (or install as a pi package)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
  CONFIG_PATH,
  loadTidyIcons,
  loadTidyMode,
  loadTidyOutputReasoning,
  loadTidyState,
  saveTidyEnabled,
  saveTidyIcons,
  saveTidyMode,
  saveTidyOutputReasoning,
  saveTidyOutputReasoningModel,
  type TidyMode,
} from "./config.js";
import {
  CODEMODE_REASONING_GUIDELINE,
  CODEMODE_TOOL,
  MISSING_REASONING_ERROR,
  addUsage,
  captureCodemodeDefinition,
  generateOutputReasoning,
  scriptReasoning,
} from "./codemode.js";
import { isOmpHost } from "./host-kind.js";
import { installReadGroupBridge } from "./read-group-bridge.js";
import { toRegistration } from "./registration.js";
import {
  callRenderInfo,
  elapsedTimer,
  findTheme,
  resultRenderInfo,
  withBackground,
} from "./render-bridge.js";


import {
  composeSourceTool,
  createDiffingWriteTool,
  withReasoning,
  type SourceToolDefinition,
} from "./tool-composition.js";
import {
  concisePiFffStatus,
  createPiFffIntegrationController,
  type PiFffIntegrationController,
} from "./pi-fff/controller.js";
import type { PiFffLifecyclePreview } from "./pi-fff/integration.js";

export { withReasoning } from "./tool-composition.js";

import {
  WidthAwareLines,
  buildToolBlock,
  buildTurnDiffBlock,
  fitToolLine,
  type TurnDiff,
} from "./block-render.js";
export {
  fitToolLine,
  formatElapsed,
  buildTurnDiffBlock,
  buildToolBlock,
} from "./block-render.js";
const DIFF_MSG_TYPE = "minimal-turn-diff";
const TIDY_COMPLETIONS = [
  "on",
  "off",
  "toggle",
  "status",
  "mode default",
  "mode reasoning",
  "mode result",
  "mode status",
  "icons on",
  "icons off",
  "icons status",
  "output-reasoning on",
  "output-reasoning off",
  "output-reasoning status",
  "output-reasoning model inherit",
  "pi-fff setup",
  "pi-fff status",
  "pi-fff teardown",
];

export interface TidyExtensionDependencies {
  cwd?: string;
  loadState?: typeof loadTidyState;
  loadMode?: typeof loadTidyMode;
  loadIcons?: typeof loadTidyIcons;
  saveIcons?: typeof saveTidyIcons;
  loadOutputReasoning?: typeof loadTidyOutputReasoning;
  /** The host's codemode extension factory; defaults to Pi's export. */
  createCodemodeExtension?: unknown;
  createIntegration?: (
    pi: ExtensionAPI,
    cwd: string
  ) => PiFffIntegrationController;
}

function previewText(preview: PiFffLifecyclePreview): string {
  return preview.changes
    .map(
      (change) =>
        `${change.scope}: ${change.settingsPath}\n${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`
    )
    .join("\n");
}

export function createTidyExtension(
  dependencies: TidyExtensionDependencies = {}
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const cwd = dependencies.cwd ?? process.cwd();
    const tidyState = (dependencies.loadState ?? loadTidyState)();
    const tidyMode = (dependencies.loadMode ?? loadTidyMode)();
    const tidyIcons = (dependencies.loadIcons ?? loadTidyIcons)();
    const persistIcons = dependencies.saveIcons ?? saveTidyIcons;
    const loadOutputReasoning =
      dependencies.loadOutputReasoning ?? loadTidyOutputReasoning;
    const integration =
      dependencies.createIntegration?.(pi, cwd) ??
      createPiFffIntegrationController({ pi: pi as any, cwd });
    let startupPlan:
      Awaited<ReturnType<PiFffIntegrationController["initialize"]>> | undefined;

    pi.registerCommand("tidy", {
      description: "Manage pi-tidy-tools state, layout, and pi-fff integration",
      getArgumentCompletions: (prefix) =>
        TIDY_COMPLETIONS.filter((value) =>
          value.startsWith(prefix.trim().toLowerCase())
        ).map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase();
        const piFff = action.match(/^pi-fff (setup|status|teardown)$/);
        if (piFff) {
          const operation = piFff[1] as "setup" | "status" | "teardown";
          const result = await integration.run(operation, {
            enabled: tidyState.enabled,
            confirm:
              ctx.hasUI === false
                ? undefined
                : async (preview) =>
                    ctx.ui.confirm(
                      `pi-fff ${preview.action}`,
                      previewText(preview)
                    ),
            reload:
              operation === "status"
                ? undefined
                : async () => {
                    ctx.ui.notify(
                      `pi-fff ${operation} committed; reloading.`,
                      "info"
                    );
                    await ctx.reload();
                    return;
                  },
          });
          if (result.reload === "requested") return;
          ctx.ui.notify(result.message, result.level);
          return;
        }
        if (action === "status" || action === "mode status") {
          const detail =
            tidyState.source === "environment"
              ? "PI_TIDY_TOOLS override"
              : tidyState.source === "file"
                ? CONFIG_PATH
                : "default; no config file";
          const status = (
            await integration.run("status", { enabled: tidyState.enabled })
          ).status;
          ctx.ui.notify(
            `pi-tidy-tools is ${tidyState.enabled ? "on" : "off"}, mode ${tidyMode}, icons ${tidyIcons ? "on" : "off"} (${detail}).\n${concisePiFffStatus(status)}.`,
            "info"
          );
          return;
        }
        const outputReasoning = args
          .trim()
          .match(/^output-reasoning (on|off|status|model\s+(\S+))$/i);
        if (outputReasoning) {
          const [, verb, model] = outputReasoning;
          try {
            if (/^(on|off)$/i.test(verb))
              await saveTidyOutputReasoning(verb.toLowerCase() === "on");
            else if (model)
              await saveTidyOutputReasoningModel(
                model.toLowerCase() === "inherit" ? undefined : model
              );
          } catch (error) {
            ctx.ui.notify(
              `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
          const current = loadOutputReasoning();
          ctx.ui.notify(
            `codemode outputReasoning is ${current.enabled ? "on" : "off"}, model ${current.model ?? "inherited from the session"}.`,
            "info"
          );
          return;
        }
        if (action === "icons status") {
          ctx.ui.notify(
            `pi-tidy-tools icons are ${tidyIcons ? "on" : "off"}.`,
            "info"
          );
          return;
        }
        const iconsMatch = action.match(/^icons (on|off)$/);
        if (iconsMatch) {
          const icons = iconsMatch[1] === "on";
          if (icons === tidyIcons) {
            ctx.ui.notify(
              `pi-tidy-tools icons are already ${icons ? "on" : "off"}.`,
              "info"
            );
            return;
          }
          try {
            await persistIcons(icons);
          } catch (error) {
            ctx.ui.notify(
              `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
          ctx.ui.notify(
            `pi-tidy-tools icons set to ${icons ? "on" : "off"}; reloading.`,
            "info"
          );
          await ctx.reload();
          return;
        }
        const modeMatch = action.match(/^mode (default|reasoning|result)$/);
        if (modeMatch) {
          const mode = modeMatch[1] as TidyMode;
          if (mode === tidyMode) {
            ctx.ui.notify(`pi-tidy-tools mode is already ${mode}.`, "info");
            return;
          }
          try {
            await saveTidyMode(mode);
          } catch (error) {
            ctx.ui.notify(
              `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
          ctx.ui.notify(
            `pi-tidy-tools mode set to ${mode}; reloading.`,
            "info"
          );
          await ctx.reload();
          return;
        }
        if (action !== "on" && action !== "off" && action !== "toggle") {
          ctx.ui.notify(
            "Usage: /tidy on|off|toggle|status|mode default|reasoning|result|status|icons on|off|status|output-reasoning on|off|status|model <provider/id>|inherit|pi-fff setup|status|teardown",
            "warning"
          );
          return;
        }
        if (tidyState.source === "environment") {
          ctx.ui.notify(
            "PI_TIDY_TOOLS overrides persistent settings; change or unset it first.",
            "warning"
          );
          return;
        }
        const enabled =
          action === "toggle" ? !tidyState.enabled : action === "on";
        if (enabled === tidyState.enabled) {
          ctx.ui.notify(
            `pi-tidy-tools is already ${enabled ? "on" : "off"}.`,
            "info"
          );
          return;
        }
        try {
          await saveTidyEnabled(enabled);
        } catch (error) {
          ctx.ui.notify(
            `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
          return;
        }
        ctx.ui.notify(
          `pi-tidy-tools ${enabled ? "enabled" : "disabled"}; reloading.`,
          "info"
        );
        await ctx.reload();
        return;
      },
    });

    startupPlan = await integration.initialize(tidyState.enabled);
    if (startupPlan.notice) {
      const notice = startupPlan.notice;
      pi.on("session_start", (_event: unknown, ctx: any) =>
        ctx.ui.notify(notice.message, notice.level)
      );
    }
    if (!tidyState.enabled) return;

    let currentTurn: TurnDiff[] = [],
      lastTurn: TurnDiff[] = [];
    const pathByCallId = new Map<string, string>();
    const startedAtByCallId = new Map<string, number>();
    const elapsedTimerByCallId = new Map<
      string,
      ReturnType<typeof setInterval>
    >();
    const ownedTools = new Set<string>();
    const codemodeActive = (): boolean => {
      try {
        return pi.getActiveTools().includes(CODEMODE_TOOL);
      } catch {
        return false;
      }
    };

    /**
     * Tidy's renderer pair for one tool. `renderCall` draws only while the
     * call streams and `renderResult` only once it settles: each phase has
     * exactly one owner, or the card prints twice.
     */
    const renderers = (name: string) => ({
      renderShell: "self",
      renderCall: (args: any, options: any, third: any) => {
        const info = callRenderInfo(args, options, third);
        if (!info.isPartial) return new Container();
        const id = info.toolCallId ?? "";
        if (info.invalidate && !elapsedTimerByCallId.has(id)) {
          const timer = elapsedTimer(info.invalidate, () => {});
          if (timer) elapsedTimerByCallId.set(id, timer);
        }
        let started = startedAtByCallId.get(id);
        if (started === undefined) {
          started = Date.now();
          startedAtByCallId.set(id, started);
        }
        const theme = findTheme(options, third);
        return new WidthAwareLines(
          () =>
            buildToolBlock(name, info.args, {}, {
              isPartial: true,
              elapsedMs: Date.now() - started!,
              mode: tidyMode,
              icons: tidyIcons,
            }),
          (text) => withBackground(theme, "toolPendingBg", text)
        );
      },
      renderResult: (
        result: any,
        options: any,
        third: any,
        fourth: any
      ) => {
        const info = resultRenderInfo(result, options, fourth);
        if (info.isPartial) return new Container();
        const isError = info.isError ?? result?.isError ?? false;
        const id = info.toolCallId ?? "";
        const started = startedAtByCallId.get(id);
        const timer = elapsedTimerByCallId.get(id);
        if (timer) clearInterval(timer);
        elapsedTimerByCallId.delete(id);
        startedAtByCallId.delete(id);
        const persisted = Number(result?.details?.piTidyElapsedMs);
        const elapsedMs = Number.isFinite(persisted)
          ? persisted
          : started === undefined
            ? 0
            : Date.now() - started;
        const theme = findTheme(options, third, fourth);
        const lines = buildToolBlock(name, info.args, result, {
          isError,
          expanded: info.expanded,
          elapsedMs,
          mode: tidyMode,
          icons: tidyIcons,
        });
        return new WidthAwareLines(lines, (text) =>
          withBackground(theme, isError ? "toolErrorBg" : "toolSuccessBg", text)
        );
      },
    });

    const decorate = (source: SourceToolDefinition): SourceToolDefinition => {
      const name = source.name;
      const tool = composeSourceTool(source, {
        mode: tidyMode,
        reasoningGuideline: `Always pass a "reasoning" phrase to ${name}: state the GOAL/intent, not the file or command (those are shown already).`,
        tolerateMissingReasoning: codemodeActive,
      });
      ownedTools.add(name);
      const decorated = {
        ...tool,
        name,
        ...renderers(name),
      } as SourceToolDefinition;
      return (isOmpHost() ? toRegistration(decorated) : decorated) as SourceToolDefinition;
    };

    /**
     * Pi's own codemode definition with tidy's card. The schema object,
     * grammar, and loadout hook are the host's, untouched; tidy requires the
     * script's `// @reasoning:` line and, when opted in, attaches the
     * outputReasoning summary to `details`.
     */
    const decorateCodemode = (
      source: SourceToolDefinition
    ): SourceToolDefinition => {
      const requireReasoning = tidyMode !== "result";
      ownedTools.add(CODEMODE_TOOL);
      return {
        ...source,
        ...(requireReasoning
          ? {
              promptGuidelines: [
                ...(source.promptGuidelines ?? []),
                CODEMODE_REASONING_GUIDELINE,
              ],
            }
          : {}),
        async execute(
          id: string,
          params: any,
          signal: any,
          onUpdate: any,
          context: any
        ) {
          if (requireReasoning && !scriptReasoning(params?.code))
            throw new Error(MISSING_REASONING_ERROR);
          const result = await source.execute.call(
            source,
            id,
            params,
            signal,
            onUpdate,
            context
          );
          const settings = loadOutputReasoning();
          if (!settings.enabled || signal?.aborted) return result;
          const summary = await generateOutputReasoning(
            context,
            String(params?.code ?? ""),
            result,
            { model: settings.model, signal }
          );
          const usage = addUsage(result?.usage, summary.usage);
          return {
            ...result,
            ...(usage === undefined ? {} : { usage }),
            details: {
              ...(result?.details ?? {}),
              ...(summary.text
                ? { outputReasoning: summary.text }
                : { outputReasoningError: summary.error }),
            },
          };
        },
        ...renderers(CODEMODE_TOOL),
      } as SourceToolDefinition;
    };

    pi.on("tool_execution_start", async (e: any) => {
      if (!startedAtByCallId.has(e.toolCallId))
        startedAtByCallId.set(e.toolCallId, Date.now());
      if (
        (e.toolName === "edit" || e.toolName === "write") &&
        typeof e?.args?.path === "string"
      )
        pathByCallId.set(e.toolCallId, e.args.path);
    });
    pi.on("tool_execution_end", async (e: any) => {
      const timer = elapsedTimerByCallId.get(e.toolCallId);
      if (timer) clearInterval(timer);
      elapsedTimerByCallId.delete(e.toolCallId);
      if (e.toolName !== "edit" && e.toolName !== "write") return;
      const path = pathByCallId.get(e.toolCallId);
      pathByCallId.delete(e.toolCallId);
      if (!e.isError)
        currentTurn.push({
          tool: e.toolName,
          path: path ?? "(unknown)",
          diff: (e?.result?.details?.diff as string | undefined) ?? "",
        });
    });
    pi.on("tool_result", async (e: any) => {
      if (!ownedTools.has(e.toolName)) return;
      const started = startedAtByCallId.get(e.toolCallId);
      if (started === undefined) return;
      return {
        details: {
          ...(e.details ?? {}),
          piTidyElapsedMs: Math.max(0, Date.now() - started),
        },
      };
    });
    pi.on("turn_end", async () => {
      lastTurn = currentTurn;
      currentTurn = [];
      pathByCallId.clear();
      startedAtByCallId.clear();
      for (const timer of elapsedTimerByCallId.values()) clearInterval(timer);
      elapsedTimerByCallId.clear();
    });
    pi.on("session_shutdown", async () => {
      for (const timer of elapsedTimerByCallId.values()) clearInterval(timer);
      elapsedTimerByCallId.clear();
    });
    pi.registerMessageRenderer(
      DIFF_MSG_TYPE,
      (message: any) =>
        new WidthAwareLines(
          message.details?.rows ?? String(message.content ?? "").split("\n")
        )
    );
    const showLastTurnDiff = (ctx: any) => {
      if (!lastTurn.length) {
        ctx.ui.notify("No file changes recorded in the last turn.", "info");
        return;
      }
      const rows = buildTurnDiffBlock(lastTurn, { icons: tidyIcons });
      pi.sendMessage({
        customType: DIFF_MSG_TYPE,
        content: rows.join("\n"),
        display: true,
        details: { rows },
      });
    };
    pi.registerCommand("diff", {
      description: "Show file changes (edit/write diffs) from the last turn",
      handler: async (_args, ctx) => showLastTurnDiff(ctx),
    });
    pi.registerShortcut("ctrl+shift+o", {
      description: "Show file changes from the last turn",
      handler: async (ctx) => showLastTurnDiff(ctx),
    });

    const sourceTools: Record<string, SourceToolDefinition> = {
      read: createReadTool(cwd) as SourceToolDefinition,
      write: createDiffingWriteTool(cwd) as SourceToolDefinition,
      edit: createEditTool(cwd) as SourceToolDefinition,
      bash: createBashTool(cwd) as SourceToolDefinition,
      grep: createGrepTool(cwd) as SourceToolDefinition,
      find: createFindTool(cwd) as SourceToolDefinition,
      ls: createLsTool(cwd) as SourceToolDefinition,
    };
    for (const [name, source] of Object.entries(sourceTools)) {
      if (startupPlan.skipTidyTools.has(name as "read" | "grep" | "find"))
        continue;
      if (name === "read") {
        installReadGroupBridge({
          render: (snapshot, width) => {
            const lines = [""];
            for (const entry of snapshot.entries) {
              const started = startedAtByCallId.get(entry.id);
              const persisted = Number(
                (
                  entry.result as
                    | { details?: { piTidyElapsedMs?: unknown } }
                    | undefined
                )?.details?.piTidyElapsedMs
              );
              const elapsedMs = Number.isFinite(persisted)
                ? persisted
                : started === undefined
                  ? 0
                  : Date.now() - started;
              for (const line of buildToolBlock("read", entry.args, entry.result ?? {}, {
                isError: entry.isError,
                isPartial: !entry.settled,
                expanded: snapshot.expanded,
                elapsedMs,
                mode: tidyMode,
                icons: tidyIcons,
              }))
                lines.push(fitToolLine(line, width));
            }
            return lines;
          },
        });
      }
      pi.registerTool(decorate(source) as any);
    }
    startupPlan.commit(decorate);

    // omp has no codemode; on Pi < 0.99 the export is absent.
    const codemodeSource = isOmpHost()
      ? undefined
      : captureCodemodeDefinition(
          pi,
          "createCodemodeExtension" in dependencies
            ? dependencies.createCodemodeExtension
            : (host as Record<string, unknown>).createCodemodeExtension
        );
    if (codemodeSource) pi.registerTool(decorateCodemode(codemodeSource) as any);

    // Issue 132: provider-abstracted image generation. Default provider
    // registrations (grok-build) load at import; further providers
    // register themselves against the seam without core edits.
    pi.registerTool(buildGenerateImageTool() as never);
  };
}

import { buildGenerateImageTool } from "./imagegen/tool.js";
import "./imagegen/providers/index.js";
const extension = createTidyExtension();
export default extension;
