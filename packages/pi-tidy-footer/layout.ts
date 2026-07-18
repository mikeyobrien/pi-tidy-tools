import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  CodexQuotaWindow,
  FooterPalette,
  FooterSnapshot,
} from "./types.js";

const SEPARATOR = " · ";
const MIN_GAP = 2;
const ERROR_WORDS = /\b(error|failed|failure|blocked|offline|degraded)\b/i;
const WARNING_WORDS = /\b(warn|warning|retry|stale|starting|stopping)\b/i;

export function sanitizeStatus(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

export function compactModelId(modelId = "no-model"): string {
  const aliases: Record<string, string> = {
    "gpt-5.6-luna": "luna",
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
  };
  const id = aliases[modelId] ?? sanitizeStatus(modelId.replace(/^.*\//, ""));
  return truncateToWidth(id, 14, "…");
}

function contextText(snapshot: FooterSnapshot, width: number): string {
  const percent = snapshot.contextPercent;
  const value =
    percent === null || percent === undefined ? "?" : `${Math.round(percent)}%`;
  const marker =
    typeof percent === "number" && percent > 90
      ? "!! "
      : typeof percent === "number" && percent > 70
        ? "! "
        : "";
  if (width >= 72 && snapshot.contextWindow) {
    return `${marker}ctx ${value}/${formatTokens(snapshot.contextWindow)}`;
  }
  return `${marker}ctx ${value}`;
}

function modelText(snapshot: FooterSnapshot, width: number): string {
  const model =
    width >= 96
      ? (snapshot.modelId ?? "no-model")
      : compactModelId(snapshot.modelId);
  if (!snapshot.thinkingLevel || snapshot.thinkingLevel === "off") return model;
  return width >= 72
    ? `${model} · ${snapshot.thinkingLevel}`
    : `${model}/${snapshot.thinkingLevel}`;
}

function locationText(snapshot: FooterSnapshot, width: number): string {
  const branch = sanitizeStatus(snapshot.branch ?? "");
  const rawDir = basename(snapshot.cwd) || snapshot.cwd || "~";
  const dir = sanitizeStatus(rawDir) || "~";
  if (width < 72) return branch || dir;
  return branch ? `${dir} (${branch})` : dir;
}

function quotaWindowLabel(
  window: CodexQuotaWindow | undefined,
  fallback: string
): string | undefined {
  if (!window) return undefined;
  const label =
    window.windowMinutes === 300
      ? "5h"
      : window.windowMinutes === 10_080
        ? "7d"
        : fallback;
  return `${label} ${Math.round(window.usedPercent)}%`;
}

interface StatusItem {
  text: string;
  severity: 0 | 1 | 2;
}

function quotaItems(snapshot: FooterSnapshot): StatusItem[] {
  if (!snapshot.quota) return [];
  return [
    [snapshot.quota.primary, "5h"],
    [snapshot.quota.secondary, "7d"],
  ].flatMap(([window, fallback]) => {
    const label = quotaWindowLabel(
      window as CodexQuotaWindow | undefined,
      fallback as string
    );
    if (!label) return [];
    const usedPercent = (window as CodexQuotaWindow).usedPercent;
    const severity: StatusItem["severity"] =
      usedPercent > 90 ? 0 : usedPercent > 70 ? 1 : 2;
    const marker = severity === 0 ? "!! " : severity === 1 ? "! " : "";
    return [{ text: `${marker}${label}`, severity }];
  });
}

function statusItems(
  statuses: ReadonlyMap<string, string> | undefined
): StatusItem[] {
  if (!statuses) return [];
  return [...statuses.entries()]
    .map(([key, value]) => {
      const text = sanitizeStatus(value);
      const severity: StatusItem["severity"] = ERROR_WORDS.test(text)
        ? 0
        : WARNING_WORDS.test(text)
          ? 1
          : 2;
      return { key, text, severity };
    })
    .filter((item) => item.text)
    .sort((a, b) => a.severity - b.severity || a.key.localeCompare(b.key));
}

function usageItems(snapshot: FooterSnapshot): string[] {
  if (!snapshot.usage) return [];
  const { input, output } = snapshot.usage;
  return [
    input ? `↑${formatTokens(input)}` : "",
    output ? `↓${formatTokens(output)}` : "",
  ].filter(Boolean);
}

function appendWhileFits(
  parts: string[],
  candidates: string[],
  maxWidth: number
): void {
  for (const candidate of candidates) {
    const next = [...parts, candidate].join(SEPARATOR);
    if (visibleWidth(next) <= maxWidth) parts.push(candidate);
  }
}

function capacityLeft(
  snapshot: FooterSnapshot,
  maxWidth: number,
  width: number
): { text: string; severity: 0 | 1 | 2 } {
  const parts: string[] = [];
  const statuses = statusItems(snapshot.statuses);
  const quotas = quotaItems(snapshot);
  let severity: 0 | 1 | 2 = 2;

  // Critical statuses and quotas displace routine accounting fields. Preserve
  // the first urgent item instead of hiding it when its prose is too long.
  for (const item of [...statuses, ...quotas]
    .filter(({ severity }) => severity < 2)
    .sort((a, b) => a.severity - b.severity)) {
    const next = [...parts, item.text].join(SEPARATOR);
    if (visibleWidth(next) <= maxWidth) {
      parts.push(item.text);
      severity = Math.min(severity, item.severity) as 0 | 1 | 2;
    } else if (parts.length === 0 && maxWidth > 0) {
      parts.push(truncateToWidth(item.text, maxWidth, "…"));
      severity = item.severity;
    }
  }

  appendWhileFits(
    parts,
    quotas.filter(({ severity }) => severity === 2).map(({ text }) => text),
    maxWidth
  );
  appendWhileFits(
    parts,
    statuses.filter(({ severity }) => severity === 2).map(({ text }) => text),
    maxWidth
  );

  if (parts.length === 0 || width >= 72) {
    appendWhileFits(parts, usageItems(snapshot), maxWidth);
  }

  return { text: parts.join(SEPARATOR), severity };
}

/**
 * Keep the right value anchored to the terminal edge. The left value receives
 * the flexible budget and is the only side truncated.
 */
export function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const fittedRight = truncateToWidth(right, width, "");
  const rightWidth = visibleWidth(fittedRight);
  if (!left || rightWidth >= width - MIN_GAP) {
    return `${" ".repeat(Math.max(0, width - rightWidth))}${fittedRight}`;
  }

  const leftBudget = Math.max(0, width - rightWidth - MIN_GAP);
  const fittedLeft = truncateToWidth(left, leftBudget, "…");
  const leftWidth = visibleWidth(fittedLeft);
  const padding = Math.max(MIN_GAP, width - leftWidth - rightWidth);
  return `${fittedLeft}${" ".repeat(padding)}${fittedRight}`;
}

function styleContext(
  text: string,
  percent: number | null | undefined,
  palette: FooterPalette
): string {
  if (typeof percent === "number" && percent > 90) return palette.error(text);
  if (typeof percent === "number" && percent > 70) return palette.warning(text);
  return palette.accent(text);
}

export function renderFooter(
  snapshot: FooterSnapshot,
  width: number,
  palette: FooterPalette
): string[] {
  if (width <= 0) return [];

  const location = locationText(snapshot, width);
  const model = modelText(snapshot, width);
  const first = alignSides(
    width < 32 ? "" : palette.dim(location),
    palette.accent(model),
    width
  );

  const context = contextText(snapshot, width);
  if (width < 32) {
    const urgent = statusItems(snapshot.statuses).find(
      ({ severity }) => severity < 2
    );
    const contextSeverity: StatusItem["severity"] =
      typeof snapshot.contextPercent === "number" &&
      snapshot.contextPercent > 90
        ? 0
        : typeof snapshot.contextPercent === "number" &&
            snapshot.contextPercent > 70
          ? 1
          : 2;
    const showStatus = urgent && urgent.severity <= contextSeverity;
    const second = showStatus
      ? urgent.severity === 0
        ? palette.error(urgent.text)
        : palette.warning(urgent.text)
      : styleContext(context, snapshot.contextPercent, palette);
    return [first, truncateToWidth(second, width, "")];
  }
  const contextWidth = visibleWidth(context);
  const leftBudget = Math.max(0, width - contextWidth - MIN_GAP);
  const capacity = capacityLeft(snapshot, leftBudget, width);
  const styledCapacity =
    capacity.severity === 0
      ? palette.error(capacity.text)
      : capacity.severity === 1
        ? palette.warning(capacity.text)
        : palette.dim(capacity.text);
  const styledContext = styleContext(context, snapshot.contextPercent, palette);
  const second = alignSides(styledCapacity, styledContext, width);

  return [first, second].map((line) => truncateToWidth(line, width, ""));
}
