import {
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  canonicalJson,
  GATEWAY_SQLITE_VERSION,
  payloadDigest,
} from "../gateway/journal.ts";
import {
  DEFAULT_LIMITS,
  encodeFrame,
  object,
  nonempty,
  ProtocolError,
  validateEvent,
  type GatewayPluginEvent,
  type JsonObject,
  type ProtocolLimits,
} from "../gateway/protocol.ts";

type Row = Record<string, unknown>;
const APPLICATION_ID = 0x54445053;
const SCHEMA_VERSION = 1;
const GAP_RESERVE_BYTES = 1024;
export interface Reservation {
  key: string;
  method: string;
  created: boolean;
  result: unknown;
  settled: boolean;
  /** Original immutable request, retained for explicit reconciliation only. */
  params: JsonObject;
}
export interface PluginStoreOptions {
  bindingId: string;
  instanceId: string;
  leaseGeneration: number;
  limits?: ProtocolLimits;
}
export type EventInput = Omit<
  GatewayPluginEvent,
  "bindingId" | "leaseGeneration" | "sourceSequence" | "eventId"
> & { type: string; payload: JsonObject; eventId?: string };

/** One binding's durable reservations and spool. It never invokes native code. */
export class PluginStore {
  private readonly db: DatabaseSync;
  readonly options: PluginStoreOptions;
  readonly limits: ProtocolLimits;
  private closed = false;
  private connectionSent = 0;
  constructor(path: string, options: PluginStoreOptions) {
    this.options = options;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    if (
      !path ||
      path === ":memory:" ||
      !options.bindingId ||
      !options.instanceId ||
      !Number.isSafeInteger(options.leaseGeneration) ||
      options.leaseGeneration < 1
    )
      throw new ProtocolError(
        "invalid_config",
        "Durable plugin binding identity and on-disk storage are required"
      );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const marker = `${path}.namespace`,
      fresh = !existsSync(marker) && !existsSync(path);
    if (fresh) {
      const descriptor = openSync(marker, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          canonicalJson({
            format: SCHEMA_VERSION,
            bindingId: options.bindingId,
          })
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } else {
      if (!existsSync(marker) || !existsSync(path))
        throw new ProtocolError(
          "corrupt_storage",
          "Missing plugin journal or durable namespace marker; reconciliation is required"
        );
      try {
        const value = JSON.parse(readFileSync(marker, "utf8"));
        if (
          value.format !== SCHEMA_VERSION ||
          value.bindingId !== options.bindingId
        )
          throw new Error("Wrong namespace");
      } catch {
        throw new ProtocolError(
          "corrupt_storage",
          "Invalid plugin journal namespace marker"
        );
      }
    }
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      if (
        this.get("SELECT sqlite_version() AS version")?.version !==
        GATEWAY_SQLITE_VERSION
      )
        throw new ProtocolError(
          "unsupported_sqlite",
          `Plugin SDK requires SQLite ${GATEWAY_SQLITE_VERSION}`
        );
      this.db.exec("PRAGMA busy_timeout=5000;");
      const app = Number(this.get("PRAGMA application_id")?.application_id),
        schema = Number(this.get("PRAGMA user_version")?.user_version);
      if (!fresh && (app !== APPLICATION_ID || schema !== SCHEMA_VERSION))
        throw new ProtocolError(
          "corrupt_storage",
          "An existing namespace cannot be recreated as an empty plugin journal"
        );
      if (
        (app !== 0 && app !== APPLICATION_ID) ||
        (schema !== 0 && schema !== SCHEMA_VERSION) ||
        (app === 0) !== (schema === 0)
      )
        throw new ProtocolError(
          "incompatible_storage",
          "Incompatible plugin journal identity/version"
        );
      if (
        app === 0 &&
        Number(
          this.get(
            "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
          )?.n
        )
      )
        throw new ProtocolError(
          "incompatible_storage",
          "Refusing to adopt a non-plugin database"
        );
      if (this.get("PRAGMA journal_mode=WAL")?.journal_mode !== "wal")
        throw new ProtocolError(
          "unsupported_storage",
          "Plugin SDK requires WAL storage"
        );
      this.db.exec("PRAGMA synchronous=FULL;");
      if (Number(this.get("PRAGMA synchronous")?.synchronous) !== 2)
        throw new ProtocolError(
          "unsupported_storage",
          "Plugin SDK requires synchronous FULL"
        );
      if (this.get("PRAGMA quick_check")?.quick_check !== "ok")
        throw new ProtocolError(
          "corrupt_storage",
          "Plugin journal integrity check failed"
        );
      if (schema !== 0) this.validateStorage();
      this.transaction(() => {
        if (schema === 0) {
          this.db
            .exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE reservations(key TEXT PRIMARY KEY,method TEXT NOT NULL,caller_digest TEXT NOT NULL,fingerprint TEXT NOT NULL,params_json TEXT NOT NULL,result_json TEXT NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE events(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,event_json TEXT NOT NULL,bytes INTEGER NOT NULL);
            CREATE TABLE event_ids(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,sequence INTEGER UNIQUE NOT NULL);
            CREATE TABLE observations(operation_id TEXT PRIMARY KEY,delivery TEXT NOT NULL,execution TEXT NOT NULL,observation TEXT NOT NULL);
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
          for (const [key, value] of Object.entries({
            binding: options.bindingId,
            sequence: "0",
            ack: "0",
            highest_sent: "0",
            reservation_count: "0",
            gap: "",
            owner: "",
            lease: "0",
          }))
            this.set(key, value);
        }
        if (this.meta("binding") !== options.bindingId)
          throw new ProtocolError(
            "stale_binding",
            "Plugin store belongs to another binding"
          );
        if (Number(this.meta("lease")) > options.leaseGeneration)
          throw new ProtocolError(
            "stale_binding",
            "Plugin store has a newer writer generation"
          );
        for (const row of this.all("SELECT event_json FROM events"))
          this.eventBytes(validateEvent(JSON.parse(String(row.event_json))));
        if (
          Number(
            this.get("SELECT coalesce(sum(bytes),0) AS n FROM events")?.n
          ) > this.limits.maxSpoolBytes
        )
          throw new ProtocolError(
            "resource_limit",
            "Retained spool exceeds newly negotiated storage limit"
          );
        const ownerText = this.meta("owner");
        if (ownerText) {
          const owner = JSON.parse(ownerText) as {
            pid: number;
            instanceId: string;
          };
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (object(error) && error.code === "ESRCH") alive = false;
          }
          if (alive)
            throw new ProtocolError(
              "busy",
              "Another plugin process owns this binding store"
            );
          if (Number(this.meta("lease")) >= options.leaseGeneration)
            throw new ProtocolError(
              "stale_binding",
              "An unclean plugin replacement requires a new reconciled writer generation"
            );
        }
        if (!fresh)
          this.prepare(
            "UPDATE observations SET execution='unknown',observation='reconciliation_required' WHERE execution NOT IN ('ended','failed','cancelled','interrupted')"
          ).run();
        this.set(
          "owner",
          canonicalJson({ pid: process.pid, instanceId: options.instanceId })
        );
        this.set("lease", String(options.leaseGeneration));
      });
      this.connectionSent = this.acknowledged;
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }
  private prepare(sql: string): StatementSync {
    if (this.closed)
      throw new ProtocolError("storage_closed", "Plugin journal is closed");
    return this.db.prepare(sql);
  }
  private get(sql: string, ...args: (string | number)[]): Row | undefined {
    return this.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number)[]): Row[] {
    return this.prepare(sql).all(...args) as Row[];
  }
  private meta(key: string): string {
    const row = this.get("SELECT value FROM meta WHERE key=?", key);
    if (!row)
      throw new ProtocolError(
        "corrupt_storage",
        "Missing plugin journal metadata"
      );
    return String(row.value);
  }
  private set(key: string, value: string): void {
    this.prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, value);
  }
  private validateStorage(): void {
    try {
      for (const name of [
        "meta",
        "reservations",
        "events",
        "event_ids",
        "observations",
      ])
        if (
          !this.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            name
          )
        )
          throw new Error("Missing table");
      for (const key of ["binding", "gap", "owner"]) this.meta(key);
      const counters = [
        "sequence",
        "ack",
        "highest_sent",
        "lease",
        "reservation_count",
      ].map((key) => {
        const text = this.meta(key),
          value = Number(text);
        if (
          !/^(0|[1-9][0-9]*)$/.test(text) ||
          !Number.isSafeInteger(value) ||
          value < 0
        )
          throw new Error("Invalid counter");
        return value;
      });
      const [sequence, ack, sent] = counters;
      if (
        ack > sent ||
        sent > sequence ||
        Number(this.get("SELECT count(*) AS n FROM events")?.n) !==
          sequence - ack ||
        Number(this.get("SELECT count(*) AS n FROM event_ids")?.n) !== sequence
      )
        throw new Error("Invalid event prefix");
      if (
        sequence > ack &&
        (Number(this.get("SELECT min(sequence) AS n FROM events")?.n) !==
          ack + 1 ||
          Number(this.get("SELECT max(sequence) AS n FROM events")?.n) !==
            sequence)
      )
        throw new Error("Invalid retained prefix");
      if (
        sequence > 0 &&
        (Number(this.get("SELECT min(sequence) AS n FROM event_ids")?.n) !==
          1 ||
          Number(this.get("SELECT max(sequence) AS n FROM event_ids")?.n) !==
            sequence)
      )
        throw new Error("Invalid event tombstone prefix");
      for (const row of this.all("SELECT * FROM events")) {
        const event = validateEvent(JSON.parse(String(row.event_json)));
        const tombstone = this.get(
          "SELECT fingerprint,sequence FROM event_ids WHERE event_id=?",
          event.eventId
        );
        const bytes = encodeFrame({
          jsonrpc: "2.0",
          method: "event",
          params: { ...event, leaseGeneration: Number.MAX_SAFE_INTEGER },
        }).length;
        if (
          event.bindingId !== this.options.bindingId ||
          event.eventId !== row.event_id ||
          event.sourceSequence !== row.sequence ||
          tombstone?.sequence !== event.sourceSequence ||
          tombstone.fingerprint !== this.eventFingerprint(event) ||
          row.bytes !== bytes
        )
          throw new Error("Invalid retained event fingerprint");
      }
      if (
        Number(this.get("SELECT count(*) AS n FROM reservations")?.n) !==
        counters[4]
      )
        throw new Error("Missing reservation");
      for (const row of this.all("SELECT * FROM reservations")) {
        const params = JSON.parse(String(row.params_json));
        JSON.parse(String(row.result_json));
        if (
          !object(params) ||
          !row.method ||
          !row.caller_digest ||
          ![0, 1].includes(Number(row.settled)) ||
          row.fingerprint !== payloadDigest({ method: row.method, params })
        )
          throw new Error("Invalid immutable reservation");
        const key =
          row.method === "session.open"
            ? `open:${params.openId}`
            : row.method === "host.call"
              ? `action:${params.actionId}`
              : `operation:${params.operationId}`;
        if (row.key !== key) throw new Error("Invalid reservation key");
      }
    } catch {
      throw new ProtocolError(
        "corrupt_storage",
        "Plugin journal schema or durable counters are invalid"
      );
    }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get watermark(): number {
    return Number(this.meta("sequence"));
  }
  get acknowledged(): number {
    return Number(this.meta("ack"));
  }
  get highestSent(): number {
    return this.connectionSent;
  }
  get observationGap(): string | undefined {
    return this.meta("gap") || undefined;
  }
  private owner(): void {
    const value = JSON.parse(this.meta("owner") || "null");
    if (
      !value ||
      value.instanceId !== this.options.instanceId ||
      Number(this.meta("lease")) !== this.options.leaseGeneration
    )
      throw new ProtocolError(
        "stale_binding",
        "Plugin store ownership changed"
      );
  }
  reserve(
    key: string,
    method: string,
    callerDigest: string,
    params: JsonObject
  ): Reservation {
    if (!key || !method || !callerDigest)
      throw new ProtocolError(
        "invalid_request",
        "Mutation requires durable key and payload digest"
      );
    const immutable = { ...params };
    delete immutable.bindingId;
    delete immutable.leaseGeneration;
    const fingerprint = payloadDigest({ method, params: immutable });
    return this.transaction(() => {
      this.owner();
      const existing = this.get("SELECT * FROM reservations WHERE key=?", key);
      if (existing) {
        if (
          existing.method !== method ||
          existing.caller_digest !== callerDigest ||
          existing.fingerprint !== fingerprint
        )
          throw new ProtocolError(
            "payload_conflict",
            "Durable key was already reserved for different immutable intent"
          );
        return {
          key,
          method,
          created: false,
          result: JSON.parse(String(existing.result_json)),
          settled: existing.settled === 1,
          params: JSON.parse(String(existing.params_json)) as JsonObject,
        };
      }
      if (this.observationGap)
        throw new ProtocolError(
          "observation_gap",
          "Plugin observation is incomplete; new native admission is paused"
        );
      if (method === "operation.submit" || method === "session.open") {
        for (const row of this.all(
          "SELECT key,method,params_json,result_json,settled FROM reservations WHERE method IN ('operation.submit','session.open')"
        )) {
          const intent = JSON.parse(String(row.params_json)) as JsonObject;
          const result = JSON.parse(String(row.result_json)) as JsonObject;
          if (row.method === "session.open") {
            if (
              row.settled !== 1 ||
              result.status !== "opened" ||
              !nonempty(result.nativeReference)
            )
              throw new ProtocolError(
                "busy",
                "Unresolved native session creation blocks another admission"
              );
          } else if (intent.conversationId === params.conversationId) {
            const observation = this.inspect(String(intent.operationId));
            const terminal =
              observation.disposition === "accepted" &&
              observation.observation === "complete" &&
              ["ended", "failed", "cancelled", "interrupted"].includes(
                String(observation.execution)
              );
            if (observation.disposition !== "rejected" && !terminal)
              throw new ProtocolError(
                "busy",
                "An unresolved native turn already owns this conversation"
              );
          }
        }
      }
      const result =
        method === "session.open"
          ? { status: "creation_unknown" }
          : {
              disposition: "unknown",
              execution: "unknown",
              observation: "reconciliation_required",
            };
      this.prepare(
        "INSERT INTO reservations(key,method,caller_digest,fingerprint,params_json,result_json) VALUES(?,?,?,?,?,?)"
      ).run(
        key,
        method,
        callerDigest,
        fingerprint,
        canonicalJson(immutable),
        canonicalJson(result)
      );
      this.set(
        "reservation_count",
        String(Number(this.meta("reservation_count")) + 1)
      );
      return {
        key,
        method,
        created: true,
        result,
        settled: false,
        params: immutable,
      };
    });
  }
  settle(key: string, result: unknown): void {
    const encoded = canonicalJson(result);
    this.transaction(() => {
      this.owner();
      const row = this.get(
        "SELECT settled,result_json,params_json,method FROM reservations WHERE key=?",
        key
      );
      if (!row)
        throw new ProtocolError(
          "invalid_request",
          "Missing durable reservation"
        );
      if (
        row.method === "session.open" &&
        (!object(result) ||
          (result.status !== "creation_unknown" &&
            !(result.status === "opened" && nonempty(result.nativeReference))))
      )
        throw new ProtocolError(
          "invalid_native_result",
          "Native open requires an explicit unknown or a proven native reference"
        );
      if (
        row.method === "operation.submit" &&
        (!object(result) ||
          !["accepted", "rejected", "unknown"].includes(
            String(result.disposition)
          ))
      )
        throw new ProtocolError(
          "invalid_native_result",
          "Native submit requires an explicit disposition"
        );
      if (
        row.method === "operation.submit" &&
        object(result) &&
        result.disposition === "rejected"
      ) {
        const intent = JSON.parse(String(row.params_json));
        if (
          this.get(
            "SELECT delivery FROM observations WHERE operation_id=?",
            String(intent.operationId)
          )?.delivery === "accepted"
        )
          throw new ProtocolError(
            "native_outcome_conflict",
            "A late rejection contradicts durable native acceptance"
          );
      }
      if (row.settled === 1 && row.result_json !== encoded)
        throw new ProtocolError(
          "payload_conflict",
          "A settled native disposition cannot be replaced"
        );
      this.prepare(
        "UPDATE reservations SET settled=1,result_json=? WHERE key=?"
      ).run(encoded, key);
    });
  }
  reservation(key: string): Reservation | undefined {
    const row = this.get("SELECT * FROM reservations WHERE key=?", key);
    return row
      ? {
          key,
          method: String(row.method),
          created: false,
          result: JSON.parse(String(row.result_json)),
          settled: row.settled === 1,
          params: JSON.parse(String(row.params_json)) as JsonObject,
        }
      : undefined;
  }
  inspect(operationId: string): JsonObject {
    const row = this.get(
      "SELECT * FROM observations WHERE operation_id=?",
      operationId
    );
    if (row)
      return {
        disposition: String(row.delivery),
        execution: String(row.execution),
        observation: this.observationGap
          ? "reconciliation_required"
          : String(row.observation),
      };
    const reservation = this.reservation(`operation:${operationId}`);
    if (reservation && object(reservation.result))
      return {
        ...reservation.result,
        execution: reservation.result.execution ?? "unknown",
        observation:
          reservation.result.observation ?? "reconciliation_required",
      };
    return {
      disposition: "unknown",
      execution: "unknown",
      observation: "reconciliation_required",
    };
  }
  append(input: EventInput): GatewayPluginEvent {
    let limitExceeded = false;
    const result = this.transaction(() => {
      this.owner();
      const event = validateEvent({
        ...input,
        bindingId: this.options.bindingId,
        leaseGeneration: this.options.leaseGeneration,
        sourceSequence: this.watermark + 1,
        eventId: input.eventId ?? `event-${randomUUID()}`,
      });
      if (event.operationId) {
        const reservation = this.get(
          "SELECT method,params_json FROM reservations WHERE key=?",
          `operation:${event.operationId}`
        );
        const controlLifecycle = [
          "operation.disposition",
          "turn.started",
          "turn.terminal",
        ].includes(event.type);
        if (
          !reservation ||
          !(
            reservation.method === "operation.submit" ||
            (controlLifecycle &&
              ["session.compact", "session.configure"].includes(
                String(reservation.method)
              ))
          ) ||
          JSON.parse(String(reservation.params_json)).turnId !== event.turnId
        )
          throw new ProtocolError(
            "invalid_event",
            "Event operation and turn must match its durable native reservation"
          );
      }
      const fingerprint = this.eventFingerprint(event);
      const old = this.get(
        "SELECT fingerprint,sequence FROM event_ids WHERE event_id=?",
        event.eventId
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ProtocolError(
            "payload_conflict",
            "Event ID already identifies different immutable content"
          );
        return { ...event, sourceSequence: Number(old.sequence) };
      }
      if (event.operationId) {
        const prior = this.inspect(event.operationId);
        if (
          (prior.disposition === "rejected" &&
            !(
              event.type === "operation.disposition" &&
              event.payload.disposition === "rejected"
            )) ||
          (event.type === "turn.started" &&
            ["ended", "failed", "cancelled", "interrupted"].includes(
              String(prior.execution)
            ))
        )
          throw new ProtocolError(
            "invalid_event",
            "Native event contradicts its durable disposition"
          );
      }
      let bytes: number;
      try {
        bytes = this.eventBytes(event);
      } catch (error) {
        if (
          !(error instanceof ProtocolError) ||
          error.code !== "resource_limit"
        )
          throw error;
        this.set("gap", "frame_capacity_exhausted");
        limitExceeded = true;
        return undefined;
      }
      const spoolBytes = Number(
        this.get("SELECT coalesce(sum(bytes),0) AS n FROM events")!.n
      );
      const capacity = Math.max(
        0,
        this.limits.maxSpoolBytes -
          Math.min(GAP_RESERVE_BYTES, Math.floor(this.limits.maxSpoolBytes / 4))
      );
      if (spoolBytes + bytes > capacity) {
        this.set("gap", "spool_capacity_exhausted");
        limitExceeded = true;
        return undefined;
      }
      this.insertEvent(event, bytes);
      return event;
    });
    if (limitExceeded)
      throw new ProtocolError(
        "observation_gap",
        "Plugin spool capacity exhausted; observation lost and admission paused"
      );
    return result!;
  }
  private insertEvent(event: GatewayPluginEvent, bytes: number): void {
    if (event.type === "observation.gap")
      this.set(
        "gap",
        nonempty(event.payload.reason)
          ? event.payload.reason
          : "native_observation_gap"
      );
    this.prepare(
      "INSERT INTO events(sequence,event_id,event_json,bytes) VALUES(?,?,?,?)"
    ).run(event.sourceSequence, event.eventId, canonicalJson(event), bytes);
    this.set("sequence", String(event.sourceSequence));
    this.prepare(
      "INSERT INTO event_ids(event_id,fingerprint,sequence) VALUES(?,?,?)"
    ).run(event.eventId, this.eventFingerprint(event), event.sourceSequence);
    if (
      event.operationId &&
      ["operation.disposition", "turn.started", "turn.terminal"].includes(
        event.type
      )
    ) {
      const prior = this.inspect(event.operationId);
      const delivery =
        prior.disposition === "accepted"
          ? "accepted"
          : event.type === "operation.disposition"
            ? String(event.payload.disposition)
            : "accepted";
      const terminal = ["ended", "failed", "cancelled", "interrupted"].includes(
        String(prior.execution)
      );
      const execution = terminal
        ? String(prior.execution)
        : event.type === "turn.started"
          ? "running"
          : event.type === "turn.terminal"
            ? String(event.payload.execution)
            : String(prior.execution);
      const observation =
        event.type === "turn.terminal"
          ? String(event.payload.observation)
          : event.type === "turn.started"
            ? "complete"
            : String(prior.observation);
      this.prepare(
        "INSERT INTO observations(operation_id,delivery,execution,observation) VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET delivery=excluded.delivery,execution=excluded.execution,observation=excluded.observation"
      ).run(event.operationId, delivery, execution, observation);
    }
  }
  private eventFingerprint(event: GatewayPluginEvent): string {
    const copy: JsonObject = { ...event };
    delete copy.leaseGeneration;
    delete copy.sourceSequence;
    return payloadDigest(copy);
  }
  private eventBytes(event: GatewayPluginEvent): number {
    // A retained event must fit when replayed under any later safe writer generation.
    return encodeFrame(
      {
        jsonrpc: "2.0",
        method: "event",
        params: { ...event, leaseGeneration: Number.MAX_SAFE_INTEGER },
      },
      this.limits.maxFrameBytes
    ).length;
  }
  /** Persistent gap state is separate from its visible event so even a full spool stays honest. */
  appendGap(
    operationId?: string,
    turnId?: string
  ): GatewayPluginEvent | undefined {
    return this.transaction(() => {
      this.owner();
      if (!this.observationGap) return undefined;
      const event = validateEvent({
        bindingId: this.options.bindingId,
        leaseGeneration: this.options.leaseGeneration,
        sourceSequence: this.watermark + 1,
        eventId: `event-${randomUUID()}`,
        type: "observation.gap",
        payload: { reason: this.observationGap, recoverable: false },
        ...(operationId ? { operationId } : {}),
        ...(turnId ? { turnId } : {}),
      });
      let bytes: number;
      try {
        bytes = this.eventBytes(event);
      } catch {
        return undefined;
      }
      if (
        Number(this.get("SELECT coalesce(sum(bytes),0) AS n FROM events")!.n) +
          bytes >
        this.limits.maxSpoolBytes
      )
        return undefined;
      this.insertEvent(event, bytes);
      return event;
    });
  }
  pending(
    after = this.acknowledged,
    count = this.limits.maxUnacknowledgedEvents
  ): GatewayPluginEvent[] {
    return this.all(
      "SELECT event_json FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
      after,
      count
    ).map(
      (row) =>
        ({
          ...JSON.parse(String(row.event_json)),
          leaseGeneration: this.options.leaseGeneration,
        }) as GatewayPluginEvent
    );
  }
  markSent(sequence: number): void {
    this.transaction(() => {
      this.owner();
      if (sequence !== this.highestSent + 1 || sequence > this.watermark)
        throw new ProtocolError(
          "invalid_ack",
          "Events must be sent contiguously"
        );
      this.set(
        "highest_sent",
        String(Math.max(sequence, Number(this.meta("highest_sent"))))
      );
    });
    this.connectionSent = sequence;
  }
  acknowledge(sequence: number): void {
    this.transaction(() => {
      this.owner();
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < this.acknowledged ||
        sequence > Number(this.meta("highest_sent"))
      )
        throw new ProtocolError(
          "invalid_ack",
          "ACK is outside the durably recorded contiguous sent prefix"
        );
      this.prepare("DELETE FROM events WHERE sequence<=?").run(sequence);
      this.set("ack", String(sequence));
    });
    this.connectionSent = Math.max(sequence, this.connectionSent);
  }
  replay(after: number): {
    gap: boolean;
    acknowledged: number;
    watermark: number;
    events: GatewayPluginEvent[];
  } {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.watermark)
      throw new ProtocolError("invalid_request", "Invalid replay cursor");
    return {
      gap: after < this.acknowledged || !!this.observationGap,
      acknowledged: this.acknowledged,
      watermark: this.watermark,
      events: this.pending(Math.max(after, this.acknowledged)),
    };
  }
  close(clean = true): void {
    if (this.closed) return;
    try {
      if (clean)
        this.transaction(() => {
          this.owner();
          this.set("owner", "");
        });
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}
