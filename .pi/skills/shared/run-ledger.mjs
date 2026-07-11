import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export const stable = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

export function parseJsonl(text, source) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) { throw new Error(`${source}:${index + 1}: ${error.message}`); }
  });
}

export function createLedgerCli(adapter) {
  const {
    name, startedType = "run.started", validateEvent, reduce, renderReport, validateInitFragment,
    refuseExisting = false, lockTimeoutMs = 5_000,
  } = adapter;

  const loadLedger = async (runDir) => {
    const path = join(runDir, "events.jsonl");
    const events = parseJsonl(await readFile(path, "utf8"), path);
    reduce(events);
    return events;
  };
  const atomicWrite = async (runDir, events) => {
    const path = join(runDir, "events.jsonl"), temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try { await writeFile(temp, `${events.map(stable).join("\n")}\n`); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  };
  const withWriteLock = async (runDir, operation) => {
    const lock = join(runDir, ".events.lock"), timeoutSeconds = Math.max(lockTimeoutMs, 1) / 1000;
    const holder = spawn("flock", ["--exclusive", "--timeout", String(timeoutSeconds), lock, process.execPath, "-e", "process.stdout.write('locked\\n'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", stdout = "", acquired = false;
    holder.stderr.setEncoding("utf8"); holder.stderr.on("data", (chunk) => { stderr += chunk; });
    holder.stdout.setEncoding("utf8");
    const ready = new Promise((resolveReady, rejectReady) => {
      holder.once("error", rejectReady);
      holder.stdout.on("data", (chunk) => { stdout += chunk; if (!acquired && stdout.includes("\n")) { acquired = true; resolveReady(); } });
      holder.once("exit", (code) => { if (!acquired) rejectReady(new Error(code === 1 ? "canonical ledger write lock timed out" : `flock failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit ${code}`}`)); });
    });
    await ready;
    try { return await operation(); }
    finally {
      holder.stdin.end();
      await new Promise((resolveExit) => { if (holder.exitCode !== null) resolveExit(); else holder.once("exit", resolveExit); });
    }
  };
  const usage = () => {
    const error = new Error(`Usage:\n  ${name}.mjs init <run-dir> <run-started.jsonl>\n  ${name}.mjs append <run-dir> <fragment.jsonl>\n  ${name}.mjs validate <run-dir>\n  ${name}.mjs report <run-dir> [output.md]`);
    error.code = "USAGE";
    throw error;
  };

  return async function run(argv) {
    const [command, runDirArg, inputArg] = argv;
    if (!command || !runDirArg) usage();
    const runDir = resolve(runDirArg);
    if (command === "init") {
      if (!inputArg) usage();
      await mkdir(join(runDir, "fragments"), { recursive: true });
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      return withWriteLock(runDir, async () => {
        if (refuseExisting) {
          try { await readFile(join(runDir, "events.jsonl")); throw new Error("canonical ledger already exists"); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
        const source = resolve(inputArg), fragment = parseJsonl(await readFile(source, "utf8"), source);
        if (fragment.length !== 1 || fragment[0]?.type !== startedType) throw new Error(`init requires exactly one ${startedType} event`);
        if (validateInitFragment) await validateInitFragment(fragment, { source, runDir });
        validateEvent(fragment[0], { fragment: true });
        const events = [{ ...fragment[0], seq: 1 }];
        reduce(events);
        await atomicWrite(runDir, events);
        return { output: join(runDir, "events.jsonl") };
      });
    }
    if (command === "append") {
      if (!inputArg) usage();
      return withWriteLock(runDir, async () => {
        const events = await loadLedger(runDir);
        const fragment = parseJsonl(await readFile(resolve(inputArg), "utf8"), inputArg);
        if (fragment.length === 0) throw new Error("fragment is empty");
        fragment.forEach((event) => {
          validateEvent(event, { fragment: true });
          if (event.type === startedType) throw new Error(`cannot append another ${startedType}`);
        });
        const combined = [...events, ...fragment.map((event, index) => ({ ...event, seq: events.length + index + 1 }))];
        reduce(combined);
        await atomicWrite(runDir, combined);
        return { output: `${fragment.length} event(s) appended` };
      });
    }
    if (command === "validate") {
      const events = await loadLedger(runDir);
      return { output: `${events.length} event(s) valid` };
    }
    if (command === "report") {
      const events = await loadLedger(runDir);
      const output = inputArg ? resolve(inputArg) : join(runDir, "report.md");
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, renderReport(events));
      return { output };
    }
    usage();
  };
}

export async function executeLedgerCli(run, argv = process.argv.slice(2), errorPrefix = "") {
  try {
    const result = await run(argv);
    if (result?.output) console.log(result.output);
  } catch (error) {
    if (error?.code === "USAGE") {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(errorPrefix ? `${errorPrefix}: ${message}` : message);
      process.exitCode = 1;
    }
  }
}
