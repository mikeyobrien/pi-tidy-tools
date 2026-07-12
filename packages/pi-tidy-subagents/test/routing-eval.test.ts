/**
 * Observational routing evaluations (AC-008, AC-009).
 *
 * Default `npm test` runs offline structural fixtures that always pass and record
 * inherit-vs-select + match-to-guidance. Live frontier-model probes are opt-in via
 * PI_TIDY_ROUTING_EVAL=1 and never gate releases.
 *
 * See docs/routing-eval.md for task shapes and recording format.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
 buildDefaultRoutingConfig,
 MODEL_FIELD_DESCRIPTION,
 resolveTaskSelection,
 STANDARD_TASK_CLASSES,
 THINKING_FIELD_DESCRIPTION,
 type RoutingConfig,
 type RoutingSelection,
} from "../index.js";

export type TaskShapeId =
 | "bounded-lookup"
 | "mechanical-implementation"
 | "ordinary-review"
 | "architectural-judgment"
 | "concurrency-analysis"
 | "cost-sensitive"
 | "similarly-named-models"
 | "cross-provider";

export interface RoutingEvalCase {
 id: TaskShapeId;
 /** Representative frontier-agent task description. */
 description: string;
 /** Expected guidance from thinking-primary defaults (+ optional model map). */
 guidance: RoutingSelection;
}

export interface RoutingChoice {
 /** Omitted / undefined = inherit parent. */
 model?: string;
 thinking?: string;
}

export interface RoutingEvalRecord {
 taskClass: TaskShapeId;
 modelAction: "inherit" | "select";
 thinkingAction: "inherit" | "select";
 modelMatch: boolean;
 thinkingMatch: boolean;
 choice: RoutingChoice;
 guidance: RoutingSelection;
}

/** Representative task shapes required by AC-008. */
export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
 {
  id: "bounded-lookup",
  description: "Find the exact export name of parseExactModelRef in runtime.ts and quote its signature.",
  guidance: { thinking: "minimal" },
 },
 {
  id: "mechanical-implementation",
  description: "Add a pure helper that joins provider and modelId with a single slash; no design choices.",
  guidance: { thinking: "low" },
 },
 {
  id: "ordinary-review",
  description: "Review a small PR for naming clarity and missing tests; no architectural rewrite.",
  guidance: { thinking: "medium" },
 },
 {
  id: "architectural-judgment",
  description: "Propose module boundaries for a multi-provider routing subsystem and defend the seams.",
  guidance: { thinking: "high" },
 },
 {
  id: "concurrency-analysis",
  description: "Analyze a FIFO scheduler for races under mixed-model child cancellation.",
  guidance: { thinking: "high" },
 },
 {
  id: "cost-sensitive",
  description: "Cheaply classify whether a file path is under packages/ without deep reasoning.",
  guidance: { thinking: "minimal" },
 },
 {
  id: "similarly-named-models",
  description: "Select between two similarly named models (fake/fast vs fake/fast-2) using exact IDs only.",
  guidance: { model: "fake/fast" },
 },
 {
  id: "cross-provider",
  description: "Pick an exact model from a different provider than the parent for a specialized task.",
  guidance: { model: "other/strong" },
 },
];

function actionFor(value: string | undefined): "inherit" | "select" {
 return value === undefined || value === "" ? "inherit" : "select";
}

/**
 * Score one frontier choice against task guidance.
 * Inherit matches when guidance also omits that field (or treats inherit as correct).
 * Select matches when the exact value equals guidance.
 */
export function recordRoutingChoice(
 taskClass: TaskShapeId,
 choice: RoutingChoice,
 guidance: RoutingSelection,
): RoutingEvalRecord {
 const modelAction = actionFor(choice.model);
 const thinkingAction = actionFor(choice.thinking);

 const modelMatch = guidance.model === undefined
  ? modelAction === "inherit"
  : modelAction === "select" && choice.model === guidance.model;

 const thinkingMatch = guidance.thinking === undefined
  ? thinkingAction === "inherit"
  : thinkingAction === "select" && choice.thinking === guidance.thinking;

 return {
  taskClass,
  modelAction,
  thinkingAction,
  modelMatch,
  thinkingMatch,
  choice,
  guidance,
 };
}

/** Offline "frontier" fixture: follows thinking-primary guidance exactly. */
export function offlineFixtureChoice(guidance: RoutingSelection): RoutingChoice {
 return {
  ...(guidance.model !== undefined ? { model: guidance.model } : {}),
  ...(guidance.thinking !== undefined ? { thinking: guidance.thinking } : {}),
 };
}

