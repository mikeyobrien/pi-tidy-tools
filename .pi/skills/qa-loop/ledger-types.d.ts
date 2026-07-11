export type RunId = string;
export type FindingId = `F${number}`;
export type ScenarioStatus = "pass" | "finding" | "blocked";
export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export interface EvidenceRef {
  kind: "capture" | "command" | "file" | "note";
  ref: string;
  sha256?: string;
}

export interface Charter {
  feature: string;
  promise: string;
  entryPoint: string;
  environment: string;
  acceptance: string[];
  safety: string[];
  outOfScope: string[];
}

interface EventBase<T extends string> {
  v: 1;
  type: T;
  /** Assigned only by the canonical ledger writer. Omit from fragments. */
  seq?: number;
}

export interface RunStarted extends EventBase<"run.started"> {
  runId: RunId;
  charter: Charter;
  tooling: {
    driver: "agent-tty";
    harness: ".pi/skills/qa-loop/scripts/pi-tui-harness.sh";
    viewports: ["120x36", "72x24"];
    sessionDir: "/tmp/pi-tidy-qa/sessions";
    agentTtyHome: "/tmp/pi-tidy-qa/agent-tty";
    piVersion: string;
    agentTtyVersion: "0.5.0";
    nodeVersion: string;
  } | {
    /** Compatibility only for ledgers created before agent-tty became canonical. */
    driver: "tmux";
    harness: ".pi/skills/qa-loop/scripts/pi-tui-harness.sh";
    viewports: ["120x36", "72x24"];
    sessionDir: "/tmp/pi-tidy-qa/sessions";
    piVersion: string;
    tmuxVersion: string;
  };
}

export interface RoundStarted extends EventBase<"round.started"> {
  round: number;
  objective: "initial" | "retest" | "post-fix";
}

export interface FindingRaised extends EventBase<"finding.raised"> {
  round: number;
  findingId: FindingId;
  severity: Severity;
  confidence: Confidence;
  summary: string;
  actual: string;
  expected: string;
  reproduction: string[];
  evidence: EvidenceRef[];
  recommendation: string;
  acceptance: string;
}

export interface ScenarioChecked extends EventBase<"scenario.checked"> {
  round: number;
  scenarioId: string;
  requirementIds: string[];
  status: ScenarioStatus;
  findingIds: FindingId[];
  evidence: EvidenceRef[];
  notes: string;
}

export interface HumanSelected extends EventBase<"human.selected"> {
  round: number;
  action: "fix" | "retest" | "close";
  findingIds: FindingId[];
}

export interface FixApplied extends EventBase<"fix.applied"> {
  round: number;
  findingId: FindingId;
  files: string[];
  tests: string[];
  summary: string;
  residualRisk: string;
}

export interface VerificationRecorded extends EventBase<"verification.recorded"> {
  round: number;
  findingId: FindingId;
  status: "passed" | "failed" | "blocked";
  evidence: EvidenceRef[];
  notes: string;
}

export interface RoundClosed extends EventBase<"round.closed"> {
  round: number;
  outcome: "findings" | "no-findings" | "blocked";
}

export interface RunClosed extends EventBase<"run.closed"> {
  reason: "no-findings" | "human-signoff";
  acceptedOpenFindingIds: FindingId[];
  verificationCommands: string[];
  worktreeStatus: string[];
}

export type QaEvent =
  | RunStarted
  | RoundStarted
  | FindingRaised
  | ScenarioChecked
  | HumanSelected
  | FixApplied
  | VerificationRecorded
  | RoundClosed
  | RunClosed;
