"""Read-only proof of an ACP session's exact persisted working conversation."""

import hashlib
import json
from pathlib import Path


class HistoryUnavailable(Exception):
    """Do not include native history, paths, credentials or database errors."""


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > 64 * 1024 * 1024:
        raise HistoryUnavailable()
    return hashlib.sha256(encoded).hexdigest()


def history_checkpoint(manager, state):
    """Compare live history with both raw and native-restorable active rows.

    Calling native load before this check is unsafe: its failure fallback can
    turn unreadable history into an empty working conversation. Compression
    lineage rotation remains unavailable until an exact mapping is implemented.
    """
    try:
        sid = state.session_id
        if (not isinstance(sid, str) or not sid or len(sid) > 512 or "\0" in sid
                or state.agent.session_id != sid or state.is_running
                or state.queued_prompts or not isinstance(state.history, list)):
            raise HistoryUnavailable()
        cwd = str(Path(state.cwd).resolve(strict=True))
        live_digest = _digest(state.history)
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
        persisted = db.get_messages_as_conversation(sid, repair_alternation=False)
        restored = db.get_messages_as_conversation(sid, repair_alternation=True)
        if (not isinstance(persisted, list) or not isinstance(restored, list)
                or _digest(persisted) != live_digest or _digest(restored) != live_digest):
            raise HistoryUnavailable()
        # Refuse a torn metadata/history observation instead of accepting one
        # successful read as proof of a stable persisted session.
        if (_digest(db.get_session(sid)) != _digest(row)
                or _digest(db.get_messages_as_conversation(sid, repair_alternation=False)) != live_digest
                or _digest(state.history) != live_digest):
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
