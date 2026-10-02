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
  resources?: ResourceSnapshot;
}

export interface DiskUsage {
  mount: string;
  blockPercent?: number;
  inodePercent?: number;
}

export interface ResourceSnapshot {
  /** One-minute load average and logical core count. */
  cpu?: { load1: number; cores: number };
  /** Bytes in use (total minus available) and total bytes. */
  memory?: { used: number; total: number };
  disks: DiskUsage[];
  /** Readings at or above this percentage use the warning style. */
  warnPercent: number;
}

export interface FooterPalette {
  dim(text: string): string;
  accent(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}
