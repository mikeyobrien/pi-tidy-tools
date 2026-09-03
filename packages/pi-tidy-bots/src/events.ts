/**
 * The RPC event pipeline (issue 184): per-kind handling of child RPC events.
 * Extracted from daemon.ts so the pipeline is one reviewable, independently
 * testable module; daemon.ts keeps lifecycle glue and supplies every state
 * access through RpcEventContext. Runtime dependencies on daemon.ts are
 * type-only, so there is no import cycle.
 */
import {
  autoUiAnswer,
  isFireAndForgetUiMethod,
  isInteractiveUiMethod,
  type RpcEvent,
  type UiAnswer,
} from "./rpc.ts";
import { randomUUID } from "node:crypto";
import { TurnPartsAccumulator } from "./turnparts.ts";
import { stripActionMarkers } from "./actions.ts";
import type { BotRuntime, TranscriptEntry, UiRequestView } from "./daemon.ts";
import type { PendingStore } from "./pending.ts";
import type { BotConfig, ToolOutputMode } from "./config.ts";

/**
 * Delta throttle decision (issue 20 item 6): emit when nothing was sent yet,
 * when >=300ms passed since the last emission, or when the cumulative text
 * grew by >=256 bytes - whichever comes first.
 */
export function deltaThrottleDue(
  last: { at: number; chars: number } | null,
  nextLength: number,
  now: number
): boolean {
  if (!last) return true;
  return now - last.at >= 300 || nextLength - last.chars >= 256;
}

/** How long a console question waits for the operator before auto-answering. */
const UI_AUTO_ANSWER_MS = 120_000;

/**
 * Issue 99-FAIL: touch only ACTIVITY-BEARING kinds. The old blanket
 * touch() stamped boot noise (session primers, extension status pings,
 * replay deltas) as "activity" — every idle bot showed the daemon's
 * boot second, and the poisoned values persisted via state.json.
 */
const ACTIVITY_EVENT_KINDS = new Set([
  "turn_start",
  "agent_start",
  "assistant_delta",
  "assistant_message",
  "tool_start",
  "tool_end",
  "tool_output",
  "usage",
]);

/** Every daemon-owned capability the event pipeline may call back into. */
export interface RpcEventContext {
  runtimes: Map<string, BotRuntime>;
  /** Live fleet roster - thunk: hot onboarding may reassign fleet.bots. */
  fleetBots: () => BotConfig[];
  pendingStore: Pick<PendingStore, "load" | "remove">;
  /** Live tool-output mode - thunk: the API can change it mid-flight. */
  activeToolOutput: () => ToolOutputMode;
  viewSteps: (
    steps: {
      toolCallId: string;
      name: string;
      reason: string;
      label?: string;
      started: number;
      duration?: number;
      output?: string;
      error?: boolean;
    }[]
  ) => {
    toolCallId: string;
    name: string;
    reason: string;
    label?: string;
    output?: string;
    duration?: number;
    error?: boolean;
  }[];
  computeFill: (tokens: number, window: number) => number | undefined;
  log: (line: string) => void;
  emit: (event: Record<string, unknown>) => void;
  emitRoster: () => void;
  touch: (runtime: BotRuntime) => void;
  appendTranscript: (runtime: BotRuntime, entry: TranscriptEntry) => void;
  resolveUi: (
    runtime: BotRuntime,
    view: UiRequestView,
    answer: UiAnswer,
    auto: boolean
  ) => void;
  maybeCompact: (
    runtime: BotRuntime,
    opts?: { force?: boolean; idle?: boolean }
  ) => Promise<unknown>;
}

