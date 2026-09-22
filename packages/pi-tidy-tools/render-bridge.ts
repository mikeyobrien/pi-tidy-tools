/**
 * Renderer-contract bridge between Pi and omp.
 *
 * Pi and omp hand tool renderers different argument shapes:
 *
 * | Host            | `renderCall(args, options, theme)` | `renderResult(result, options, theme, extra)` |
 * |-----------------|-------------------------------------|-----------------------------------------------|
 * | Pi (`renderShell: "self"`) | 3rd arg is a render context | 4th arg is a render context (`{ args, toolCallId, isError, invalidate }`) |
 * | omp (`inline`)  | 3rd arg is the theme        | 4th arg is the raw tool arguments |
 *
 * Callers locate the theme by shape (`bg`) rather than position. A missing
 * theme must not throw: Pi exits the process on an uncaught renderer exception,
 * and omp swallows it and falls back to the native card.
 */

/** Fields tidy draws from the host render context, when the host supplies one. */
export interface RenderContext {
  toolCallId?: string;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  args?: Record<string, unknown>;
  invalidate?: () => void;
}

export interface CallRenderInfo {
  args: Record<string, unknown>;
  isPartial: boolean;
  toolCallId?: string;
  invalidate?: () => void;
}

export interface ResultRenderInfo {
  args: Record<string, unknown>;
  isPartial: boolean;
  expanded: boolean;
  isError?: boolean;
  toolCallId?: string;
}

function asRenderContext(value: unknown): RenderContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const nestedArgs =
    "args" in candidate &&
    typeof candidate.args === "object" &&
    candidate.args !== null &&
    !Array.isArray(candidate.args);
  const known =
    "toolCallId" in candidate ||
    "invalidate" in candidate ||
    "renderContext" in candidate ||
    "argsComplete" in candidate ||
    "executionStarted" in candidate ||
    nestedArgs;
  return known ? (candidate as RenderContext) : undefined;
}

function asArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/** Pi passes `(args, theme, context)`; omp passes `(args, options, theme)`. */
export function callRenderInfo(
  args: unknown,
  options: unknown,
  third: unknown
): CallRenderInfo {
  const context = asRenderContext(third);
  const opts = asArgs(options);
  return {
    args: asArgs(args) ?? {},
    isPartial:
      context?.isPartial ?? (opts?.isPartial as boolean | undefined) ?? false,
    toolCallId: context?.toolCallId,
    invalidate: context?.invalidate,
  };
}

/**
 * Pi passes `(result, options, theme, context)`; omp passes
 * `(result, options, theme, args)`.
 */
export function resultRenderInfo(
  result: unknown,
  options: unknown,
  fourth: unknown
): ResultRenderInfo {
  const opts = asArgs(options);
  const asContext = asRenderContext(fourth);
  const args = asContext?.args ?? asArgs(fourth) ?? {};
  const resultRecord = asArgs(result);
  return {
    args,
    isPartial:
      asContext?.isPartial ?? (opts?.isPartial as boolean | undefined) ?? false,
    expanded:
      asContext?.expanded ?? (opts?.expanded as boolean | undefined) ?? false,
    isError:
      asContext?.isError ?? (resultRecord?.isError as boolean | undefined),
    toolCallId: asContext?.toolCallId,
  };
}

/** Pi exposes `invalidate()`; omp does not, so the timer is omitted there. */
export function elapsedTimer(
  invalidate: (() => void) | undefined,
  onTick: () => void,
  intervalMs = 1000
): ReturnType<typeof setInterval> | undefined {
  if (!invalidate) return undefined;
  const timer = setInterval(() => {
    onTick();
    invalidate();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export interface RenderTheme {
  bg(name: string, text: string): string;
}

function asTheme(value: unknown): RenderTheme | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.bg === "function"
    ? (candidate as unknown as RenderTheme)
    : undefined;
}

/** First argument that is actually a theme, regardless of host position. */
export function findTheme(...candidates: unknown[]): RenderTheme | undefined {
  for (const candidate of candidates) {
    const theme = asTheme(candidate);
    if (theme !== undefined) return theme;
  }
  return undefined;
}

/** Apply a background when a theme exists. Never throws. */
export function withBackground(
  theme: RenderTheme | undefined,
  name: string,
  text: string
): string {
  if (theme === undefined) return text;
  try {
    return theme.bg(name, text);
  } catch {
    return text;
  }
}
