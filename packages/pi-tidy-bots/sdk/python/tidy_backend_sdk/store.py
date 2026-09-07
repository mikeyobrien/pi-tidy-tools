"""Durable native-bound reservations and bounded replay using standard sqlite3."""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

from .protocol import SDKError, canonical, encode_frame, fingerprint, identity, integer, limits, validate_event

SQLITE_VERSION = "3.53.4"
APPLICATION_ID = 0x54425059
SCHEMA_VERSION = 1
MAX_INTEGER = 9007199254740991
MAX_EVENT_IDENTITIES = 100000
SCHEMA = {
    "meta": "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "reservations": "CREATE TABLE reservations(key TEXT PRIMARY KEY, method TEXT NOT NULL, digest TEXT NOT NULL, fingerprint TEXT NOT NULL, params TEXT NOT NULL, result TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, execution TEXT NOT NULL DEFAULT 'unknown', observation TEXT NOT NULL DEFAULT 'reconciliation_required')",
    "events": "CREATE TABLE events(sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, event_json TEXT NOT NULL, bytes INTEGER NOT NULL)",
    "event_identities": "CREATE TABLE event_identities(sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL)",
}


class DurableStore:
    def __init__(self, directory, plugin_id, binding_id, lease_generation, negotiated=None):
        if sys.version_info < (3, 11) or sqlite3.sqlite_version != SQLITE_VERSION:
            raise SDKError("unsupported_storage", "Requires Python >=3.11 and SQLite " + SQLITE_VERSION)
        if not identity(plugin_id) or not identity(binding_id) or not integer(lease_generation, 1):
            raise SDKError("invalid_identity")
        self.limits = limits(negotiated)
        self.binding_id, self.lease = binding_id, lease_generation
        # Future leases and sequences may use more digits. Reserve the complete
        # largest envelope now, so retained bytes remain replayable after restart.
        self.gap_reserve = len(encode_frame({"jsonrpc": "2.0", "method": "event", "params": {
            "bindingId": binding_id, "leaseGeneration": MAX_INTEGER,
            "sourceSequence": MAX_INTEGER, "eventId": "event-" + "0" * 36,
            "type": "observation.gap", "payload": {"reason": "native_producer_cannot_pause", "observation": "reconciliation_required"}
        }}, self.limits["maxFrameBytes"]))
        self.db = None
        self.lock = None
        root = Path(directory)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = open(root / "owner.lock", "a+b")
        os.chmod(root / "owner.lock", 0o600)
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            database = root / "backend.sqlite"
            self.lock.seek(0)
            previously_initialized = bool(self.lock.read())
            if previously_initialized and not database.exists():
                raise SDKError("incompatible_storage", "Initialized database is missing")
            self.db = sqlite3.connect(database, isolation_level=None, timeout=5)
            os.chmod(database, 0o600)
            app = self.db.execute("PRAGMA application_id").fetchone()[0]
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if (app, version) not in [(0, 0), (APPLICATION_ID, SCHEMA_VERSION)]:
                raise SDKError("incompatible_storage")
            if not app and self.db.execute("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchone():
                raise SDKError("incompatible_storage")
            if not app and previously_initialized:
                raise SDKError("incompatible_storage", "Initialized database was cleared")
            if self.db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise SDKError("incompatible_storage")
            if self.db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                raise SDKError("unsupported_storage")
            self.db.execute("PRAGMA synchronous=FULL")
            if self.db.execute("PRAGMA synchronous").fetchone()[0] != 2:
                raise SDKError("unsupported_storage")
            with self.transaction():
                new = canonical({"plugin": plugin_id, "binding": binding_id})
                if not app:
                    for sql in SCHEMA.values():
                        self.db.execute(sql)
                    self.db.execute("PRAGMA application_id=" + str(APPLICATION_ID))
                    self.db.execute("PRAGMA user_version=" + str(SCHEMA_VERSION))
                    self._set("identity", new)
                    self._set("lease", str(lease_generation))
                    for key in ("ack", "sequence", "highest_sent", "gap", "reservation_count", "owner_clean"):
                        self._set(key, "0")
                else:
                    self._verify_storage()
                if self._get("identity") != new:
                    raise SDKError("stale_binding")
                if int(self._get("lease")) > lease_generation:
                    raise SDKError("stale_binding")
                if app and self._get("owner_clean") != "1" and int(self._get("lease")) == lease_generation:
                    raise SDKError("stale_binding", "Unproven native cleanup requires a new reconciled lease")
                if app:
                    # Acceptance is durable evidence; an old process's running
                    # observation is not. Even clean ownership release proves
                    # resource cleanup, not a terminal outcome for each turn.
                    self.db.execute("UPDATE reservations SET execution='unknown',observation='reconciliation_required' WHERE method='operation.submit' AND execution NOT IN ('ended','failed','cancelled','interrupted')")
                self._set("lease", str(lease_generation))
                self._set("owner_clean", "0")
                count, size, largest = self.db.execute("SELECT COUNT(*),COALESCE(SUM(bytes),0),COALESCE(MAX(bytes),0) FROM events").fetchone()
                if count > self.limits["maxUnacknowledgedEvents"] or size > self.limits["maxSpoolBytes"] or largest > self.limits["maxFrameBytes"]:
                    raise SDKError("resource_limit", "Retained replay requires the prior negotiated limits")
            if not previously_initialized:
                self.lock.write(b"initialized\n")
                self.lock.flush()
                os.fsync(self.lock.fileno())
                parent = os.open(root, os.O_RDONLY)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
        except BlockingIOError as error:
            self.close()
            raise SDKError("ownership_conflict") from error
        except BaseException:
            self.close()
            raise

    def _verify_storage(self):
        try:
            tables = dict(self.db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
            if tables != SCHEMA:
                raise ValueError("schema")
            meta = dict(self.db.execute("SELECT key,value FROM meta"))
            required = {"identity", "lease", "ack", "sequence", "highest_sent", "gap", "reservation_count", "owner_clean"}
            if set(meta) != required | ({"gap_event"} if meta.get("gap") == "1" else set()):
                raise ValueError("metadata")
            for name in ("lease", "ack", "sequence", "highest_sent", "reservation_count"):
                if not integer(int(meta[name]), 1 if name == "lease" else 0) or str(int(meta[name])) != meta[name]:
                    raise ValueError("counter")
            if meta["gap"] not in ("0", "1") or meta["owner_clean"] not in ("0", "1") or not self.acknowledged <= int(meta["highest_sent"]) <= self.sequence or self.sequence > MAX_EVENT_IDENTITIES:
                raise ValueError("watermark")
            identity_value = json.loads(meta["identity"])
            if set(identity_value) != {"plugin", "binding"} or not all(identity(value) for value in identity_value.values()):
                raise ValueError("identity")
            reservations = self.db.execute("SELECT key,method,digest,fingerprint,params,result,complete,execution,observation FROM reservations").fetchall()
            if len(reservations) != int(meta["reservation_count"]):
                raise ValueError("missing reservation")
            for key, method, digest, actual, params, result, complete, execution, observation in reservations:
                params = json.loads(params)
                if self.request_key(method, params) != key or params.get("payloadDigest") != digest or fingerprint({"method": method, "params": params}) != actual or not isinstance(json.loads(result), dict):
                    raise ValueError("reservation fingerprint")
                if complete not in (0, 1) or execution not in ("unknown", "running", "ended", "failed", "cancelled", "interrupted") or observation not in ("complete", "reconciliation_required"):
                    raise ValueError("reservation state")
            count, low, high = self.db.execute("SELECT COUNT(*),MIN(sequence),MAX(sequence) FROM event_identities").fetchone()
            if count != self.sequence or (count and (low != 1 or high != count)):
                raise ValueError("missing event identity")
            events = self.db.execute("SELECT sequence,event_id,event_json,bytes FROM events ORDER BY sequence").fetchall()
            if [row[0] for row in events] != list(range(self.acknowledged + 1, self.sequence + 1)):
                raise ValueError("missing event")
            for sequence, event_id, encoded, size in events:
                event = json.loads(encoded)
                validate_event({**event, "leaseGeneration": self.lease})
                expected = (event_id, fingerprint(event), size)
                if event["sourceSequence"] != sequence or event["eventId"] != event_id or event["bindingId"] != identity_value["binding"] or self.db.execute("SELECT event_id,digest,bytes FROM event_identities WHERE sequence=?", (sequence,)).fetchone() != expected:
                    raise ValueError("event fingerprint")
                actual_size = len(encode_frame({"jsonrpc": "2.0", "method": "event", "params": {**event, "leaseGeneration": MAX_INTEGER}}, MAX_INTEGER))
                if size != actual_size:
                    raise ValueError("event size")
            if meta["gap"] == "1":
                event = json.loads(meta["gap_event"])
                validate_event({**event, "leaseGeneration": self.lease})
                if event["type"] != "observation.gap" or event["sourceSequence"] != self.sequence or self.db.execute("SELECT digest FROM event_identities WHERE sequence=?", (self.sequence,)).fetchone() != (fingerprint(event),):
                    raise ValueError("gap")
        except (ValueError, TypeError, KeyError, SDKError, sqlite3.DatabaseError) as error:
            raise SDKError("incompatible_storage", "Retained SDK state failed integrity checks") from error

    @contextlib.contextmanager
    def transaction(self):
        if self.db is None:
            raise SDKError("storage_closed")
        try:
            self.db.execute("BEGIN IMMEDIATE")
            yield
            self.db.execute("COMMIT")
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def _get(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def _set(self, key, value):
        self.db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    @property
    def acknowledged(self):
        return int(self._get("ack"))

    @property
    def sequence(self):
        return int(self._get("sequence"))

    @property
    def observation_lost(self):
        return self._get("gap") == "1"

    @staticmethod
    def request_key(method, params):
        if method == "host.call":
            if not all(identity(params.get(key)) for key in ("operationId", "toolCallId", "actionId")):
                raise SDKError("invalid_payload")
            return "reverse:" + canonical([params["operationId"], params["toolCallId"], params["actionId"]])
        key = params.get("openId") if method == "session.open" else params.get("operationId")
        if not identity(key):
            raise SDKError("invalid_payload", "Missing durable operation identity")
        return ("open:" if method == "session.open" else "operation:") + key

    def reserve(self, method, params):
        key = self.request_key(method, params)
        digest = params.get("payloadDigest")
        if not identity(digest):
            raise SDKError("invalid_payload", "Missing immutable payload digest")
        # instanceId remains significant for an exact permission target. Only
        # transport envelope identity is excluded from this independent hash.
        immutable = {k: v for k, v in params.items() if k not in ("bindingId", "leaseGeneration")}
        text = canonical(immutable)
        actual = fingerprint({"method": method, "params": immutable})
        unknown = {"status": "creation_unknown"} if method == "session.open" else ({"disposition": "unknown"} if method == "operation.submit" else {"status": "unknown"})
        with self.transaction():
            existing = self.db.execute("SELECT method,digest,fingerprint,result FROM reservations WHERE key=?", (key,)).fetchone()
            if existing:
                if existing[:3] != (method, digest, actual):
                    raise SDKError("payload_conflict")
                return key, False, json.loads(existing[3])
            if self.observation_lost:
                raise SDKError("observation_gap")
            if self.sequence >= MAX_EVENT_IDENTITIES - 1:
                raise SDKError("resource_limit", "Event identity retention requires explicit conversation replacement")
            if method in ("session.open", "operation.submit"):
                # Unknown work in this conversation is a reconciliation gate,
                # never permission to create or submit another native session.
                for prior_method, prior_params, prior_result, execution, observation, complete in self.db.execute("SELECT method,params,result,execution,observation,complete FROM reservations WHERE method!='host.call'"):
                    prior_params, prior_result = json.loads(prior_params), json.loads(prior_result)
                    if prior_params.get("conversationId") != params.get("conversationId"):
                        continue
                    if prior_method == "session.open":
                        unresolved = not (complete and prior_result.get("status") == "opened" and identity(prior_result.get("nativeReference")))
                    elif prior_method == "operation.submit":
                        unresolved = prior_result.get("disposition") != "rejected" and (execution not in ("ended", "failed", "cancelled", "interrupted") or observation != "complete")
                    else:
                        unresolved = not complete or prior_result.get("status") == "unknown"
                    if unresolved:
                        raise SDKError("busy", "Prior native work requires reconciliation")
            count, size = self.db.execute("SELECT COUNT(*),COALESCE(SUM(LENGTH(CAST(params AS BLOB))),0) FROM reservations").fetchone()
            if count >= 10000 or size + len(text.encode("utf-8")) > 16 * 1024 * 1024:
                raise SDKError("resource_limit", "Reservation identities require explicit conversation replacement")
            self.db.execute("INSERT INTO reservations(key,method,digest,fingerprint,params,result) VALUES(?,?,?,?,?,?)", (key, method, digest, actual, text, canonical(unknown)))
            self._set("reservation_count", str(count + 1))
        return key, True, unknown

    def complete(self, key, result):
        if not isinstance(result, dict):
            raise SDKError("invalid_result")
        encoded = canonical(result)
        with self.transaction():
            row = self.db.execute("SELECT result,complete,method FROM reservations WHERE key=?", (key,)).fetchone()
            if not row:
                raise SDKError("operation_not_found")
            if row[2] == "session.open" and not (result.get("status") == "creation_unknown" or result.get("status") == "opened" and identity(result.get("nativeReference"))):
                raise SDKError("invalid_result", "Session creation requires a proven native reference")
            if row[2] == "operation.submit" and result.get("disposition") not in ("accepted", "rejected", "unknown"):
                raise SDKError("invalid_result")
            prior = json.loads(row[0])
            if row[2] == "operation.submit" and prior.get("disposition") == "accepted":
                if result.get("disposition") == "unknown":
                    return prior
                if result.get("disposition") != "accepted":
                    raise SDKError("result_conflict", "Native event evidence already established acceptance")
            if row[1] and row[0] != encoded:
                raise SDKError("result_conflict")
            self.db.execute("UPDATE reservations SET result=?,complete=1 WHERE key=?", (encoded, key))
            return result

    def settled(self, key):
        row = self.db.execute("SELECT complete FROM reservations WHERE key=?", (key,)).fetchone()
        if not row:
            raise SDKError("operation_not_found")
        return bool(row[0])

    def reservation(self, key):
        row = self.db.execute("SELECT method,params,result,complete FROM reservations WHERE key=?", (key,)).fetchone()
        if not row:
            raise SDKError("operation_not_found")
        return {"method": row[0], "params": json.loads(row[1]), "result": json.loads(row[2]), "settled": bool(row[3])}

    def host_action(self, action_id):
        matches = []
        for key, method, params, result, complete in self.db.execute("SELECT key,method,params,result,complete FROM reservations WHERE method='host.call'"):
            value = json.loads(params)
            if value.get("actionId") == action_id:
                matches.append((key, method, value, json.loads(result), bool(complete)))
        if len(matches) != 1:
            raise SDKError("operation_not_found" if not matches else "corrupt_storage")
        key, method, params, result, settled = matches[0]
        return {"key": key, "method": method, "params": params, "result": result, "settled": settled}

    def inspect(self, operation_id):
        row = self.db.execute("SELECT result,execution,observation FROM reservations WHERE key=?", ("operation:" + operation_id,)).fetchone()
        if not row:
            return {"disposition": "unknown", "execution": "unknown", "observation": "reconciliation_required"}
        return {**json.loads(row[0]), "execution": row[1], "observation": row[2]}

    def append(self, value, gap=False):
        if any(key in value for key in ("bindingId", "leaseGeneration", "sourceSequence", "eventId")):
            raise SDKError("invalid_event", "The durable store owns event envelope identity")
        with self.transaction():
            if self.observation_lost and not gap:
                raise SDKError("observation_gap")
            if gap and self.observation_lost:
                event = json.loads(self._get("gap_event"))
                return {**event, "leaseGeneration": self.lease}
            if self.sequence >= MAX_EVENT_IDENTITIES - (0 if gap else 1):
                raise SDKError("resource_limit", "Event identity retention is full")
            event = {**value, "bindingId": self.binding_id, "leaseGeneration": self.lease,
                     "sourceSequence": self.sequence + 1, "eventId": "event-" + str(uuid.uuid4())}
            validate_event(event)
            reservation = None
            if event.get("operationId"):
                reservation = self.db.execute("SELECT method,params,result,execution FROM reservations WHERE key=?", ("operation:" + event["operationId"],)).fetchone()
                if not reservation or reservation[0] != "operation.submit" or json.loads(reservation[1]).get("turnId") != event.get("turnId"):
                    raise SDKError("invalid_event", "Event must match a reserved native turn")
                if json.loads(reservation[2]).get("disposition") == "rejected" or reservation[3] in ("ended", "failed", "cancelled", "interrupted"):
                    raise SDKError("invalid_event", "Finalized native turn cannot resume")
            frame = encode_frame({"jsonrpc": "2.0", "method": "event", "params": {**event, "leaseGeneration": MAX_INTEGER}}, self.limits["maxFrameBytes"])
            count, size = self.db.execute("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM events").fetchone()
            if count >= self.limits["maxUnacknowledgedEvents"] - (0 if gap else 1) or size + len(frame) > self.limits["maxSpoolBytes"] - (0 if gap else self.gap_reserve):
                raise SDKError("resource_limit", "Event spool requires acknowledgement before more output")
            # Persist a lease-free identity; replay receives the current envelope.
            persisted = {k: v for k, v in event.items() if k != "leaseGeneration"}
            if self.db.execute("SELECT 1 FROM event_identities WHERE event_id=?", (event["eventId"],)).fetchone():
                raise SDKError("event_identity_conflict")
            self.db.execute("INSERT INTO event_identities VALUES(?,?,?,?)", (event["sourceSequence"], event["eventId"], fingerprint(persisted), len(frame)))
            self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (event["sourceSequence"], event["eventId"], canonical(persisted), len(frame)))
            self._set("sequence", str(event["sourceSequence"]))
            if gap:
                self._set("gap", "1")
                self._set("gap_event", canonical(persisted))
            if event.get("operationId"):
                key = "operation:" + event["operationId"]
                if event["type"] == "operation.disposition":
                    disposition = event["payload"].get("disposition")
                    if disposition not in ("accepted", "rejected", "unknown"):
                        raise SDKError("invalid_event")
                    prior = json.loads(reservation[2]).get("disposition")
                    if prior == "accepted" and disposition == "rejected":
                        raise SDKError("result_conflict")
                    if disposition != "unknown":
                        self.db.execute("UPDATE reservations SET result=? WHERE key=?", (canonical({"disposition": disposition}), key))
                elif event["type"] == "turn.started":
                    self.db.execute("UPDATE reservations SET result=?,execution='running',observation='complete' WHERE key=? AND method='operation.submit'", (canonical({"disposition": "accepted"}), key))
                elif event["type"] == "turn.terminal":
                    execution = event["payload"].get("execution")
                    if execution not in ("ended", "failed", "cancelled", "interrupted"):
                        raise SDKError("invalid_event")
                    observation = "complete" if event["payload"].get("observation") == "complete" else "reconciliation_required"
                    self.db.execute("UPDATE reservations SET result=?,execution=?,observation=? WHERE key=? AND method='operation.submit'", (canonical({"disposition": "accepted"}), execution, observation, key))
            return event

    def mark_gap(self, reason="native_observation_lost"):
        return self.append({"type": "observation.gap", "payload": {"reason": reason, "observation": "reconciliation_required"}}, gap=True)

    def ack(self, sequence):
        if not integer(sequence):
            raise SDKError("invalid_ack")
        with self.transaction():
            if sequence < self.acknowledged or sequence > int(self._get("highest_sent")):
                raise SDKError("invalid_ack")
            count = self.db.execute("SELECT COUNT(*) FROM events WHERE sequence>? AND sequence<=?", (self.acknowledged, sequence)).fetchone()[0]
            if count != sequence - self.acknowledged:
                raise SDKError("invalid_ack", "Acknowledgement is not a contiguous spool prefix")
            self.db.execute("DELETE FROM events WHERE sequence<=?", (sequence,))
            self._set("ack", str(sequence))

    def mark_sent(self, sequence):
        # Record exposure before the write: a crash while writing is uncertain,
        # and a prior pipe may have delivered an acknowledgement that was lost.
        with self.transaction():
            prior = int(self._get("highest_sent"))
            if not integer(sequence, 1) or sequence > self.sequence or sequence > prior + 1:
                raise SDKError("invalid_cursor", "Output must offer a contiguous retained prefix")
            if sequence > prior:
                self._set("highest_sent", str(sequence))

    def replay(self, after):
        if not integer(after) or after > self.sequence:
            raise SDKError("invalid_cursor")
        if after < self.acknowledged:
            return {"status": "gap", "afterSequence": after, "acknowledgedSequence": self.acknowledged, "sourceSequence": self.sequence, "observation": "reconciliation_required"}, []
        rows = self.db.execute("SELECT event_json FROM events WHERE sequence>? ORDER BY sequence", (after,)).fetchall()
        return {"status": "gap" if self.observation_lost else "replayed", "sourceSequence": self.sequence, "acknowledgedSequence": self.acknowledged}, [{**json.loads(row[0]), "leaseGeneration": self.lease} for row in rows]

    def close(self, *, clean=False):
        try:
            # Only a lifecycle hook with evidence may certify owned cleanup.
            # Releasing flock alone never proves the native process stopped.
            if self.db is not None and clean is True:
                with self.transaction():
                    self._set("owner_clean", "1")
        finally:
            try:
                if self.db is not None:
                    self.db.close()
            finally:
                self.db = None
                if self.lock is not None:
                    self.lock.close()
                    self.lock = None
