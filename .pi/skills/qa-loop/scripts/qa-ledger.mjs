#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const EVENT_TYPES = new Set([
  "run.started", "round.started", "finding.raised", "scenario.checked",
  "human.selected", "fix.applied", "verification.recorded", "round.closed", "run.closed",
]);
const enumValues = (value, values, field) => assert(values.includes(value), `${field} must be one of: ${values.join(", ")}`);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value, field) => { assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`); return value; };
const string = (value, field) => { assert(typeof value === "string" && value.trim().length > 0, `${field} must be a non-empty string`); };
const number = (value, field) => { assert(Number.isInteger(value) && value > 0, `${field} must be a positive integer`); };
const strings = (value, field, nonempty = false) => {
  assert(Array.isArray(value) && (!nonempty || value.length > 0), `${field} must be ${nonempty ? "a non-empty" : "an"} array`);
  value.forEach((item, index) => string(item, `${field}[${index}]`));
};
const exactKeys = (value, allowed, field) => {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${field}.${key} is not allowed`);
  for (const key of allowed) assert(key in value, `${field}.${key} is required`);
};

function evidence(value, field) {
  assert(Array.isArray(value) && value.length > 0, `${field} must contain evidence`);
  value.forEach((item, index) => {
    object(item, `${field}[${index}]`);
    const allowed = item.sha256 === undefined ? ["kind", "ref"] : ["kind", "ref", "sha256"];
    exactKeys(item, allowed, `${field}[${index}]`);
    enumValues(item.kind, ["capture", "command", "file", "note"], `${field}[${index}].kind`);
    string(item.ref, `${field}[${index}].ref`);
    if (item.sha256 !== undefined) assert(/^[a-f0-9]{64}$/.test(item.sha256), `${field}[${index}].sha256 must be lowercase SHA-256`);
  });
}

