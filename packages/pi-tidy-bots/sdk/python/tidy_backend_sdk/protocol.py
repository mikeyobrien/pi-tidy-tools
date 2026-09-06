"""Wire validation. No gateway implementation or native runtime imports."""

import hashlib
import json
import math

DEFAULT_LIMITS = {
    "maxFrameBytes": 1024 * 1024,
    "maxUnacknowledgedEvents": 256,
    "maxSpoolBytes": 16 * 1024 * 1024,
    "maxPendingRequests": 256,
    "initializeTimeoutMs": 10000,
    "inspectTimeoutMs": 10000,
    "commandTimeoutMs": 15000,
    "shutdownTimeoutMs": 10000,
}
CORE_METHODS = ["health", "session.open", "session.snapshot", "operation.submit",
                "operation.inspect", "operation.cancel", "interaction.respond",
                "events.ack", "events.replay", "session.close", "shutdown"]
EVENT_TYPES = {"session.state", "operation.disposition", "turn.started", "message.started",
               "text.snapshot", "tool.started", "tool.updated", "tool.finished", "message.finished",
               "interaction.requested", "interaction.resolved", "usage.updated", "turn.terminal", "observation.gap"}
MUTATING = {"session.open", "operation.submit", "operation.cancel", "interaction.respond",
            "operation.steer", "session.compact", "session.configure", "session.import"}


class SDKError(Exception):
    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def identity(value):
    return isinstance(value, str) and bool(value) and len(value) <= 512 and "\0" not in value


def _json_value(value):
    if value is None or type(value) in (bool, str):
        return
    if type(value) is int and abs(value) <= 9007199254740991:
        return
    if type(value) is float and math.isfinite(value):
        return
    if isinstance(value, list):
        for entry in value:
            _json_value(entry)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for entry in value.values():
            _json_value(entry)
        return
    raise SDKError("invalid_payload", "Non-interoperable JSON value")


def canonical(value):
    _json_value(value)
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (ValueError, UnicodeError) as error:
        raise SDKError("invalid_payload") from error


def fingerprint(value):
    return "sha256:" + hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def limits(value=None):
    result = dict(DEFAULT_LIMITS)
    for key, amount in (value or {}).items():
        if key not in result or not integer(amount, 1) or amount > DEFAULT_LIMITS[key]:
            raise SDKError("invalid_config", "Unsupported negotiated limit")
        result[key] = amount
    # Keep room for an explicit reliable gap, even when ordinary output is full.
    if result["maxUnacknowledgedEvents"] < 2 or result["maxFrameBytes"] < 4096 or result["maxSpoolBytes"] < 4096:
        raise SDKError("invalid_config", "Limits cannot reserve an observation-gap slot")
    return result