export function createRpcEventHandler(
  ctx: RpcEventContext
): (runtime: BotRuntime, event: RpcEvent) => void {
  return (runtime, event) => {
    if (ACTIVITY_EVENT_KINDS.has(event.kind)) ctx.touch(runtime);
    const botName = runtime.config.name;
    switch (event.kind) {
      case "turn_start": {
        // A queued follow-up turn starts with turn_start, not agent_start —
        // the oldest queued message is now streaming: mark it delivered.
        if (runtime.queuedCount > 0) {
          runtime.queuedCount--;
          const head = ctx.pendingStore.load(botName)[0];
          if (head) {
            ctx.pendingStore.remove(botName, head.id);
            const delivered = runtime.transcript.find(
              (candidate) => candidate.id === head.id
            );
            if (delivered) {
              delivered.delivering = false;
              ctx.emit({ type: "append", bot: botName, entry: delivered });
            }
          }
          ctx.emitRoster();
        }
        return;
      }
      case "usage": {
        if (event.inputTokens !== undefined)
          runtime.inputTokens = event.inputTokens;
        if (runtime.contextWindow && runtime.inputTokens !== undefined)
          runtime.fill = ctx.computeFill(
            runtime.inputTokens,
            runtime.contextWindow
          );
        return;
      }
      case "agent_start": {
        // Issue 74: the child ACCEPTED a prompt — that entry is streaming,
        // not queued. delivering now means only "not yet accepted".
        if (runtime.activeDeliveryId) {
          const accepted = runtime.transcript.find(
            (candidate) => candidate.id === runtime.activeDeliveryId
          );
          runtime.activeDeliveryId = null;
          if (accepted?.delivering) {
            accepted.delivering = false;
            ctx.emit({ type: "append", bot: botName, entry: accepted });
          }
        }
        // Issue 148: replayed journal entries have no activeDeliveryId (it
        // died with the old daemon) — clear their delivering flags by id so
        // the operator bubble stops spinning after the restart replay.
        if (runtime.replayDeliveryIds.size > 0) {
          for (const id of runtime.replayDeliveryIds) {
            const replayed = runtime.transcript.find(
              (candidate) => candidate.id === id
            );
            if (replayed?.delivering) {
              replayed.delivering = false;
              ctx.emit({ type: "append", bot: botName, entry: replayed });
            }
          }
          runtime.replayDeliveryIds.clear();
        }
        runtime.turnId = randomUUID();
        runtime.turnText = "";
        runtime.steps = [];
        runtime.turnParts = new TurnPartsAccumulator();
        runtime.deltaSent = null;
        ctx.emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "working",
          steps: [],
        });
        return;
      }
      case "tool_start": {
        // Issue 61 layer 2: circuit breaker — 5 consecutive identical
        // tool_start events means the harness keeps rejecting the same call.
        const failSig = `${event.toolName}:${event.label ?? ""}`;
        if (
          runtime.toolFailStreak &&
          runtime.toolFailStreak.signature === failSig
        ) {
          runtime.toolFailStreak.count++;
        } else {
          runtime.toolFailStreak = { count: 1, signature: failSig };
        }
        if (runtime.toolFailStreak.count >= 5) {
          runtime.toolFailStreak = null;
          runtime.session?.abort();
          ctx.appendTranscript(runtime, {
            id: randomUUID(),
            role: "system",
            origin: "system",
            text: `Stopped: 5 identical tool failures \u2014 model/tool contract broken (${event.toolName}). Operator intervention required.`,
            ts: new Date().toISOString(),
          });
          ctx.log(
            `[${botName}] circuit breaker: 5 identical tool failures, turn aborted`
          );
          return;
        }
        runtime.turnParts.startTool({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          label: event.label,
          reason: event.reason,
          started: Date.now(),
          // Issue 128: message_agent dispatches carry the receipt ON the
          // tool part — the chip renders in-order at the call site; the
          // standalone receipt ENTRY is gone (single surface).
          ...(event.target
            ? {
                receipt: (() => {
                  const target = ctx
                    .fleetBots()
                    .find((bot) => bot.name === event.target);
                  return {
                    name: event.target,
                    ...(target?.avatar ? { avatar: target.avatar } : {}),
                    ...(target?.title ? { title: target.title } : {}),
                  };
                })(),
              }
            : {}),
        });
        runtime.steps.push({
          toolCallId: event.toolCallId,
          name: event.toolName,
          reason: event.reason,
          ...(event.label ? { label: event.label } : {}),
          started: Date.now(),
        });
        ctx.emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "parts",
          parts: runtime.turnParts.snapshot(),
        });
        if (ctx.activeToolOutput() !== "off") {
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: ctx.viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "tool_output": {
        runtime.toolFailStreak = null;
        runtime.turnParts.updateToolOutput(event.toolCallId, event.text);
        const step = [...runtime.steps]
          .reverse()
          .find((candidate) => candidate.toolCallId === event.toolCallId);
        if (step) step.output = event.text.slice(0, 1200);
        if (ctx.activeToolOutput() === "full") {
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: ctx.viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "tool_end": {
        // Issue 66: pi's tool_execution_end — THE settle event. Until this
        // mapping existed every tool stayed "running" and the settle
        // fallback flipped them all to error: every successful call rendered
        // failed, durations never displayed, and the 61 breaker's output
        // streak-reset never fired.
        const step = [...runtime.steps]
          .reverse()
          .find((candidate) => candidate.toolCallId === event.toolCallId);
        const duration =
          event.elapsedMs ?? (step ? Date.now() - step.started : undefined);
        if (!event.isError) runtime.toolFailStreak = null;
        runtime.turnParts.settleTool(event.toolCallId, {
          isError: event.isError,
          duration,
          output: event.result,
        });
        if (step) {
          step.output = event.result.slice(0, 1200);
          step.error = event.isError;
          if (duration !== undefined) step.duration = duration;
        }
        ctx.emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "parts",
          parts: runtime.turnParts.snapshot(),
        });
        if (ctx.activeToolOutput() === "full") {
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: ctx.viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "assistant_delta": {
        runtime.messageStreamed = true;
        runtime.turnText += event.delta;
        runtime.turnParts.appendText(event.delta);
        const text = stripActionMarkers(runtime.turnText);
        // Throttle: emit at most every ~300ms or ~256 bytes of growth. Frames
        // are cumulative, so dropped frames lose nothing; the settle path
        // always emits the final text.
        const now = Date.now();
        const last = runtime.deltaSent;
        if (deltaThrottleDue(last, text.length, now)) {
          runtime.deltaSent = { at: now, chars: text.length };
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "delta",
            // Server-side marker stripping: any WS client gets clean streaming
            // text. A marker line still open mid-stream becomes visible only
            // until its closing ]] arrives — the grammar is line-based.
            text,
          });
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "parts",
            parts: runtime.turnParts.snapshot(),
          });
        }
        return;
      }
      case "assistant_message": {
        // Issue 124: turnText is DERIVED from the parts model (append
        // semantics), never replaced by the latest message — the old
        // assignment wiped narration at every message boundary ("" at
        // tool-call-only ones). A message that streamed no deltas (arrived
        // whole) is appended so its text reaches the model exactly once.
        if (!runtime.messageStreamed && event.text.length > 0)
          runtime.turnParts.appendText(event.text);
        // Message boundary: narration blocks stay distinct parts (issue
        // 123's styling signal), and the boundary forces an emit so
        // paragraph completions land promptly.
        runtime.turnParts.splitText();
        runtime.turnText = runtime.turnParts.concatText();
        runtime.deltaSent = {
          at: Date.now(),
          chars: stripActionMarkers(runtime.turnText).length,
        };
        ctx.emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "delta",
          text: stripActionMarkers(runtime.turnText),
        });
        ctx.emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "parts",
          parts: runtime.turnParts.snapshot(),
        });
        return;
      }
      case "event": {
        // Issue 124: message boundaries reset the streamed flag — a message
        // that arrives whole (no deltas) is appended at assistant_message.
        const rawType = (event.raw as { type?: string } | undefined)?.type;
        if (rawType === "message_start") runtime.messageStreamed = false;
        return;
      }
      case "agent_settled": {
        const turnId = runtime.turnId;
        runtime.turnId = null;
        // Issue 124: canonical text = the full turn's narration from the
        // parts model — never the last message alone.
        const text = stripActionMarkers(runtime.turnParts.concatText());
        const entry: TranscriptEntry = {
          id: randomUUID(),
          role: "assistant",
          origin: "bot",
          originFrom: botName,
          text,
          ts: new Date().toISOString(),
          // Marker stripping applies to parts too: settled history never
          // carries [[action:]] lines in any surface.
          parts: runtime.turnParts.snapshot().map((part) => {
            if (part.type === "text")
              return { ...part, text: stripActionMarkers(part.text) };
            // Issue 49: "running" clears at settle — a turn cannot end
            // while a tool result is still owed.
            if (part.status === "running") part.status = "error";
            return part;
          }),
          ...(runtime.steps.length > 0
            ? {
                steps: runtime.steps.map((step) => ({
                  name: step.name,
                  duration: step.duration,
                })),
              }
            : {}),
        };
        ctx.appendTranscript(runtime, entry);
        if (turnId)
          ctx.emit({
            type: "bubble",
            bot: botName,
            turnId,
            phase: "final",
            text,
          });
        const pendingSources = runtime.pendingFrom;
        runtime.pendingFrom = [];
        for (const pendingFrom of pendingSources) {
          const source = ctx.runtimes.get(pendingFrom);
          if (!source) continue;
          // Issue 58 (grok-style): the completion is a transcript FACT on the
          // dispatcher, not a prompt. Prompting the dispatcher started a turn
          // on it (ping-pong pollution in the operator's chat); the report now
          // renders as a "Message from X" entry the dispatcher never answers.
          ctx.appendTranscript(source, {
            id: randomUUID(),
            role: "assistant",
            origin: "bot",
            originFrom: botName,
            kind: "completion",
            text,
            ts: new Date().toISOString(),
          });
          ctx.touch(source);
        }
        // Issue 43 amendment: a window-(re)learn that showed fill ≥ 60%
        // (model switch onto a smaller window, restart over a big session)
        // schedules a FORCED compaction here — the first settled boundary.
        const forceNext = runtime.forceCompactNext === true;
        runtime.forceCompactNext = false;
        void ctx
          .maybeCompact(runtime, forceNext ? { force: true } : {})
          .catch(() => {});
        return;
      }
      case "ui_request": {
        if (!event.id) return;
        if (isFireAndForgetUiMethod(event.method)) return; // status pings: not activity
        // A real interactive question is activity; status pings are not.
        ctx.touch(runtime);
        if (!isInteractiveUiMethod(event.method)) {
          // Unknown method: defuse it immediately so a future interactive UI
          // request can never wedge a turn. The child ignores unmatched
          // responses, so a cancelled answer is safe for any method.
          ctx.resolveUi(
            runtime,
            { id: event.id, method: event.method, title: event.title },
            { cancel: true },
            true
          );
          return;
        }
        if (runtime.pendingUi.has(event.id)) return;
        const view: UiRequestView = {
          id: event.id,
          method: event.method,
          title: event.title,
          ...(event.options ? { options: event.options } : {}),
          ...(event.message ? { message: event.message } : {}),
          ...(event.placeholder ? { placeholder: event.placeholder } : {}),
        };
        ctx.appendTranscript(runtime, {
          id: randomUUID(),
          role: "system",
          origin: "system",
          text: view.message ? `${view.title} — ${view.message}` : view.title,
          ts: new Date().toISOString(),
          ui: view,
        });
        const timer = setTimeout(() => {
          if (!runtime.pendingUi.delete(view.id)) return;
          ctx.resolveUi(
            runtime,
            view,
            autoUiAnswer(view.method, view.options),
            true
          );
        }, UI_AUTO_ANSWER_MS);
        runtime.pendingUi.set(view.id, { view, timer });
        return;
      }
      default:
        return;
    }
  };
}
