import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk" / "python"))
from tidy_backend_sdk import DurableStore, SDKError
from tidy_backend_sdk.protocol import encode_frame, parse_frame, validate_capabilities


def operation(**values):
    return {"operationId": "op-1", "payloadDigest": "caller-claims-same-digest", "conversationId": "conv-1",
            "turnId": "turn-1", "input": [{"type": "text", "text": "hello"}], **values}


class DurableSDKTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.store = DurableStore(self.path, "org.example.python", "binding", 1)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def assertCode(self, code, fn):
        with self.assertRaises(SDKError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)

    def test_independent_fingerprint_rejects_changed_intent_with_same_claimed_digest(self):
        p = operation()
        key, created, receipt = self.store.reserve("operation.submit", p)
        self.assertTrue(created)
        self.assertEqual(receipt, {"disposition": "unknown"})
        self.assertFalse(self.store.reserve("operation.submit", {**p, "leaseGeneration": 2})[1])
        self.assertCode("payload_conflict", lambda: self.store.reserve("operation.submit", operation(input=[{"type": "text", "text": "changed"}])))
        self.assertCode("payload_conflict", lambda: self.store.reserve("operation.cancel", p))
        self.assertCode("busy", lambda: self.store.reserve("operation.submit", operation(operationId="op-2", turnId="turn-2")))
        self.store.complete(key, {"disposition": "rejected"})
        self.assertTrue(self.store.reserve("operation.submit", operation(operationId="op-2", turnId="turn-2"))[1])
        self.assertCode("result_conflict", lambda: self.store.complete(key, {"disposition": "accepted"}))

    def test_open_controls_and_reverse_decisions_fence_every_immutable_field(self):
        base = {"openId": "open-1", "operationId": "opening-1", "payloadDigest": "same", "conversationId": "conv", "mode": "new", "cwd": "/fixture"}
        self.store.reserve("session.open", base)
        for result in ({}, {"status": "unknown"}, {"status": "opened"}):
            self.assertCode("invalid_result", lambda r=result: self.store.complete("open:open-1", r))
            self.assertCode("busy", lambda: self.store.reserve("session.open", {**base, "openId": "different"}))
        self.assertCode("payload_conflict", lambda: self.store.reserve("session.open", {**base, "cwd": "/changed"}))
        decision = {"operationId": "decision-1", "payloadDigest": "same", "targetOperationId": "op", "interactionId": "permission", "instanceId": "instance-old", "optionId": "deny", "optionsDigest": "options", "expiresAt": "2026-09-06T00:00:00Z", "revision": 1}
        self.store.reserve("interaction.respond", decision)
        for field, value in [("optionId", "allow"), ("instanceId", "instance-new"), ("revision", 2), ("targetOperationId", "different"), ("expiresAt", "2026-09-07T00:00:00Z")]:
            self.assertCode("payload_conflict", lambda f=field, v=value: self.store.reserve("interaction.respond", {**decision, f: v}))
        reverse = {"name": "fleet.send", "operationId": "op", "toolCallId": "tool", "actionId": "action", "payloadDigest": "same", "arguments": {"target": "bb", "text": "hello"}}
        self.store.reserve("host.call", reverse)
        self.assertCode("payload_conflict", lambda: self.store.reserve("host.call", {**reverse, "arguments": {"target": "cc", "text": "hello"}}))

    def test_crash_after_reservation_never_reexecutes_and_rejects_older_lease(self):
        self.store.close()
        program = "from tidy_backend_sdk import DurableStore; import os; s=DurableStore(os.environ['CASE_DIR'],'org.example.python','binding',2); s.reserve('operation.submit'," + repr(operation()) + "); os._exit(19)"
        env = {**os.environ, "CASE_DIR": str(self.path), "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "sdk" / "python")}
        result = subprocess.run([sys.executable, "-B", "-c", program], env=env, capture_output=True)
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertCode("stale_binding", lambda: DurableStore(self.path, "org.example.python", "binding", 1))
        self.store = DurableStore(self.path, "org.example.python", "binding", 3)
        self.assertEqual(self.store.reserve("operation.submit", operation())[1:], (False, {"disposition": "unknown"}))

    def test_spool_replays_original_identity_under_new_lease_and_exposes_expired_cursor(self):
        first = self.store.append({"type": "session.state", "payload": {"text": "one\u2028two\nthree"}})
        second = self.store.append({"type": "session.state", "payload": {"text": "next"}})
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 2)
        status, events = self.store.replay(0)
        self.assertEqual(status["status"], "replayed")
        self.assertEqual([event["eventId"] for event in events], [first["eventId"], second["eventId"]])
        self.assertEqual([event["leaseGeneration"] for event in events], [2, 2])
        self.assertEqual([event["sourceSequence"] for event in events], [1, 2])
        self.assertCode("invalid_ack", lambda: self.store.ack(3))
        self.assertCode("invalid_ack", lambda: self.store.ack(1))
        self.store.mark_sent(1)
        self.store.mark_sent(2)
        self.store.ack(1)
        self.assertEqual(self.store.replay(0)[0]["status"], "gap")
        self.assertEqual(self.store.replay(1)[1][0]["eventId"], second["eventId"])
        self.assertCode("invalid_ack", lambda: self.store.ack(0))

    def test_spool_reserves_gap_slot_and_sticky_gap_survives_ack_and_restart(self):
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 2, {"maxUnacknowledgedEvents": 3})
        self.store.append({"type": "session.state", "payload": {}})
        self.store.append({"type": "session.state", "payload": {}})
        self.assertCode("resource_limit", lambda: self.store.append({"type": "session.state", "payload": {}}))
        gap = self.store.mark_gap()
        self.assertEqual(gap["type"], "observation.gap")
        self.assertEqual(gap["sourceSequence"], 3)
        self.assertCode("observation_gap", lambda: self.store.reserve("operation.submit", operation()))
        for sequence in range(1, 4):
            self.store.mark_sent(sequence)
        self.store.ack(3)
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 3)
        self.assertTrue(self.store.observation_lost)
        self.assertEqual(self.store.replay(3)[0]["status"], "gap")

    def test_exclusive_writer_and_failed_transaction_preserve_unknown(self):
        self.assertCode("ownership_conflict", lambda: DurableStore(self.path, "org.example.python", "binding", 2))
        key, _, _ = self.store.reserve("operation.submit", operation())
        self.store.db.execute("CREATE TRIGGER reject_result BEFORE UPDATE OF result ON reservations BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END")
        with self.assertRaises(sqlite3.DatabaseError):
            self.store.complete(key, {"disposition": "accepted"})
        self.assertEqual(self.store.inspect("op-1")["disposition"], "unknown")

    def test_protocol_rejects_malformed_nonfinite_duplicate_or_oversize_frames(self):
        value = {"jsonrpc": "2.0", "id": "rpc", "method": "hello", "params": {"text": "a\u2028b\n"}}
        wire = encode_frame(value, 4096)
        self.assertEqual(wire.count(b"\n"), 1)
        self.assertEqual(parse_frame(wire), value)
        for raw in (b'{"jsonrpc":"2.0","id":1,"result":{}}\n', b'{"jsonrpc":"2.0","id":"x","result":NaN}\n', b'{"jsonrpc":"2.0","id":"x","id":"y","result":{}}\n', b'[]\n', b'{}', b'\xff\n'):
            self.assertCode("invalid_frame", lambda r=raw: parse_frame(r))
        self.assertCode("resource_limit", lambda: encode_frame({**value, "params": {"text": "x" * 10000}}, 4096))

    def test_existing_state_is_verified_never_recreated_from_missing_tables_or_metadata(self):
        corruptions = ["DROP TABLE reservations", "DROP TABLE event_identities", "DELETE FROM meta WHERE key='identity'",
                       "DELETE FROM meta WHERE key='ack'", "DELETE FROM meta WHERE key='sequence'",
                       "UPDATE meta SET value='0' WHERE key='sequence'", "DELETE FROM reservations",
                       "DELETE FROM events", "DELETE FROM event_identities",
                       "UPDATE reservations SET params='{}'", "UPDATE events SET event_json='{}'"]
        for index, sql in enumerate(corruptions):
            with self.subTest(sql=sql):
                directory = self.path / str(index)
                store = DurableStore(directory, "org.example.python", "binding", 1)
                store.reserve("operation.submit", operation())
                store.append({"type": "session.state", "payload": {}})
                store.close()
                database = sqlite3.connect(directory / "backend.sqlite", isolation_level=None)
                database.execute(sql)
                database.close()
                self.assertCode("incompatible_storage", lambda: DurableStore(directory, "org.example.python", "binding", 2))
        directory = self.path / "deleted-database"
        DurableStore(directory, "org.example.python", "binding", 1).close()
        (directory / "backend.sqlite").unlink()
        self.assertCode("incompatible_storage", lambda: DurableStore(directory, "org.example.python", "binding", 2))

    def test_event_evidence_survives_late_unknown_and_rejects_unmatched_or_resumed_turn(self):
        key, _, _ = self.store.reserve("operation.submit", operation())
        event = {"type": "turn.started", "operationId": "op-1", "turnId": "turn-1", "payload": {}}
        self.assertCode("invalid_event", lambda: self.store.append({**event, "turnId": "other"}))
        self.assertCode("invalid_event", lambda: self.store.append({**event, "operationId": "other"}))
        self.store.append(event)
        self.assertEqual(self.store.complete(key, {"disposition": "unknown"}), {"disposition": "accepted"})
        self.assertCode("result_conflict", lambda: self.store.complete(key, {"disposition": "rejected"}))
        self.store.append({**event, "type": "turn.terminal", "payload": {"execution": "ended", "observation": "complete"}})
        self.assertEqual(self.store.complete(key, {"disposition": "unknown"}), {"disposition": "accepted"})
        self.assertCode("invalid_event", lambda: self.store.append(event))
        self.assertEqual(self.store.sequence, 2)
        self.assertEqual(self.store.inspect("op-1")["execution"], "ended")

    def test_acked_identity_tombstones_prevent_reuse_without_advancing_sequence(self):
        with patch("tidy_backend_sdk.store.uuid.uuid4", return_value="fixed-event"):
            self.store.append({"type": "session.state", "payload": {"value": "first"}})
            self.store.mark_sent(1)
            self.store.ack(1)
            self.store.close()
            self.store = DurableStore(self.path, "org.example.python", "binding", 2)
            self.assertCode("event_identity_conflict", lambda: self.store.append({"type": "session.state", "payload": {"value": "changed"}}))
            self.assertEqual(self.store.sequence, 1)

    def test_frame_budget_remains_valid_with_largest_future_lease(self):
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 2, {"maxFrameBytes": 4096})
        prototype = {"jsonrpc": "2.0", "method": "event", "params": {"bindingId": "binding", "leaseGeneration": 9007199254740991,
                     "sourceSequence": 1, "eventId": "event-" + "0" * 36, "type": "session.state", "payload": {"text": ""}}}
        length = 4096 - len(encode_frame(prototype, 4096))
        self.store.append({"type": "session.state", "payload": {"text": "x" * length}})
        self.assertCode("resource_limit", lambda: self.store.append({"type": "session.state", "payload": {"text": "x" * (length + 1)}}))
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 9007199254740991, {"maxFrameBytes": 4096})
        event = self.store.replay(0)[1][0]
        self.assertEqual(len(encode_frame({"jsonrpc": "2.0", "method": "event", "params": event}, 4096)), 4096)

    def test_same_generation_requires_explicit_clean_native_ownership_evidence(self):
        self.store.close()
        self.assertCode("stale_binding", lambda: DurableStore(self.path, "org.example.python", "binding", 1))
        self.store = DurableStore(self.path, "org.example.python", "binding", 2)
        self.store.close(clean=True)
        self.store = DurableStore(self.path, "org.example.python", "binding", 2)
        self.store.close()
        self.assertCode("stale_binding", lambda: DurableStore(self.path, "org.example.python", "binding", 2))

    def test_new_instance_demotes_running_evidence_and_preserves_acceptance_and_terminal(self):
        running = operation()
        terminal = operation(operationId="finished", turnId="finished-turn", conversationId="other-conversation")
        for params in (running, terminal):
            key, _, _ = self.store.reserve("operation.submit", params)
            self.store.append({"type": "turn.started", "operationId": params["operationId"], "turnId": params["turnId"], "payload": {}})
            self.store.complete(key, {"disposition": "accepted"})
        self.store.append({"type": "turn.terminal", "operationId": "finished", "turnId": "finished-turn", "payload": {"execution": "ended", "observation": "complete"}})
        for sequence in range(1, 4):
            self.store.mark_sent(sequence)
        self.store.ack(3)
        self.store.close()
        self.store = DurableStore(self.path, "org.example.python", "binding", 2)
        self.assertEqual(self.store.inspect("op-1"), {"disposition": "accepted", "execution": "unknown", "observation": "reconciliation_required"})
        self.assertEqual(self.store.inspect("finished"), {"disposition": "accepted", "execution": "ended", "observation": "complete"})
        self.assertEqual(self.store.reserve("operation.submit", running)[1:], (False, {"disposition": "accepted"}))
        self.assertCode("busy", lambda: self.store.reserve("operation.submit", operation(operationId="fresh")))
        self.store.append({"type": "turn.started", "operationId": "op-1", "turnId": "turn-1", "payload": {}})
        self.store.close(clean=True)
        self.store = DurableStore(self.path, "org.example.python", "binding", 2)
        self.assertEqual(self.store.inspect("op-1"), {"disposition": "accepted", "execution": "unknown", "observation": "reconciliation_required"})
        self.assertEqual(self.store.inspect("finished"), {"disposition": "accepted", "execution": "ended", "observation": "complete"})


if __name__ == "__main__":
    unittest.main()
