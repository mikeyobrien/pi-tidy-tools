import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  startFleet,
  type PluginFaultObservation,
  type PluginHostObservation,
} from "./daemon.ts";
import {
  nonempty,
  object,
  ProtocolError,
  type JsonObject,
} from "./gateway/protocol.ts";

export type ConformanceStatus = "passed" | "failed" | "unsupported" | "not-run";
export interface LocalConformanceCell {
  id: string;
  kind:
    | "message"
    | "split_lf"
    | "post_native_eof"
    | "malformed_plugin"
    | "cancel"
    | "prelaunch";
  operationId: string;
  text: string;
  retry?: "same" | "conflict";
  effect?: { file: string; expectedOccurrences: number; contains: string };
  /** Separate, immutable control operation and native cancellation evidence. */
  cancel?: {
    operationId: string;
    effect: { file: string; expectedOccurrences: number; contains: string };
    expect: {
      execution: "ended" | "unknown";
      observation: "complete" | "reconciliation_required";
    };
  };
  /** Public stream predicates; one fixture bot executes cells serially. */
  events?: { minFrames: number; terminalFinals: 1 };
  /** Host startup is itself a conformance surface; no request may reach native handlers. */
  prelaunch?: {
    phase: "compatible" | "initialize" | "config_preflight";
    code?:
      "incompatible_protocol" | "missing_required_method" | "invalid_config";
    instrumentation: "readable" | "absent_preflight";
  };
  expect: {
    status: number;
    execution?:
      "ended" | "failed" | "cancelled" | "cancel_requested" | "unknown";
    observation?: "complete" | "reconciliation_required";
  };
  skip?: boolean;
}
export interface LocalConformanceFixture {
  version: 1;
  cells: LocalConformanceCell[];
  /** Explicitly allowed uncertainty is evidence, never a pass by omission. */
  allowedUncertainty?: string[];
  /** Reserved fixture hook for deterministic crash/IO engine injection. */
  injection?: {
    kind: "none" | "plugin_eof" | "slow_response";
    fixtureId: string;
  };
}
export interface LocalConformanceOptions {
  registryPath: string;
  pluginId: string;
  config: JsonObject;
  healthy?: { pluginId: string; config: JsonObject };
  policy?: {
    workspace?: "none" | "read" | "read-write";
    nativeProfile?: boolean;
    network?: boolean;
    gatewayTools?: string[];
  };
  fixture: LocalConformanceFixture;
}
export interface LocalConformanceReceipt {
  id: string;
  status: ConformanceStatus;
  evidence: JsonObject;
  error?: string;
}
export interface LocalConformanceReport {
  scope: JsonObject;
  cells: LocalConformanceReceipt[];
}

const MALFORMED_FRAME_CODES: Record<string, string> = {
  "malformed-json": "invalid_frame",
  "malformed-event": "invalid_event",
  nonfinite: "invalid_frame",
  oversize: "resource_limit",
  "stdout-log": "invalid_frame",
};

/** The latest ready identity is the only admissible active host for a cell. */
export function latestPluginInstance(
  instances: readonly PluginHostObservation[],
  botName: string,
  bindingId: string
): PluginHostObservation | undefined {
  for (let index = instances.length - 1; index >= 0; index--) {
    const candidate = instances[index];
    if (candidate.botName === botName && candidate.bindingId === bindingId)
      return candidate;
  }
  return undefined;
}

/** The decoder reason is host-generated and exact: fixture output cannot satisfy this predicate. */
export function malformedPluginFaultMatches(
  mode: string,
  fault: PluginFaultObservation | undefined,
  instance: PluginHostObservation | undefined
): boolean {
  return (
    fault?.botName === "fixture" &&
    instance?.botName === "fixture" &&
    fault.bindingId === instance.bindingId &&
    fault.instanceId === instance.instanceId &&
    fault.leaseGeneration === instance.leaseGeneration &&
    fault.code === MALFORMED_FRAME_CODES[mode]
  );
}
export function normalizeConformanceTrace(value: unknown): unknown {
  const identifiers = new Map<string, number>();
  const normalize = (item: unknown, key?: string): unknown => {
    if (
      typeof item === "string" &&
      key &&
      /(?:id|reference|revision)$/i.test(key)
    ) {
      const ordinal = identifiers.get(item) ?? identifiers.size + 1;
      identifiers.set(item, ordinal);
      return `<id:${ordinal}>`;
    }
    if (
      typeof item === "string" &&
      key &&
      /(?:ts|timestamp|createdAt|updatedAt|lastActive)$/i.test(key)
    )
      return "<clock>";
    if (Array.isArray(item)) return item.map((entry) => normalize(entry));
    if (!object(item)) return item;
    const result: JsonObject = {};
    for (const [childKey, child] of Object.entries(item))
      result[childKey] = normalize(child, childKey) as never;
    return result;
  };
  return normalize(value);
}

