import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedEvent, RunDetails } from "./types.js";

export async function createRunStore(agentDir: string, runId: string): Promise<string> {
 const dir = join(agentDir, "pi-tidy-subagents", "runs", runId);
 await mkdir(dir, { recursive: true });
 return dir;
}
export async function appendEvent(runDir: string, childId: string, event: NormalizedEvent): Promise<void> {
 await appendFile(join(runDir, `${childId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
}
export async function saveRun(details: RunDetails, completed = true): Promise<void> {
 const manifest = {
  schemaVersion: 1, runId: details.runId, cwd: details.cwd, createdAt: details.createdAt,
  ...(completed ? { completedAt: new Date().toISOString() } : {}), concurrencyCap: details.cap, runtime: details.runtime,
  children: details.children.map(({ prompt, response: _response, streamingLine: _streamingLine, activeTools: _activeTools, runtimePlan: _runtimePlan, ...child }) => ({ ...child, prompt, eventPath: `${child.id}.jsonl` })),
 };
 await writeFile(join(details.runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
 await Promise.all(details.children.flatMap((child) => [
  writeFile(child.artifactPath, child.response || child.error || "", "utf8"),
  appendFile(join(details.runDir, `${child.id}.jsonl`), "", "utf8"),
 ]));
}