def parse_frame(raw):
    if not raw.endswith(b"\n"):
        raise SDKError("invalid_frame", "Unterminated frame")
    try:
        def unique(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("duplicate JSON key")
                result[key] = value
            return result
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SDKError("invalid_frame") from error
    try:
        canonical(value).encode("utf-8")
        validate_rpc(value)
    except (SDKError, UnicodeError, RecursionError) as error:
        raise SDKError("invalid_frame") from error
    return value


def validate_rpc(value):
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
        raise SDKError("invalid_frame")
    if "id" in value and not isinstance(value["id"], str):
        raise SDKError("invalid_frame", "RPC IDs are strings")
    if "method" in value:
        if not identity(value["method"]) or "result" in value or "error" in value or ("params" in value and not isinstance(value["params"], dict)):
            raise SDKError("invalid_frame")
    elif "id" not in value or "params" in value or ("result" in value) == ("error" in value):
        raise SDKError("invalid_frame")
    elif "error" in value:
        error = value["error"]
        if not isinstance(error, dict) or type(error.get("code")) is not int or not isinstance(error.get("message"), str):
            raise SDKError("invalid_frame")


def encode_frame(value, maximum):
    validate_rpc(value)
    try:
        frame = (canonical(value) + "\n").encode("utf-8")
    except (UnicodeError, RecursionError) as error:
        raise SDKError("invalid_frame") from error
    if len(frame) > maximum:
        raise SDKError("resource_limit", "Complete encoded frame exceeds its byte budget")
    return frame


def validate_event(event):
    if not isinstance(event, dict) or event.get("type") not in EVENT_TYPES or not isinstance(event.get("payload"), dict):
        raise SDKError("invalid_event")
    if not identity(event.get("eventId")) or not identity(event.get("bindingId")) or not integer(event.get("leaseGeneration"), 1) or not integer(event.get("sourceSequence"), 1):
        raise SDKError("invalid_event")
    for name in ("operationId", "turnId", "messageId", "blockId", "toolCallId", "interactionId"):
        if name in event and not identity(event[name]):
            raise SDKError("invalid_event")
    kind = event["type"]
    if kind not in ("session.state", "observation.gap") and not all(identity(event.get(name)) for name in ("operationId", "turnId")):
        raise SDKError("invalid_event", "Missing turn correlation")
    if (kind.startswith("message.") or kind == "text.snapshot") and not identity(event.get("messageId")):
        raise SDKError("invalid_event")
    if kind == "text.snapshot" and (not identity(event.get("blockId")) or not integer(event["payload"].get("revision")) or not isinstance(event["payload"].get("text"), str)):
        raise SDKError("invalid_event")
    if kind.startswith("tool.") and not identity(event.get("toolCallId")):
        raise SDKError("invalid_event")
    if kind.startswith("interaction.") and not identity(event.get("interactionId")):
        raise SDKError("invalid_event")
    payload = event["payload"]
    if kind == "operation.disposition" and payload.get("disposition") not in ("accepted", "rejected", "unknown"):
        raise SDKError("invalid_event")
    if kind == "message.started" and (payload.get("role") not in ("assistant", "user", "tool", "system") or not integer(payload.get("order"))):
        raise SDKError("invalid_event")
    if kind == "message.finished":
        if not isinstance(payload.get("blocks"), list):
            raise SDKError("invalid_event")
        for block in payload["blocks"]:
            if not isinstance(block, dict) or not identity(block.get("blockId")) or not integer(block.get("revision")):
                raise SDKError("invalid_event")
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                continue
            if block.get("type") == "artifact" and identity(block.get("artifactId")) and identity(block.get("mediaType")):
                continue
            raise SDKError("invalid_event")
    if kind == "turn.terminal" and (payload.get("execution") not in ("ended", "failed", "cancelled", "interrupted") or payload.get("observation") not in ("complete", "live_gap", "reconciliation_required")):
        raise SDKError("invalid_event")


def validate_capabilities(value):
    fields = {
        "input": {"text", "mediaTypes", "maxMediaBytes"},
        "sessions": {"load", "import", "continuity"},
        "output": {"text", "tools", "usage"},
        "operations": {"nativeDedupe", "nativeDedupeRetentionMs", "nativeReplay", "nativeReplayRetentionMs", "nativeReplayGapSemantics", "cancel", "steer"},
        "interactions": {"permissions", "questions"},
        "configuration": {"model", "thinking", "compact"},
    }
    if not isinstance(value, dict):
        raise SDKError("invalid_capabilities")
    for section, names in fields.items():
        if not isinstance(value.get(section), dict):
            raise SDKError("invalid_capabilities")
        for key, child in value[section].items():
            if key not in names and ("." not in key or isinstance(child, dict) and child.get("required") is True):
                raise SDKError("invalid_capabilities")
    for key, child in value.items():
        if key not in fields and key != "fleetTools" and ("." not in key or isinstance(child, dict) and child.get("required") is True):
            raise SDKError("invalid_capabilities")
    inp = value["input"]
    if inp.get("text") is not True or not isinstance(inp.get("mediaTypes"), list) or not all(identity(v) for v in inp["mediaTypes"]) or not integer(inp.get("maxMediaBytes")):
        raise SDKError("invalid_capabilities")
    for section, names in {"sessions": ["load", "import"], "output": ["tools"], "operations": ["steer"], "interactions": ["questions"], "configuration": ["model", "thinking", "compact"]}.items():
        if any(type(value[section].get(name)) is not bool for name in names):
            raise SDKError("invalid_capabilities")
    if type(value.get("fleetTools")) is not bool:
        raise SDKError("invalid_capabilities")
    for section, name, allowed in [
        ("sessions", "continuity", ["verified", "unverified"]), ("output", "text", ["final-only", "snapshots"]),
        ("output", "usage", ["reported", "estimated", "unknown"]), ("operations", "nativeDedupe", ["durable", "none"]),
        ("operations", "nativeReplay", ["cursor", "none"]), ("operations", "cancel", ["cooperative", "process-termination", "unsupported"]),
        ("interactions", "permissions", ["exact-request", "none"]),
    ]:
        if value[section].get(name) not in allowed:
            raise SDKError("invalid_capabilities")
    ops = value["operations"]
    if ops["nativeDedupe"] == "durable" and not integer(ops.get("nativeDedupeRetentionMs"), 1):
        raise SDKError("invalid_capabilities")
    if ops["nativeReplay"] == "cursor" and (not integer(ops.get("nativeReplayRetentionMs"), 1) or ops.get("nativeReplayGapSemantics") != "explicit-gap"):
        raise SDKError("invalid_capabilities")
    if (value["sessions"]["load"] or value["sessions"]["import"]) and value["sessions"]["continuity"] != "verified":
        raise SDKError("invalid_capabilities")
    return value
