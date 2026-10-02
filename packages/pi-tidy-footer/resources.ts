import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import type { DiskUsage, ResourceSnapshot } from "./types.js";

/** Minimum spacing between samples; rendering only ever reads the cache. */
export const DEFAULT_SAMPLE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 4_000;

export interface StatFsLike {
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
  files: number | bigint;
  ffree: number | bigint;
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface ResourceProbe {
  loadavg(): number[];
  cpuCount(): number;
  totalMemory(): number;
  availableMemory(): Promise<number>;
  disk(mount: string): Promise<Omit<DiskUsage, "mount">>;
}

export function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

/** Percent of the blocks a non-root user can use, matching df's Use%. */
export function statfsUsage(stats: StatFsLike): Omit<DiskUsage, "mount"> {
  const blocks = Number(stats.blocks);
  const bfree = Number(stats.bfree);
  const bavail = Number(stats.bavail);
  const files = Number(stats.files);
  const ffree = Number(stats.ffree);
  const used = blocks - bfree;
  const usable = used + bavail;
  return {
    ...(usable > 0 ? { blockPercent: (used / usable) * 100 } : {}),
    // Some filesystems (btrfs, some network mounts) report zero inodes.
    ...(files > 0 ? { inodePercent: ((files - ffree) / files) * 100 } : {}),
  };
}

const BLOCK_HEADERS = new Set(["capacity", "use%"]);
const INODE_HEADERS = new Set(["iuse%", "%iused"]);

/**
 * Read block and inode percentages from `df` output on Linux or macOS. Header
 * names locate the percent columns, so the same parser reads `df -P -k`, GNU
 * `df -i`, and BSD `df -i` (which reports both).
 */
export function parseDf(text: string): Omit<DiskUsage, "mount"> {
  const lines = text.split("\n").filter((line) => line.trim());
  const header = lines[0];
  const row = lines.at(-1);
  if (!header || !row || row === header) return {};
  const kinds = header
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((name) => BLOCK_HEADERS.has(name) || INODE_HEADERS.has(name));
  const values = row
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((token) => /^(\d+%|-)$/.test(token));
  const result: Omit<DiskUsage, "mount"> = {};
  kinds.forEach((kind, index) => {
    const value = values[index];
    if (!value || value === "-") return;
    const percent = Number(value.slice(0, -1));
    if (INODE_HEADERS.has(kind)) result.inodePercent = percent;
    else result.blockPercent = percent;
  });
  return result;
}

/** macOS available memory from vm_stat: free, inactive, speculative, purgeable. */
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;
  const pages = (label: string) =>
    Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return (
    (pages("Pages free") +
      pages("Pages inactive") +
      pages("Pages speculative") +
      pages("Pages purgeable")) *
    pageSize
  );
}

export interface SystemProbeOptions {
  platform?: NodeJS.Platform;
  statfs?: ((path: string) => Promise<StatFsLike>) | undefined;
  run?: CommandRunner;
  freemem?: () => number;
}

export function createSystemProbe(
  options: SystemProbeOptions = {}
): ResourceProbe {
  const platform = options.platform ?? process.platform;
  const statfs =
    "statfs" in options
      ? options.statfs
      : typeof fs.statfs === "function"
        ? (path: string) => fs.statfs(path)
        : undefined;
  const run = options.run ?? runCommand;
  const freemem = options.freemem ?? os.freemem;

  const dfFallback = async (mount: string) => {
    const [blocks, inodes] = await Promise.allSettled([
      run("df", ["-P", "-k", mount]),
      run("df", ["-i", mount]),
    ]);
    const merged = {
      ...(blocks.status === "fulfilled" ? parseDf(blocks.value) : {}),
      ...(inodes.status === "fulfilled" ? parseDf(inodes.value) : {}),
    };
    if (merged.blockPercent === undefined && merged.inodePercent === undefined)
      throw new Error(`df could not read ${mount}`);
    return merged;
  };

  return {
    loadavg: () => os.loadavg(),
    cpuCount: () => os.availableParallelism(),
    totalMemory: () => os.totalmem(),
    async availableMemory() {
      // Node's freemem is MemAvailable on Linux but only truly free pages on
      // macOS, which overstates use; vm_stat counts reclaimable pages too.
      if (platform === "darwin") {
        try {
          const available = parseVmStat(await run("vm_stat", []));
          if (available !== undefined) return available;
        } catch {
          // Fall through to Node's estimate.
        }
      }
      return freemem();
    },
    async disk(mount) {
      if (!statfs) return dfFallback(mount);
      try {
        return statfsUsage(await statfs(mount));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
        return dfFallback(mount);
      }
    },
  };
}

export async function sampleResources(
  probe: ResourceProbe,
  mounts: readonly string[],
  warnPercent: number
): Promise<ResourceSnapshot> {
  const cores = probe.cpuCount();
  const load1 = probe.loadavg()[0];
  const total = probe.totalMemory();
  const [available, ...disks] = await Promise.allSettled([
    probe.availableMemory(),
    ...mounts.map((mount) => probe.disk(mount)),
  ]);
  return {
    warnPercent,
    ...(cores > 0 && typeof load1 === "number" && Number.isFinite(load1)
      ? { cpu: { load1, cores } }
      : {}),
    ...(available!.status === "fulfilled" && total > 0
      ? {
          memory: {
            used: Math.max(0, total - (available!.value as number)),
            total,
          },
        }
      : {}),
    disks: disks.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [{ mount: mounts[index]!, ...(result.value as object) }]
        : []
    ),
  };
}

/**
 * Background sampler. `snapshot` is a cached value read synchronously by the
 * renderer; probing happens on a timer and never inside `render()`.
 */
export class ResourceMonitor {
  private readonly probe: ResourceProbe;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private mounts: readonly string[] = [];
  private warnPercent = 85;
  private generation = 0;

  snapshot?: ResourceSnapshot;

  constructor(
    probe: ResourceProbe = createSystemProbe(),
    intervalMs = DEFAULT_SAMPLE_MS
  ) {
    this.probe = probe;
    this.intervalMs = Math.max(DEFAULT_SAMPLE_MS, intervalMs);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  async refresh(onUpdate?: () => void): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    let operation!: Promise<void>;
    operation = (async () => {
      try {
        const next = await sampleResources(
          this.probe,
          this.mounts,
          this.warnPercent
        );
        if (generation === this.generation) this.snapshot = next;
      } catch {
        // A failed probe keeps the last good reading on screen.
      } finally {
        if (this.inFlight === operation) this.inFlight = undefined;
        if (generation === this.generation) onUpdate?.();
      }
    })();
    this.inFlight = operation;
    return operation;
  }

  start(
    mounts: readonly string[],
    warnPercent: number,
    onUpdate: () => void
  ): void {
    this.mounts = [...mounts];
    this.warnPercent = warnPercent;
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.refresh(onUpdate),
      this.intervalMs
    );
    this.timer.unref?.();
    void this.refresh(onUpdate);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation += 1;
    this.inFlight = undefined;
    this.snapshot = undefined;
  }
}
