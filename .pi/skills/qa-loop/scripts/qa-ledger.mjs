#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, posix, resolve } from "node:path";
import { reduce as reduceBuildLedger, renderReport as renderBuildReport } from "../../build-loop/scripts/build-ledger.mjs";
import { createLedgerCli, executeLedgerCli, parseJsonl } from "../../shared/run-ledger.mjs";

const EVENT_TYPES = new Set([
  "run.started", "round.started", "finding.raised", "scenario.checked",
  "human.selected", "fix.applied", "verification.recorded", "round.closed", "run.closed",
]);
const enumValues = (value, values, field) => assert(values.includes(value), `${field} must be one of: ${values.join(", ")}`);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value, field) => { assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`); return value; };
const string = (value, field) => { assert(typeof value === "string" && value.trim().length > 0, `${field} must be a non-empty string`); };
const number = (value, field) => { assert(Number.isInteger(value) && value > 0, `${field} must be a positive integer`); };
const requirementId = (value, field) => { string(value, field); assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), `${field} must be stable kebab-case`); };
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
    if (["capture", "file"].includes(item.kind)) { const normalized = posix.normalize(item.ref); assert(!item.ref.startsWith("/") && !item.ref.includes("\\") && normalized === item.ref && normalized !== "." && normalized !== ".." && !normalized.startsWith("../"), `${field}[${index}].ref must be a normalized run-relative path`); }
    if (item.sha256 !== undefined) assert(/^[a-f0-9]{64}$/.test(item.sha256), `${field}[${index}].sha256 must be lowercase SHA-256`);
  });
}

async function validateHandoffArtifact(value) {
  object(value, "handoff artifact"); exactKeys(value, ["schema", "version", "parent", "acceptedTickets", "entryPoints", "environment", "residualRisks", "deferredWork", "suggestedAcceptanceBoundaries"], "handoff artifact");
  assert(value.schema === "pi-tidy-build-qa-handoff" && value.version === 1, "handoff artifact schema/version is unsupported");
  const parent = object(value.parent, "handoff artifact.parent"); exactKeys(parent, ["id", "url", "title", "promise"], "handoff artifact.parent"); for (const key of ["id", "url", "title", "promise"]) string(parent[key], `handoff artifact.parent.${key}`);
  assert(Array.isArray(value.acceptedTickets) && value.acceptedTickets.length > 0, "handoff artifact.acceptedTickets must be non-empty");
  const ids = new Set(), commits = new Set(), reports = new Set();
  value.acceptedTickets.forEach((item, index) => { object(item, `handoff artifact.acceptedTickets[${index}]`); exactKeys(item, ["id", "url", "commitSha", "reportPath"], `handoff artifact.acceptedTickets[${index}]`); for (const key of ["id", "url", "reportPath"]) string(item[key], `handoff artifact.acceptedTickets[${index}].${key}`); assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.commitSha), `handoff artifact.acceptedTickets[${index}].commitSha must be a full hexadecimal commit ID`); assert(/^\.pi\/build-runs\/[A-Za-z0-9._-]+\/report\.md$/.test(item.reportPath), `handoff artifact.acceptedTickets[${index}].reportPath must be canonical`); assert(!ids.has(item.id) && !commits.has(item.commitSha) && !reports.has(item.reportPath), "handoff artifact ticket IDs, commits, and reports must be unique"); ids.add(item.id); commits.add(item.commitSha); reports.add(item.reportPath); });
  for (const [key, nonempty] of [["entryPoints", true], ["environment", true], ["residualRisks", false], ["deferredWork", false], ["suggestedAcceptanceBoundaries", true]]) strings(value[key], `handoff artifact.${key}`, nonempty);
  const trackerId = (tracker) => `${tracker.provider}:${tracker.repository}#${tracker.number}`;
  for (const ticket of value.acceptedTickets) {
    const report = resolve(ticket.reportPath), runDir = dirname(report), ledger = join(runDir, "events.jsonl"), events = parseJsonl(await readFile(ledger, "utf8"), ledger), state = reduceBuildLedger(events), charter = state.run.charter;
    assert(trackerId(charter.ticket) === ticket.id && charter.ticket.url === ticket.url, `handoff ticket ${ticket.id} does not match its build charter`);
    assert(trackerId(charter.parent) === value.parent.id && charter.parent.url === value.parent.url && charter.parent.title === value.parent.title && charter.parentBody === value.parent.promise, `handoff parent does not match build charter for ${ticket.id}`);
    assert(state.commit?.status === "succeeded" && state.commit.sha.startsWith(ticket.commitSha) && state.ticketClosed?.commitSha === state.commit.sha && state.closed?.reason === "ticket-closed", `handoff ticket ${ticket.id} lacks canonical closed build evidence`);
    const resolvedCommit = spawnSync("git", ["rev-parse", "--verify", `${ticket.commitSha}^{commit}`], { encoding: "utf8" }); assert(resolvedCommit.status === 0 && resolvedCommit.stdout.trim() === state.commit.sha, `handoff ticket ${ticket.id} commit is missing or mismatched`);
    assert(await readFile(report, "utf8") === renderBuildReport(events), `handoff ticket ${ticket.id} report is missing or stale`);
  }
}

