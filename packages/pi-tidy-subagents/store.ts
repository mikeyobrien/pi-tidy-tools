import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
async function atomicJson(path: string, value: unknown): Promise<void> {
 const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
 await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
 await rename(temporaryPath, path);
}

export async function saveRun(details: RunDetails, completed = true): Promise<void> {
 const manifest = {
  schemaVersion: details.schemaVersion ?? 2,
  runId: details.runId,
  cwd: details.cwd,
  createdAt: details.createdAt,
  ...(completed ? { completedAt: new Date().toISOString() } : {}),
  concurrencyCap: details.cap,
  // Parent runtime snapshot retained at run level.
  runtime: details.runtime,
  children: details.children.map(({ prompt, response: _response, streamingLine: _streamingLine, activeTools: _activeTools, runtimePlan, ...child }) => ({
   ...child,
   prompt,
   eventPath: `${child.id}.jsonl`,
   // Schema v2: per-child requested / resolved / observed model and thinking provenance.
   ...(runtimePlan ? {
    runtimePlan: {
     provider: runtimePlan.provider,
     modelId: runtimePlan.modelId,
     model: runtimePlan.model,
     thinking: runtimePlan.thinking,
     provenance: runtimePlan.provenance,
     thinkingProvenance: runtimePlan.thinkingProvenance,
     resolvedThinking: runtimePlan.resolvedThinking,
     ...(runtimePlan.requestedModel !== undefined ? { requestedModel: runtimePlan.requestedModel } : {}),
     ...(runtimePlan.requestedThinking !== undefined ? { requestedThinking: runtimePlan.requestedThinking } : {}),
     ...(runtimePlan.thinkingAdjustment ? { thinkingAdjustment: { ...runtimePlan.thinkingAdjustment } } : {}),
     ...(runtimePlan.observed ? { observed: { ...runtimePlan.observed } } : {}),
    },
   } : {}),
  })),
 };
 const manifestPath = join(details.runDir, "run.json");
 await atomicJson(manifestPath, manifest);
 await Promise.all(details.children.flatMap((child) => [
  writeFile(child.artifactPath, child.response || child.error || "", "utf8"),
  appendFile(join(details.runDir, `${child.id}.jsonl`), "", "utf8"),
 ]));
}

/** Merge coordinator metadata into selected legacy children without normalizing siblings or touching artifacts. */
export async function saveLegacyState(details: RunDetails): Promise<void> {
 const manifestPath = join(details.runDir, "run.json");
 const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
 const updates = new Map(details.children.map((child) => {
  const { response: _response, streamingLine: _streamingLine, activeTools: _activeTools, ...persisted } = child;
  return [child.id, persisted];
 }));
 manifest.children = (manifest.children ?? []).map((child: any) => {
  const update = updates.get(child.id);
  return update ? { ...child, ...update } : child;
 });
 await atomicJson(manifestPath, manifest);
}