function validateEvent(event, { fragment = false } = {}) {
  object(event, "event");
  assert(event.v === 1, "event.v must be 1");
  string(event.type, "event.type");
  assert(EVENT_TYPES.has(event.type), `unknown event type: ${event.type}`);
  if (fragment) assert(event.seq === undefined, "fragment events must omit seq");
  else number(event.seq, "event.seq");
  const base = ["v", "seq", "type"].filter((key) => key !== "seq" || !fragment);
  const keys = (...specific) => exactKeys(event, [...base, ...specific], event.type);
  const round = () => number(event.round, `${event.type}.round`);
  const findingId = () => assert(/^F\d{3,}$/.test(event.findingId), `${event.type}.findingId must match F001`);

  switch (event.type) {
    case "run.started": {
      keys("runId", "charter", "tooling"); string(event.runId, "run.started.runId");
      const charter = object(event.charter, "run.started.charter");
      exactKeys(charter, ["feature", "promise", "entryPoint", "environment", "acceptance", "safety", "outOfScope"], "run.started.charter");
      for (const key of ["feature", "promise", "entryPoint", "environment"]) string(charter[key], `run.started.charter.${key}`);
      strings(charter.acceptance, "run.started.charter.acceptance", true); strings(charter.safety, "run.started.charter.safety", true); strings(charter.outOfScope, "run.started.charter.outOfScope");
      const tooling = object(event.tooling, "run.started.tooling");
      if (tooling.driver === "agent-tty") {
        exactKeys(tooling, ["driver", "harness", "viewports", "sessionDir", "agentTtyHome", "piVersion", "agentTtyVersion", "nodeVersion"], "run.started.tooling");
        const homeMatch = tooling.agentTtyHome?.match(/^(\/tmp\/pi-tidy-qa(?:-[a-zA-Z0-9._-]+)?)\/agent-tty$/);
        assert(homeMatch, "tooling.agentTtyHome must use a safe canonical or per-run root");
        assert(tooling.sessionDir === `${homeMatch[1]}/sessions`, "tooling.sessionDir must share the agent-tty per-run root");
        assert(tooling.agentTtyVersion === "0.5.0", "tooling.agentTtyVersion must be 0.5.0");
        assert(/^v?(2[4-6])\./.test(tooling.nodeVersion), "tooling.nodeVersion must be Node 24-26");
        string(tooling.nodeVersion, "tooling.nodeVersion");
      } else {
        exactKeys(tooling, ["driver", "harness", "viewports", "sessionDir", "piVersion", "tmuxVersion"], "run.started.tooling");
        assert(tooling.driver === "tmux", "tooling.driver must be agent-tty (or tmux for a legacy ledger)");
        string(tooling.tmuxVersion, "tooling.tmuxVersion");
      }
      assert(tooling.harness === ".pi/skills/qa-loop/scripts/pi-tui-harness.sh", "tooling.harness must be canonical");
      assert(JSON.stringify(tooling.viewports) === JSON.stringify(["120x36", "72x24"]), "tooling.viewports must be canonical");
      if (tooling.driver === "tmux") assert(tooling.sessionDir === "/tmp/pi-tidy-qa/sessions", "legacy tmux tooling.sessionDir must be canonical");
      string(tooling.piVersion, "tooling.piVersion"); break;
    }
    case "round.started": keys("round", "objective"); round(); enumValues(event.objective, ["initial", "retest", "post-fix"], "round.started.objective"); break;
    case "finding.raised":
      keys("round", "findingId", "severity", "confidence", "summary", "actual", "expected", "reproduction", "evidence", "recommendation", "acceptance");
      round(); findingId(); enumValues(event.severity, ["critical", "high", "medium", "low"], "finding.raised.severity"); enumValues(event.confidence, ["high", "medium", "low"], "finding.raised.confidence");
      for (const key of ["summary", "actual", "expected", "recommendation", "acceptance"]) string(event[key], `finding.raised.${key}`);
      strings(event.reproduction, "finding.raised.reproduction", true); evidence(event.evidence, "finding.raised.evidence"); break;
    case "scenario.checked":
      keys("round", "scenarioId", "requirementIds", "status", "findingIds", "evidence", "notes"); round(); string(event.scenarioId, "scenario.checked.scenarioId"); strings(event.requirementIds, "scenario.checked.requirementIds", true); enumValues(event.status, ["pass", "finding", "blocked"], "scenario.checked.status"); strings(event.findingIds, "scenario.checked.findingIds"); evidence(event.evidence, "scenario.checked.evidence"); string(event.notes, "scenario.checked.notes");
      assert(event.status === "finding" ? event.findingIds.length > 0 : event.findingIds.length === 0, "scenario findingIds must be populated only for finding status");
      event.findingIds.forEach((id) => assert(/^F\d{3,}$/.test(id), `invalid scenario finding ID: ${id}`)); break;
    case "human.selected": keys("round", "action", "findingIds"); round(); enumValues(event.action, ["fix", "retest", "close"], "human.selected.action"); strings(event.findingIds, "human.selected.findingIds"); assert(event.action === "fix" ? event.findingIds.length > 0 : event.findingIds.length === 0, "only fix selections contain findingIds"); break;
    case "fix.applied": keys("round", "findingId", "files", "tests", "summary", "residualRisk"); round(); findingId(); strings(event.files, "fix.applied.files", true); strings(event.tests, "fix.applied.tests", true); string(event.summary, "fix.applied.summary"); string(event.residualRisk, "fix.applied.residualRisk"); break;
    case "verification.recorded": keys("round", "findingId", "status", "evidence", "notes"); round(); findingId(); enumValues(event.status, ["passed", "failed", "blocked"], "verification.recorded.status"); evidence(event.evidence, "verification.recorded.evidence"); string(event.notes, "verification.recorded.notes"); break;
    case "round.closed": keys("round", "outcome"); round(); enumValues(event.outcome, ["findings", "no-findings", "blocked"], "round.closed.outcome"); break;
    case "run.closed": keys("reason", "acceptedOpenFindingIds", "verificationCommands", "worktreeStatus"); enumValues(event.reason, ["no-findings", "human-signoff"], "run.closed.reason"); strings(event.acceptedOpenFindingIds, "run.closed.acceptedOpenFindingIds"); strings(event.verificationCommands, "run.closed.verificationCommands", true); assert(Array.isArray(event.worktreeStatus), "run.closed.worktreeStatus must be an array"); event.worktreeStatus.forEach((line) => assert(typeof line === "string", "worktree status lines must be strings")); break;
  }
}

