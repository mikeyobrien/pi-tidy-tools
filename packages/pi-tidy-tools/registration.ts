/**
 * Fresh tool registration for omp.
 *
 * Spreading a host-built tool keeps identity markers that belong to the
 * host's own definition. omp only consults those markers on the SDK
 * `options.customTools` path, not on `pi.registerTool`, so dropping them is
 * hygiene rather than the render fix. Pi keeps the decorated object as-is.
 */

import type { SourceToolDefinition } from "./tool-composition.js";

export interface RegistrationShape {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: string;
  inline?: boolean;
  [key: string]: unknown;
}

const CARRIED_FIELDS = [
  "approval",
  "hidden",
  "defaultInactive",
  "loadMode",
  "deferrable",
  "strict",
  "readsSkillUris",
  "mcpServerName",
  "mcpToolName",
  "legacyName",
] as const;

export function toRegistration(source: SourceToolDefinition): RegistrationShape {
  const registration: RegistrationShape = {
    name: source.name,
    label: source.label ?? source.name,
    description: source.description ?? "",
    parameters: source.parameters,
    execute: source.execute,
  };
  for (const field of CARRIED_FIELDS) {
    if (field in source)
      registration[field] = (source as Record<string, unknown>)[field];
  }
  for (const field of [
    "renderCall",
    "renderResult",
    "renderShell",
    "inline",
    "onSession",
    "promptGuidelines",
  ]) {
    if (field in source)
      registration[field] = (source as Record<string, unknown>)[field];
  }
  return registration;
}
