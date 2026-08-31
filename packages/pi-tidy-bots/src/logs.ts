/**
 * Size-capped rotating log writer (issue 51, closes the issue-08 tee promise):
 * daemon output tees to `.fleet/logs/daemon.log`, rotating at `capBytes` and
 * keeping `keep` previous generations. Appends are best-effort and synchronous
 * — daemon log volume is low (lines, not frames).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface RotatingLogWriter {
  write(line: string): void;
  /** Absolute path of the current generation. */
  file: string;
}

export function createRotatingLogWriter(
  dir: string,
  base: string,
  capBytes = 1_000_000,
  keep = 3
): RotatingLogWriter {
  const current = (bot?: string) => join(dir, bot ?? base);
  const file = current();
  const generation = (bot: string, n: number) => join(dir, `${bot}.${n}`);

  return {
    file,
    write(line: string): void {
      try {
        mkdirSync(dir, { recursive: true });
        try {
          if (existsSync(file) && statSync(file).size >= capBytes) {
            for (let n = keep - 1; n >= 1; n--) {
              const from = generation(base, n);
              const to = generation(base, n + 1);
              if (existsSync(from)) {
                if (existsSync(to)) rmSync(to);
                renameSync(from, to);
              }
            }
            renameSync(file, generation(base, 1));
          }
        } catch {
          // Rotation is best-effort; keep writing to the current file.
        }
        appendFileSync(file, `${line}\n`);
      } catch {
        // Logging is best-effort — never block the daemon on log I/O.
      }
    },
  };
}
