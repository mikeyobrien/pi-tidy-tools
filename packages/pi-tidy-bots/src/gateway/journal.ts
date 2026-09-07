import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  permissionKey,
  permissionRequest,
  permissionResolution,
  matchPermissionDecision,
  type PermissionRecord,
  type PermissionProjection,
} from "./permissions.ts";
import {
  questionKey,
  questionRequest,
  questionResolution,
  matchQuestionDecision,
  type QuestionRecord,
  type QuestionProjection,
} from "./questions.ts";

/** Gateway storage is certified against this engine, rather than a best-effort substitute. */
export const GATEWAY_SQLITE_VERSION = "3.53.4";
const APPLICATION_ID = 0x54474459;
const SCHEMA_VERSION = 2;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface ArtifactUpload {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
function imageFile(artifact: JsonValue): string | null {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    return null;
  const id = artifact.artifactId;
  const extension =
    artifact.mediaType === "image/png"
      ? "png"
      : artifact.mediaType === "image/jpeg"
        ? "jpg"
        : null;
  return typeof id === "string" && /^sha256:[a-f0-9]{64}$/.test(id) && extension
    ? `${id.slice(7)}.${extension}`
    : null;
}
function publicArtifacts(artifacts: JsonValue, bot: string): JsonObject {
  if (!Array.isArray(artifacts)) return {};
  const images: JsonValue[] = [],
    attachments: JsonValue[] = [];
  for (const artifact of artifacts) {
    const file = imageFile(artifact);
    if (file) {
      const descriptor = artifact as JsonObject;
      images.push({
        mediaType: descriptor.mediaType,
        name: descriptor.name,
        path: `.fleet/images/${bot}/${file}`,
      });
    } else attachments.push(artifact);
  }
  return {
    ...(images.length ? { images } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}
function artifactPrefix(key: OperationKey): string {
  return `artifact_v1:${payloadDigest({ botId: key.botId, conversationId: key.conversationId, operationId: key.operationId })}:`;
}

export type OperationKind =
  | "message"
  | "model"
  | "thinking"
  | "compact"
  | "new_context"
  | "instructions"
  | "question"
  | "permission"
  | "cancel"
  | "session_open";
export type DeliveryState =
  "queued" | "dispatching" | "accepted" | "rejected" | "unknown";
export type ExecutionState =
  | "not_started"
  | "running"
  | "waiting_for_input"
  | "cancel_requested"
  | "ended"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type ObservationState =
  "complete" | "live_gap" | "reconciliation_required";
export interface ConversationKey {
  botId: string;
  conversationId: string;
}
export interface OperationKey extends ConversationKey {
  operationId: string;
}
export interface ConversationBinding extends ConversationKey {
  bindingId: string;
  bindingRevision: string;
  policyRevision: string;
}
export interface WriterLease {
  ownerId: string;
  generation: number;
  expiresAt: number;
}
export interface OwnerProcessIdentity {
  pid: number;
  /** Opaque platform birth identity, compared exactly by the supervisor. */
  startedAt: string;
}
export interface WriterState {
  ownerId: string | null;
  generation: number;
  expiresAt: number;
  reconciled: boolean;
}
interface OwnedLaunchIdentity {
  launchId: string;
  bindingId: string;
  /** Independently supervised group owned by a started launch in this binding. */
  parentLaunchId?: string;
}
export type OwnedLaunchRecord = OwnedLaunchIdentity &
  (
    | {
        state: "prepared";
        pid?: undefined;
        startedAt?: undefined;
        token?: undefined;
      }
    | { state: "started"; pid: number; startedAt: string; token: string }
    | { state: "stopped"; pid?: number; startedAt?: string; token?: string }
  );
export interface SupervisorOwnershipRecord {
  version: 1;
  generation: number;
  ownerProcess: OwnerProcessIdentity;
  launches: OwnedLaunchRecord[];
}
const SUPERVISOR_META_KEY = "supervisor_ownership_v1";
const MAX_OWNED_LAUNCHES = 16384;
const MAX_OWNERSHIP_DEPTH = 64;
export interface OperationReceipt extends OperationKey {
  fleetId: string;
  bindingId: string;
  bindingRevision: string;
  kind?: OperationKind;
  userEntryId?: string;
  delivery: DeliveryState;
  execution: ExecutionState;
  observation: ObservationState;
  result?: JsonObject;
}
export interface AdmitOperation extends ConversationBinding {
  operationId: string;
  kind?: OperationKind;
  payload: JsonObject;
  actorId?: string;
  /** Display routing alias for the atomic public append; identities remain ID based. */
  publicBotName?: string;
  /** Additional canonical message metadata, after upstream validation. */
  userEntry?: JsonObject;
}
export interface RoutineFireAdmission {
  scheduleId: string;
  occurrence: string;
  owner: string;
  ownerGeneration: number;
  binding: ConversationBinding;
  payload: JsonObject;
  actorId?: string;
}
export interface RoutineScheduleOwner {
  scheduleId: string;
  owner: string;
  generation: number;
}
export interface OperationRecord {
  receipt: OperationReceipt;
  payload: JsonObject | null;
  payloadDigest: string;
  policyRevision: string;
  actorId: string;
  turnId: string;
  ordinal: number;
  leaseGeneration: number | null;
  expired: boolean;
}
export interface AdmitFleetDispatch {
  origin: ConversationBinding & { operationId: string };
  toolCallId: string;
  actionId: string;
  payloadDigest?: string;
  target: ConversationBinding;
  text: string;
  publicBotName?: string;
}
export interface FleetDispatchLookup {
  origin: ConversationBinding & { operationId: string };
  toolCallId: string;
  actionId: string;
  payloadDigest: string;
  target: ConversationBinding;
}
export interface FleetDispatchProof {
  fleetId: string;
  bindingId: string;
  operationId: string;
  toolCallId: string;
  actionId: string;
  payloadDigest: string;
  targetBotId: string;
  targetConversationId: string;
  targetBindingId: string;
}
export interface OperationDisposition {
  delivery?: DeliveryState;
  execution?: ExecutionState;
  observation?: ObservationState;
  result?: JsonObject;
  /** Correlated native evidence is required to resolve ambiguity or an observation gap. */
  evidence?: string;
}
export interface PluginSourceEvent {
  bindingId: string;
  leaseGeneration: number;
  sourceSequence: number;
  eventId: string;
  type: string;
  operationId?: string;
  turnId?: string;
  /** Optional native UI or permission interaction correlation. */
  interactionId?: string;
  payload: JsonObject;
}
export interface CompletionDelivery {
  dispatchId: string;
  originBotId: string;
  payload: JsonObject;
}
export interface EventProjection {
  permission?: PermissionProjection;
  question?: QuestionProjection;
  entries?: JsonObject[];
  operation?: OperationDisposition;
  completion?: CompletionDelivery;
  /** Wire events, without seq. Omit to expose the source event as one public event. */
  publicEvents?: JsonObject[];
}
export interface PublicEvent {
  seq: number;
  event: JsonObject;
}
export interface EventCommit {
  duplicate: boolean;
  /** Highest contiguous source sequence committed, suitable for events.ack. */
  ack: number;
  publicEvents: PublicEvent[];
}
export interface OutboxDelivery extends CompletionDelivery {
  id: number;
  targetBotId: string;
  conversationId: string;
  operationId: string;
}

export class GatewayJournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GatewayJournalError";
  }
}
function fail(code: string, message: string): never {
  throw new GatewayJournalError(code, message);
}
function identifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    value.includes("\0")
  )
    fail("invalid_identity", `Invalid ${label}`);
}

