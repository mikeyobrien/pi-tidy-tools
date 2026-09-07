"""Scoped, bounded artifact reads for Python backend plugins."""

import base64
import binascii
import hashlib
import uuid

from .protocol import SDKError, identity, integer


_FIELDS = ("type", "artifactId", "name", "mediaType", "sha256", "size")
_MAX_BYTES = 16 * 1024 * 1024


def _invalid_reference():
    raise SDKError("invalid_payload", "Invalid or oversized artifact reference")


async def read_artifact(context, operation_id, descriptor, max_bytes):
    """Read one admitted artifact through scoped ``artifact.read`` host calls.

    The caller supplies metadata only; each response must repeat it exactly.
    Paths and caller-selected storage locations are intentionally absent.
    """
    if (
        not identity(operation_id)
        or not isinstance(descriptor, dict)
        or set(descriptor) != set(_FIELDS)
        or descriptor.get("type") != "artifact"
        or not all(identity(descriptor.get(key)) for key in ("artifactId", "name", "mediaType"))
        or not isinstance(descriptor.get("sha256"), str)
        or len(descriptor["sha256"]) != 71
        or not descriptor["sha256"].startswith("sha256:")
        or any(char not in "0123456789abcdef" for char in descriptor["sha256"][7:])
        or not integer(max_bytes, 1)
        or max_bytes > _MAX_BYTES
        or not integer(descriptor.get("size"), 1)
        or descriptor["size"] > max_bytes
    ):
        _invalid_reference()
    try:
        frame_bytes = context.initialization["limits"]["maxFrameBytes"]
    except (AttributeError, KeyError, TypeError):
        raise SDKError("invalid_config", "Artifact transport limits are unavailable") from None
    if not integer(frame_bytes, 1):
        raise SDKError("invalid_config", "Artifact frame limit is invalid")
    chunk_size = min(65536, frame_bytes // 8)
    if chunk_size < 256:
        raise SDKError("resource_limit", "Artifact transport budget is too small")

    chunks = []
    offset = 0
    while offset < descriptor["size"]:
        limit = min(chunk_size, descriptor["size"] - offset)
        result = await context.host_call(
            "artifact.read",
            {"artifactId": descriptor["artifactId"], "offset": offset, "limit": limit},
            operation_id=operation_id,
            call_id=str(uuid.uuid4()),
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("artifact"), dict)
            or set(result["artifact"]) != set(_FIELDS)
            or any(result["artifact"].get(key) != descriptor[key] for key in _FIELDS)
            or not isinstance(result.get("data"), str)
            or len(result["data"]) > ((limit + 2) // 3) * 4
        ):
            raise SDKError("invalid_artifact", "Artifact response differs from admitted metadata")
        try:
            encoded = result["data"].encode("ascii")
            chunk = base64.b64decode(encoded, validate=True)
        except (UnicodeEncodeError, ValueError, binascii.Error):
            raise SDKError("invalid_artifact", "Artifact response has invalid bytes") from None
        expected_offset = offset + limit if offset + limit < descriptor["size"] else None
        if (
            len(chunk) != limit
            or base64.b64encode(chunk).decode("ascii") != result["data"]
            or result.get("nextOffset") != expected_offset
        ):
            raise SDKError("invalid_artifact", "Artifact response has an invalid range")
        chunks.append(chunk)
        offset += limit
    data = b"".join(chunks)
    if "sha256:" + hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
        raise SDKError("invalid_artifact", "Artifact bytes differ from their admitted digest")
    return data