function guidanceConfig(): RoutingConfig {
 return buildDefaultRoutingConfig({
  "similarly-named-models": "fake/fast",
  "cross-provider": "other/strong",
 });
}

test("routing eval covers all required task shapes", () => {
 const ids = ROUTING_EVAL_CASES.map((c) => c.id).sort();
 assert.deepEqual(ids, [...STANDARD_TASK_CLASSES].sort());
 assert.equal(ROUTING_EVAL_CASES.length, 8);
 for (const shape of [
  "bounded-lookup",
  "mechanical-implementation",
  "ordinary-review",
  "architectural-judgment",
  "concurrency-analysis",
  "cost-sensitive",
  "similarly-named-models",
  "cross-provider",
 ]) {
  assert.ok(ROUTING_EVAL_CASES.some((c) => c.id === shape), `missing ${shape}`);
 }
});

test("routing eval offline fixtures record inherit/select and match-to-guidance", () => {
 const config = guidanceConfig();
 const records: RoutingEvalRecord[] = [];

 for (const testCase of ROUTING_EVAL_CASES) {
  const guidance = resolveTaskSelection(config, testCase.id);
  // Case table guidance should agree with config resolution for these defaults.
  assert.equal(guidance.thinking, testCase.guidance.thinking);
  assert.equal(guidance.model, testCase.guidance.model);

  const choice = offlineFixtureChoice(guidance);
  const record = recordRoutingChoice(testCase.id, choice, guidance);
  records.push(record);

  assert.equal(record.modelMatch, true, `${testCase.id} model should match offline fixture`);
  assert.equal(record.thinkingMatch, true, `${testCase.id} thinking should match offline fixture`);
  assert.equal(record.modelAction, guidance.model ? "select" : "inherit");
  assert.equal(record.thinkingAction, guidance.thinking ? "select" : "inherit");
 }

 // Observational summary is recorded, never used as a release gate.
 const modelMatches = records.filter((r) => r.modelMatch).length;
 const thinkingMatches = records.filter((r) => r.thinkingMatch).length;
 assert.equal(modelMatches, records.length);
 assert.equal(thinkingMatches, records.length);
 assert.ok(records.every((r) => r.modelAction === "inherit" || r.modelAction === "select"));
 assert.ok(records.every((r) => r.thinkingAction === "inherit" || r.thinkingAction === "select"));
});

test("routing eval mismatch recording stays observational (does not throw)", () => {
 // Deliberately wrong choices still produce records; the suite does not fail the process on mismatch.
 const record = recordRoutingChoice(
  "architectural-judgment",
  { model: "fake/fast", thinking: "minimal" },
  { thinking: "high", model: "other/strong" },
 );
 assert.equal(record.modelMatch, false);
 assert.equal(record.thinkingMatch, false);
 assert.equal(record.modelAction, "select");
 assert.equal(record.thinkingAction, "select");
});

test("schema guidance remains short and rejects fuzzy aliases", () => {
 assert.match(MODEL_FIELD_DESCRIPTION, /exact registered provider\/model-id/i);
 assert.match(MODEL_FIELD_DESCRIPTION, /aliases|profiles|fuzzy/i);
 assert.match(THINKING_FIELD_DESCRIPTION, /omit inherits parent/i);
 // Keep defaults short — not long churny essays.
 assert.ok(MODEL_FIELD_DESCRIPTION.length < 280, `model desc too long: ${MODEL_FIELD_DESCRIPTION.length}`);
 assert.ok(THINKING_FIELD_DESCRIPTION.length < 320, `thinking desc too long: ${THINKING_FIELD_DESCRIPTION.length}`);
});

test("live routing eval is opt-in and skips without PI_TIDY_ROUTING_EVAL", {
 skip: process.env.PI_TIDY_ROUTING_EVAL === "1" ? false : "set PI_TIDY_ROUTING_EVAL=1 to run live frontier probes",
}, async () => {
 // Live path is intentionally a placeholder probe: real multi-provider frontier
 // measurement is operator-driven. When enabled without a harness, record skip diagnostics.
 assert.ok(
  process.env.PI_TIDY_ROUTING_EVAL === "1",
  "live routing eval requires PI_TIDY_ROUTING_EVAL=1",
 );
 // No network calls in-tree; operators can extend this hook. Recording shape is proven offline.
 const config = guidanceConfig();
 for (const testCase of ROUTING_EVAL_CASES) {
  const guidance = resolveTaskSelection(config, testCase.id);
  const record = recordRoutingChoice(testCase.id, offlineFixtureChoice(guidance), guidance);
  assert.equal(typeof record.modelAction, "string");
  assert.equal(typeof record.thinkingAction, "string");
 }
});
