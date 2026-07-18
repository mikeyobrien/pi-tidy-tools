export type MemoryKind = "world" | "experience" | "observation" | string;
export type MemoryBudget = "low" | "mid" | "high";

export interface MemoryRecord {
  id: string;
  text: string;
  kind?: MemoryKind;
  context?: string;
  occurredAt?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface RecallInput {
  query: string;
  maxTokens?: number;
  budget?: MemoryBudget;
  types?: string[];
  tags?: string[];
}

export interface RecallOutput {
  memories: MemoryRecord[];
}

export interface RetainInput {
  content: string;
  context?: string;
  occurredAt?: string;
  documentId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface RetainOutput {
  accepted: number;
  deferred: boolean;
  operationId?: string;
}

export interface ReflectInput {
  query: string;
  budget?: MemoryBudget;
  tags?: string[];
  maxTokens?: number;
}

export interface ReflectOutput {
  text: string;
  memories?: MemoryRecord[];
}

export interface MemoryHealth {
  ok: boolean;
  message: string;
}

export interface MemoryBackend {
  readonly type: string;
  readonly label: string;
  readonly capabilities: ReadonlySet<
    "health" | "recall" | "retain" | "reflect"
  >;
  health(signal?: AbortSignal): Promise<MemoryHealth>;
  recall(input: RecallInput, signal?: AbortSignal): Promise<RecallOutput>;
  retain(input: RetainInput, signal?: AbortSignal): Promise<RetainOutput>;
  reflect(input: ReflectInput, signal?: AbortSignal): Promise<ReflectOutput>;
  close?(): Promise<void>;
}

export interface BackendFactoryContext {
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
}

export interface BackendFactory {
  readonly type: string;
  create(config: unknown, context: BackendFactoryContext): MemoryBackend;
}
