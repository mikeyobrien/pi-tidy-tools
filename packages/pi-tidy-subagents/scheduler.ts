import { availableParallelism } from "node:os";
const DEFAULT_BYTES_PER_CHILD = 2 * 1024 ** 3;
export function bytesPerChildFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.PI_TIDY_SUBAGENT_BYTES_PER_CHILD ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BYTES_PER_CHILD;
}
// Follow-up: measure process memory, CPU/tool contention, and provider behavior
// before replacing this deliberately naive heuristic or exposing public controls.
export function concurrencyCap(
  cpus = availableParallelism(),
  freeBytes = process.availableMemory(),
  bytesPerChild = bytesPerChildFromEnv()
): number {
  return Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(cpus / 2)),
      Math.max(1, Math.floor(freeBytes / bytesPerChild))
    )
  );
}
interface Job<T> {
  owner: string;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
export class Scheduler {
  private active = 0;
  private queue: Job<any>[] = [];
  private stopped = false;
  constructor(readonly cap: number) {}
  schedule<T>(owner: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("scheduler shut down"));
    return new Promise((resolve, reject) => {
      this.queue.push({ owner, run, resolve, reject });
      this.pump();
    });
  }
  cancel(owner?: string): void {
    const kept: Job<any>[] = [];
    for (const job of this.queue)
      owner === undefined || job.owner === owner
        ? job.reject(new DOMException("Cancelled", "AbortError"))
        : kept.push(job);
    this.queue = kept;
  }
  shutdown(): void {
    this.stopped = true;
    this.cancel();
  }
  private pump(): void {
    while (!this.stopped && this.active < this.cap && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