function reduce(events) {
  assert(events.length > 0, "ledger is empty");
  const state = { run: null, rounds: new Map(), findings: new Map(), decisions: [], fixes: [], verifications: [], closed: null, authorized: new Set() };
  let activeRound = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]; validateEvent(event);
    assert(event.seq === index + 1, `event seq must be contiguous at ${index + 1}`);
    assert(!state.closed, `event ${event.seq} occurs after run.closed`);
    switch (event.type) {
      case "run.started": assert(index === 0 && !state.run, "run.started must be the first and only run start"); state.run = event; break;
      case "round.started": {
        assert(state.run, "run must start before rounds"); assert(activeRound === null, "previous round must close before another starts");
        assert(event.round === state.rounds.size + 1, "round numbers must be contiguous");
        const record = { event, scenarios: new Map(), outcome: null }; state.rounds.set(event.round, record); activeRound = record; break;
      }
      case "finding.raised":
        assert(activeRound?.event.round === event.round, "finding must belong to active round"); assert(!state.findings.has(event.findingId), `duplicate finding: ${event.findingId}`);
        assert(event.findingId === `F${String(state.findings.size + 1).padStart(3, "0")}`, `next finding ID must be F${String(state.findings.size + 1).padStart(3, "0")}`);
        state.findings.set(event.findingId, { event, status: "open" }); break;
      case "scenario.checked": {
        assert(activeRound?.event.round === event.round, "scenario must belong to active round"); assert(!activeRound.scenarios.has(event.scenarioId), `duplicate scenario in round: ${event.scenarioId}`);
        for (const id of event.findingIds) { const finding = state.findings.get(id); assert(finding, `unknown scenario finding: ${id}`); finding.status = "open"; }
        activeRound.scenarios.set(event.scenarioId, event); break;
      }
      case "human.selected":
        assert(activeRound?.event.round === event.round, "selection must belong to active round");
        for (const id of event.findingIds) { assert(state.findings.has(id), `unknown selected finding: ${id}`); state.authorized.add(id); }
        state.decisions.push(event); break;
      case "fix.applied": {
        assert(activeRound?.event.round === event.round, "fix must belong to active round"); const finding = state.findings.get(event.findingId); assert(finding, `unknown fixed finding: ${event.findingId}`); assert(state.authorized.has(event.findingId), `finding was not authorized: ${event.findingId}`);
        finding.status = "repairing"; state.fixes.push(event); break;
      }
      case "verification.recorded": {
        assert(activeRound?.event.round === event.round, "verification must belong to active round"); const finding = state.findings.get(event.findingId); assert(finding, `unknown verified finding: ${event.findingId}`); assert(state.fixes.some((fix) => fix.findingId === event.findingId), `finding has no applied fix: ${event.findingId}`);
        finding.status = event.status === "passed" ? "fixed" : event.status === "blocked" ? "blocked" : "open"; state.verifications.push(event); break;
      }
      case "round.closed": {
        assert(activeRound?.event.round === event.round, "closed round must be active"); assert(activeRound.scenarios.size > 0, "round cannot close without scenarios");
        const statuses = [...activeRound.scenarios.values()].map((scenario) => scenario.status);
        const expected = statuses.includes("blocked") ? "blocked" : statuses.includes("finding") ? "findings" : "no-findings";
        assert(event.outcome === expected, `round outcome must be ${expected}`);
        if (event.outcome === "no-findings") assert([...state.findings.values()].every((finding) => finding.status === "fixed"), "no-findings requires every historical finding fixed");
        activeRound.outcome = event; activeRound = null; break;
      }
      case "run.closed": {
        assert(activeRound === null, "active round must close before run"); const latest = [...state.rounds.values()].at(-1); assert(latest?.outcome, "run requires a closed round");
        const open = [...state.findings].filter(([, finding]) => finding.status !== "fixed").map(([id]) => id).sort();
        if (event.reason === "no-findings") { assert(latest.outcome.outcome === "no-findings" && open.length === 0, "no-findings closure requires an exhausted final round"); assert(event.acceptedOpenFindingIds.length === 0, "no-findings cannot accept open findings"); }
        else { assert(state.decisions.at(-1)?.action === "close", "human-signoff requires a close decision"); assert(JSON.stringify([...event.acceptedOpenFindingIds].sort()) === JSON.stringify(open), "human-signoff must account for every open finding"); }
        state.closed = event; break;
      }
    }
  }
  assert(state.run, "missing run.started");
  return state;
}

