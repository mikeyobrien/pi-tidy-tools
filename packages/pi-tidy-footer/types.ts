export interface CodexQuotaWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export type CodexQuotaSnapshot = (
  | { primary: CodexQuotaWindow; secondary?: CodexQuotaWindow }
  | { primary?: never; secondary: CodexQuotaWindow }
) & {
  updatedAt?: string;
};

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface FooterSnapshot {
  cwd: string;
  branch?: string | null;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  contextPercent?: number | null;
  contextWindow?: number;
  usage?: FooterUsage;
  quota?: CodexQuotaSnapshot;
  statuses?: ReadonlyMap<string, string>;
}

export interface FooterPalette {
  dim(text: string): string;
  accent(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}
