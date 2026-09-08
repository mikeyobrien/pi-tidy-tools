"""Read-only proof of an ACP session's exact persisted working conversation."""

import hashlib
import json
import os
import stat
from pathlib import Path
from uuid import uuid4
from types import SimpleNamespace


class HistoryUnavailable(Exception):
    """Do not include native history, paths, credentials or database errors."""


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > 64 * 1024 * 1024:
        raise HistoryUnavailable()
    return hashlib.sha256(encoded).hexdigest()


# get_session() flushes queued usage deltas before reading the row. These are
# accounting observations, not native restoration inputs. Keep every other
# field (including unknown fields, lineage and runtime billing fallbacks) in
# the stability proof so a schema change fails closed by default.
_ACCOUNTING_ROW_FIELDS = frozenset((
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "api_call_count", "estimated_cost_usd", "actual_cost_usd",
    "cost_status", "cost_source", "pricing_version",
))
# Pinned Hermes 0.20.5 SessionDB stamps load-time bookkeeping onto every
# decoded message (_db_persisted, _row_id, timestamp). Live ACP history after
# a turn is result["messages"] without those keys. Treating them as
# conversation identity left every first-turn checkpoint unavailable, so
# reload failed as session_open:native_startup_history / continuity_unverified.
#
# Live build_assistant_message always stamps reasoning=None. SessionDB
# _rows_to_conversation omits falsy optional fields, so the same turn
# projected from state.db has no reasoning key. None vs omit is not
# conversation identity.
_PERSISTENCE_BOOKKEEPING_KEYS = frozenset((
    "_db_persisted", "_row_id", "_compressed_summary", "timestamp",
))


def _stable_session_row(row):
    if not isinstance(row, dict):
        raise HistoryUnavailable()
    return {key: value for key, value in row.items() if key not in _ACCOUNTING_ROW_FIELDS}


def _conversation_identity(messages):
    if not isinstance(messages, list):
        raise HistoryUnavailable()
    identity = []
    for message in messages:
        if not isinstance(message, dict):
            raise HistoryUnavailable()
        identity.append({
            key: value for key, value in message.items()
            if key not in _PERSISTENCE_BOOKKEEPING_KEYS
            and not (isinstance(key, str) and key.startswith("_"))
            and value is not None
        })
    return identity


def history_checkpoint(manager, state):
    """Compare live history with both raw and native-restorable active rows.

    Calling native load before this check is unsafe: its failure fallback can
    turn unreadable history into an empty working conversation. Compression
    lineage rotation remains unavailable until an exact mapping is implemented.
    """
    try:
        sid = state.session_id
        if (not isinstance(sid, str) or not sid or len(sid) > 512 or "\0" in sid
                or state.agent.session_id != sid or state.agent.model != state.model or state.is_running
                or state.queued_prompts or not isinstance(state.history, list)):
            raise HistoryUnavailable()
        cwd = str(Path(state.cwd).resolve(strict=True))
        live_digest = _digest(_conversation_identity(state.history))
        # Do not call the lazy getter: it can create a database while proving
        # persistence. Only inspect the instance native saving already opened.
        db = getattr(manager, "_db_instance", None)
        if db is None:
            raise HistoryUnavailable()
        row = db.get_session(sid)
        if not isinstance(row, dict) or row.get("id") != sid or row.get("source") != "acp":
            raise HistoryUnavailable()
        metadata = json.loads(row["model_config"])
        if (not isinstance(metadata, dict) or not isinstance(metadata.get("cwd"), str)
                or str(Path(metadata["cwd"]).resolve(strict=True)) != cwd
                or (row.get("model") or "") != state.model):
            raise HistoryUnavailable()
        for field in ("provider", "base_url", "api_mode"):
            if field in metadata:
                effective = getattr(state.agent, field, None)
                if not isinstance(effective, str) or effective.strip() != metadata[field]:
                    raise HistoryUnavailable()
        persisted = db.get_messages_as_conversation(sid, repair_alternation=False)
        restored = db.get_messages_as_conversation(sid, repair_alternation=True)
        if (not isinstance(persisted, list) or not isinstance(restored, list)
                or _digest(_conversation_identity(persisted)) != live_digest
                or _digest(_conversation_identity(restored)) != live_digest):
            raise HistoryUnavailable()
        # Refuse a torn metadata/history observation instead of accepting one
        # successful read as proof of a stable persisted session.
        if (_digest(_stable_session_row(db.get_session(sid))) != _digest(_stable_session_row(row))
                or _digest(_conversation_identity(
                    db.get_messages_as_conversation(sid, repair_alternation=False))) != live_digest
                or _digest(_conversation_identity(state.history)) != live_digest):
            raise HistoryUnavailable()
        return {"version": 1, "sessionId": sid, "messageCount": len(persisted),
                "historyDigest": live_digest, "metadataDigest": _digest(metadata),
                "modelDigest": _digest(state.model), "cwdDigest": _digest(cwd)}
    except Exception:
        raise HistoryUnavailable() from None


