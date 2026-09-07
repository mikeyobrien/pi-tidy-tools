import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startFleet } from "./daemon.ts";
import { nonempty, object, type JsonObject } from "./gateway/protocol.ts";

export type ConformanceStatus = "passed" | "failed" | "unsupported" | "not-run";
export interface LocalConformanceCell {
  id: string;
  kind: "message";
  operationId: string;
  text: string;
  retry?: "same" | "conflict";
  effect?: { file: string; expectedOccurrences: number; contains: string };
  /** Public stream predicates; one fixture bot executes cells serially. */
  events?: { minFrames: number; terminalFinals: 1 };
  expect: { status: number; execution?: "ended" | "failed" | "cancelled" };
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
export function normalizeConformanceTrace(value: unknown): unknown {
  const identifiers = new Map<string, number>();
  const normalize = (item: unknown, key?: string): unknown => {
    if (typeof item === "string" && key && /(?:id|reference)$/i.test(key)) {
      const ordinal = identifiers.get(item) ?? identifiers.size + 1;
      identifiers.set(item, ordinal);
      return `<id:${ordinal}>`;
    }
    if (
      typeof item === "string" &&
      key &&
      /(?:ts|timestamp|createdAt|updatedAt)$/i.test(key)
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
        cell.kind !== "message" ||
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
            cell.events.terminalFinals !== 1))
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
  execution: string
): Promise<JsonObject> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const receipt = await fetchReceipt();
    if (receipt.execution === execution) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Conformance receipt did not reach its expected terminal state"
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
  const sequenced = trace.filter((frame) => typeof frame.seq === "number");
  const ordered = sequenced.every(
    (frame, index) =>
      index === 0 || Number(frame.seq) > Number(sequenced[index - 1].seq)
  );
  if (
    trace.length < expected.minFrames ||
    terminal.length !== expected.terminalFinals ||
    !ordered
  )
    return undefined;
  return {
    frameCount: trace.length,
    linkedAppendCount: linked.length,
    terminalFinalCount: terminal.length,
    ordered,
    turnId: `<correlated>`,
    trace: normalizeConformanceTrace(trace) as JsonObject,
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
    "",
  ].join("\n");
  await writeFile(join(directory, "bots.toml"), gateway);
  let handle: Awaited<ReturnType<typeof startFleet>> | undefined;
  const cells: LocalConformanceReceipt[] = [];
  let report: LocalConformanceReport | undefined;
  try {
    handle = await startFleet({
      dir: directory,
      port: 0,
      token: "local-conformance-token",
      log() {},
    });
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
    const publicTrace = await collectPublicTrace(handle.url);
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
          "C03",
          "L10",
          ...(eventCells.length ? ["C05.public_ordered_terminal"] : []),
        ],
        eventCells,
        notRun: [
          "C01",
          "C02",
          "C04",
          "C05.source_replay_crash",
          "C06",
          "C07",
          "C08",
          "C09",
          "C10",
          "L01",
          "L02",
          "L03",
          "L04",
          "L05",
          "L06",
          "L07",
          "L08",
          "L09",
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