async function validateInitHandoff(events) {
  const reference = events[0]?.charter?.handoff;
  if (!reference) return;
  assert(/^\.pi\/build-runs\/[A-Za-z0-9._-]+\/artifacts\/qa-handoff\.v1\.json$/.test(reference.path), "run.started.charter.handoff.path must be canonical");
  const bytes = await readFile(resolve(reference.path)), actual = createHash("sha256").update(bytes).digest("hex");
  assert(actual === reference.sha256, "run.started.charter.handoff.sha256 does not match artifact bytes");
  let artifact; try { artifact = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`handoff artifact is not valid JSON: ${error.message}`); }
  await validateHandoffArtifact(artifact);
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
  const findingId = () => assert(/^F\d{3,4}$/.test(event.findingId), `${event.type}.findingId must match F001`);

  switch (event.type) {
    case "run.started": {
      keys("runId", "charter", "tooling"); string(event.runId, "run.started.runId");
      const charter = object(event.charter, "run.started.charter");
      exactKeys(charter, ["feature", "promise", "entryPoint", "environment", "acceptance", "safety", "outOfScope", "handoff"], "run.started.charter");
      for (const key of ["feature", "promise", "entryPoint", "environment"]) string(charter[key], `run.started.charter.${key}`);
      assert(Array.isArray(charter.acceptance) && charter.acceptance.length > 0, "run.started.charter.acceptance must be a non-empty array");
      const requirementIds = new Set();
      charter.acceptance.forEach((item, index) => { object(item, `run.started.charter.acceptance[${index}]`); exactKeys(item, ["id", "text"], `run.started.charter.acceptance[${index}]`); requirementId(item.id, `run.started.charter.acceptance[${index}].id`); string(item.text, `run.started.charter.acceptance[${index}].text`); assert(!requirementIds.has(item.id), `duplicate acceptance requirement ID: ${item.id}`); requirementIds.add(item.id); });
      strings(charter.safety, "run.started.charter.safety", true); strings(charter.outOfScope, "run.started.charter.outOfScope");
      if (charter.handoff !== null) { const handoff = object(charter.handoff, "run.started.charter.handoff"); exactKeys(handoff, ["path", "schemaVersion", "sha256"], "run.started.charter.handoff"); string(handoff.path, "run.started.charter.handoff.path"); assert(handoff.schemaVersion === 1, "run.started.charter.handoff.schemaVersion must be 1"); assert(/^[a-f0-9]{64}$/.test(handoff.sha256), "run.started.charter.handoff.sha256 must be lowercase SHA-256"); }
      const tooling = object(event.tooling, "run.started.tooling");
      if (tooling.driver === "agent-tty") {
        exactKeys(tooling, ["driver", "harness", "viewports", "sessionDir", "agentTtyHome", "piVersion", "agentTtyVersion", "nodeVersion"], "run.started.tooling");
        assert(tooling.agentTtyHome === "/tmp/pi-tidy-qa/agent-tty", "tooling.agentTtyHome must be canonical");
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
      assert(tooling.sessionDir === "/tmp/pi-tidy-qa/sessions", "tooling.sessionDir must be canonical");
      string(tooling.piVersion, "tooling.piVersion"); break;
    }
    case "round.started": keys("round", "objective"); round(); enumValues(event.objective, ["initial", "retest", "post-fix"], "round.started.objective"); break;
    case "finding.raised":
      keys("round", "findingId", "severity", "confidence", "summary", "actual", "expected", "reproduction", "evidence", "recommendation", "acceptance");
      round(); findingId(); enumValues(event.severity, ["critical", "high", "medium", "low"], "finding.raised.severity"); enumValues(event.confidence, ["high", "medium", "low"], "finding.raised.confidence");
      for (const key of ["summary", "actual", "expected", "recommendation", "acceptance"]) string(event[key], `finding.raised.${key}`);
      strings(event.reproduction, "finding.raised.reproduction", true); evidence(event.evidence, "finding.raised.evidence"); break;
    case "scenario.checked":
      keys("round", "scenarioId", "requirementIds", "status", "findingIds", "evidence", "notes"); round(); string(event.scenarioId, "scenario.checked.scenarioId"); strings(event.requirementIds, "scenario.checked.requirementIds", true); event.requirementIds.forEach((id, index) => requirementId(id, `scenario.checked.requirementIds[${index}]`)); assert(new Set(event.requirementIds).size === event.requirementIds.length, "scenario requirementIds must be unique"); enumValues(event.status, ["pass", "finding", "blocked"], "scenario.checked.status"); strings(event.findingIds, "scenario.checked.findingIds"); evidence(event.evidence, "scenario.checked.evidence"); string(event.notes, "scenario.checked.notes");
      assert(event.status === "finding" ? event.findingIds.length > 0 : event.findingIds.length === 0, "scenario findingIds must be populated only for finding status");
      event.findingIds.forEach((id) => assert(/^F\d{3,4}$/.test(id), `invalid scenario finding ID: ${id}`)); break;
    case "human.selected": keys("round", "action", "findingIds"); round(); enumValues(event.action, ["fix", "retest", "close"], "human.selected.action"); strings(event.findingIds, "human.selected.findingIds"); assert(event.action === "fix" ? event.findingIds.length > 0 : event.findingIds.length === 0, "only fix selections contain findingIds"); break;
    case "fix.applied": keys("round", "findingId", "files", "tests", "summary", "residualRisk"); round(); findingId(); strings(event.files, "fix.applied.files", true); strings(event.tests, "fix.applied.tests", true); string(event.summary, "fix.applied.summary"); string(event.residualRisk, "fix.applied.residualRisk"); break;
    case "verification.recorded": keys("round", "findingId", "status", "evidence", "notes"); round(); findingId(); enumValues(event.status, ["passed", "failed", "blocked"], "verification.recorded.status"); evidence(event.evidence, "verification.recorded.evidence"); string(event.notes, "verification.recorded.notes"); break;
    case "round.closed": keys("round", "outcome"); round(); enumValues(event.outcome, ["findings", "no-findings", "blocked"], "round.closed.outcome"); break;
    case "run.closed": keys("reason", "acceptedOpenFindingIds", "verificationChecks", "worktreeStatus"); enumValues(event.reason, ["no-findings", "human-signoff"], "run.closed.reason"); strings(event.acceptedOpenFindingIds, "run.closed.acceptedOpenFindingIds"); assert(Array.isArray(event.verificationChecks) && event.verificationChecks.length > 0, "run.closed.verificationChecks must be non-empty"); event.verificationChecks.forEach((check, index) => { object(check, `run.closed.verificationChecks[${index}]`); exactKeys(check, ["command", "status", "exitCode", "evidence"], `run.closed.verificationChecks[${index}]`); string(check.command, `run.closed.verificationChecks[${index}].command`); enumValues(check.status, ["passed", "failed", "blocked"], `run.closed.verificationChecks[${index}].status`); assert(check.status === "blocked" ? check.exitCode === null : Number.isInteger(check.exitCode), `run.closed.verificationChecks[${index}].exitCode must match status`); assert(check.status !== "passed" || check.exitCode === 0, `run.closed.verificationChecks[${index}] passed status requires exit code 0`); evidence(check.evidence, `run.closed.verificationChecks[${index}].evidence`); }); assert(Array.isArray(event.worktreeStatus), "run.closed.worktreeStatus must be an array"); event.worktreeStatus.forEach((line) => assert(typeof line === "string", "worktree status lines must be strings")); break;
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
        const record = { event, scenarios: new Map(), decision: null, fixes: new Map(), verifications: new Map(), outcome: null }; state.rounds.set(event.round, record); activeRound = record; break;
      }
      case "finding.raised":
        assert(activeRound?.event.round === event.round, "finding must belong to active round"); assert(activeRound.scenarios.size === 0, "findings must precede every scenario in a round"); assert(!state.findings.has(event.findingId), `duplicate finding: ${event.findingId}`);
        assert(event.findingId === `F${String(state.findings.size + 1).padStart(3, "0")}`, `next finding ID must be F${String(state.findings.size + 1).padStart(3, "0")}`);
        state.findings.set(event.findingId, { event, status: "open" }); break;
      case "scenario.checked": {
        assert(activeRound?.event.round === event.round, "scenario must belong to active round"); assert(!activeRound.scenarios.has(event.scenarioId), `duplicate scenario in round: ${event.scenarioId}`);
        const charterRequirementIds = new Set(state.run.charter.acceptance.map((requirement) => requirement.id));
        for (const id of event.requirementIds) assert(charterRequirementIds.has(id), `unknown scenario requirement: ${id}`);
        for (const id of event.findingIds) { const finding = state.findings.get(id); assert(finding, `unknown scenario finding: ${id}`); finding.status = "open"; }
        activeRound.scenarios.set(event.scenarioId, event); break;
      }
      case "human.selected":
        assert(activeRound?.event.round === event.round, "selection must belong to active round"); assert(activeRound.scenarios.size > 0, "selection must follow scenario accounting"); assert(!activeRound.decision, "round may contain only one human selection");
        assert(new Set(event.findingIds).size === event.findingIds.length, "selected finding IDs must be unique"); const currentlyObserved = new Set([...activeRound.scenarios.values()].filter((scenario) => scenario.status === "finding").flatMap((scenario) => scenario.findingIds));
        for (const id of event.findingIds) { const finding = state.findings.get(id); assert(finding, `unknown selected finding: ${id}`); assert(finding.status !== "fixed" && currentlyObserved.has(id), `selected finding is not open and observed in this round: ${id}`); state.authorized.add(id); }
        activeRound.decision = event; state.decisions.push(event); break;
      case "fix.applied": {
        assert(activeRound?.event.round === event.round, "fix must belong to active round"); const finding = state.findings.get(event.findingId); assert(finding, `unknown fixed finding: ${event.findingId}`); assert(activeRound.decision?.action === "fix" && activeRound.decision.findingIds.includes(event.findingId), `finding was not selected for repair in this round: ${event.findingId}`); assert(!activeRound.fixes.has(event.findingId), `duplicate fix in round: ${event.findingId}`);
        finding.status = "repairing"; activeRound.fixes.set(event.findingId, event); state.fixes.push(event); break;
      }
      case "verification.recorded": {
        assert(activeRound?.event.round === event.round, "verification must belong to active round"); const finding = state.findings.get(event.findingId); assert(finding, `unknown verified finding: ${event.findingId}`); assert(activeRound.fixes.has(event.findingId), `finding has no fix in this round: ${event.findingId}`); assert(!activeRound.verifications.has(event.findingId), `duplicate verification in round: ${event.findingId}`);
        finding.status = event.status === "passed" ? "fixed" : event.status === "blocked" ? "blocked" : "open"; activeRound.verifications.set(event.findingId, event); state.verifications.push(event); break;
      }
      case "round.closed": {
        assert(activeRound?.event.round === event.round, "closed round must be active"); assert(activeRound.scenarios.size > 0, "round cannot close without scenarios");
        const coveredRequirements = new Set([...activeRound.scenarios.values()].flatMap((scenario) => scenario.requirementIds));
        const missingRequirements = state.run.charter.acceptance.map((requirement) => requirement.id).filter((id) => !coveredRequirements.has(id));
        assert(missingRequirements.length === 0, `round cannot close without requirement coverage: ${missingRequirements.join(", ")}`);
        const statuses = [...activeRound.scenarios.values()].map((scenario) => scenario.status);
        const expected = statuses.includes("blocked") ? "blocked" : statuses.includes("finding") ? "findings" : "no-findings";
        assert(event.outcome === expected, `round outcome must be ${expected}`); assert(expected !== "findings" || activeRound.decision, "findings round requires a human selection before closure");
        if (activeRound.decision?.action === "fix") for (const id of activeRound.decision.findingIds) { assert(activeRound.fixes.has(id), `selected finding requires one fix before round closure: ${id}`); assert(activeRound.verifications.has(id), `selected finding requires terminal verification before round closure: ${id}`); }
        if (event.outcome === "no-findings") assert([...state.findings.values()].every((finding) => finding.status === "fixed"), "no-findings requires every historical finding fixed");
        activeRound.outcome = event; activeRound = null; break;
      }
      case "run.closed": {
        assert(activeRound === null, "active round must close before run"); const latest = [...state.rounds.values()].at(-1); assert(latest?.outcome, "run requires a closed round");
        const open = [...state.findings].filter(([, finding]) => finding.status !== "fixed").map(([id]) => id).sort();
        if (event.reason === "no-findings") { assert(latest.outcome.outcome === "no-findings" && open.length === 0, "no-findings closure requires an exhausted final round"); assert(event.acceptedOpenFindingIds.length === 0, "no-findings cannot accept open findings"); assert(event.verificationChecks.every((check) => check.status === "passed" && check.exitCode === 0), "no-findings closure requires every final verification check to pass"); }
        else { assert(state.decisions.at(-1)?.action === "close", "human-signoff requires a close decision"); assert(JSON.stringify([...event.acceptedOpenFindingIds].sort()) === JSON.stringify(open), "human-signoff must account for every open finding"); }
        state.closed = event; break;
      }
    }
  }
  assert(state.run, "missing run.started");
  return state;
}

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const evidenceText = (items) => items.map((item) => `${item.kind}:${item.ref}${item.sha256 ? `#${item.sha256.slice(0, 12)}` : ""}`).join(", ");
function renderReport(events) {
  const state = reduce(events), lines = [];
  lines.push(`# QA Loop Report — ${state.run.runId}`, "", `**Feature:** ${state.run.charter.feature}  `, `**Promise:** ${state.run.charter.promise}  `, `**Entry point:** ${state.run.charter.entryPoint}  `, `**Environment:** ${state.run.charter.environment}`, "");
  lines.push("## Charter", "", "### Acceptance", ...state.run.charter.acceptance.map((item) => `- **${item.id}:** ${item.text}`), ...(state.run.charter.handoff ? ["", `Build handoff: \`${state.run.charter.handoff.path}\` (schema v${state.run.charter.handoff.schemaVersion}, SHA-256 ${state.run.charter.handoff.sha256})`] : []), "", "### Safety", ...state.run.charter.safety.map((item) => `- ${item}`), "", "### Out of scope", ...(state.run.charter.outOfScope.length ? state.run.charter.outOfScope.map((item) => `- ${item}`) : ["- None"]), "");
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
  else { lines.push(`Closed by **${state.closed.reason}**.`); if (state.closed.acceptedOpenFindingIds.length) lines.push(`Accepted open findings: ${state.closed.acceptedOpenFindingIds.join(", ")}.`); lines.push("", "Verification checks:", ...state.closed.verificationChecks.map((check) => `- **${check.status}** \`${check.command}\` (exit ${check.exitCode ?? "blocked"}; ${evidenceText(check.evidence)})`), "", "Final worktree status:", "```text", ...state.closed.worktreeStatus, "```"); }
  return `${lines.join("\n")}\n`;
}

const cli = createLedgerCli({ name: "qa-ledger", validateEvent, reduce, renderReport, validateInitFragment: validateInitHandoff, refuseExisting: true });
await executeLedgerCli(cli, process.argv.slice(2), "qa-ledger");