function toml(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return JSON.stringify(value);
  throw new Error(
    "Conformance config accepts only scalar values and string arrays"
  );
}
function validFixture(value: LocalConformanceFixture): void {
  if (
    value.version !== 1 ||
    !Array.isArray(value.cells) ||
    !value.cells.length ||
    value.cells.some(
      (cell) =>
        !nonempty(cell.id) ||
        ![
          "message",
          "split_lf",
          "post_native_eof",
          "malformed_plugin",
          "cancel",
          "prelaunch",
        ].includes(cell.kind) ||
        !nonempty(cell.operationId) ||
        typeof cell.text !== "string" ||
        !object(cell.expect) ||
        !Number.isInteger(cell.expect.status) ||
        (cell.effect !== undefined &&
          (!/^[A-Za-z0-9_.-]+$/.test(cell.effect.file) ||
            !nonempty(cell.effect.contains) ||
            !Number.isInteger(cell.effect.expectedOccurrences) ||
            cell.effect.expectedOccurrences < 0)) ||
        (cell.events !== undefined &&
          (!Number.isInteger(cell.events.minFrames) ||
            cell.events.minFrames < 1 ||
            cell.events.terminalFinals !== 1)) ||
        (cell.kind === "post_native_eof" &&
          (!cell.effect ||
            cell.expect.execution !== "unknown" ||
            cell.expect.observation !== "reconciliation_required")) ||
        (cell.kind === "prelaunch" &&
          (!cell.prelaunch ||
            !["compatible", "initialize", "config_preflight"].includes(
              cell.prelaunch.phase
            ) ||
            (cell.prelaunch.phase === "compatible"
              ? cell.prelaunch.code !== undefined || cell.expect.status !== 200
              : cell.prelaunch.code === undefined ||
                cell.expect.status !== 0) ||
            (cell.prelaunch.code !== undefined &&
              ![
                "incompatible_protocol",
                "missing_required_method",
                "invalid_config",
              ].includes(cell.prelaunch.code)) ||
            !["readable", "absent_preflight"].includes(
              cell.prelaunch.instrumentation
            ))) ||
        (cell.kind === "cancel" &&
          (!cell.effect ||
            !cell.cancel ||
            !nonempty(cell.cancel.operationId) ||
            cell.cancel.operationId === cell.operationId ||
            !/^[A-Za-z0-9_.-]+$/.test(cell.cancel.effect.file) ||
            !nonempty(cell.cancel.effect.contains) ||
            !Number.isInteger(cell.cancel.effect.expectedOccurrences) ||
            cell.cancel.effect.expectedOccurrences < 1 ||
            !["ended", "unknown"].includes(cell.cancel.expect.execution) ||
            !["complete", "reconciliation_required"].includes(
              cell.cancel.expect.observation
            ) ||
            !["cancelled", "cancel_requested", "unknown"].includes(
              String(cell.expect.execution)
            )))
    )
  )
    throw new Error("Invalid local conformance fixture");
  if (
    value.allowedUncertainty !== undefined &&
    (!Array.isArray(value.allowedUncertainty) ||
      !value.allowedUncertainty.every(nonempty))
  )
    throw new Error("Invalid allowed uncertainty declaration");
}
async function waitFor(
  fetchReceipt: () => Promise<JsonObject>,
  execution: string,
  observation?: string
): Promise<JsonObject> {
  const deadline = Date.now() + 5000;
  let last: JsonObject = {};
  while (Date.now() < deadline) {
    const receipt = (last = await fetchReceipt());
    if (
      receipt.execution === execution &&
      (observation === undefined || receipt.observation === observation)
    )
      return receipt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Conformance receipt did not reach ${execution}/${observation ?? "any"}: ${JSON.stringify(last)}`
  );
}

export interface PrelaunchNativeEffects {
  instrumentation: "readable" | "absent_preflight" | "missing";
  lines: string[];
}

/** Reads only fixture-owned native counters; startup failures never trust plugin stderr. */
async function prelaunchNativeEffects(
  directory: string
): Promise<PrelaunchNativeEffects> {
  const plugins = join(directory, ".fleet", "plugins");
  let bindings;
  try {
    bindings = await readdir(plugins, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { instrumentation: "absent_preflight", lines: [] };
    throw error;
  }
  const lines: string[] = [];
  let readable = false;
  for (const binding of bindings) {
    if (!binding.isDirectory()) continue;
    try {
      const value = await readFile(
        join(plugins, binding.name, "native-calls.jsonl"),
        "utf8"
      );
      readable = true;
      lines.push(...value.split("\n").filter(Boolean));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { instrumentation: readable ? "readable" : "missing", lines };
}

function startupCode(error: unknown): string {
  return error instanceof ProtocolError ? error.code : "startup_error";
}

/** A startup rejection is evidence only when its host code and native counters agree. */
export function prelaunchFailureMatches(
  expected: NonNullable<LocalConformanceCell["prelaunch"]>,
  code: string,
  effects: PrelaunchNativeEffects
): boolean {
  const nativeCalls = effects.lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!object(value) || typeof value.kind !== "string")
      throw new Error("Fixture native instrumentation is malformed");
    return String(value.kind);
  });
  return (
    expected.phase !== "compatible" &&
    expected.code === code &&
    effects.instrumentation === expected.instrumentation &&
    !nativeCalls.some((kind) => kind === "open" || kind === "submit")
  );
}

interface PublicTrace {
  frames: JsonObject[];
  close(): void;
}
async function collectPublicTrace(url: string): Promise<PublicTrace> {
  const frames: JsonObject[] = [];
  const socket = new WebSocket(
    `${url.replace("http", "ws")}/api/ws?token=local-conformance-token&since=0`
  );
  socket.on("message", (raw) => {
    if (frames.length >= 256) {
      socket.close();
      return;
    }
    try {
      const frame = JSON.parse(String(raw));
      if (object(frame)) frames.push(frame);
    } catch {
      /* malformed frames cannot satisfy evidence */
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Conformance event collector timed out opening"));
    }, 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (frames.some((frame) => frame.type === "hello"))
      return { frames, close: () => socket.terminate() };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket.terminate();
  throw new Error("Conformance event collector did not receive hello");
}
/** Validates the public, one-bot serial event subscenario without claiming source replay coverage. */
export function publicEventEvidence(
  trace: JsonObject[],
  operationId: string,
  expected: NonNullable<LocalConformanceCell["events"]>
): JsonObject | undefined {
  const linked = trace
    .map((frame, index) => ({ frame, index }))
    .filter(
      ({ frame }) =>
        object(frame.entry) &&
        frame.entry.operationId === operationId &&
        typeof frame.entry.turnId === "string"
    );
  if (linked.length !== 1) return undefined;
  const turnId = String((linked[0].frame.entry as JsonObject).turnId);
  const terminal = trace.filter(
    (frame) =>
      frame.type === "bubble" &&
      frame.phase === "final" &&
      frame.turnId === turnId
  );
  const correlated = trace.filter(
    (frame) =>
      (frame.type === "bubble" && frame.turnId === turnId) ||
      (frame.type === "append" &&
        object(frame.entry) &&
        frame.entry.operationId === operationId &&
        frame.entry.turnId === turnId)
  );
  const sequenced = correlated.filter((frame) => typeof frame.seq === "number");
  const ordered = sequenced.every(
    (frame, index) =>
      index === 0 || Number(frame.seq) > Number(sequenced[index - 1].seq)
  );
  if (
    correlated.length < expected.minFrames ||
    terminal.length !== expected.terminalFinals ||
    !ordered
  )
    return undefined;
  return {
    frameCount: correlated.length,
    linkedAppendCount: linked.length,
    terminalFinalCount: terminal.length,
    ordered,
    turnId: `<correlated>`,
    // Roster frames are concurrent state snapshots, not operation evidence. Keep
    // only the exact operation/turn and normalize their order without losing it.
    trace: normalizeConformanceTrace(
      correlated.map((frame, index) => ({
        ...frame,
        seq: `<sequence:${index + 1}>`,
      }))
    ) as JsonObject,
  };
}
async function publicEvidence(
  trace: JsonObject[],
  from: number,
  operationId: string,
  expected: NonNullable<LocalConformanceCell["events"]>
): Promise<JsonObject> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const evidence = publicEventEvidence(
      trace.slice(from),
      operationId,
      expected
    );
    if (evidence) return evidence;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Public event evidence lacks ordered correlated single terminal"
  );
}
export function matchingEffectLines(value: string, contains: string): string[] {
  return value.split("\n").filter((line) => line.includes(contains));
}
async function waitForEffect(
  path: string,
  contains: string,
  expectedOccurrences: number
): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const file = await readFile(path, "utf8");
    const count = matchingEffectLines(file, contains).length;
    if (count === expectedOccurrences) return file;
    if (count > expectedOccurrences)
      throw new Error("Fixture write evidence exceeds expectation");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture write evidence did not settle");
}
async function stableEffect(
  path: string,
  contains: string,
  expectedOccurrences: number
): Promise<string> {
  const first = await waitForEffect(path, contains, expectedOccurrences);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await readFile(path, "utf8");
  if (
    JSON.stringify(matchingEffectLines(first, contains)) !==
    JSON.stringify(matchingEffectLines(second, contains))
  )
    throw new Error("Fixture native write changed during recovery observation");
  return second;
}
/** A public final is relevant only when an assistant entry establishes this operation's turn identity. */
export function noCompletedAssistant(
  trace: JsonObject[],
  operationId: string
): boolean {
  const assistantTurns = trace.flatMap((frame) =>
    object(frame.entry) &&
    frame.entry.operationId === operationId &&
    frame.entry.role === "assistant" &&
    typeof frame.entry.turnId === "string"
      ? [String(frame.entry.turnId)]
      : []
  );
  return (
    assistantTurns.length === 0 ||
    !trace.some(
      (frame) =>
        frame.type === "bubble" &&
        frame.phase === "final" &&
        assistantTurns.includes(String(frame.turnId))
    )
  );
}
export function postNativeEofMatches(
  first: { status: number; body: JsonObject },
  before: JsonObject,
  after: JsonObject,
  expected: LocalConformanceCell["expect"],
  effectBefore: string[],
  effectAfter: string[],
  noCompletedAssistant: boolean
): boolean {
  return (
    first.status === expected.status &&
    before.execution === "unknown" &&
    before.observation === "reconciliation_required" &&
    after.execution === "unknown" &&
    after.observation === "reconciliation_required" &&
    immutableReceiptMatches(first.body, before) &&
    immutableReceiptMatches(before, after) &&
    JSON.stringify(effectBefore) === JSON.stringify(effectAfter) &&
    noCompletedAssistant
  );
}
/** Durable cancellation controls and their target must retain their own immutable identities. */
export function cancellationReceiptsMatch(
  submit: JsonObject,
  target: JsonObject,
  admittedControl: JsonObject,
  control: JsonObject,
  retry: JsonObject,
  controlAfterRetry: JsonObject,
  targetAfterRetry: JsonObject,
  nativeTargetMatches: boolean,
  requiresRequestedResult: boolean
): boolean {
  return (
    immutableReceiptMatches(submit, target) &&
    immutableReceiptMatches(admittedControl, control) &&
    immutableReceiptMatches(control, retry) &&
    immutableReceiptMatches(control, controlAfterRetry) &&
    immutableReceiptMatches(target, targetAfterRetry) &&
    control.kind === "cancel" &&
    (!requiresRequestedResult ||
      (control.result !== null &&
        object(control.result) &&
        control.result.status === "requested")) &&
    JSON.stringify(control) === JSON.stringify(controlAfterRetry) &&
    JSON.stringify(target) === JSON.stringify(targetAfterRetry) &&
    nativeTargetMatches
  );
}

export function immutableReceiptMatches(
  first: JsonObject,
  terminal: JsonObject
): boolean {
  const identity = [
    "fleetId",
    "botId",
    "conversationId",
    "bindingId",
    "bindingRevision",
    "operationId",
  ];
  if (!identity.every((key) => first[key] === terminal[key])) return false;
  const firstUserEntry = first.userEntryId;
  const terminalUserEntry = terminal.userEntryId;
  // Message receipts must preserve their canonical durable user entry. Controls omit it on both sides.
  return firstUserEntry === undefined && terminalUserEntry === undefined
    ? true
    : nonempty(firstUserEntry) && firstUserEntry === terminalUserEntry;
}

/** Starts an explicitly pinned plugin via the shipped fleet daemon in a fresh local namespace. */
export async function runLocalConformance(
  options: LocalConformanceOptions
): Promise<LocalConformanceReport> {
  validFixture(options.fixture);
  if (
    !nonempty(options.registryPath) ||
    !nonempty(options.pluginId) ||
    !object(options.config)
  )
    throw new Error(
      "Conformance requires explicit registry, plugin and configuration"
    );
  const directory = await mkdtemp(join(tmpdir(), "tidy-conformance-"));
  const workspace = join(directory, "workspace");
  const policy = options.policy ?? {};
  await mkdir(workspace);
  await writeFile(
    join(workspace, "AGENTS.md"),
    "Disposable local conformance workspace.\n"
  );
  const gateway = [
    "[gateway]",
    `registry = ${JSON.stringify(options.registryPath)}`,
    'environment = ["PATH"]',
    `workspace_access = ${JSON.stringify(policy.workspace ?? "none")}`,
    `native_profile = ${policy.nativeProfile === true}`,
    `network = ${policy.network === true}`,
    `gateway_tools = ${JSON.stringify(policy.gatewayTools ?? [])}`,
    "[[bot]]",
    'name = "fixture"',
    'dir = "workspace"',
    `backend = ${JSON.stringify(options.pluginId)}`,
    "[bot.backend_config]",
    ...Object.entries(options.config).map(
      ([key, value]) => `${key} = ${toml(value)}`
    ),
    ...(options.healthy
      ? [
          "",
          "[[bot]]",
          'name = "healthy"',
          'dir = "workspace"',
          `backend = ${JSON.stringify(options.healthy.pluginId)}`,
          "[bot.backend_config]",
          ...Object.entries(options.healthy.config).map(
            ([key, value]) => `${key} = ${toml(value)}`
          ),
        ]
      : []),
    "",
  ].join("\n");
  await writeFile(join(directory, "bots.toml"), gateway);
  let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
  const cells: LocalConformanceReceipt[] = [];
  let report: LocalConformanceReport | undefined;
  try {
    const pluginFaults: PluginFaultObservation[] = [];
    const pluginInstances: PluginHostObservation[] = [];
    const launch = () =>
      startFleet({
        dir: directory,
        port: 0,
        token: "local-conformance-token",
        onPluginFault(fault) {
          pluginFaults.push(fault);
        },
        onPluginReady(instance) {
          pluginInstances.push(instance);
        },
      });
    const startupCells = options.fixture.cells.filter(
      (cell) => cell.kind === "prelaunch" && !cell.skip
    );
    try {
      handle = await launch();
    } catch (error) {
      if (!startupCells.length) throw error;
      const effects = await prelaunchNativeEffects(directory);
      const code = startupCode(error);
      for (const cell of startupCells) {
        const matched = prelaunchFailureMatches(cell.prelaunch!, code, effects);
        cells.push({
          id: cell.id,
          status: matched ? "passed" : "failed",
          evidence: {
            phase: cell.prelaunch!.phase,
            expectedCode: cell.prelaunch!.code ?? null,
            actualCode: code,
            instrumentation: effects.instrumentation,
            nativeCalls: effects.lines.map((line) => JSON.parse(line)),
          },
        });
      }
      report = {
        scope: {
          mode: "local_disposable",
          daemon: "startFleet",
          registryPath: options.registryPath,
          pluginId: options.pluginId,
          exercised: ["C01.startup_negotiation_prelaunch"],
          notRun: [
            "C01.compatible_session_open",
            "C01.other_protocol_variants",
            "C02",
            "C03",
            "C04",
            "C05",
            "L01",
            "L02",
            "L03",
            "L10",
          ],
          nativeProvider: "not-run",
        },
        cells,
      };
      return report;
    }
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(handle!.url + path, {
        ...init,
        headers: {
          authorization: "Bearer local-conformance-token",
          ...init.headers,
        },
      });
      let body: JsonObject = {};
      try {
        body = (await response.json()) as JsonObject;
      } catch {
        /* Non-JSON is a failed conformance response. */
      }
      return { status: response.status, body };
    };
    const binding = (await request("/api/bots/fixture/capabilities")).body;
    if (
      !object(binding) ||
      !nonempty(binding.conversationId) ||
      !nonempty(binding.bindingRevision)
    )
      throw new Error("Conformance daemon did not expose a binding");
    const registry = JSON.parse(await readFile(options.registryPath, "utf8"));
    const entry = Array.isArray(registry.plugins)
      ? registry.plugins.find(
          (item: unknown) => object(item) && item.id === options.pluginId
        )
      : undefined;
    if (!object(entry))
      throw new Error("Conformance registry does not pin the requested plugin");
    const headers = {
      "content-type": "application/json",
      "x-tidy-client-contract": "2",
      "x-tidy-binding-revision": String(binding.bindingRevision),
    };
    let publicTrace = await collectPublicTrace(handle.url);
    try {
      for (const cell of options.fixture.cells) {
        if (cell.skip) {
          cells.push({
            id: cell.id,
            status: "not-run",
            evidence: { reason: "fixture_skip" },
          });
          continue;
        }
        if (cell.retry && !cell.effect) {
          cells.push({
            id: cell.id,
            status: "not-run",
            evidence: { reason: "fixture_native_effect_evidence_required" },
          });
          continue;
        }
        if (cell.kind === "prelaunch") {
          const effects = await prelaunchNativeEffects(directory);
          const calls = effects.lines.map(
            (line) => JSON.parse(line) as JsonObject
          );
          const openCount = calls.filter((call) => call.kind === "open").length;
          const submitCount = calls.filter(
            (call) => call.kind === "submit"
          ).length;
          const matched =
            cell.prelaunch!.phase === "compatible" &&
            effects.instrumentation === "readable" &&
            openCount === 1 &&
            submitCount === 0;
          cells.push({
            id: cell.id,
            status: matched ? "passed" : "failed",
            evidence: {
              phase: cell.prelaunch!.phase,
              instrumentation: effects.instrumentation,
              nativeOpenCount: openCount,
              nativeSubmitCount: submitCount,
            },
          });
          continue;
        }
        const submit = (text: string) =>
          request("/api/bots/fixture/message", {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationId: cell.operationId,
              clientMessageId: cell.operationId,
              conversationId: binding.conversationId,
              text,
            }),
          });
        try {
          if (cell.kind === "malformed_plugin") {
            const traceStart = publicTrace.frames.length;
            const faultStart = pluginFaults.length;
            const instance = latestPluginInstance(
              pluginInstances,
              "fixture",
              String(binding.bindingId)
            );
            const first = await submit(cell.text);
            const effectPath = join(
              directory,
              ".fleet",
              "plugins",
              String(binding.bindingId),
              cell.effect!.file
            );
            const emitted = await waitForEffect(
              effectPath,
              cell.effect!.contains,
              cell.effect!.expectedOccurrences
            );
            const bad = await waitFor(
              () =>
                request(
                  `/api/bots/fixture/operations/${encodeURIComponent(cell.operationId)}`
                ).then((v) => v.body),
              "unknown",
              "reconciliation_required"
            );
            const healthy = (await request("/api/bots/healthy/capabilities"))
              .body;
            if (
              !object(healthy) ||
              !nonempty(healthy.conversationId) ||
              !nonempty(healthy.bindingRevision)
            )
              throw new Error("healthy_binding_unavailable");
            const healthyId = `${cell.operationId}-healthy`;
            const healthyResponse = await request("/api/bots/healthy/message", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-tidy-client-contract": "2",
                "x-tidy-binding-revision": String(healthy.bindingRevision),
              },
              body: JSON.stringify({
                operationId: healthyId,
                clientMessageId: healthyId,
                conversationId: healthy.conversationId,
                text: cell.text,
              }),
            });
            const healthyReceipt = await waitFor(
              () =>
                request(`/api/bots/healthy/operations/${healthyId}`).then(
                  (v) => v.body
                ),
              "ended",
              "complete"
            );
            const adversaryTrace = publicTrace.frames.slice(traceStart);
            const noAssistant = noCompletedAssistant(
              adversaryTrace,
              cell.operationId
            );
            const protocolFault = pluginFaults
              .slice(faultStart)
              .find((fault) =>
                malformedPluginFaultMatches(
                  String(options.config.mode),
                  fault,
                  instance
                )
              );
            cells.push({
              id: cell.id,
              status:
                first.status === cell.expect.status &&
                Boolean(protocolFault) &&
                bad.execution === "unknown" &&
                bad.observation === "reconciliation_required" &&
                healthyResponse.status === 202 &&
                healthyReceipt.execution === "ended" &&
                noAssistant
                  ? "passed"
                  : "failed",
              evidence: {
                malformedEmission: matchingEffectLines(
                  emitted,
                  cell.effect!.contains
                ),
                protocolRejection: protocolFault
                  ? (normalizeConformanceTrace(protocolFault) as JsonObject)
                  : null,
                noAssistant,
                adversaryReceipt: normalizeConformanceTrace(bad) as JsonObject,
                healthyReceipt: normalizeConformanceTrace(
                  healthyReceipt
                ) as JsonObject,
                adversaryTrace: normalizeConformanceTrace(
                  adversaryTrace
                ) as JsonObject,
              },
            });
            continue;
          }
          if (cell.kind === "cancel") {
            const traceStart = publicTrace.frames.length;
            const first = await submit(cell.text);
            const inspect = (operationId: string) =>
              request(
                `/api/bots/fixture/operations/${encodeURIComponent(operationId)}`
              ).then((value) => value.body);
            const submitPath = join(
              directory,
              ".fleet",
              "plugins",
              String(binding.bindingId),
              cell.effect!.file
            );
            await waitForEffect(
              submitPath,
              cell.effect!.contains,
              cell.effect!.expectedOccurrences
            );
            await waitFor(inspect.bind(undefined, cell.operationId), "running");
            const cancelBody = {
              kind: "cancel",
              operationId: cell.cancel!.operationId,
              conversationId: binding.conversationId,
              targetOperationId: cell.operationId,
            };
            const cancelPath = join(
              directory,
              ".fleet",
              "plugins",
              String(binding.bindingId),
              cell.cancel!.effect.file
            );
            const cancel = (targetOperationId: string, payload: JsonObject) =>
              request(
                `/api/bots/fixture/operations/${encodeURIComponent(targetOperationId)}/cancel`,
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify(payload),
                }
              );
            const firstCancel = await cancel(cell.operationId, cancelBody);
            const cancelEffects = await waitForEffect(
              cancelPath,
              cell.cancel!.effect.contains,
              cell.cancel!.effect.expectedOccurrences
            );
            const control = await waitFor(
              inspect.bind(undefined, cell.cancel!.operationId),
              cell.cancel!.expect.execution,
              cell.cancel!.expect.observation
            );
            const target = await waitFor(
              inspect.bind(undefined, cell.operationId),
              String(cell.expect.execution),
              cell.expect.observation
            );
            const retry = await cancel(cell.operationId, cancelBody);
            const conflictTarget = `${cell.operationId}-different`;
            const conflict = await cancel(conflictTarget, {
              ...cancelBody,
              targetOperationId: conflictTarget,
            });
            const afterEffects = await stableEffect(
              cancelPath,
              cell.cancel!.effect.contains,
              cell.cancel!.effect.expectedOccurrences
            );
            const targetEffects = await stableEffect(
              submitPath,
              cell.effect!.contains,
              cell.effect!.expectedOccurrences
            );
            const controlAfterRetry = await inspect(cell.cancel!.operationId);
            const targetAfterRetry = await inspect(cell.operationId);
            const nativeTargetMatches = matchingEffectLines(
              afterEffects,
              cell.cancel!.effect.contains
            ).every(
              (line) =>
                line.includes(`"operationId": "${cell.cancel!.operationId}"`) &&
                line.includes(`"targetOperationId": "${cell.operationId}"`)
            );
            const trace = publicTrace.frames.slice(traceStart);
            const noAssistantCompletion = noCompletedAssistant(
              trace,
              cell.operationId
            );
            const matched =
              first.status === 202 &&
              firstCancel.status === 202 &&
              retry.status === 202 &&
              conflict.status === 409 &&
              cancellationReceiptsMatch(
                first.body,
                target,
                firstCancel.body,
                control,
                retry.body,
                controlAfterRetry,
                targetAfterRetry,
                nativeTargetMatches,
                cell.cancel!.expect.execution === "ended"
              ) &&
              control.execution === cell.cancel!.expect.execution &&
              control.observation === cell.cancel!.expect.observation &&
              target.execution === cell.expect.execution &&
              target.observation === cell.expect.observation &&
              matchingEffectLines(cancelEffects, cell.cancel!.effect.contains)
                .length === cell.cancel!.effect.expectedOccurrences &&
              JSON.stringify(
                matchingEffectLines(cancelEffects, cell.cancel!.effect.contains)
              ) ===
                JSON.stringify(
                  matchingEffectLines(
                    afterEffects,
                    cell.cancel!.effect.contains
                  )
                ) &&
              matchingEffectLines(targetEffects, cell.effect!.contains)
                .length === cell.effect!.expectedOccurrences &&
              noAssistantCompletion;
            cells.push({
              id: cell.id,
              status: matched ? "passed" : "failed",
              evidence: {
                cancelRetryConflictStatus: conflict.status,
                nativeTargetMatches,
                noCompletedAssistant: noAssistantCompletion,
                nativeEffects: {
                  submitCount: matchingEffectLines(
                    targetEffects,
                    cell.effect!.contains
                  ).length,
                  cancelCount: matchingEffectLines(
                    afterEffects,
                    cell.cancel!.effect.contains
                  ).length,
                  cancelUnchangedAfterRetry:
                    JSON.stringify(
                      matchingEffectLines(
                        cancelEffects,
                        cell.cancel!.effect.contains
                      )
                    ) ===
                    JSON.stringify(
                      matchingEffectLines(
                        afterEffects,
                        cell.cancel!.effect.contains
                      )
                    ),
                },
                receipts: normalizeConformanceTrace({
                  submit: first.body,
                  cancel: firstCancel.body,
                  control,
                  target,
                  retry: retry.body,
                }) as JsonObject,
                trace: normalizeConformanceTrace(trace) as JsonObject,
              },
            });
            continue;
          }
          if (cell.kind === "post_native_eof") {
            const traceStart = publicTrace.frames.length;
            const initialBootId = publicTrace.frames.find(
              (frame) => frame.type === "hello"
            )?.bootId;
            const first = await submit(cell.text);
            const inspect = () =>
              request(
                `/api/bots/fixture/operations/${encodeURIComponent(cell.operationId)}`
              ).then((value) => value.body);
            const before = await waitFor(
              inspect,
              "unknown",
              "reconciliation_required"
            );
            const effectPath = join(
              directory,
              ".fleet",
              "plugins",
              String(binding.bindingId),
              cell.effect!.file
            );
            const beforeFile = await stableEffect(
              effectPath,
              cell.effect!.contains,
              cell.effect!.expectedOccurrences
            );
            const beforeEffects = matchingEffectLines(
              beforeFile,
              cell.effect!.contains
            );
            const beforeTrace = publicTrace.frames.slice(traceStart);
            publicTrace.close();
            await handle!.stop();
            handle = await launch();
            const recoveredBinding = (
              await request("/api/bots/fixture/capabilities")
            ).body;
            if (
              !object(recoveredBinding) ||
              !nonempty(recoveredBinding.bindingId) ||
              !nonempty(recoveredBinding.conversationId)
            )
              throw new Error(
                "Conformance recovery did not reach supervisor readiness"
              );
            publicTrace = await collectPublicTrace(handle.url);
            const recoveryBootId = publicTrace.frames.find(
              (frame) => frame.type === "hello"
            )?.bootId;
            const sameBinding =
              recoveredBinding.bindingId === binding.bindingId &&
              recoveredBinding.bindingRevision === binding.bindingRevision &&
              recoveredBinding.conversationId === binding.conversationId;
            const rosterReady = publicTrace.frames.some(
              (frame) =>
                frame.type === "roster" &&
                Array.isArray(frame.bots) &&
                frame.bots.some(
                  (bot) =>
                    object(bot) && bot.name === "fixture" && bot.online === true
                )
            );
            const supervisorReady =
              sameBinding &&
              rosterReady &&
              nonempty(initialBootId) &&
              nonempty(recoveryBootId) &&
              initialBootId !== recoveryBootId;
            if (!supervisorReady)
              throw new Error(
                "Conformance recovery lacks a new ready supervisor with the original binding"
              );
            const after = await waitFor(
              inspect,
              "unknown",
              "reconciliation_required"
            );
            const afterFile = await stableEffect(
              effectPath,
              cell.effect!.contains,
              cell.effect!.expectedOccurrences
            );
            const afterEffects = matchingEffectLines(
              afterFile,
              cell.effect!.contains
            );
            const recoveryTrace = publicTrace.frames.slice();
            const noAssistantCompletion = noCompletedAssistant(
              [...beforeTrace, ...recoveryTrace],
              cell.operationId
            );
            const matched = postNativeEofMatches(
              first,
              before,
              after,
              cell.expect,
              beforeEffects,
              afterEffects,
              noAssistantCompletion
            );
            cells.push({
              id: cell.id,
              status: matched ? "passed" : "failed",
              evidence: {
                firstStatus: first.status,
                recoveryReady: supervisorReady,
                recoveryState: "ready",
                noCompletedAssistant: noAssistantCompletion,
                nativeEffects: {
                  file: cell.effect!.file,
                  count: afterEffects.length,
                  unchanged:
                    JSON.stringify(beforeEffects) ===
                    JSON.stringify(afterEffects),
                },
                receipts: normalizeConformanceTrace({
                  first: first.body,
                  before,
                  after,
                }) as JsonObject,
                events: normalizeConformanceTrace({
                  beforeRestart: beforeTrace,
                  afterRestart: recoveryTrace,
                }) as JsonObject,
              },
            });
            continue;
          }
          const traceStart = publicTrace.frames.length;
          const first = await submit(cell.text);
          const receipt = cell.expect.execution
            ? await waitFor(
                async () =>
                  (
                    await request(
                      `/api/bots/fixture/operations/${encodeURIComponent(cell.operationId)}`
                    )
                  ).body,
                cell.expect.execution
              )
            : undefined;
          const effectPath =
            cell.effect &&
            join(
              directory,
              ".fleet",
              "plugins",
              String(binding.bindingId),
              cell.effect.file
            );
          const beforeEffect = effectPath
            ? await waitForEffect(
                effectPath,
                cell.effect!.contains,
                cell.effect!.expectedOccurrences
              )
            : undefined;
          const retry =
            cell.retry === "same"
              ? await submit(cell.text)
              : cell.retry === "conflict"
                ? await submit(`${cell.text} changed`)
                : undefined;
          const afterReceipt = cell.retry
            ? (
                await request(
                  `/api/bots/fixture/operations/${encodeURIComponent(cell.operationId)}`
                )
              ).body
            : undefined;
          const events = cell.events
            ? await publicEvidence(
                publicTrace.frames,
                traceStart,
                cell.operationId,
                cell.events
              )
            : undefined;
          let healthyReceipt: JsonObject | undefined;
          let healthyStatus: number | undefined;
          if (cell.kind === "split_lf") {
            const healthy = (await request("/api/bots/healthy/capabilities"))
              .body;
            if (
              !object(healthy) ||
              !nonempty(healthy.conversationId) ||
              !nonempty(healthy.bindingRevision)
            )
              throw new Error("healthy_binding_unavailable");
            const healthyId = `${cell.operationId}-healthy`;
            healthyStatus = (
              await request("/api/bots/healthy/message", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-tidy-client-contract": "2",
                  "x-tidy-binding-revision": String(healthy.bindingRevision),
                },
                body: JSON.stringify({
                  operationId: healthyId,
                  clientMessageId: healthyId,
                  conversationId: healthy.conversationId,
                  text: cell.text,
                }),
              })
            ).status;
            healthyReceipt = await waitFor(
              () =>
                request(`/api/bots/healthy/operations/${healthyId}`).then(
                  (value) => value.body
                ),
              "ended",
              "complete"
            );
          }
          let effects: JsonObject | undefined;
          if (cell.effect) {
            const file = await readFile(effectPath!, "utf8");
            const before = matchingEffectLines(
              beforeEffect!,
              cell.effect!.contains
            );
            const after = matchingEffectLines(file, cell.effect!.contains);
            effects = {
              file: cell.effect.file,
              count: after.length,
              unchanged: JSON.stringify(before) === JSON.stringify(after),
            };
            // The fixture-owned predicate is the native operation write. Other post-terminal RPC traffic is not a repeat.
            if (
              after.length !== cell.effect.expectedOccurrences ||
              JSON.stringify(before) !== JSON.stringify(after)
            )
              throw new Error(
                "Fixture write evidence differs from expectation"
              );
          }
          const immutable = receipt
            ? immutableReceiptMatches(first.body, receipt)
            : true;
          const retryUnchanged =
            !cell.retry ||
            JSON.stringify(afterReceipt) === JSON.stringify(receipt);
          const matched =
            first.status === cell.expect.status &&
            immutable &&
            retryUnchanged &&
            (!cell.expect.execution ||
              receipt?.execution === cell.expect.execution) &&
            (cell.kind !== "split_lf" ||
              (healthyStatus === 202 &&
                healthyReceipt?.execution === "ended")) &&
            (cell.retry !== "conflict" || retry?.status === 409);
          cells.push({
            id: cell.id,
            status: matched ? "passed" : "failed",
            evidence: {
              firstStatus: first.status,
              immutableReceipt: immutable,
              retryUnchanged,
              ...(retry ? { retryStatus: retry.status } : {}),
              ...(receipt ? { receipt } : {}),
              ...(afterReceipt ? { retryReceipt: afterReceipt } : {}),
              ...(effects ? { effects } : {}),
              ...(events ? { events } : {}),
              ...(healthyReceipt
                ? {
                    healthyStatus,
                    healthyReceipt: normalizeConformanceTrace(healthyReceipt),
                  }
                : {}),
            },
          });
        } catch (error) {
          const code =
            error instanceof Error ? error.message : "conformance_error";
          cells.push({
            id: cell.id,
            status: /capability_unavailable|unsupported/.test(code)
              ? "unsupported"
              : "failed",
            evidence: {},
            error: code,
          });
        }
      }
    } finally {
      publicTrace.close();
    }
    const eventCells = options.fixture.cells
      .filter((cell) => cell.events && !cell.skip)
      .map((cell) => cell.id);
    const splitLfCells = options.fixture.cells
      .filter((cell) => cell.kind === "split_lf" && !cell.skip)
      .map((cell) => cell.id);
    const malformedCells = options.fixture.cells
      .filter((cell) => cell.kind === "malformed_plugin" && !cell.skip)
      .map((cell) => cell.id);
    const eofCells = options.fixture.cells
      .filter((cell) => cell.kind === "post_native_eof" && !cell.skip)
      .map((cell) => cell.id);
    const cancellationCells = options.fixture.cells
      .filter((cell) => cell.kind === "cancel" && !cell.skip)
      .map((cell) => cell.id);
    const retryCells = options.fixture.cells
      .filter((cell) => cell.retry && !cell.skip)
      .map((cell) => cell.id);
    const prelaunchCells = options.fixture.cells
      .filter((cell) => cell.kind === "prelaunch" && !cell.skip)
      .map((cell) => cell.id);
    report = {
      scope: {
        mode: "local_disposable",
        daemon: "startFleet",
        registryPath: options.registryPath,
        pluginId: options.pluginId,
        artifact: entry,
        fixtureSha256: `sha256:${createHash("sha256").update(JSON.stringify(options.fixture)).digest("hex")}`,
        allowedUncertainty: options.fixture.allowedUncertainty ?? [],
        injection: options.fixture.injection ?? {
          kind: "none",
          fixtureId: "none",
        },
        exercised: [
          ...(prelaunchCells.length
            ? ["C01.startup_negotiation_prelaunch"]
            : []),
          ...(retryCells.length || cancellationCells.length ? ["C03"] : []),
          ...(eventCells.length ? ["C05.public_ordered_terminal"] : []),
          ...(splitLfCells.length ? ["C02.lf_split_valid_frame"] : []),
          ...(malformedCells.length ? ["C02.malformed_plugin_isolation"] : []),
          ...(eofCells.length
            ? ["C04.post_write_eof", "C05.post_write_eof_recovery"]
            : []),
          ...(cancellationCells.length
            ? ["L03.cancel_rest_acknowledged_delayed_lost"]
            : []),
        ],
        eventCells,
        eofCells,
        cancellationCells,
        retryCells,
        notRun: [
          ...(prelaunchCells.length
            ? ["C01.other_protocol_variants"]
            : ["C01"]),
          ...(splitLfCells.length || malformedCells.length
            ? ["C02.other_plugin_frame_variants"]
            : ["C02"]),
          ...(retryCells.length || cancellationCells.length ? [] : ["C03"]),
          "C04",
          "C05.source_replay_crash",
          "C06",
          "C07",
          "C08",
          "C09",
          "C10",
          "L01",
          "L02",
          ...(cancellationCells.length
            ? [
                "L03.cancel_impossible_or_unsupported",
                "L03.tool_child_survives",
              ]
            : ["L03"]),
          "L04",
          "L05",
          "L06",
          "L07",
          "L08",
          "L09",
          "L10",
        ],
        nativeProvider: "not-run",
      },
      cells,
    };
    return report;
  } finally {
    try {
      await handle?.stop();
    } catch (error) {
      if (report)
        report.cells.push({
          id: "cleanup",
          status: "failed",
          evidence: {},
          error: error instanceof Error ? error.message : "cleanup_failed",
        });
      else throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
