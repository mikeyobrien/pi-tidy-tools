import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("history", Path(__file__).parents[1] / "backends/hermes/history.py")
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class Database:
    def __init__(self, state):
        self.row = {"id": state.session_id, "source": "acp", "model": state.model,
                    "model_config": json.dumps({"cwd": state.cwd})}
        self.messages = copy.deepcopy(state.history)
        self.repaired = None
        self.reads = []

    def get_session(self, sid):
        return copy.deepcopy(self.row)

    def get_messages_as_conversation(self, sid, *, repair_alternation):
        self.reads.append((sid, repair_alternation))
        return copy.deepcopy(self.repaired if repair_alternation and self.repaired is not None else self.messages)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.state = SimpleNamespace(session_id="one", agent=SimpleNamespace(session_id="one"),
                                     cwd=str(Path(__file__).parent.resolve()), model="fixture-model", is_running=False,
                                     queued_prompts=[], history=[{"role": "user", "content": "PRIVATE_HISTORY"},
                                                                {"role": "assistant", "content": "answer"}])
        self.db = Database(self.state)
        self.manager = SimpleNamespace(_db_instance=self.db)

    def unavailable(self):
        with self.assertRaises(history.HistoryUnavailable) as caught:
            history.history_checkpoint(self.manager, self.state)
        self.assertEqual(str(caught.exception), "")

    def test_exact_roundtrip_and_changed_checkpoint(self):
        checkpoint = history.history_checkpoint(self.manager, self.state)
        self.assertEqual(checkpoint["messageCount"], 2)
        self.assertNotIn("PRIVATE_HISTORY", json.dumps(checkpoint))
        self.assertNotIn(self.state.cwd, json.dumps(checkpoint))
        self.assertEqual(history.verify_history_checkpoint(self.manager, self.state, checkpoint), checkpoint)
        changed = {**checkpoint, "historyDigest": "changed"}
        with self.assertRaises(history.HistoryUnavailable):
            history.verify_history_checkpoint(self.manager, self.state, changed)
        self.assertEqual(self.db.reads[:3], [("one", False), ("one", True), ("one", False)])

    def test_unavailable_or_failed_database(self):
        self.manager._db_instance = None
        self.unavailable()
        def failed(sid):
            raise RuntimeError("PRIVATE_HISTORY database secret")
        self.manager._db_instance = self.db
        self.db.get_session = failed
        self.unavailable()

    def test_missing_or_changed_history(self):
        for messages in ([], [{"role": "user", "content": "changed"}], None):
            self.db.messages = messages
            self.unavailable()

    def test_native_repair_is_not_exact_restoration(self):
        self.db.repaired = [{"role": "user", "content": "repaired"}]
        self.unavailable()

    def test_wrong_origin_workspace_model_and_lineage(self):
        original = copy.deepcopy(self.db.row)
        for key, value in (("source", "cli"), ("id", "other"), ("model", "other"), ("model_config", "{}")):
            self.db.row = {**original, key: value}
            self.unavailable()
        self.db.row = original
        self.state.agent.session_id = "rotated-child"
        self.unavailable()
        self.state.agent.session_id = "one"
        self.state.is_running = True
        self.unavailable()
        self.state.is_running = False
        self.state.queued_prompts = ["pending"]
        self.unavailable()

    def test_concurrent_metadata_change(self):
        original = self.db.get_session
        count = 0
        def changing(sid):
            nonlocal count
            count += 1
            return {**original(sid), "revision": count}
        self.db.get_session = changing
        self.unavailable()


if __name__ == "__main__":
    unittest.main()