/** Sorted JSON encoding rejects values JSON.stringify would silently erase or coerce. */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null || stack.has(item))
      return fail("invalid_payload", "Payload must be finite, acyclic JSON");
    stack.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Sparse slots must not silently become null.
      for (let i = 0; i < item.length; i++)
        if (!(i in item)) fail("invalid_payload", "Sparse JSON array");
      result = `[${item.map(encode).join(",")}]`;
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        fail("invalid_payload", "Payload must use plain JSON objects");
      if (Object.getOwnPropertySymbols(item).length)
        fail("invalid_payload", "Symbol keys are not JSON");
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
        .join(",")}}`;
    }
    stack.delete(item);
    return result;
  }
  return encode(value);
}
export function payloadDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function parseObject(value: unknown): JsonObject {
  return JSON.parse(String(value)) as JsonObject;
}
type Row = Record<string, unknown>;
type SqlValue = null | number | bigint | string | Uint8Array;
type RowStatement = Omit<StatementSync, "get" | "all"> & {
  get(...parameters: SqlValue[]): Row | undefined;
  all(...parameters: SqlValue[]): Row[];
};
const terminalExecutions = new Set<ExecutionState>([
  "ended",
  "failed",
  "cancelled",
  "interrupted",
]);
const operationKinds = new Set<OperationKind>([
  "message",
  "model",
  "thinking",
  "compact",
  "new_context",
  "instructions",
  "question",
  "permission",
  "cancel",
  "session_open",
]);
function terminal(receipt: OperationReceipt): boolean {
  return (
    terminalExecutions.has(receipt.execution) || receipt.delivery === "rejected"
  );
}
function uncertain(receipt: OperationReceipt): boolean {
  return (
    receipt.delivery === "unknown" ||
    receipt.execution === "unknown" ||
    receipt.observation !== "complete"
  );
}
function resolved(receipt: OperationReceipt): boolean {
  if (uncertain(receipt) || !terminal(receipt)) return false;
  if (
    receipt.delivery === "rejected" ||
    receipt.execution !== "ended" ||
    !receipt.kind ||
    receipt.kind === "message"
  )
    return true;
  if (receipt.kind === "session_open")
    return (
      ["opened", "applied"].includes(String(receipt.result?.status)) &&
      typeof receipt.result?.nativeReference === "string" &&
      receipt.result.nativeReference.length > 0
    );
  return (
    ["applied", "expired", "cancelled", "failed"].includes(
      String(receipt.result?.status)
    ) ||
    (receipt.kind === "question" &&
      receipt.result?.status === "unknown" &&
      receipt.result?.transport === "submitted" &&
      receipt.result?.consumption === "unconfirmed") ||
    (receipt.kind === "cancel" && receipt.result?.status === "requested")
  );
}

/**
 * One local writer, fenced across every transaction. An expired lease never proves
 * old native ownership ended: acquiring its replacement requires supervisor evidence.
 * No method in this module invokes a native runtime or retries a native mutation.
 */
export class GatewayJournal {
  readonly fleetId: string;
  readonly sqliteVersion: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(
    path: string,
    options: { fleetId?: string; now?: () => number } = {}
  ) {
    if (!path || path === ":memory:")
      fail(
        "storage_not_durable",
        "Gateway journal requires an on-disk database"
      );
    if (options.fleetId !== undefined) identifier(options.fleetId, "fleet ID");
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.sqliteVersion = String(
        this.prepare("SELECT sqlite_version() AS version").get()!.version
      );
      if (this.sqliteVersion !== GATEWAY_SQLITE_VERSION)
        fail(
          "unsupported_sqlite",
          `Gateway requires SQLite ${GATEWAY_SQLITE_VERSION}; found ${this.sqliteVersion}`
        );
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const applicationId = Number(
        this.prepare("PRAGMA application_id").get()!.application_id
      );
      const schemaVersion = Number(
        this.prepare("PRAGMA user_version").get()!.user_version
      );
      if (applicationId !== 0 && applicationId !== APPLICATION_ID)
        fail("incompatible_storage", "Database belongs to another application");
      if (
        schemaVersion !== 0 &&
        schemaVersion !== 1 &&
        schemaVersion !== SCHEMA_VERSION
      )
        fail(
          "incompatible_storage",
          `Unsupported gateway schema ${schemaVersion}`
        );
      if ((applicationId === 0) !== (schemaVersion === 0))
        fail(
          "incompatible_storage",
          "Gateway schema and application identities disagree"
        );
      if (
        applicationId === 0 &&
        Number(
          this.prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
          ).get()!.n
        )
      )
        fail(
          "incompatible_storage",
          "Refusing to adopt an existing non-gateway database"
        );
      const mode = this.prepare("PRAGMA journal_mode = WAL").get()!
        .journal_mode;
      this.db.exec("PRAGMA synchronous = FULL;");
      if (
        mode !== "wal" ||
        Number(this.prepare("PRAGMA synchronous").get()!.synchronous) !== 2
      )
        fail(
          "unsupported_storage",
          "Gateway requires SQLite WAL and synchronous FULL"
        );
      const check = this.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || check[0].quick_check !== "ok")
        fail("corrupt_storage", "Gateway journal integrity check failed");
      if (schemaVersion !== 0) {
        const existingTables = new Set(
          this.prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((row) => row.name)
        );
        for (const table of [
          "gateway_meta",
          "bots",
          "writer_lease",
          "conversations",
          "operations",
          "transcript_entries",
          "source_events",
          "public_events",
          "completion_outbox",
        ]) {
          if (!existingTables.has(table))
            fail(
              "corrupt_storage",
              `Gateway table ${table} is missing; refusing to fabricate empty recovery state`
            );
        }
        if (this.prepare("PRAGMA foreign_key_check").all().length)
          fail(
            "corrupt_storage",
            "Gateway journal contains broken identity references"
          );
      } else
        this.transaction(() => {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS bots (bot_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
          CREATE TABLE IF NOT EXISTS writer_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT,
            generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, reconciled INTEGER NOT NULL CHECK(reconciled IN (0,1))) STRICT;
          CREATE TABLE IF NOT EXISTS conversations (bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
            binding_id TEXT NOT NULL UNIQUE, binding_revision TEXT NOT NULL, policy_revision TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), source_ack INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(bot_id, conversation_id)) STRICT;
          CREATE TABLE IF NOT EXISTS operations (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            binding_id TEXT NOT NULL, binding_revision TEXT NOT NULL, policy_revision TEXT NOT NULL,
            actor_id TEXT NOT NULL, kind TEXT NOT NULL, payload_digest TEXT NOT NULL, payload_json TEXT,
            turn_id TEXT NOT NULL, user_entry_id TEXT, delivery TEXT NOT NULL, execution TEXT NOT NULL,
            observation TEXT NOT NULL, result_json TEXT, lease_generation INTEGER, expired INTEGER NOT NULL DEFAULT 0,
            UNIQUE(bot_id, conversation_id, operation_id),
            FOREIGN KEY(bot_id, conversation_id) REFERENCES conversations(bot_id, conversation_id)) STRICT;
          CREATE INDEX IF NOT EXISTS operations_fifo ON operations(bot_id, conversation_id, ordinal);
          CREATE TABLE IF NOT EXISTS transcript_entries (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entry_id TEXT NOT NULL, operation_id TEXT,
            entry_json TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(bot_id, conversation_id, entry_id),
            FOREIGN KEY(bot_id, conversation_id) REFERENCES conversations(bot_id, conversation_id)) STRICT;
          CREATE TABLE IF NOT EXISTS source_events (binding_id TEXT NOT NULL, source_sequence INTEGER NOT NULL,
            event_id TEXT NOT NULL, digest TEXT NOT NULL, event_json TEXT NOT NULL, projection_json TEXT NOT NULL,
            applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding_id, source_sequence), UNIQUE(binding_id, event_id),
            FOREIGN KEY(binding_id) REFERENCES conversations(binding_id)) STRICT;
          CREATE TABLE IF NOT EXISTS public_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, binding_id TEXT NOT NULL,
            event_json TEXT NOT NULL, FOREIGN KEY(binding_id) REFERENCES conversations(binding_id)) STRICT;
          CREATE TABLE IF NOT EXISTS completion_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
            origin_bot_id TEXT NOT NULL, target_bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
            operation_id TEXT NOT NULL, payload_json TEXT NOT NULL, digest TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE IF NOT EXISTS schedule_owners (schedule_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation >= 1)) STRICT;
          CREATE TABLE IF NOT EXISTS routine_fires (fire_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
            occurrence TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL, binding_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
            owner TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
            FOREIGN KEY(bot_id, conversation_id) REFERENCES conversations(bot_id, conversation_id)) STRICT;
        `);
          this.prepare(
            "INSERT INTO gateway_meta(key,value) VALUES('fleet_id',?)"
          ).run(options.fleetId ?? `fleet-${randomUUID()}`);
          this.db.exec(
            `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`
          );
        });
      if (schemaVersion === 1) {
        const storedBeforeUpgrade = this.prepare(
          "SELECT value FROM gateway_meta WHERE key='fleet_id'"
        ).get();
        if (
          !storedBeforeUpgrade ||
          typeof storedBeforeUpgrade.value !== "string" ||
          !storedBeforeUpgrade.value
        )
          fail("corrupt_storage", "Gateway fleet identity is missing");
        if (
          options.fleetId !== undefined &&
          storedBeforeUpgrade.value !== options.fleetId
        )
          fail(
            "fleet_mismatch",
            "Stored fleet ID differs from requested fleet ID"
          );
        const writer = this.prepare(
          "SELECT * FROM writer_lease WHERE singleton=1"
        ).get();
        if (
          writer?.owner_id !== null ||
          Number(writer?.expires_at ?? 0) > this.now() ||
          Number(writer?.reconciled ?? 0) !== 1
        )
          fail(
            "ownership_unreconciled",
            "Storage upgrade requires a stopped, reconciled gateway"
          );
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS schedule_owners (schedule_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK(generation >= 1)) STRICT;
            CREATE TABLE IF NOT EXISTS routine_fires (fire_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
              occurrence TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL,
              conversation_id TEXT NOT NULL, binding_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
              owner TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
              FOREIGN KEY(bot_id, conversation_id) REFERENCES conversations(bot_id, conversation_id)) STRICT;
            PRAGMA user_version = ${SCHEMA_VERSION};
          `);
        });
      }
      for (const table of ["schedule_owners", "routine_fires"]) {
        if (
          !this.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
          ).get(table)
        )
          fail(
            "corrupt_storage",
            `Gateway table ${table} is missing; refusing to fabricate schedule state`
          );
      }
      const stored = this.prepare(
        "SELECT value FROM gateway_meta WHERE key='fleet_id'"
      ).get();
      if (!stored || typeof stored.value !== "string" || !stored.value)
        fail("corrupt_storage", "Gateway fleet identity is missing");
      if (options.fleetId !== undefined && stored.value !== options.fleetId)
        fail(
          "fleet_mismatch",
          "Stored fleet ID differs from requested fleet ID"
        );
      this.fleetId = stored.value;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private prepare(sql: string): RowStatement {
    return this.db.prepare(sql) as RowStatement;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure; acceptance was never returned. */
      }
      throw error;
    }
  }
  private write<T>(lease: WriterLease, work: () => T): T {
    return this.transaction(() => {
      this.assertLease(lease);
      return work();
    });
  }
  private assertLease(lease: WriterLease): void {
    const row = this.prepare(
      "SELECT * FROM writer_lease WHERE singleton=1"
    ).get();
    if (
      !row ||
      row.owner_id !== lease.ownerId ||
      row.generation !== lease.generation ||
      Number(row.expires_at) <= this.now()
    )
      fail(
        "stale_writer",
        "Writer lease is stale, expired, or owned by another process"
      );
  }
  getWriterState(): WriterState | null {
    const row = this.prepare(
      "SELECT * FROM writer_lease WHERE singleton=1"
    ).get();
    if (!row) return null;
    if (
      (row.owner_id !== null &&
        (typeof row.owner_id !== "string" || !row.owner_id.trim())) ||
      !Number.isSafeInteger(row.generation) ||
      Number(row.generation) < 1 ||
      !Number.isSafeInteger(row.expires_at) ||
      Number(row.expires_at) < 0 ||
      (row.reconciled !== 0 && row.reconciled !== 1) ||
      (row.reconciled === 1 && row.owner_id !== null)
    )
      fail("invalid_ownership", "Stored writer ownership is malformed");
    return {
      ownerId: row.owner_id as string | null,
      generation: Number(row.generation),
      expiresAt: Number(row.expires_at),
      reconciled: row.reconciled === 1,
    };
  }
  private validateOwnerProcess(value: unknown): OwnerProcessIdentity {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      fail("invalid_ownership", "Missing process identity");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["pid", "startedAt"].includes(key)) ||
      !Number.isSafeInteger(record.pid) ||
      Number(record.pid) <= 0 ||
      Number(record.pid) > 2_147_483_647 ||
      typeof record.startedAt !== "string" ||
      !record.startedAt.trim() ||
      record.startedAt.length > 1024 ||
      record.startedAt.includes("\0")
    )
      fail("invalid_ownership", "Malformed process birth identity");
    return { pid: Number(record.pid), startedAt: record.startedAt };
  }
  /** Missing metadata remains missing; callers must never infer an empty owned set. */
  getSupervisorRecord(): SupervisorOwnershipRecord | null {
    const stored = this.prepare(
      "SELECT value FROM gateway_meta WHERE key=?"
    ).get(SUPERVISOR_META_KEY);
    if (!stored) return null;
    let value: unknown;
    try {
      value = JSON.parse(String(stored.value));
    } catch {
      fail(
        "invalid_ownership",
        "Stored supervisor ownership is not valid JSON"
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      fail(
        "invalid_ownership",
        "Stored supervisor ownership must be an object"
      );
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) =>
          !["version", "generation", "ownerProcess", "launches"].includes(key)
      ) ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.generation) ||
      Number(record.generation) < 1 ||
      !Array.isArray(record.launches) ||
      record.launches.length > MAX_OWNED_LAUNCHES
    )
      fail(
        "invalid_ownership",
        "Stored supervisor ownership has an unsupported shape"
      );
    const ownerProcess = this.validateOwnerProcess(record.ownerProcess);
    const ids = new Set<string>();
    const launches: OwnedLaunchRecord[] = record.launches.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("invalid_ownership", "Malformed owned launch");
      const launch = value as Record<string, unknown>;
      if (
        Object.keys(launch).some(
          (key) =>
            ![
              "launchId",
              "bindingId",
              "parentLaunchId",
              "state",
              "pid",
              "startedAt",
              "token",
            ].includes(key)
        ) ||
        !["prepared", "started", "stopped"].includes(String(launch.state)) ||
        typeof launch.launchId !== "string" ||
        typeof launch.bindingId !== "string"
      )
        fail("invalid_ownership", "Malformed owned launch identity/state");
      identifier(launch.launchId, "launch ID");
      identifier(launch.bindingId, "binding ID");
      if (launch.parentLaunchId !== undefined) {
        if (typeof launch.parentLaunchId !== "string")
          fail("invalid_ownership", "Malformed parent launch identity");
        identifier(launch.parentLaunchId, "parent launch ID");
      }
      if (ids.has(launch.launchId))
        fail("invalid_ownership", "Duplicate owned launch identity");
      ids.add(launch.launchId);
      const hasProcess =
        launch.pid !== undefined ||
        launch.startedAt !== undefined ||
        launch.token !== undefined;
      if (
        (launch.state === "prepared" && hasProcess) ||
        (launch.state === "started" && !hasProcess)
      )
        fail(
          "invalid_ownership",
          "Launch state disagrees with persisted process identity"
        );
      if (hasProcess) {
        this.validateOwnerProcess({
          pid: launch.pid,
          startedAt: launch.startedAt,
        });
        if (typeof launch.token !== "string" || !launch.token.trim())
          fail("invalid_ownership", "Owned launch token is missing");
        identifier(launch.token, "launch token");
      }
      return {
        launchId: launch.launchId,
        bindingId: launch.bindingId,
        ...(launch.parentLaunchId !== undefined
          ? { parentLaunchId: String(launch.parentLaunchId) }
          : {}),
        state: launch.state,
        ...(hasProcess
          ? {
              pid: Number(launch.pid),
              startedAt: String(launch.startedAt),
              token: String(launch.token),
            }
          : {}),
      } as OwnedLaunchRecord;
    });
    const byId = new Map(launches.map((launch) => [launch.launchId, launch]));
    const liveRoots = new Set<string>();
    const livePids = new Set<number>();
    const liveTokens = new Set<string>();
    for (const launch of launches) {
      const ancestors = new Set([launch.launchId]);
      let child = launch;
      while (child.parentLaunchId !== undefined) {
        const parent = byId.get(child.parentLaunchId);
        if (
          !parent ||
          parent.bindingId !== launch.bindingId ||
          ancestors.has(parent.launchId) ||
          ancestors.size >= MAX_OWNERSHIP_DEPTH ||
          parent.state === "prepared" ||
          (parent.state === "stopped" && child.state !== "stopped")
        )
          fail(
            "invalid_ownership",
            "Owned launch ancestry is missing, cyclic, or inconsistent"
          );
        ancestors.add(parent.launchId);
        child = parent;
      }
      if (launch.state !== "stopped" && launch.parentLaunchId === undefined) {
        if (liveRoots.has(launch.bindingId))
          fail("invalid_ownership", "Binding has competing root launches");
        liveRoots.add(launch.bindingId);
      }
      if (launch.state === "started") {
        if (livePids.has(launch.pid) || liveTokens.has(launch.token))
          fail(
            "invalid_ownership",
            "Owned launches share a live process identity"
          );
        livePids.add(launch.pid);
        liveTokens.add(launch.token);
      }
    }
    const writer = this.getWriterState();
    if (!writer || writer.generation !== record.generation)
      fail(
        "ownership_changed",
        "Supervisor ownership does not match the current writer generation"
      );
    return {
      version: 1,
      generation: Number(record.generation),
      ownerProcess,
      launches,
    };
  }
  private saveSupervisorRecord(record: SupervisorOwnershipRecord): void {
    this.prepare(
      "INSERT INTO gateway_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(SUPERVISOR_META_KEY, canonicalJson(record));
  }
  private ownedRecord(lease: WriterLease): SupervisorOwnershipRecord {
    const record = this.getSupervisorRecord();
    if (!record || record.generation !== lease.generation)
      fail(
        "ownership_missing",
        "This writer has no durable supervisor identity"
      );
    return record;
  }
  /** Commit before spawn; a prepared launch is not proof that a process exists or exited. */
  prepareOwnedLaunch(
    lease: WriterLease,
    launch: OwnedLaunchIdentity
  ): OwnedLaunchRecord {
    identifier(launch.launchId, "launch ID");
    identifier(launch.bindingId, "binding ID");
    if (launch.parentLaunchId !== undefined)
      identifier(launch.parentLaunchId, "parent launch ID");
    return this.write(lease, () => {
      const record = this.ownedRecord(lease);
      const existing = record.launches.find(
        (value) => value.launchId === launch.launchId
      );
      if (existing) {
        if (
          existing.bindingId !== launch.bindingId ||
          existing.parentLaunchId !== launch.parentLaunchId ||
          existing.state !== "prepared"
        )
          fail(
            "launch_conflict",
            "Launch identity cannot be replaced or returned to prepared"
          );
        return existing;
      }
      if (record.launches.length >= MAX_OWNED_LAUNCHES)
        fail(
          "resource_limit",
          "Supervisor launch history capacity is exhausted"
        );
      if (launch.parentLaunchId !== undefined) {
        const parent = record.launches.find(
          (value) => value.launchId === launch.parentLaunchId
        );
        if (
          !parent ||
          parent.state !== "started" ||
          parent.bindingId !== launch.bindingId
        )
          fail(
            "parent_not_owned",
            "Child launch requires a started parent in this binding"
          );
        const byId = new Map(
          record.launches.map((value) => [value.launchId, value])
        );
        let ancestor: OwnedLaunchRecord = parent;
        let depth = 2;
        while (ancestor.parentLaunchId !== undefined) {
          ancestor = byId.get(ancestor.parentLaunchId)!;
          if (++depth > MAX_OWNERSHIP_DEPTH)
            fail("resource_limit", "Supervisor ownership depth is exhausted");
        }
      } else if (
        record.launches.some(
          (value) =>
            value.bindingId === launch.bindingId && value.state !== "stopped"
        )
      )
        fail("binding_owned", "Binding already has an unresolved owned launch");
      const prepared: OwnedLaunchRecord = {
        launchId: launch.launchId,
        bindingId: launch.bindingId,
        ...(launch.parentLaunchId !== undefined
          ? { parentLaunchId: launch.parentLaunchId }
          : {}),
        state: "prepared",
      };
      record.launches.push(prepared);
      this.saveSupervisorRecord(record);
      return prepared;
    });
  }
  /** Commit exact wrapper identity before releasing its native-execution gate. */
  recordOwnedLaunch(
    lease: WriterLease,
    launchId: string,
    process: OwnerProcessIdentity & { token: string }
  ): OwnedLaunchRecord {
    const identity = this.validateOwnerProcess({
      pid: process.pid,
      startedAt: process.startedAt,
    });
    identifier(process.token, "launch token");
    return this.write(lease, () => {
      const record = this.ownedRecord(lease);
      const launch = record.launches.find(
        (value) => value.launchId === launchId
      );
      if (!launch)
        fail(
          "launch_not_prepared",
          "Native wrapper requires a durable launch reservation"
        );
      if (launch.state === "stopped")
        fail(
          "launch_conflict",
          "A stopped launch identity cannot be activated again"
        );
      const started: OwnedLaunchRecord = {
        launchId,
        bindingId: launch.bindingId,
        ...(launch.parentLaunchId !== undefined
          ? { parentLaunchId: launch.parentLaunchId }
          : {}),
        state: "started",
        ...identity,
        token: process.token,
      };
      if (launch.state === "started") {
        if (canonicalJson(launch) !== canonicalJson(started))
          fail("launch_conflict", "Owned launch process identity is immutable");
        return launch;
      }
      if (
        launch.parentLaunchId !== undefined &&
        !record.launches.some(
          (parent) =>
            parent.launchId === launch.parentLaunchId &&
            parent.state === "started" &&
            parent.bindingId === launch.bindingId
        )
      )
        fail(
          "parent_not_owned",
          "Child activation requires its original live parent"
        );
      if (
        record.launches.some(
          (other) =>
            other.state === "started" &&
            (other.pid === identity.pid || other.token === process.token)
        )
      )
        fail(
          "launch_conflict",
          "A process group cannot satisfy two launch identities"
        );
      record.launches[record.launches.indexOf(launch)] = started;
      this.saveSupervisorRecord(record);
      return started;
    });
  }
  /** Caller must have proved no owned group remains; this does not cancel native work. */
  completeOwnedLaunch(lease: WriterLease, launchId: string): OwnedLaunchRecord {
    return this.write(lease, () => {
      const record = this.ownedRecord(lease);
      const launch = record.launches.find(
        (value) => value.launchId === launchId
      );
      if (!launch) fail("launch_not_prepared", "Unknown owned launch");
      if (launch.state === "stopped") return launch;
      if (
        record.launches.some(
          (child) =>
            child.parentLaunchId === launchId && child.state !== "stopped"
        )
      )
        fail(
          "ownership_unreconciled",
          "Owned child launches must be reconciled before their parent"
        );
      const stopped: OwnedLaunchRecord = { ...launch, state: "stopped" };
      record.launches[record.launches.indexOf(launch)] = stopped;
      this.saveSupervisorRecord(record);
      return stopped;
    });
  }
  acquireWriterLease(
    ownerId: string,
    options: {
      ttlMs?: number;
      previousOwnerReconciled?: boolean;
      previousGeneration?: number;
      ownerProcess?: OwnerProcessIdentity;
    } = {}
  ): WriterLease {
    identifier(ownerId, "writer ID");
    const ttl = options.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400_000)
      fail("invalid_lease", "Lease TTL must be between 1 ms and one day");
    const ownerProcess =
      options.ownerProcess === undefined
        ? undefined
        : this.validateOwnerProcess(options.ownerProcess);
    if (
      options.previousGeneration !== undefined &&
      (!Number.isSafeInteger(options.previousGeneration) ||
        options.previousGeneration < 1)
    )
      fail(
        "invalid_ownership",
        "Reconciled writer generation must be a positive integer"
      );
    return this.transaction(() => {
      const row = this.prepare(
        "SELECT * FROM writer_lease WHERE singleton=1"
      ).get();
      const now = this.now();
      if (
        options.previousGeneration !== undefined &&
        row?.generation !== options.previousGeneration
      )
        fail(
          "ownership_changed",
          "Recovery proof refers to a different writer generation"
        );
      if (row && row.owner_id === ownerId && Number(row.expires_at) > now) {
        if (ownerProcess) {
          const existing = this.getSupervisorRecord();
          if (
            !existing ||
            canonicalJson(existing.ownerProcess) !== canonicalJson(ownerProcess)
          )
            fail(
              "owner_process_conflict",
              "A live writer identity cannot be replaced"
            );
        }
        const lease = {
          ownerId,
          generation: Number(row.generation),
          expiresAt: now + ttl,
        };
        this.prepare(
          "UPDATE writer_lease SET expires_at=? WHERE singleton=1"
        ).run(lease.expiresAt);
        return lease;
      }
      if (row && row.owner_id !== null && Number(row.expires_at) > now)
        fail("writer_busy", "Another writer still owns the gateway journal");
      if (row && !row.reconciled && !options.previousOwnerReconciled)
        fail(
          "ownership_unreconciled",
          "Expired lease does not prove old native ownership ended"
        );
      const previousSupervisor = this.getSupervisorRecord();
      if (previousSupervisor) {
        this.prepare(
          "INSERT INTO gateway_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).run(
          `supervisor_previous_v1:${previousSupervisor.generation}`,
          canonicalJson(previousSupervisor)
        );
      }
      const lease = {
        ownerId,
        generation: Number(row?.generation ?? 0) + 1,
        expiresAt: now + ttl,
      };
      this.prepare(
        "INSERT INTO writer_lease VALUES(1,?,?,?,0) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,generation=excluded.generation,expires_at=excluded.expires_at,reconciled=0"
      ).run(ownerId, lease.generation, lease.expiresAt);
      if (ownerProcess)
        this.saveSupervisorRecord({
          version: 1,
          generation: lease.generation,
          ownerProcess,
          launches: [],
        });
      else
        this.prepare("DELETE FROM gateway_meta WHERE key=?").run(
          SUPERVISOR_META_KEY
        );
      return lease;
    });
  }
  renewWriterLease(lease: WriterLease, ttlMs = 30_000): WriterLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000)
      fail("invalid_lease", "Invalid lease TTL");
    return this.write(lease, () => {
      const renewed = { ...lease, expiresAt: this.now() + ttlMs };
      this.prepare(
        "UPDATE writer_lease SET expires_at=? WHERE singleton=1"
      ).run(renewed.expiresAt);
      return renewed;
    });
  }
  /** Call with true only after the supervisor proved owned native processes stopped/fenced. */
  releaseWriterLease(
    lease: WriterLease,
    options: { ownershipReconciled?: boolean } = {}
  ): void {
    this.write(lease, () => {
      if (options.ownershipReconciled) {
        const owned = this.getSupervisorRecord();
        if (owned?.launches.some((launch) => launch.state !== "stopped"))
          fail(
            "ownership_unreconciled",
            "Owned launches must be proven stopped before clean release"
          );
      }
      this.prepare(
        "UPDATE writer_lease SET owner_id=NULL,expires_at=0,reconciled=? WHERE singleton=1"
      ).run(options.ownershipReconciled ? 1 : 0);
    });
  }

  ensureBot(lease: WriterLease, name: string): { botId: string; name: string } {
    identifier(name, "bot name");
    return this.write(lease, () => {
      const existing = this.botByName(name);
      if (existing) return existing;
      const bot = { botId: `bot-${randomUUID()}`, name };
      this.prepare("INSERT INTO bots(bot_id,name) VALUES(?,?)").run(
        bot.botId,
        name
      );
      return bot;
    });
  }
  botByName(name: string): { botId: string; name: string } | null {
    const row = this.prepare("SELECT * FROM bots WHERE name=?").get(name);
    return row ? { botId: String(row.bot_id), name: String(row.name) } : null;
  }
  renameBot(lease: WriterLease, botId: string, name: string): void {
    identifier(name, "bot name");
    this.write(lease, () => {
      if (!this.prepare("SELECT 1 FROM bots WHERE bot_id=?").get(botId))
        fail("bot_not_found", "Unknown bot identity");
      const other = this.botByName(name);
      if (other && other.botId !== botId)
        fail(
          "bot_name_conflict",
          "Bot name already belongs to another identity"
        );
      this.prepare("UPDATE bots SET name=? WHERE bot_id=?").run(name, botId);
    });
  }

  ensureConversation(
    lease: WriterLease,
    binding: ConversationBinding
  ): ConversationBinding {
    Object.entries(binding).forEach(([key, value]) => identifier(value, key));
    return this.write(lease, () => {
      const existing = this.conversation(binding, true);
      if (existing) {
        if (existing.deleted)
          fail(
            "conversation_deleted",
            "Deleted conversation identity cannot be reused"
          );
        if (
          existing.binding_id !== binding.bindingId ||
          existing.binding_revision !== binding.bindingRevision ||
          existing.policy_revision !== binding.policyRevision
        )
          fail(
            "binding_conflict",
            "Conversation already has a different immutable binding"
          );
        return { ...binding };
      }
      if (
        this.prepare("SELECT 1 FROM conversations WHERE binding_id=?").get(
          binding.bindingId
        )
      )
        fail(
          "binding_conflict",
          "Binding identity already belongs to another conversation"
        );
      this.prepare(
        "INSERT INTO conversations(bot_id,conversation_id,binding_id,binding_revision,policy_revision) VALUES(?,?,?,?,?)"
      ).run(
        binding.botId,
        binding.conversationId,
        binding.bindingId,
        binding.bindingRevision,
        binding.policyRevision
      );
      return { ...binding };
    });
  }
  getConversation(key: ConversationKey): ConversationBinding | null {
    const row = this.conversation(key, true);
    return !row || row.deleted ? null : this.binding(row);
  }
  listConversations(): ConversationBinding[] {
    return this.prepare(
      "SELECT * FROM conversations WHERE deleted=0 ORDER BY bot_id,conversation_id"
    )
      .all()
      .map((row) => this.binding(row));
  }
  private binding(row: Row): ConversationBinding {
    return {
      botId: String(row.bot_id),
      conversationId: String(row.conversation_id),
      bindingId: String(row.binding_id),
      bindingRevision: String(row.binding_revision),
      policyRevision: String(row.policy_revision),
    };
  }
  private conversation(
    key: ConversationKey,
    allowMissing = false
  ): Row | undefined {
    identifier(key.botId, "bot ID");
    identifier(key.conversationId, "conversation ID");
    const row = this.prepare(
      "SELECT * FROM conversations WHERE bot_id=? AND conversation_id=?"
    ).get(key.botId, key.conversationId);
    if (!row && !allowMissing)
      fail("conversation_not_found", "Conversation was not provisioned");
    if (row?.deleted && !allowMissing)
      fail("conversation_deleted", "Conversation was deleted");
    return row;
  }

  admit(
    lease: WriterLease,
    input: AdmitOperation
  ): { receipt: OperationReceipt; created: boolean } {
    return this.write(lease, () => this.admitOperation(input));
  }
  registerRoutineSchedule(
    lease: WriterLease,
    scheduleId: string,
    owner: string
  ): RoutineScheduleOwner {
    identifier(scheduleId, "schedule ID");
    identifier(owner, "schedule owner");
    return this.write(lease, () => {
      const existing = this.prepare(
        "SELECT * FROM schedule_owners WHERE schedule_id=?"
      ).get(scheduleId);
      if (existing) {
        if (existing.owner !== owner)
          fail("schedule_owner_conflict", "Schedule already has another owner");
        return {
          scheduleId,
          owner: String(existing.owner),
          generation: Number(existing.generation),
        };
      }
      this.prepare(
        "INSERT INTO schedule_owners(schedule_id,owner,generation) VALUES(?,?,1)"
      ).run(scheduleId, owner);
      return { scheduleId, owner, generation: 1 };
    });
  }
  cutoverRoutineSchedule(
    lease: WriterLease,
    scheduleId: string,
    expectedOwner: string,
    expectedGeneration: number,
    nextOwner: string
  ): RoutineScheduleOwner {
    identifier(scheduleId, "schedule ID");
    identifier(expectedOwner, "schedule owner");
    identifier(nextOwner, "schedule owner");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
      fail("invalid_generation", "Schedule generation must be positive");
    return this.write(lease, () => {
      const updated = this.prepare(
        "UPDATE schedule_owners SET owner=?,generation=generation+1 WHERE schedule_id=? AND owner=? AND generation=?"
      ).run(nextOwner, scheduleId, expectedOwner, expectedGeneration);
      if (updated.changes !== 1)
        fail("stale_schedule_owner", "Schedule owner or generation is stale");
      return {
        scheduleId,
        owner: nextOwner,
        generation: expectedGeneration + 1,
      };
    });
  }
  admitRoutineFire(
    lease: WriterLease,
    input: RoutineFireAdmission
  ): { receipt: OperationReceipt; created: boolean; fireId: string } {
    identifier(input.scheduleId, "schedule ID");
    identifier(input.occurrence, "schedule occurrence");
    identifier(input.owner, "schedule owner");
    if (
      !Number.isSafeInteger(input.ownerGeneration) ||
      input.ownerGeneration < 1
    )
      fail("invalid_generation", "Schedule generation must be positive");
    const fireId = `routine-fire:${payloadDigest({ scheduleId: input.scheduleId, occurrence: input.occurrence }).slice(7)}`;
    const operationId = `routine-op:${fireId.slice("routine-fire:".length)}`;
    const payloadDigestValue = payloadDigest(input.payload);
    return this.write(lease, () => {
      const existing = this.prepare(
        "SELECT * FROM routine_fires WHERE fire_id=?"
      ).get(fireId);
      if (existing) {
        if (
          existing.payload_digest !== payloadDigestValue ||
          existing.schedule_id !== input.scheduleId ||
          existing.occurrence !== input.occurrence ||
          existing.bot_id !== input.binding.botId ||
          existing.conversation_id !== input.binding.conversationId ||
          existing.binding_id !== input.binding.bindingId
        )
          fail(
            "operation_conflict",
            "Routine fire identity already has different intent"
          );
        const receipt = this.getOperation({
          botId: input.binding.botId,
          conversationId: input.binding.conversationId,
          operationId,
        });
        if (!receipt)
          fail("corrupt_storage", "Routine fire operation is missing");
        return { receipt, created: false, fireId };
      }
      const owner = this.prepare(
        "SELECT owner,generation FROM schedule_owners WHERE schedule_id=?"
      ).get(input.scheduleId);
      if (!owner)
        fail("schedule_not_registered", "Schedule owner is not registered");
      if (owner.owner !== input.owner)
        fail(
          "schedule_owner_conflict",
          "Schedule is owned by another scheduler"
        );
      if (Number(owner.generation) !== input.ownerGeneration)
        fail("stale_schedule_owner", "Schedule owner generation is stale");
      const admitted = this.admitOperation({
        ...input.binding,
        operationId,
        kind: "message",
        actorId: `schedule:${input.scheduleId}`,
        payload: input.payload,
        userEntry: {
          id: `entry-${fireId.slice("routine-fire:".length)}`,
          role: "user",
          origin: "routine",
          originFrom: input.scheduleId,
          text: String(input.payload.text ?? ""),
        },
      });
      this.prepare(
        "INSERT INTO routine_fires(fire_id,schedule_id,occurrence,operation_id,bot_id,conversation_id,binding_id,payload_digest,owner,owner_generation) VALUES(?,?,?,?,?,?,?,?,?,?)"
      ).run(
        fireId,
        input.scheduleId,
        input.occurrence,
        operationId,
        input.binding.botId,
        input.binding.conversationId,
        input.binding.bindingId,
        payloadDigestValue,
        input.owner,
        input.ownerGeneration
      );
      return { receipt: admitted.receipt, created: true, fireId };
    });
  }
  describeArtifacts(
    input: AdmitOperation,
    uploads: ArtifactUpload[]
  ): JsonObject[] {
    return this.prepareArtifacts(input, uploads).map((item) => item.descriptor);
  }
  private prepareArtifacts(
    input: AdmitOperation,
    uploads: ArtifactUpload[]
  ): Array<{ descriptor: JsonObject; data: string }> {
    if (
      (input.kind && input.kind !== "message") ||
      !uploads.length ||
      uploads.length > 16
    )
      fail(
        "invalid_payload",
        "Artifacts require a message with one to sixteen uploads"
      );
    let total = 0;
    return uploads.map((upload, index) => {
      if (
        !(upload.bytes instanceof Uint8Array) ||
        !upload.bytes.byteLength ||
        (total += upload.bytes.byteLength) > MAX_ARTIFACT_BYTES
      )
        fail("resource_limit", "Artifact bytes exceed the admission limit");
      if (
        typeof upload.name !== "string" ||
        !upload.name.trim() ||
        upload.name.length > 256 ||
        /[\x00-\x1f\x7f/\\]/.test(upload.name) ||
        typeof upload.mediaType !== "string" ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(upload.mediaType)
      )
        fail("invalid_payload", "Invalid artifact display metadata");
      const bytes = Buffer.from(upload.bytes);
      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const descriptor: JsonObject = {
        type: "artifact",
        artifactId: payloadDigest({
          botId: input.botId,
          conversationId: input.conversationId,
          bindingId: input.bindingId,
          operationId: input.operationId,
          index,
          sha256,
          name: upload.name,
          mediaType: upload.mediaType,
        }),
        name: upload.name,
        mediaType: upload.mediaType,
        sha256,
        size: bytes.length,
      };
      return { descriptor, data: bytes.toString("base64") };
    });
  }
  /** Media decoding and capability checks belong to admission before this transaction. */
  admitMessageArtifacts(
    lease: WriterLease,
    input: AdmitOperation,
    uploads: ArtifactUpload[]
  ): { receipt: OperationReceipt; created: boolean } {
    const retained = this.prepareArtifacts(input, uploads);
    return this.write(lease, () => {
      const admitted = this.admitOperation({
        ...input,
        payload: {
          ...input.payload,
          artifacts: retained.map((item) => item.descriptor),
        },
      });
      for (const item of retained) {
        const key = artifactPrefix(input) + item.descriptor.artifactId;
        const encoded = canonicalJson(item);
        const prior = this.prepare(
          "SELECT value FROM gateway_meta WHERE key=?"
        ).get(key);
        if (prior) {
          if (prior.value !== encoded)
            fail(
              "corrupt_storage",
              "Retained artifact differs from admitted bytes"
            );
        } else {
          if (!admitted.created)
            fail("corrupt_storage", "Admitted artifact bytes are missing");
          this.prepare("INSERT INTO gateway_meta(key,value) VALUES(?,?)").run(
            key,
            encoded
          );
        }
      }
      return admitted;
    });
  }
  /** Caller authenticates the binding; the journal also requires exact operation membership. */
  readArtifact(
    key: OperationKey & { bindingId: string },
    artifactId: string,
    offset = 0,
    limit = 65536
  ): { descriptor: JsonObject; bytes: Uint8Array; nextOffset: number | null } {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      fail("invalid_cursor", "Invalid artifact read range");
    const { descriptor, bytes } = this.verifiedArtifact(key, artifactId);
    if (offset > bytes.length)
      fail("invalid_cursor", "Artifact offset is past its end");
    const end = Math.min(bytes.length, offset + limit);
    return {
      descriptor,
      bytes: bytes.subarray(offset, end),
      nextOffset: end < bytes.length ? end : null,
    };
  }
  private verifiedArtifact(
    key: OperationKey & { bindingId: string },
    artifactId: string
  ): { descriptor: JsonObject; bytes: Buffer } {
    this.conversation(key);
    const operation = this.operationRow(key);
    if (
      !operation ||
      operation.binding_id !== key.bindingId ||
      operation.expired
    )
      fail("artifact_unavailable", "Artifact operation is unavailable");
    const payload = parseObject(operation.payload_json);
    const descriptor = Array.isArray(payload.artifacts)
      ? (payload.artifacts.find(
          (value) =>
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.artifactId === artifactId
        ) as JsonObject | undefined)
      : undefined;
    if (!descriptor)
      fail("artifact_unavailable", "Artifact is outside this operation");
    const row = this.prepare("SELECT value FROM gateway_meta WHERE key=?").get(
      artifactPrefix(key) + artifactId
    );
    if (!row) fail("corrupt_storage", "Admitted artifact bytes are missing");
    const stored = parseObject(row.value);
    if (
      canonicalJson(stored.descriptor) !== canonicalJson(descriptor) ||
      typeof stored.data !== "string"
    )
      fail("corrupt_storage", "Artifact metadata differs from admission");
    const bytes = Buffer.from(stored.data as string, "base64");
    if (
      bytes.length !== descriptor.size ||
      bytes.length > MAX_ARTIFACT_BYTES ||
      bytes.toString("base64") !== stored.data ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        descriptor.sha256
    )
      fail("corrupt_storage", "Artifact bytes failed integrity verification");
    return { descriptor, bytes };
  }
  /** Public image names are opaque IDs, never filesystem paths. */
  readImage(
    key: ConversationKey & { bindingId: string },
    file: string
  ): { mediaType: string; bytes: Buffer } {
    const match = /^([a-f0-9]{64})\.(png|jpg)$/.exec(file);
    if (!match) fail("artifact_unavailable", "Image is unavailable");
    this.conversation(key);
    const artifactId = `sha256:${match[1]}`;
    const mediaType = match[2] === "png" ? "image/png" : "image/jpeg";
    const rows = this.prepare(
      `SELECT o.operation_id FROM operations o,
      json_each(o.payload_json, '$.artifacts') a
      WHERE o.bot_id=? AND o.conversation_id=? AND o.binding_id=? AND o.expired=0
      AND json_extract(a.value, '$.artifactId')=? AND json_extract(a.value, '$.mediaType')=? LIMIT 2`
    ).all(key.botId, key.conversationId, key.bindingId, artifactId, mediaType);
    if (rows.length !== 1) fail("artifact_unavailable", "Image is unavailable");
    const scope = { ...key, operationId: String(rows[0].operation_id) };
    return { mediaType, bytes: this.verifiedArtifact(scope, artifactId).bytes };
  }
  private deleteArtifacts(key: OperationKey): void {
    const prefix = artifactPrefix(key);
    this.prepare("DELETE FROM gateway_meta WHERE substr(key,1,?)=?").run(
      prefix.length,
      prefix
    );
  }

  /** Route grants and native tool correlation are checked by the host. This
   * transaction prevents a lost host reply from admitting another target turn.
   */
  hasFleetDispatch(
    input: Pick<AdmitFleetDispatch, "origin" | "toolCallId" | "actionId">
  ): boolean {
    const digest = payloadDigest({
      bindingId: input.origin.bindingId,
      operationId: input.origin.operationId,
      toolCallId: input.toolCallId,
      actionId: input.actionId,
    }).slice(7);
    return !!this.prepare("SELECT 1 FROM gateway_meta WHERE key=?").get(
      `fleet_dispatch_v1:dispatch-${digest}`
    );
  }
  /** Lookup is deliberately read-only: old ledger rows without recovery proof
   * remain unknown rather than being upgraded into a successful dispatch. */
  inspectFleetDispatch(input: FleetDispatchLookup):
    | {
        status: "admitted";
        dispatchId: string;
        receipt: OperationReceipt;
        proof: FleetDispatchProof;
      }
    | { status: "unknown" } {
    const scope = {
      bindingId: input.origin.bindingId,
      operationId: input.origin.operationId,
      toolCallId: input.toolCallId,
      actionId: input.actionId,
    };
    const dispatchId = `dispatch-${payloadDigest(scope).slice(7)}`;
    const row = this.prepare("SELECT value FROM gateway_meta WHERE key=?").get(
      `fleet_dispatch_v1:${dispatchId}`
    );
    if (!row) return { status: "unknown" };
    let record: JsonObject;
    try {
      record = parseObject(row.value);
    } catch {
      fail("corrupt_storage", "Retained dispatch ledger is unreadable");
    }
    // Rows written before recovery proof had no caller digest or full target
    // identity. They are intentionally not evidence for a successful lookup.
    if (
      typeof record.callerPayloadDigest !== "string" ||
      typeof record.originBotId !== "string" ||
      typeof record.originConversationId !== "string" ||
      typeof record.targetBotId !== "string" ||
      typeof record.targetConversationId !== "string" ||
      typeof record.targetBindingId !== "string"
    )
      return { status: "unknown" };
    if (
      record.callerPayloadDigest !== input.payloadDigest ||
      record.originBotId !== input.origin.botId ||
      record.originConversationId !== input.origin.conversationId ||
      record.targetBotId !== input.target.botId ||
      record.targetConversationId !== input.target.conversationId ||
      record.targetBindingId !== input.target.bindingId
    )
      fail("action_conflict", "Fleet action recovery identity changed");
    if (
      record.dispatchId !== dispatchId ||
      typeof record.receipt !== "object" ||
      record.receipt === null ||
      Array.isArray(record.receipt) ||
      (record.receipt as JsonObject).operationId !== dispatchId ||
      (record.receipt as JsonObject).botId !== input.target.botId ||
      (record.receipt as JsonObject).conversationId !==
        input.target.conversationId ||
      (record.receipt as JsonObject).bindingId !== input.target.bindingId ||
      (record.receipt as JsonObject).fleetId !== this.fleetId
    )
      fail("corrupt_storage", "Retained dispatch receipt is invalid");
    return {
      status: "admitted",
      dispatchId,
      receipt: record.receipt as unknown as OperationReceipt,
      proof: {
        fleetId: this.fleetId,
        bindingId: input.origin.bindingId,
        operationId: input.origin.operationId,
        toolCallId: input.toolCallId,
        actionId: input.actionId,
        payloadDigest: input.payloadDigest,
        targetBotId: input.target.botId,
        targetConversationId: input.target.conversationId,
        targetBindingId: input.target.bindingId,
      },
    };
  }
  admitFleetDispatch(
    lease: WriterLease,
    input: AdmitFleetDispatch
  ): {
    dispatchId: string;
    receipt: OperationReceipt;
    created: boolean;
  } {
    return this.write(lease, () => {
      for (const [value, label] of [
        [input.origin.bindingId, "origin binding"],
        [input.origin.operationId, "origin operation"],
        [input.toolCallId, "native tool call"],
        [input.actionId, "host action"],
      ])
        identifier(value, label);
      if (typeof input.text !== "string" || !input.text.trim())
        fail("invalid_payload", "Dispatch text is required");
      const scope = {
        bindingId: input.origin.bindingId,
        operationId: input.origin.operationId,
        toolCallId: input.toolCallId,
        actionId: input.actionId,
      };
      const dispatchId = `dispatch-${payloadDigest(scope).slice(7)}`;
      const key = `fleet_dispatch_v1:${dispatchId}`;
      const digest = payloadDigest({
        ...scope,
        originBotId: input.origin.botId,
        originConversationId: input.origin.conversationId,
        targetBotId: input.target.botId,
        text: input.text,
      });
      const existing = this.prepare(
        "SELECT value FROM gateway_meta WHERE key=?"
      ).get(key);
      if (existing) {
        let record: JsonObject;
        try {
          record = parseObject(existing.value);
          if (
            !record ||
            Array.isArray(record) ||
            typeof record !== "object" ||
            typeof record.digest !== "string"
          )
            throw new Error();
        } catch {
          return fail(
            "corrupt_storage",
            "Retained dispatch ledger is unreadable"
          );
        }
        if (record.digest !== digest)
          fail(
            "action_conflict",
            "Fleet action already identifies different immutable intent"
          );
        if (
          !record.receipt ||
          typeof record.receipt !== "object" ||
          Array.isArray(record.receipt) ||
          record.dispatchId !== dispatchId ||
          record.receipt.operationId !== dispatchId ||
          record.receipt.botId !== input.target.botId ||
          record.receipt.fleetId !== this.fleetId ||
          record.receipt.delivery !== "queued" ||
          record.receipt.execution !== "not_started" ||
          record.receipt.observation !== "complete" ||
          ![
            "conversationId",
            "bindingId",
            "bindingRevision",
            "userEntryId",
          ].every(
            (field) => typeof (record.receipt as JsonObject)[field] === "string"
          )
        )
          fail("corrupt_storage", "Retained dispatch receipt is invalid");
        return {
          dispatchId,
          receipt: record.receipt as unknown as OperationReceipt,
          created: false,
        };
      }
      const binding = this.conversation(input.origin)!;
      if (
        binding.binding_id !== input.origin.bindingId ||
        binding.binding_revision !== input.origin.bindingRevision ||
        binding.policy_revision !== input.origin.policyRevision
      )
        fail("binding_conflict", "Dispatch origin binding is stale");
      const origin = this.operationRow(input.origin);
      if (
        !origin ||
        origin.expired ||
        origin.binding_id !== input.origin.bindingId ||
        origin.kind !== "message" ||
        !["dispatching", "accepted"].includes(String(origin.delivery)) ||
        ["ended", "failed", "cancelled", "interrupted"].includes(
          String(origin.execution)
        )
      )
        fail(
          "invalid_origin",
          "Dispatch requires a live reserved origin operation"
        );
      if (Buffer.byteLength(input.text, "utf8") > 65536)
        fail("resource_limit", "Fleet dispatch exceeds the text budget");
      const originPayload = parseObject(origin.payload_json);
      const parent = originPayload.dispatch;
      const parentDepth =
        parent && typeof parent === "object" && !Array.isArray(parent)
          ? parent.depth
          : (originPayload.completionDepth ?? 0);
      if (
        !Number.isSafeInteger(parentDepth) ||
        Number(parentDepth) < 0 ||
        Number(parentDepth) >= 8
      )
        fail("route_limit", "Fleet dispatch chain reached its depth budget");
      const depth = Number(parentDepth) + 1;
      const recent = this.prepare(
        "WITH dispatches AS MATERIALIZED (SELECT value FROM gateway_meta WHERE key LIKE 'fleet_dispatch_v1:%') SELECT count(*) AS n FROM dispatches WHERE json_extract(value,'$.originBotId')=? AND json_extract(value,'$.targetBotId')=? AND json_extract(value,'$.createdAt')>?"
      ).get(input.origin.botId, input.target.botId, this.now() - 60000);
      if (Number(recent!.n) >= 32)
        fail("route_limit", "Fleet route admission rate exceeded");
      const pending = this.prepare(
        "SELECT (SELECT count(*) FROM operations WHERE bot_id=? AND execution NOT IN ('ended','failed','cancelled','interrupted') AND delivery!='rejected' AND json_extract(payload_json,'$.dispatch.originBotId')=?) + (SELECT count(*) FROM completion_outbox WHERE origin_bot_id=? AND target_bot_id=? AND delivered=0) AS n"
      ).get(
        input.target.botId,
        input.origin.botId,
        input.origin.botId,
        input.target.botId
      );
      if (Number(pending!.n) >= 32)
        fail("route_limit", "Fleet route outstanding work budget exceeded");
      const target = { ...input.target, operationId: dispatchId };
      if (this.operationRow(target))
        fail(
          "action_conflict",
          "Dispatch target identity was already occupied"
        );
      const admitted = this.admitOperation(
        {
          ...target,
          actorId: input.origin.botId,
          publicBotName: input.publicBotName,
          payload: {
            text: input.text,
            dispatch: {
              dispatchId,
              originBotId: input.origin.botId,
              originConversationId: input.origin.conversationId,
              originOperationId: input.origin.operationId,
              originBindingId: input.origin.bindingId,
              toolCallId: input.toolCallId,
              depth,
            },
          },
          userEntry: { dispatchId, from: input.origin.botId },
        },
        "fleet"
      );
      this.prepare("INSERT INTO gateway_meta(key,value) VALUES(?,?)").run(
        key,
        canonicalJson({
          dispatchId,
          digest,
          receipt: admitted.receipt,
          originBotId: input.origin.botId,
          originConversationId: input.origin.conversationId,
          targetBotId: input.target.botId,
          targetConversationId: input.target.conversationId,
          targetBindingId: input.target.bindingId,
          ...(typeof input.payloadDigest === "string"
            ? { callerPayloadDigest: input.payloadDigest }
            : {}),
          createdAt: this.now(),
        })
      );
      return { dispatchId, receipt: admitted.receipt, created: true };
    });
  }
  private admitOperation(
    input: AdmitOperation,
    messageOrigin: "operator" | "fleet" = "operator"
  ): {
    receipt: OperationReceipt;
    created: boolean;
  } {
    identifier(input.operationId, "operation ID");
    const kind = input.kind ?? "message";
    if (!operationKinds.has(kind))
      fail("invalid_kind", "Unsupported operation kind");
    const actorId = input.actorId ?? "operator";
    identifier(actorId, "actor ID");
    const digest = payloadDigest({
      fleetId: this.fleetId,
      botId: input.botId,
      conversationId: input.conversationId,
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
      policyRevision: input.policyRevision,
      actorId,
      kind,
      payload: input.payload,
      ...(messageOrigin === "fleet" ? { messageOrigin } : {}),
      ...(input.userEntry ? { userEntry: input.userEntry } : {}),
    });
    const payload = canonicalJson(input.payload);
    if (kind === "message" && typeof input.payload.text !== "string")
      fail("invalid_payload", "Message payload requires text");
    if (kind !== "message" && input.userEntry)
      fail("invalid_payload", "Control operations do not create user entries");
    const binding = this.conversation(input)!;
    if (
      binding.binding_id !== input.bindingId ||
      binding.binding_revision !== input.bindingRevision ||
      binding.policy_revision !== input.policyRevision
    )
      fail(
        "binding_conflict",
        "Operation targets a stale binding or policy revision"
      );
    const existing = this.operationRow(input);
    if (existing) {
      if (existing.payload_digest !== digest)
        fail(
          "operation_conflict",
          "Operation key already identifies different immutable intent"
        );
      if (existing.expired)
        fail(
          "operation_expired",
          "Operation body expired; its identity cannot be reused"
        );
      return { receipt: this.receipt(existing), created: false };
    }
    const userEntryId = kind === "message" ? `entry-${randomUUID()}` : null;
    this.prepare(
      "INSERT INTO operations(bot_id,conversation_id,operation_id,binding_id,binding_revision,policy_revision,actor_id,kind,payload_digest,payload_json,turn_id,user_entry_id,delivery,execution,observation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'queued','not_started','complete')"
    ).run(
      input.botId,
      input.conversationId,
      input.operationId,
      input.bindingId,
      input.bindingRevision,
      input.policyRevision,
      actorId,
      kind,
      digest,
      payload,
      `turn-${randomUUID()}`,
      userEntryId
    );
    if (userEntryId) {
      const entry = {
        ...input.userEntry,
        id: userEntryId,
        operationId: input.operationId,
        clientMessageId: input.operationId,
        role: "user",
        origin: messageOrigin,
        text: input.payload.text,
        ...publicArtifacts(
          input.payload.artifacts,
          input.publicBotName ?? input.botId
        ),
        ts: new Date(this.now()).toISOString(),
      };
      this.insertEntry(input, entry, input.operationId);
      if (input.publicBotName !== undefined) {
        identifier(input.publicBotName, "public bot name");
        this.insertPublicEvents(input.bindingId, [
          { type: "append", bot: input.publicBotName, entry },
        ]);
      }
    }
    return {
      receipt: this.receipt(this.operationRow(input)!),
      created: true,
    };
  }
  getPermission(scope: JsonObject): PermissionRecord | null {
    const key = permissionKey(scope);
    const row = this.prepare("SELECT value FROM gateway_meta WHERE key=?").get(
      key
    );
    if (!row) return null;
    try {
      const record = JSON.parse(String(row.value)) as PermissionRecord;
      if (
        permissionKey(record.descriptor) !== key ||
        canonicalJson(permissionRequest(record.descriptor)) !==
          canonicalJson(record.descriptor)
      )
        fail("corrupt_storage", "Retained permission identity is invalid");
      if (record.resolution)
        permissionResolution(record.resolution, record.descriptor);
      return record;
    } catch {
      return fail(
        "corrupt_storage",
        "Retained permission evidence is unreadable"
      );
    }
  }
  private savePermission(record: PermissionRecord): void {
    this.prepare(
      "INSERT INTO gateway_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(permissionKey(record.descriptor), canonicalJson(record));
  }
  /** Retire native futures lost with an instance without claiming native denial. */
  closePermissions(
    lease: WriterLease,
    binding: ConversationBinding,
    botName: string,
    keepInstanceId?: string
  ): void {
    this.write(lease, () => {
      this.conversation(binding);
      const rows = this.prepare(
        "SELECT value FROM gateway_meta WHERE key LIKE 'permission_v1:%'"
      ).all();
      for (const row of rows) {
        const saved = parseObject(row.value);
        const descriptor = saved.descriptor as JsonObject;
        if (descriptor?.bindingId !== binding.bindingId) continue;
        const record = this.getPermission(descriptor)!;
        if (descriptor.instanceId === keepInstanceId || record.resolution)
          continue;
        const decisionKey = {
          ...binding,
          operationId: record.decisionOperationId ?? "",
        };
        const decision = record.decisionOperationId
          ? this.operationRow(decisionKey)
          : undefined;
        if (record.decisionOperationId && !decision)
          fail("corrupt_storage", "Retained permission decision is missing");
        const uncertain =
          decision &&
          decision.delivery !== "queued" &&
          decision.delivery !== "rejected";
        const resolution = permissionResolution(
          {
            ...descriptor,
            status: uncertain ? "unknown" : "expired",
          },
          descriptor
        );
        if (decision?.delivery === "queued")
          this.applyDisposition(decisionKey, {
            delivery: "rejected",
            execution: "not_started",
            observation: "complete",
            result: { status: "expired" },
            evidence: "permission_instance_lost_before_dispatch",
          });
        record.resolution = resolution;
        this.savePermission(record);
        const entry: JsonObject = {
          id: payloadDigest({
            permission: permissionKey(descriptor),
            resolution,
          }),
          operationId: descriptor.operationId,
          turnId: descriptor.turnId,
          role: "assistant",
          origin: "bot",
          text: "",
          ts: new Date(this.now()).toISOString(),
          permissionResolved: resolution,
        };
        this.insertEntry(binding, entry, String(descriptor.operationId));
        this.insertPublicEvents(binding.bindingId, [
          { type: "append", bot: botName, entry },
        ]);
      }
    });
  }
  admitPermission(
    lease: WriterLease,
    input: AdmitOperation,
    instanceId: string
  ): { receipt: OperationReceipt; created: boolean } {
    return this.write(lease, () => {
      if (input.kind !== "permission")
        fail(
          "invalid_kind",
          "Permission admission requires a permission control"
        );
      const record = this.getPermission(input.payload);
      if (!record)
        fail(
          "permission_not_found",
          "No retained permission request matches this decision"
        );
      if (record.descriptor.bindingId !== input.bindingId)
        fail("permission_conflict", "Permission belongs to another binding");
      matchPermissionDecision(record.descriptor, input.payload);
      const known = this.operationRow(input);
      if (known) return this.admitOperation(input);
      if (record.decisionOperationId)
        fail(
          "operation_conflict",
          "This permission already has a durable decision"
        );
      if (
        record.resolution ||
        record.descriptor.instanceId !== instanceId ||
        Date.parse(String(record.descriptor.expiresAt)) <= this.now()
      )
        fail(
          "interaction_expired",
          "Permission request is no longer answerable"
        );
      const target = this.operationRow({
        ...input,
        operationId: String(record.descriptor.operationId),
      });
      if (
        !target ||
        target.binding_id !== input.bindingId ||
        target.turn_id !== record.descriptor.turnId ||
        target.delivery !== "accepted" ||
        terminal(this.receipt(target))
      )
        fail("interaction_expired", "Permission target is no longer active");
      if (input.operationId === record.descriptor.operationId)
        fail(
          "invalid_payload",
          "Decision and target operations must be distinct"
        );
      const result = this.admitOperation(input);
      record.decisionOperationId = input.operationId;
      this.savePermission(record);
      return result;
    });
  }

  getQuestion(scope: JsonObject): QuestionRecord | null {
    const key = questionKey(scope);
    const row = this.prepare("SELECT value FROM gateway_meta WHERE key=?").get(
      key
    );
    if (!row) return null;
    try {
      const record = JSON.parse(String(row.value)) as QuestionRecord;
      if (
        questionKey(record.descriptor) !== key ||
        canonicalJson(questionRequest(record.descriptor)) !==
          canonicalJson(record.descriptor)
      )
        fail("corrupt_storage", "Retained question identity is invalid");
      if (record.resolution)
        questionResolution(record.resolution, record.descriptor);
      return record;
    } catch {
      return fail(
        "corrupt_storage",
        "Retained question evidence is unreadable"
      );
    }
  }
  private saveQuestion(record: QuestionRecord): void {
    this.prepare(
      "INSERT INTO gateway_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(questionKey(record.descriptor), canonicalJson(record));
  }
  /** Retire native futures lost with an instance without claiming native denial. */
  closeQuestions(
    lease: WriterLease,
    binding: ConversationBinding,
    botName: string,
    keepInstanceId?: string
  ): void {
    this.write(lease, () => {
      this.conversation(binding);
      const rows = this.prepare(
        "SELECT value FROM gateway_meta WHERE key LIKE 'question_v1:%'"
      ).all();
      for (const row of rows) {
        const saved = parseObject(row.value);
        const descriptor = saved.descriptor as JsonObject;
        if (descriptor?.bindingId !== binding.bindingId) continue;
        const record = this.getQuestion(descriptor)!;
        if (descriptor.instanceId === keepInstanceId || record.resolution)
          continue;
        const decisionKey = {
          ...binding,
          operationId: record.decisionOperationId ?? "",
        };
        const decision = record.decisionOperationId
          ? this.operationRow(decisionKey)
          : undefined;
        if (record.decisionOperationId && !decision)
          fail("corrupt_storage", "Retained question decision is missing");
        const uncertain =
          decision &&
          decision.delivery !== "queued" &&
          decision.delivery !== "rejected";
        const resolution = questionResolution(
          {
            ...descriptor,
            status: uncertain ? "unknown" : "expired",
          },
          descriptor
        );
        if (decision?.delivery === "queued")
          this.applyDisposition(decisionKey, {
            delivery: "rejected",
            execution: "not_started",
            observation: "complete",
            result: { status: "expired" },
            evidence: "question_instance_lost_before_dispatch",
          });
        record.resolution = resolution;
        this.saveQuestion(record);
        const entry: JsonObject = {
          id: payloadDigest({
            question: questionKey(descriptor),
            resolution,
          }),
          operationId: descriptor.operationId,
          turnId: descriptor.turnId,
          role: "assistant",
          origin: "bot",
          text: "",
          ts: new Date(this.now()).toISOString(),
          questionResolved: resolution,
        };
        this.insertEntry(binding, entry, String(descriptor.operationId));
        this.insertPublicEvents(binding.bindingId, [
          { type: "append", bot: botName, entry },
        ]);
      }
    });
  }
  admitQuestion(
    lease: WriterLease,
    input: AdmitOperation,
    instanceId: string
  ): { receipt: OperationReceipt; created: boolean } {
    return this.write(lease, () => {
      if (input.kind !== "question")
        fail("invalid_kind", "Question admission requires a question control");
      const record = this.getQuestion(input.payload);
      if (!record)
        fail(
          "question_not_found",
          "No retained question request matches this decision"
        );
      if (record.descriptor.bindingId !== input.bindingId)
        fail("question_conflict", "Question belongs to another binding");
      matchQuestionDecision(record.descriptor, input.payload);
      const known = this.operationRow(input);
      if (known) return this.admitOperation(input);
      if (record.decisionOperationId)
        fail(
          "operation_conflict",
          "This question already has a durable decision"
        );
      if (
        record.resolution ||
        record.descriptor.instanceId !== instanceId ||
        (record.descriptor.expiresAt !== undefined &&
          Date.parse(String(record.descriptor.expiresAt)) <= this.now())
      )
        fail("interaction_expired", "Question request is no longer answerable");
      const target = this.operationRow({
        ...input,
        operationId: String(record.descriptor.operationId),
      });
      if (
        !target ||
        target.binding_id !== input.bindingId ||
        target.turn_id !== record.descriptor.turnId ||
        target.delivery !== "accepted" ||
        terminal(this.receipt(target))
      )
        fail("interaction_expired", "Question target is no longer active");
      if (input.operationId === record.descriptor.operationId)
        fail(
          "invalid_payload",
          "Decision and target operations must be distinct"
        );
      const result = this.admitOperation(input);
      record.decisionOperationId = input.operationId;
      this.saveQuestion(record);
      return result;
    });
  }
  private operationRow(key: OperationKey): Row | undefined {
    return this.prepare(
      "SELECT * FROM operations WHERE bot_id=? AND conversation_id=? AND operation_id=?"
    ).get(key.botId, key.conversationId, key.operationId);
  }
  private receipt(row: Row): OperationReceipt {
    return {
      fleetId: this.fleetId,
      botId: String(row.bot_id),
      conversationId: String(row.conversation_id),
      bindingId: String(row.binding_id),
      bindingRevision: String(row.binding_revision),
      operationId: String(row.operation_id),
      ...(row.kind === "message" ? {} : { kind: row.kind as OperationKind }),
      ...(row.user_entry_id ? { userEntryId: String(row.user_entry_id) } : {}),
      delivery: row.delivery as DeliveryState,
      execution: row.execution as ExecutionState,
      observation: row.observation as ObservationState,
      ...(row.result_json === null
        ? {}
        : { result: parseObject(row.result_json) }),
    };
  }
  private record(row: Row): OperationRecord {
    return {
      receipt: this.receipt(row),
      payload: row.payload_json === null ? null : parseObject(row.payload_json),
      payloadDigest: String(row.payload_digest),
      policyRevision: String(row.policy_revision),
      actorId: String(row.actor_id),
      turnId: String(row.turn_id),
      ordinal: Number(row.ordinal),
      leaseGeneration:
        row.lease_generation === null ? null : Number(row.lease_generation),
      expired: Boolean(row.expired),
    };
  }
  getOperation(key: OperationKey): OperationReceipt | null {
    const row = this.operationRow(key);
    return row ? this.receipt(row) : null;
  }
  getOperationRecord(key: OperationKey): OperationRecord | null {
    const row = this.operationRow(key);
    return row ? this.record(row) : null;
  }
  listOperationRecords(key?: ConversationKey): OperationRecord[] {
    return (
      key
        ? this.prepare(
            "SELECT * FROM operations WHERE bot_id=? AND conversation_id=? ORDER BY ordinal"
          ).all(key.botId, key.conversationId)
        : this.prepare("SELECT * FROM operations ORDER BY ordinal").all()
    ).map((row) => this.record(row));
  }

  /** Strict FIFO by default. Explicit interrupt controls must name the active target. */
  reserveNext(
    lease: WriterLease,
    key: ConversationKey,
    options: {
      interruptKinds?: ("permission" | "question" | "cancel")[];
      onlyInterrupts?: boolean;
      /** Startup may restore an exact session before queued messages, never before uncertain work. */
      sessionLoadId?: string;
    } = {}
  ): OperationRecord | null {
    return this.write(lease, () => {
      this.conversation(key);
      const rows = this.prepare(
        "SELECT * FROM operations WHERE bot_id=? AND conversation_id=? AND expired=0 ORDER BY ordinal"
      ).all(key.botId, key.conversationId);
      const unresolved = rows.filter((row) => !resolved(this.receipt(row)));
      if (unresolved.some((row) => uncertain(this.receipt(row)))) return null;
      const active = unresolved.filter((row) => row.delivery !== "queued");
      let candidate: Row | undefined;
      if (!active.length)
        candidate = unresolved.find(
          (row) =>
            row.delivery === "queued" &&
            (!options.sessionLoadId ||
              (row.operation_id === options.sessionLoadId &&
                row.kind === "session_open" &&
                parseObject(row.payload_json).mode === "load")) &&
            (!options.onlyInterrupts ||
              options.interruptKinds?.includes(
                row.kind as "permission" | "question" | "cancel"
              ))
        );
      else if (
        !options.sessionLoadId &&
        options.interruptKinds?.length &&
        active.length === 1 &&
        active[0].delivery === "accepted" &&
        !terminal(this.receipt(active[0]))
      ) {
        candidate = unresolved.find(
          (row) =>
            row.delivery === "queued" &&
            options.interruptKinds!.includes(
              row.kind as "permission" | "question" | "cancel"
            ) &&
            parseObject(row.payload_json).targetOperationId ===
              active[0].operation_id
        );
      }
      if (!candidate) return null;
      this.prepare(
        "UPDATE operations SET delivery='dispatching',lease_generation=? WHERE ordinal=? AND delivery='queued'"
      ).run(lease.generation, Number(candidate.ordinal));
      return this.record(
        this.operationRow({
          ...key,
          operationId: String(candidate.operation_id),
        })!
      );
    });
  }
  recordDisposition(
    lease: WriterLease,
    key: OperationKey,
    disposition: OperationDisposition
  ): OperationReceipt {
    return this.write(lease, () => {
      this.conversation(key);
      return this.applyDisposition(key, disposition);
    });
  }
  private applyDisposition(
    key: OperationKey,
    disposition: OperationDisposition
  ): OperationReceipt {
    const row = this.operationRow(key);
    if (!row) fail("operation_not_found", "Unknown operation");
    const before = this.receipt(row);
    const after: OperationReceipt = { ...before, ...disposition };
    delete (after as OperationReceipt & { evidence?: string }).evidence;
    if (
      !["queued", "dispatching", "accepted", "rejected", "unknown"].includes(
        after.delivery
      ) ||
      ![
        "not_started",
        "running",
        "waiting_for_input",
        "cancel_requested",
        "ended",
        "failed",
        "cancelled",
        "interrupted",
        "unknown",
      ].includes(after.execution) ||
      !["complete", "live_gap", "reconciliation_required"].includes(
        after.observation
      )
    )
      fail("invalid_state", "Unknown operation state");
    if (after.delivery === "queued" && before.delivery !== "queued")
      fail(
        "unsafe_retry",
        "An operation cannot return to the native submission queue"
      );
    if (after.delivery === "dispatching" && before.delivery !== "dispatching")
      fail(
        "unreserved_dispatch",
        "Use reserveNext before crossing the native boundary"
      );
    if (
      before.delivery === "queued" &&
      after.delivery !== "queued" &&
      after.delivery !== "rejected"
    )
      fail(
        "unreserved_dispatch",
        "Native disposition requires a durable dispatch reservation"
      );
    if (
      before.delivery === "accepted" &&
      !["accepted", "unknown"].includes(after.delivery)
    )
      fail(
        "invalid_transition",
        "Native acceptance cannot become unsubmitted or rejected"
      );
    if (before.delivery === "rejected" && after.delivery !== "rejected")
      fail("invalid_transition", "A rejected identity is retained permanently");
    if (
      terminalExecutions.has(before.execution) &&
      after.execution !== before.execution
    )
      fail("invalid_transition", "Terminal execution cannot regress");
    if (
      ((before.delivery === "unknown" && after.delivery !== "unknown") ||
        (before.execution === "unknown" && after.execution !== "unknown") ||
        (before.observation !== "complete" &&
          after.observation === "complete")) &&
      !disposition.evidence?.trim()
    )
      fail(
        "evidence_required",
        "Ambiguity requires correlated native evidence, not elapsed time or absence"
      );
    if (after.delivery === "queued" && after.execution !== "not_started")
      fail("invalid_state", "Queued work has not executed");
    if (
      after.delivery === "rejected" &&
      !["not_started", "failed", "cancelled"].includes(after.execution)
    )
      fail("invalid_state", "Rejected work cannot be running");
    if (
      disposition.result &&
      before.result &&
      canonicalJson(disposition.result) !== canonicalJson(before.result)
    )
      fail("result_conflict", "An operation result is immutable");
    this.prepare(
      "UPDATE operations SET delivery=?,execution=?,observation=?,result_json=? WHERE ordinal=?"
    ).run(
      after.delivery,
      after.execution,
      after.observation,
      after.result ? canonicalJson(after.result) : null,
      Number(row.ordinal)
    );
    return after;
  }
  /** A startup recovery marker, never an automatic replay authorization. */
  recoverInterrupted(lease: WriterLease): number {
    return this.write(lease, () =>
      Number(
        this.prepare(
          "UPDATE operations SET delivery=CASE WHEN delivery='accepted' THEN 'accepted' ELSE 'unknown' END,execution='unknown',observation='reconciliation_required' WHERE delivery IN ('dispatching','accepted') AND execution NOT IN ('ended','failed','cancelled','interrupted')"
        ).run().changes
      )
    );
  }
  /** Admit cancellation and settle unsubmitted targets in one fenced transaction. */
  admitCancellation(
    lease: WriterLease,
    input: AdmitOperation
  ): { receipt: OperationReceipt; created: boolean } {
    return this.write(lease, () => {
      if (input.kind !== "cancel")
        fail("invalid_kind", "Cancellation requires a cancel control");
      const targetId = input.payload.targetOperationId;
      if (
        typeof targetId !== "string" ||
        !targetId.trim() ||
        targetId === input.operationId
      )
        fail("invalid_payload", "Cancellation requires a distinct target");
      // Resolve retained intent first: retries cannot cancel a different target.
      if (this.operationRow(input)) return this.admitOperation(input);
      const targetKey = { ...input, operationId: targetId };
      const target = this.operationRow(targetKey);
      if (
        !target ||
        target.binding_id !== input.bindingId ||
        target.kind !== "message"
      )
        fail(
          "invalid_target",
          "Cancellation requires a message in this binding"
        );
      const admitted = this.admitOperation(input);
      if (target.delivery !== "queued" || target.lease_generation !== null)
        return admitted;
      this.applyDisposition(targetKey, {
        delivery: "rejected",
        execution: "cancelled",
        evidence: "atomic_cancellation_before_dispatch",
      });
      const dispatch = parseObject(target.payload_json).dispatch;
      if (
        dispatch &&
        typeof dispatch === "object" &&
        !Array.isArray(dispatch)
      ) {
        const cause = dispatch as JsonObject;
        this.insertCompletion(
          {
            botId: input.botId,
            conversationId: input.conversationId,
            operationId: targetId,
          },
          {
            dispatchId: String(cause.dispatchId),
            originBotId: String(cause.originBotId),
            payload: {
              originConversationId: cause.originConversationId,
              originBindingId: cause.originBindingId,
              depth: cause.depth,
              execution: "cancelled",
              observation: "complete",
              text: "",
            },
          }
        );
      }
      // The gateway executes this control locally; no native boundary is crossed.
      this.prepare(
        "UPDATE operations SET delivery='dispatching',lease_generation=? WHERE bot_id=? AND conversation_id=? AND operation_id=? AND delivery='queued'"
      ).run(
        lease.generation,
        input.botId,
        input.conversationId,
        input.operationId
      );
      return {
        created: true,
        receipt: this.applyDisposition(input, {
          delivery: "accepted",
          execution: "ended",
          observation: "complete",
          result: { status: "cancelled", targetOperationId: targetId },
          evidence: "atomic_cancellation_before_dispatch",
        }),
      };
    });
  }

  cancelQueued(lease: WriterLease, key: OperationKey): OperationReceipt {
    return this.write(lease, () => {
      this.conversation(key);
      const row = this.operationRow(key);
      if (!row || row.delivery !== "queued" || row.lease_generation !== null)
        fail(
          "already_dispatched",
          "Only provably unsubmitted queued work can be cancelled locally"
        );
      return this.applyDisposition(key, {
        delivery: "rejected",
        execution: "cancelled",
      });
    });
  }

  /** Highest stored source sequence, including buffered gaps; use sourceAck for replay. */
  maxSourceSequence(bindingId: string): number {
    return Number(
      this.prepare(
        "SELECT COALESCE(MAX(source_sequence),0) AS seq FROM source_events WHERE binding_id=?"
      ).get(bindingId)!.seq
    );
  }
  sourceAck(bindingId: string): number {
    const row = this.prepare(
      "SELECT source_ack FROM conversations WHERE binding_id=?"
    ).get(bindingId);
    if (!row) fail("binding_not_found", "Unknown binding");
    return Number(row.source_ack);
  }
  readSourceEvents(
    bindingId: string,
    after = 0,
    limit = 1000
  ): PluginSourceEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10_000
    )
      fail("invalid_cursor", "Invalid source event cursor/limit");
    return this.prepare(
      "SELECT event_json FROM source_events WHERE binding_id=? AND source_sequence>? AND applied=1 ORDER BY source_sequence LIMIT ?"
    )
      .all(bindingId, after, limit)
      .map((row) => JSON.parse(String(row.event_json)) as PluginSourceEvent);
  }
  commitPluginEvent(
    lease: WriterLease,
    event: PluginSourceEvent,
    projection: EventProjection = {}
  ): EventCommit {
    identifier(event.eventId, "event ID");
    identifier(event.type, "event type");
    if (!Number.isSafeInteger(event.sourceSequence) || event.sourceSequence < 1)
      fail(
        "invalid_sequence",
        "Source sequence must be a positive safe integer"
      );
    // The same persisted event can be re-enveloped by a replacement instance.
    const { leaseGeneration: _generation, ...identity } = event;
    const digest = payloadDigest(identity);
    const eventJson = canonicalJson(event);
    const projectionJson = canonicalJson(projection);
    return this.write(lease, () => {
      if (event.leaseGeneration !== lease.generation)
        fail("stale_plugin", "Source event came from a stale plugin lease");
      const binding = this.prepare(
        "SELECT * FROM conversations WHERE binding_id=?"
      ).get(event.bindingId);
      if (!binding || binding.deleted)
        fail("binding_not_found", "Event targets a missing or deleted binding");
      if (
        event.operationId &&
        !this.operationRow({
          botId: String(binding.bot_id),
          conversationId: String(binding.conversation_id),
          operationId: event.operationId,
        })
      )
        fail("operation_not_found", "Event names an unknown operation");
      const existing = this.prepare(
        "SELECT * FROM source_events WHERE binding_id=? AND (source_sequence=? OR event_id=?)"
      ).all(event.bindingId, event.sourceSequence, event.eventId);
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0].digest !== digest ||
          existing[0].source_sequence !== event.sourceSequence ||
          existing[0].event_id !== event.eventId
        )
          fail(
            "event_conflict",
            "Source event identity was reused with different content"
          );
        return {
          duplicate: true,
          ack: Number(binding.source_ack),
          publicEvents: [],
        };
      }
      if (event.sourceSequence <= Number(binding.source_ack))
        fail(
          "event_expired",
          "Event body expired below the retained source watermark"
        );
      this.prepare(
        "INSERT INTO source_events(binding_id,source_sequence,event_id,digest,event_json,projection_json) VALUES(?,?,?,?,?,?)"
      ).run(
        event.bindingId,
        event.sourceSequence,
        event.eventId,
        digest,
        eventJson,
        projectionJson
      );
      const publicEvents: PublicEvent[] = [];
      let ack = Number(binding.source_ack);
      for (;;) {
        const next = this.prepare(
          "SELECT * FROM source_events WHERE binding_id=? AND source_sequence=? AND applied=0"
        ).get(event.bindingId, ack + 1);
        if (!next) break;
        const source = JSON.parse(String(next.event_json)) as PluginSourceEvent;
        const effect = JSON.parse(
          String(next.projection_json)
        ) as EventProjection;
        const scope = {
          botId: String(binding.bot_id),
          conversationId: String(binding.conversation_id),
        };
        if (effect.permission) {
          const value =
            "request" in effect.permission
              ? effect.permission.request
              : effect.permission.resolution;
          if (
            value.bindingId !== source.bindingId ||
            value.operationId !== source.operationId ||
            value.turnId !== source.turnId
          )
            fail(
              "invalid_permission",
              "Permission scope differs from its source event"
            );
          const existing = this.getPermission(value);
          if ("request" in effect.permission) {
            const descriptor = permissionRequest(value);
            if (
              existing &&
              canonicalJson(existing.descriptor) !== canonicalJson(descriptor)
            )
              fail(
                "permission_conflict",
                "Permission identity cannot be rebound to new facts"
              );
            if (!existing) this.savePermission({ descriptor });
          } else {
            if (!existing)
              fail(
                "permission_not_found",
                "Resolution requires retained request evidence"
              );
            const resolution = permissionResolution(value, existing.descriptor);
            if (
              existing.resolution &&
              existing.resolution.status !== "unknown" &&
              canonicalJson(existing.resolution) !== canonicalJson(resolution)
            )
              fail(
                "permission_conflict",
                "Terminal permission resolution cannot change"
              );
            if (resolution.status === "applied") {
              if (!existing.decisionOperationId)
                fail(
                  "invalid_permission",
                  "Applied permission lacks an operator decision"
                );
              const decision = this.operationRow({
                ...scope,
                operationId: existing.decisionOperationId,
              });
              if (
                !decision ||
                parseObject(decision.payload_json).optionId !==
                  resolution.optionId
              )
                fail(
                  "permission_conflict",
                  "Applied permission differs from the admitted choice"
                );
            }
            existing.resolution = resolution;
            this.savePermission(existing);
            if (
              existing.decisionOperationId &&
              resolution.status !== "unknown"
            ) {
              const decisionKey = {
                ...scope,
                operationId: existing.decisionOperationId,
              };
              const decision = this.operationRow(decisionKey);
              if (!decision)
                fail(
                  "corrupt_storage",
                  "Retained permission decision is missing"
                );
              if (
                decision.delivery === "queued" &&
                resolution.status === "applied"
              )
                fail(
                  "invalid_permission",
                  "Permission cannot apply before dispatch"
                );
              this.applyDisposition(decisionKey, {
                delivery:
                  decision.delivery === "queued" ? "rejected" : "accepted",
                execution:
                  decision.delivery === "queued" ? "not_started" : "ended",
                observation: "complete",
                result: { status: resolution.status },
                evidence: `permission:${source.eventId}`,
              });
            }
          }
        }
        if (effect.question) {
          const value =
            "request" in effect.question
              ? effect.question.request
              : effect.question.resolution;
          if (
            value.bindingId !== source.bindingId ||
            value.operationId !== source.operationId ||
            value.turnId !== source.turnId
          )
            fail(
              "invalid_question",
              "Question scope differs from its source event"
            );
          const existing = this.getQuestion(value);
          if ("request" in effect.question) {
            const descriptor = questionRequest(value);
            if (
              existing &&
              canonicalJson(existing.descriptor) !== canonicalJson(descriptor)
            )
              fail(
                "question_conflict",
                "Question identity cannot be rebound to new facts"
              );
            if (!existing) this.saveQuestion({ descriptor });
          } else {
            if (!existing)
              fail(
                "question_not_found",
                "Resolution requires retained request evidence"
              );
            const resolution = questionResolution(value, existing.descriptor);
            if (
              existing.resolution &&
              existing.resolution.status !== "unknown" &&
              canonicalJson(existing.resolution) !== canonicalJson(resolution)
            )
              fail(
                "question_conflict",
                "Terminal question resolution cannot change"
              );
            existing.resolution = resolution;
            this.saveQuestion(existing);
          }
        }
        if (effect.operation) {
          if (!source.operationId)
            fail(
              "invalid_projection",
              "Operation state requires a correlated operation ID"
            );
          this.applyDisposition(
            { ...scope, operationId: source.operationId },
            {
              ...effect.operation,
              evidence: effect.operation.evidence ?? `source:${source.eventId}`,
            }
          );
        }
        for (const entry of effect.entries ?? [])
          this.insertEntry(scope, entry, source.operationId);
        if (effect.completion) {
          if (!source.operationId)
            fail(
              "invalid_projection",
              "Completion requires a correlated operation ID"
            );
          const op = this.operationRow({
            ...scope,
            operationId: source.operationId,
          })!;
          if (!terminal(this.receipt(op)))
            fail(
              "invalid_projection",
              "Completion cannot precede terminal execution"
            );
          this.insertCompletion(
            { ...scope, operationId: source.operationId },
            effect.completion
          );
        }
        const messages = effect.publicEvents ?? [
          {
            type: source.type,
            bindingId: source.bindingId,
            botId: scope.botId,
            ...(source.operationId ? { operationId: source.operationId } : {}),
            payload: source.payload,
          },
        ];
        publicEvents.push(
          ...this.insertPublicEvents(event.bindingId, messages)
        );
        ack++;
        this.prepare(
          "UPDATE source_events SET applied=1 WHERE binding_id=? AND source_sequence=?"
        ).run(event.bindingId, ack);
      }
      this.prepare(
        "UPDATE conversations SET source_ack=? WHERE binding_id=?"
      ).run(ack, event.bindingId);
      return { duplicate: false, ack, publicEvents };
    });
  }
  private insertEntry(
    scope: ConversationKey,
    entry: JsonObject,
    operationId?: string
  ): void {
    if (typeof entry.id !== "string")
      fail("invalid_entry", "Canonical transcript entry requires an ID");
    identifier(entry.id, "entry ID");
    if (
      operationId &&
      entry.operationId !== undefined &&
      entry.operationId !== operationId
    )
      fail("entry_conflict", "Entry names a different operation");
    const canonical = { ...entry, ...(operationId ? { operationId } : {}) };
    const json = canonicalJson(canonical);
    const digest = payloadDigest(canonical);
    const old = this.prepare(
      "SELECT digest FROM transcript_entries WHERE bot_id=? AND conversation_id=? AND entry_id=?"
    ).get(scope.botId, scope.conversationId, entry.id);
    if (old) {
      if (old.digest !== digest)
        fail("entry_conflict", "Canonical entry identity is immutable");
      return;
    }
    this.prepare(
      "INSERT INTO transcript_entries(bot_id,conversation_id,entry_id,operation_id,entry_json,digest) VALUES(?,?,?,?,?,?)"
    ).run(
      scope.botId,
      scope.conversationId,
      entry.id,
      operationId ?? null,
      json,
      digest
    );
  }
  private insertCompletion(
    key: OperationKey,
    delivery: CompletionDelivery
  ): void {
    identifier(delivery.dispatchId, "dispatch ID");
    identifier(delivery.originBotId, "origin bot ID");
    const digest = payloadDigest({ ...key, ...delivery });
    const existing = this.prepare(
      "SELECT digest FROM completion_outbox WHERE dispatch_id=?"
    ).get(delivery.dispatchId);
    if (existing) {
      if (existing.digest !== digest)
        fail(
          "completion_conflict",
          "Completion dispatch identity is immutable"
        );
      return;
    }
    this.prepare(
      "INSERT INTO completion_outbox(dispatch_id,origin_bot_id,target_bot_id,conversation_id,operation_id,payload_json,digest) VALUES(?,?,?,?,?,?,?)"
    ).run(
      delivery.dispatchId,
      delivery.originBotId,
      key.botId,
      key.conversationId,
      key.operationId,
      canonicalJson(delivery.payload),
      digest
    );
  }
  private insertPublicEvents(
    bindingId: string,
    events: JsonObject[]
  ): PublicEvent[] {
    return events.map((event) => {
      const inserted = this.prepare(
        "INSERT INTO public_events(binding_id,event_json) VALUES(?,?)"
      ).run(bindingId, canonicalJson(event));
      const seq = Number(inserted.lastInsertRowid);
      return { seq, event: { ...event, seq } };
    });
  }
  appendPublicEvents(
    lease: WriterLease,
    bindingId: string,
    events: JsonObject[]
  ): PublicEvent[] {
    return this.write(lease, () => {
      const binding = this.prepare(
        "SELECT deleted FROM conversations WHERE binding_id=?"
      ).get(bindingId);
      if (!binding || binding.deleted)
        fail(
          "binding_not_found",
          "Public event targets a missing or deleted binding"
        );
      return this.insertPublicEvents(bindingId, events);
    });
  }
  readTranscript(key: ConversationKey): JsonObject[] {
    this.conversation(key);
    return this.prepare(
      "SELECT entry_json FROM transcript_entries WHERE bot_id=? AND conversation_id=? ORDER BY ordinal"
    )
      .all(key.botId, key.conversationId)
      .map((row) => parseObject(row.entry_json));
  }
  readEvents(since = 0, limit = 1000): PublicEvent[] {
    if (
      !Number.isSafeInteger(since) ||
      since < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10_000
    )
      fail("invalid_cursor", "Invalid public event cursor/limit");
    return this.prepare(
      "SELECT seq,event_json FROM public_events WHERE seq>? ORDER BY seq LIMIT ?"
    )
      .all(since, limit)
      .map((row) => ({
        seq: Number(row.seq),
        event: { ...parseObject(row.event_json), seq: Number(row.seq) },
      }));
  }
  get publicSequence(): number {
    return Number(
      this.prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM public_events"
      ).get()!.seq
    );
  }
  readOutbox(limit = 100, afterId = 0): OutboxDelivery[] {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10_000 ||
      !Number.isSafeInteger(afterId) ||
      afterId < 0
    )
      fail("invalid_cursor", "Invalid outbox limit");
    return this.prepare(
      "SELECT * FROM completion_outbox WHERE delivered=0 AND id>? ORDER BY id LIMIT ?"
    )
      .all(afterId, limit)
      .map((row) => ({
        id: Number(row.id),
        dispatchId: String(row.dispatch_id),
        originBotId: String(row.origin_bot_id),
        targetBotId: String(row.target_bot_id),
        conversationId: String(row.conversation_id),
        operationId: String(row.operation_id),
        payload: parseObject(row.payload_json),
      }));
  }
  ackOutbox(lease: WriterLease, id: number): void {
    this.write(lease, () => {
      if (!this.prepare("SELECT 1 FROM completion_outbox WHERE id=?").get(id))
        fail("delivery_not_found", "Unknown outbox delivery");
      this.prepare("UPDATE completion_outbox SET delivered=1 WHERE id=?").run(
        id
      );
    });
  }

  admitCompletion(
    lease: WriterLease,
    id: number,
    target: ConversationBinding,
    publicBotName: string
  ): { receipt: OperationReceipt; created: boolean } {
    return this.write(lease, () => {
      const row = this.prepare(
        "SELECT * FROM completion_outbox WHERE id=?"
      ).get(id);
      if (!row)
        fail("delivery_not_found", "Completion outbox record is missing");
      const payload = parseObject(row.payload_json);
      if (
        row.origin_bot_id !== target.botId ||
        payload.originConversationId !== target.conversationId ||
        payload.originBindingId !== target.bindingId
      )
        fail(
          "binding_conflict",
          "Completion belongs to another origin binding"
        );
      if (
        typeof payload.text !== "string" ||
        typeof payload.execution !== "string" ||
        !Number.isSafeInteger(payload.depth)
      )
        fail("corrupt_storage", "Completion payload is invalid");
      const admitted = this.admitOperation(
        {
          ...target,
          operationId: `completion-${String(row.dispatch_id)}`,
          actorId: String(row.target_bot_id),
          publicBotName,
          payload: {
            text: `Fleet completion from ${String(row.target_bot_id)}. Execution: ${payload.execution}; observation: ${String(payload.observation)}.\n\n${payload.text}`,
            completionOf: String(row.dispatch_id),
            completionDepth: payload.depth,
          },
          userEntry: {
            from: String(row.target_bot_id),
            dispatchId: String(row.dispatch_id),
            completion: true,
          },
        },
        "fleet"
      );
      this.prepare("UPDATE completion_outbox SET delivered=1 WHERE id=?").run(
        id
      );
      return admitted;
    });
  }

  expireOperation(lease: WriterLease, key: OperationKey): void {
    this.write(lease, () => {
      this.conversation(key);
      const row = this.operationRow(key);
      if (!row) fail("operation_not_found", "Unknown operation");
      if (row.kind === "permission")
        fail(
          "operation_retained",
          "Exact permission decisions must retain their original facts"
        );
      if (!resolved(this.receipt(row)))
        fail(
          "operation_unresolved",
          "Unresolved identity and body must be retained"
        );
      this.deleteArtifacts(key);
      this.prepare(
        "UPDATE operations SET payload_json=NULL,expired=1 WHERE ordinal=?"
      ).run(Number(row.ordinal));
      this.prepare(
        "DELETE FROM transcript_entries WHERE bot_id=? AND conversation_id=? AND operation_id=?"
      ).run(key.botId, key.conversationId, key.operationId);
    });
  }
  tombstoneConversation(lease: WriterLease, key: ConversationKey): void {
    this.write(lease, () => {
      const binding = this.conversation(key)!;
      const unresolved = this.prepare(
        "SELECT * FROM operations WHERE bot_id=? AND conversation_id=?"
      )
        .all(key.botId, key.conversationId)
        .some((row) => !resolved(this.receipt(row)));
      if (unresolved)
        fail(
          "conversation_unresolved",
          "Resolve or explicitly abandon native work before deleting its conversation"
        );
      for (const operation of this.listOperationRecords(key))
        this.deleteArtifacts(operation.receipt);
      this.prepare("UPDATE conversations SET deleted=1 WHERE binding_id=?").run(
        String(binding.binding_id)
      );
      this.prepare(
        "UPDATE operations SET payload_json=NULL,expired=1 WHERE bot_id=? AND conversation_id=?"
      ).run(key.botId, key.conversationId);
      this.prepare(
        "DELETE FROM transcript_entries WHERE bot_id=? AND conversation_id=?"
      ).run(key.botId, key.conversationId);
      // Source identities, operation digests, outbox delivery identities and public seq remain durable.
    });
  }
}