const stable = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}
function parseJsonl(text, source) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch (error) { throw new Error(`${source}:${index + 1}: ${error.message}`); }
  });
}
async function loadLedger(runDir) {
  const path = join(runDir, "events.jsonl");
  const events = parseJsonl(await readFile(path, "utf8"), path); reduce(events); return events;
}
async function atomicLedgerWrite(runDir, events) {
  const path = join(runDir, "events.jsonl"), temp = `${path}.tmp`;
  await writeFile(temp, `${events.map(stable).join("\n")}\n`); await rename(temp, path);
}
const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const evidenceText = (items) => items.map((item) => `${item.kind}:${item.ref}${item.sha256 ? `#${item.sha256.slice(0, 12)}` : ""}`).join(", ");
function renderReport(events) {
  const state = reduce(events), lines = [];
  lines.push(`# QA Loop Report — ${state.run.runId}`, "", `**Feature:** ${state.run.charter.feature}  `, `**Promise:** ${state.run.charter.promise}  `, `**Entry point:** ${state.run.charter.entryPoint}  `, `**Environment:** ${state.run.charter.environment}`, "");
  lines.push("## Charter", "", "### Acceptance", ...state.run.charter.acceptance.map((item) => `- ${item}`), "", "### Safety", ...state.run.charter.safety.map((item) => `- ${item}`), "", "### Out of scope", ...(state.run.charter.outOfScope.length ? state.run.charter.outOfScope.map((item) => `- ${item}`) : ["- None"]), "");
  const toolingVersion = state.run.tooling.driver === "agent-tty" ? `${state.run.tooling.agentTtyVersion}; ${state.run.tooling.nodeVersion}` : state.run.tooling.tmuxVersion;
  lines.push("## Tooling", "", `- Driver: ${state.run.tooling.driver} (${toolingVersion})`, `- Pi: ${state.run.tooling.piVersion}`, `- Harness: \`${state.run.tooling.harness}\``, `- Viewports: ${state.run.tooling.viewports.join(", ")}`, `- Session directory: \`${state.run.tooling.sessionDir}\``, ...(state.run.tooling.driver === "agent-tty" ? [`- agent-tty home: \`${state.run.tooling.agentTtyHome}\``] : []), "");
  lines.push("## Findings", "", "| ID | Severity | Confidence | Status | Summary |", "|---|---|---|---|---|");
  for (const [id, finding] of [...state.findings].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${id} | ${finding.event.severity} | ${finding.event.confidence} | ${finding.status} | ${cell(finding.event.summary)} |`);
  if (state.findings.size === 0) lines.push("| — | — | — | — | No findings | ");
  lines.push("");
  for (const [id, finding] of [...state.findings].sort(([a], [b]) => a.localeCompare(b))) {
    const event = finding.event; lines.push(`### ${id} — ${event.summary}`, "", `- **Actual:** ${event.actual}`, `- **Expected:** ${event.expected}`, `- **Acceptance:** ${event.acceptance}`, `- **Recommendation:** ${event.recommendation}`, `- **Evidence:** ${evidenceText(event.evidence)}`, "", "Reproduction:", ...event.reproduction.map((step, index) => `${index + 1}. ${step}`), "");
  }
  lines.push("## Coverage", "", "| Round | Objective | Scenario | Requirements | Status | Findings | Evidence |", "|---:|---|---|---|---|---|---|");
  for (const [round, record] of state.rounds) for (const scenario of [...record.scenarios.values()].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))) lines.push(`| ${round} | ${record.event.objective} | ${cell(scenario.scenarioId)} | ${scenario.requirementIds.map(cell).join(", ")} | ${scenario.status} | ${scenario.findingIds.join(", ") || "—"} | ${cell(evidenceText(scenario.evidence))} |`);
  lines.push("", "## Decisions and repairs", "");
  for (const decision of state.decisions) lines.push(`- Round ${decision.round}: human chose **${decision.action}**${decision.findingIds.length ? ` (${decision.findingIds.join(", ")})` : ""}.`);
  for (const fix of state.fixes) lines.push(`- ${fix.findingId}: ${fix.summary} Tests: ${fix.tests.join(", ")}. Residual risk: ${fix.residualRisk}`);
  for (const verification of state.verifications) lines.push(`- ${verification.findingId}: verification **${verification.status}** — ${verification.notes} (${evidenceText(verification.evidence)})`);
  if (!state.decisions.length && !state.fixes.length && !state.verifications.length) lines.push("- None.");
  lines.push("", "## Closure", "");
  if (!state.closed) lines.push("Run remains open.");
  else { lines.push(`Closed by **${state.closed.reason}**.`); if (state.closed.acceptedOpenFindingIds.length) lines.push(`Accepted open findings: ${state.closed.acceptedOpenFindingIds.join(", ")}.`); lines.push("", "Verification commands:", ...state.closed.verificationCommands.map((command) => `- \`${command}\``), "", "Final worktree status:", "```text", ...state.closed.worktreeStatus, "```"); }
  return `${lines.join("\n")}\n`;
}

