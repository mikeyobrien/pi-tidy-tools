type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type BuildFailureDigits =
  | `${Digit}${Digit}${Digit}`
  | `${Digit}${Digit}${Digit}${Digit}`;
export type BuildFailureId = `BF-${BuildFailureDigits}`;
export type CriterionStatus = "pass" | "fail" | "blocked";
export type Actor = "parent" | "builder" | "repairer" | "acceptance-verifier";

export interface EvidenceRef {
  kind: "capture" | "command" | "file" | "note";
  ref: string;
  sha256?: string;
}

export interface TrackerRef {
  provider: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
}

export interface Criterion { criterionId: string; text: string }
export interface TestSeam {
  seamId: string;
  criterionIds: string[];
  kind: "package-interface" | "cli" | "integration" | "tui";
  description: string;
}
export interface MechanicalCheck { checkId: string; command: string; required: true }
export interface BuildCharter {
  ticket: TrackerRef;
  ticketBody: string;
  ticketComments: string[];
  parent: TrackerRef;
  parentBody: string;
  parentComments: string[];
  userVisibleOutcome: string;
  criteria: Criterion[];
  testSeams: TestSeam[];
  mechanicalChecks: MechanicalCheck[];
  mutablePaths: string[];
  safety: string[];
  outOfScope: string[];
  startingWorktree: string[];
  userOwnedPaths: string[];
}

interface EventBase<T extends string, A extends Actor> { v: 1; type: T; actor: A; seq?: number }
export interface RunStarted extends EventBase<"run.started", "parent"> { runId: string; charter: BuildCharter; evidence: EvidenceRef[] }
export interface TicketStarted extends EventBase<"ticket.started", "parent"> { blockers: TrackerRef[]; frontierStatus: "ready"; evidence: EvidenceRef[] }
export interface AttemptStarted extends EventBase<"attempt.started", "parent"> {
  attempt: number;
  kind: "initial" | "repair" | "revision" | "retest";
  agentId: string;
  authorizedFailureIds: BuildFailureId[];
  direction: string;
}
export interface ImplementationApplied extends EventBase<"implementation.applied", "builder" | "repairer" | "parent"> {
  attempt: number;
  agentId: string;
  mode: "changed" | "unchanged" | "blocked";
  failureIds: BuildFailureId[];
  files: string[];
  tests: string[];
  summary: string;
  residualRisk: string;
  evidence: EvidenceRef[];
}
export interface MechanicalVerificationRecorded extends EventBase<"mechanical.verification.recorded", "parent"> {
  attempt: number;
  checks: Array<{ checkId: string; command: string; status: "passed" | "failed" | "blocked"; exitCode: number | null; evidence: EvidenceRef[] }>;
  scopeAudit: "clean" | "failed" | "blocked";
  ticketFiles: string[];
  worktreeStatus: string[];
  evidence: EvidenceRef[];
}
export interface AcceptanceStarted extends EventBase<"acceptance.started", "parent"> { attempt: number; verifierId: string; evidence: EvidenceRef[] }
export interface CriterionChecked extends EventBase<"criterion.checked", "acceptance-verifier"> {
  attempt: number; verifierId: string; criterionId: string; seamId: string; status: CriterionStatus; notes: string; evidence: EvidenceRef[];
}
export interface AcceptanceClosed extends EventBase<"acceptance.closed", "acceptance-verifier"> { attempt: number; verifierId: string; evidence: EvidenceRef[] }
export interface FailureRaised extends EventBase<"failure.raised", "parent" | "acceptance-verifier"> {
  attempt: number;
  verifierId: string;
  failureId: BuildFailureId;
  sourceKind: "agent" | "mechanical" | "criterion";
  sourceId: string;
  classification: "repairable" | "decision-required" | "scope-expansion" | "external";
  summary: string;
  actual: string;
  expected: string;
  evidence: EvidenceRef[];
}
export interface RepairApplied extends EventBase<"repair.applied", "repairer"> {
  attempt: number; agentId: string; failureId: BuildFailureId; files: string[]; tests: string[]; summary: string; residualRisk: string; evidence: EvidenceRef[];
}
export interface FailureVerificationRecorded extends EventBase<"failure.verification.recorded", "parent" | "acceptance-verifier"> {
  attempt: number; verifierId: string; failureId: BuildFailureId; status: "passed" | "failed" | "blocked"; notes: string; evidence: EvidenceRef[];
}
export interface AttemptClosed extends EventBase<"attempt.closed", "parent"> { attempt: number; outcome: "ready" | "failed" | "blocked"; openFailureIds: BuildFailureId[]; residualRisk: string; evidence: EvidenceRef[] }
export interface HumanDecided extends EventBase<"human.decided", "parent"> { attempt: number; action: "accept" | "revise" | "retest" | "stop"; direction: string; evidence: EvidenceRef[] }
export interface RunBlocked extends EventBase<"run.blocked", "parent"> { attempt: number; stage: "attempt" | "commit" | "tracker"; failureIds: BuildFailureId[]; reason: string; requiredAction: string; evidence: EvidenceRef[] }
export interface RunResumed extends EventBase<"run.resumed", "parent"> { attempt: number; stage: "attempt" | "commit" | "tracker"; failureIds: BuildFailureId[]; resolution: string; evidence: EvidenceRef[] }
export interface CommitRecorded extends EventBase<"commit.recorded", "parent"> { attempt: number; status: "succeeded" | "failed" | "blocked"; sha: string; files: string[]; worktreeStatus: string[]; evidence: EvidenceRef[] }
export interface TrackerRecorded extends EventBase<"tracker.recorded", "parent"> { attempt: number; status: "succeeded" | "failed" | "blocked"; ticket: TrackerRef; parent: TrackerRef; parentModified: false; evidence: EvidenceRef[] }
export interface TicketClosed extends EventBase<"ticket.closed", "parent"> { attempt: number; commitSha: string; finalWorktree: string[]; residualRisk: string; evidence: EvidenceRef[] }
export interface RunClosed extends EventBase<"run.closed", "parent"> { reason: "ticket-closed" | "stopped"; ticketState: "open" | "closed"; parentState: "open"; parentModified: false; commitSha: string; finalWorktree: string[]; residualRisk: string; evidence: EvidenceRef[] }

export type BuildEvent = RunStarted | TicketStarted | AttemptStarted | ImplementationApplied | MechanicalVerificationRecorded | AcceptanceStarted | CriterionChecked | AcceptanceClosed | FailureRaised | RepairApplied | FailureVerificationRecorded | AttemptClosed | HumanDecided | RunBlocked | RunResumed | CommitRecorded | TrackerRecorded | TicketClosed | RunClosed;
