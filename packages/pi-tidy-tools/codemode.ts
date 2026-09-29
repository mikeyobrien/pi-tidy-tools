/**
 * Pi's `codemode` tool (Pi >= 0.99) under tidy.
 *
 * Tidy re-registers Pi's OWN codemode definition — produced by the host's
 * `createCodemodeExtension()` export — so behavior, the parameter schema
 * object, the raw-source sampling grammar, and `prepareLoadout` stay the
 * host's. The MCP extension recognizes codemode by schema identity
 * (`parameters === codemodeSchema`), so the schema must never be rebuilt.
 *
 * Because the schema cannot carry tidy's `reasoning` field, a script states
 * its goal in a leading `// @reasoning: <goal>` comment line (after the
 * optional `// @options:` line, which the host requires to be first). The
 * comment is plain JavaScript, so the sandbox ignores it.
 *
 * `outputReasoning` is an opt-in one-sentence summary of what a finished
 * script did, written by a nested model call. It is kept in `details` for the
 * card only; the main model never sees it.
 */

import type { SourceToolDefinition } from "./tool-composition.js";

export const CODEMODE_TOOL = "codemode";
export const REASONING_DIRECTIVE = "// @reasoning:";

const DIRECTIVE = /^\/\/\s*@reasoning:\s*(.*?)\s*$/;

export const CODEMODE_REASONING_GUIDELINE =
  'Start every codemode script with a "// @reasoning: <goal>" line (directly after the "// @options:" line when you use one) stating the GOAL of the script, not the tools it calls. Tools called from scripts do not take a "reasoning" argument.';

export const MISSING_REASONING_ERROR =
  'codemode scripts must start with a "// @reasoning: <goal>" line (after the "// @options:" line, if any) stating the GOAL of the script. Re-issue the call with that line.';

/**
 * The goal stated in a script's leading comment block, or undefined. Only the
 * comment lines before the first line of code are read, so a directive that
 * appears inside the program body is not a headline.
 */
export function scriptReasoning(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("//")) return undefined;
    const match = line.match(DIRECTIVE);
    if (match) return match[1] || undefined;
  }
  return undefined;
}

/** First line of actual code, for the card's detail when nothing better exists. */
export function firstCodeLine(code: unknown): string {
  if (typeof code !== "string") return "";
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("//")) return line;
  }
  return "";
}

type CodemodeFactory = () => (pi: any) => void;

/**
 * Run the host's codemode extension factory against `pi`, capturing the tool
 * it registers instead of registering it. Every other API call is forwarded,
 * so the definition's lazy reads (settings, namespaces, store entries) go to
 * the real host. Returns undefined when the host has no codemode export.
 */
export function captureCodemodeDefinition(
  pi: object,
  createCodemodeExtension: unknown
): SourceToolDefinition | undefined {
  if (typeof createCodemodeExtension !== "function") return undefined;
  let captured: SourceToolDefinition | undefined;
  const proxy = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool")
        return (tool: SourceToolDefinition) => {
          if (tool?.name === CODEMODE_TOOL) captured = tool;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  (createCodemodeExtension as CodemodeFactory)()(proxy);
  return captured;
}

interface NestedCall {
  name?: string;
  args?: string;
  status?: string;
  error?: string;
}

const SUMMARY_SYSTEM_PROMPT =
  "You summarize what a JavaScript tool-orchestration script just did. Reply with ONE plain sentence of at most 20 words, past tense, stating what it did and what it found or changed. No preamble, no markdown, no quotes.";

const MAX_SECTION_CHARS = 4000;

function clip(text: string, max = MAX_SECTION_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

function resultText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

/** The user message the summary model reads. */
export function summaryPrompt(code: string, result: any): string {
  const calls: NestedCall[] = Array.isArray(result?.details?.calls)
    ? result.details.calls
    : [];
  const callLines = calls.map(
    (call) =>
      `- ${call.name ?? "?"} ${call.args ?? ""} [${call.status ?? "?"}]${call.error ? ` ${call.error}` : ""}`
  );
  return [
    `Script:\n${clip(code)}`,
    `Tool calls (${calls.length}):\n${callLines.join("\n") || "(none)"}`,
    `${result?.isError ? "Failed" : "Output"}:\n${clip(resultText(result))}`,
  ].join("\n\n");
}

/**
 * Resolve the summary model: an explicit "provider/id" override, else the
 * session's current model. The provider is everything before the first "/",
 * since model ids may contain slashes ("groq/openai/gpt-oss-20b").
 */
export function resolveSummaryModel(
  ctx: any,
  override: string | undefined
): { model?: any; error?: string } {
  if (override) {
    const slash = override.indexOf("/");
    if (slash <= 0 || slash === override.length - 1)
      return { error: `outputReasoning model "${override}" is not provider/id` };
    const model = ctx?.modelRegistry?.find?.(
      override.slice(0, slash),
      override.slice(slash + 1)
    );
    return model
      ? { model }
      : { error: `outputReasoning model ${override} not found` };
  }
  return ctx?.model
    ? { model: ctx.model }
    : { error: "outputReasoning has no session model to inherit" };
}

/** Add two provider usages field by field (numbers and nested cost objects). */
export function addUsage(a: any, b: any): any {
  if (!a) return b;
  if (!b) return a;
  const sum: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = sum[key];
    if (typeof value === "number")
      sum[key] = (typeof current === "number" ? current : 0) + value;
    else if (value && typeof value === "object")
      sum[key] = addUsage(current, value);
  }
  return sum;
}

export interface OutputReasoning {
  text?: string;
  error?: string;
  usage?: unknown;
}

const SUMMARY_TIMEOUT_MS = 15_000;

/**
 * Ask a model for the one-sentence summary. Never throws: a failed or empty
 * summary comes back as `error`, which the card shows dimmed.
 */
export async function generateOutputReasoning(
  ctx: any,
  code: string,
  result: any,
  options: { model?: string; signal?: AbortSignal }
): Promise<OutputReasoning> {
  const resolved = resolveSummaryModel(ctx, options.model);
  if (!resolved.model) return { error: resolved.error };
  if (typeof ctx?.modelRegistry?.streamSimple !== "function")
    return { error: "outputReasoning needs Pi >= 0.99" };
  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const stream = ctx.modelRegistry.streamSimple(
      resolved.model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: summaryPrompt(code, result) }],
            timestamp: Date.now(),
          },
        ],
      },
      { signal, maxTokens: 120 }
    );
    const message = await stream.result();
    const text = (Array.isArray(message?.content) ? message.content : [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (message?.stopReason === "error" || message?.stopReason === "aborted")
      return {
        error: `outputReasoning failed: ${message.errorMessage ?? message.stopReason}`,
        usage: message.usage,
      };
    return text
      ? { text, usage: message?.usage }
      : { error: "outputReasoning returned no text", usage: message?.usage };
  } catch (error) {
    return {
      error: `outputReasoning failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