function usage() {
  console.error("Usage:\n  qa-ledger.mjs init <run-dir> <run-started.jsonl>\n  qa-ledger.mjs append <run-dir> <fragment.jsonl>\n  qa-ledger.mjs validate <run-dir>\n  qa-ledger.mjs report <run-dir> [output.md]"); process.exit(2);
}
const [command, runDirArg, inputArg] = process.argv.slice(2); if (!command || !runDirArg) usage();
const runDir = resolve(runDirArg);
try {
  if (command === "init") {
    if (!inputArg) usage(); await mkdir(join(runDir, "fragments"), { recursive: true }); await mkdir(join(runDir, "artifacts"), { recursive: true });
    const fragment = parseJsonl(await readFile(resolve(inputArg), "utf8"), inputArg); assert(fragment.length === 1 && fragment[0].type === "run.started", "init requires exactly one run.started event"); validateEvent(fragment[0], { fragment: true });
    const events = [{ ...fragment[0], seq: 1 }]; reduce(events); await atomicLedgerWrite(runDir, events); console.log(join(runDir, "events.jsonl"));
  } else if (command === "append") {
    if (!inputArg) usage(); const events = await loadLedger(runDir); const fragment = parseJsonl(await readFile(resolve(inputArg), "utf8"), inputArg); assert(fragment.length > 0, "fragment is empty");
    fragment.forEach((event) => { validateEvent(event, { fragment: true }); assert(event.type !== "run.started", "cannot append another run.started"); });
    const combined = [...events, ...fragment.map((event, index) => ({ ...event, seq: events.length + index + 1 }))]; reduce(combined); await atomicLedgerWrite(runDir, combined); console.log(`${fragment.length} event(s) appended`);
  } else if (command === "validate") {
    const events = await loadLedger(runDir); console.log(`${events.length} event(s) valid`);
  } else if (command === "report") {
    const events = await loadLedger(runDir); const output = inputArg ? resolve(inputArg) : join(runDir, "report.md"); await mkdir(dirname(output), { recursive: true }); await writeFile(output, renderReport(events)); console.log(output);
  } else usage();
} catch (error) { console.error(`qa-ledger: ${error.message}`); process.exit(1); }