def verify_history_checkpoint(manager, state, expected):
    """A retained checkpoint must match before and after native restoration."""
    actual = history_checkpoint(manager, state)
    if actual != expected:
        raise HistoryUnavailable()
    return actual


def prepare_history_load(manager, sid, cwd, expected, database_path):
    """Prove persisted input before native restore can construct an agent or repair history."""
    try:
        path = Path(database_path)
        if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
            raise HistoryUnavailable()
        if getattr(manager, "_db_instance", None) is None:
            manager._get_db()
        db = getattr(manager, "_db_instance", None)
        if db is None or expected.get("sessionId") != sid:
            raise HistoryUnavailable()
        row = db.get_session(sid)
        if not isinstance(row, dict):
            raise HistoryUnavailable()
        metadata = json.loads(row["model_config"])
        native = SimpleNamespace(session_id=sid, model=row.get("model") or "",
                                 **{field: metadata[field] for field in ("provider", "base_url", "api_mode") if field in metadata})
        state = SimpleNamespace(session_id=sid, agent=native,
                                cwd=cwd, model=row.get("model") or "", is_running=False, queued_prompts=[],
                                history=db.get_messages_as_conversation(sid, repair_alternation=False))
        return verify_history_checkpoint(manager, state, expected)
    except Exception:
        raise HistoryUnavailable() from None


class HistoryStore:
    """Private binding-scoped checkpoint files, atomically published and invalidated."""

    def __init__(self, directory, binding_id):
        if not isinstance(binding_id, str) or not binding_id or len(binding_id) > 512 or "\0" in binding_id:
            raise HistoryUnavailable()
        self.binding_id = binding_id
        try:
            self.fd = os.open(str(Path(directory).resolve(strict=True)), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except Exception:
            raise HistoryUnavailable() from None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def _name(self, sid):
        if not isinstance(sid, str) or not sid or len(sid) > 512 or "\0" in sid or self.fd is None:
            raise HistoryUnavailable()
        return "hermes-history-" + _digest([self.binding_id, sid]) + ".json"

    def invalidate(self, sid):
        try:
            name = self._name(sid)
            try:
                os.unlink(name, dir_fd=self.fd)
            except FileNotFoundError:
                pass
            os.fsync(self.fd)
        except Exception:
            raise HistoryUnavailable() from None

    def save(self, checkpoint):
        temporary = ".hermes-history-" + str(uuid4()) + ".tmp"
        try:
            sid = checkpoint["sessionId"]
            name = self._name(sid)
            encoded = json.dumps({"version": 1, "bindingId": self.binding_id, "checkpoint": checkpoint},
                                 allow_nan=False, sort_keys=True).encode("utf-8")
            if len(encoded) > 16384:
                raise HistoryUnavailable()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        except Exception:
            raise HistoryUnavailable() from None
        finally:
            if self.fd is not None:
                try:
                    os.unlink(temporary, dir_fd=self.fd)
                except FileNotFoundError:
                    pass

    def load(self, sid):
        try:
            fd = os.open(self._name(sid), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= 16384:
                    raise HistoryUnavailable()
                encoded = stream.read(16385)
            if len(encoded) != info.st_size:
                raise HistoryUnavailable()
            record = json.loads(encoded)
            checkpoint = record["checkpoint"]
            if (record.get("version") != 1 or record.get("bindingId") != self.binding_id
                    or not isinstance(checkpoint, dict) or checkpoint.get("version") != 1
                    or checkpoint.get("sessionId") != sid
                    or type(checkpoint.get("messageCount")) is not int or checkpoint["messageCount"] < 0
                    or set(checkpoint) != {"version", "sessionId", "messageCount", "historyDigest", "metadataDigest", "modelDigest", "cwdDigest"}
                    or any(not isinstance(checkpoint[key], str) or len(checkpoint[key]) != 64
                           or any(char not in "0123456789abcdef" for char in checkpoint[key])
                           for key in ("historyDigest", "metadataDigest", "modelDigest", "cwdDigest"))):
                raise HistoryUnavailable()
            return checkpoint
        except Exception:
            raise HistoryUnavailable() from None
