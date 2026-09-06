#!/usr/bin/env python3
"""Installed external backend fixture. No TypeScript or gateway source imports."""
import asyncio
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "sdk"))
from tidy_backend_sdk import run_plugin

mode = "normal"
owned = None
attached_pid = None


def record(ctx, kind, **values):
    path = Path(ctx.initialization["dataDir"]) / "native-calls.jsonl"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"kind": kind, **values}) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


async def initialize(config, ctx):
    global mode, attached_pid
    mode = config.get("mode", "normal")
    if mode == "attached":
        ctx.ownership = "attached"
        attached_pid = config["externalPid"]
    record(ctx, "initialized")


async def opened(p, ctx):
    global owned
    record(ctx, "open", openId=p["openId"])
    if mode == "crash-open":
        os._exit(17)
    if mode == "owned":
        owned = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(600)")
        record(ctx, "owned", pid=owned.pid)
    return {"status": "opened", "nativeReference": "python:" + p["openId"]}


async def submit(p, ctx):
    record(ctx, "submit", operationId=p["operationId"], text=p["input"][0]["text"])
    if mode == "crash-submit":
        os._exit(18)
    if mode == "timeout":
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            record(ctx, "handler_cancelled", operationId=p["operationId"])
            raise
    if mode == "reverse":
        await ctx.host_call("operator.enqueue", {"title": p["input"][0]["text"]}, operation_id=p["operationId"], tool_call_id="tool-1", action_id="action-1", payload_digest="sha256:reverse")
    ids = {"operationId": p["operationId"], "turnId": p["turnId"]}
    await ctx.emit({**ids, "type": "turn.started", "payload": {}})
    message = {**ids, "messageId": "message:" + p["operationId"]}
    await ctx.emit({**message, "type": "message.started", "payload": {"role": "assistant", "order": 0}})
    text = "Python: " + p["input"][0]["text"]
    await ctx.emit({**message, "blockId": "body", "type": "text.snapshot", "payload": {"revision": 1, "text": text}})
    await ctx.emit({**message, "type": "message.finished", "payload": {"ts": "2026-09-05T12:00:00.000Z", "blocks": [{"type": "text", "blockId": "body", "revision": 1, "text": text}]}})
    await ctx.emit({**ids, "type": "turn.terminal", "payload": {"execution": "ended", "observation": "complete"}})
    return {"disposition": "accepted"}


async def cancelled(p, ctx):
    record(ctx, "cancel", operationId=p["operationId"], targetOperationId=p["targetOperationId"])
    return {"status": "requested"}


async def respond(p, ctx):
    record(ctx, "decision", operationId=p["operationId"], optionId=p["optionId"])
    return {"status": "applied"}


async def snapshot(p, ctx):
    return {"sourceSequence": ctx.store.sequence, "nativeOutcome": "unknown"}


async def closed(p, ctx):
    if attached_pid is not None:
        # Fixture deliberately makes the lifecycle contract observable against
        # a process started by the test outside the plugin ownership tree.
        if p["stopOwned"]:
            os.kill(attached_pid, 15)
        record(ctx, "attached_closed", stopOwned=p["stopOwned"], pid=attached_pid)
        return {"ownedStopped": True}
    if owned is not None and p["stopOwned"]:
        if owned.returncode is None:
            owned.terminate()
        await owned.wait()
        record(ctx, "reaped", pid=owned.pid)
        return {"ownedStopped": True}
    if ctx.initialization:
        record(ctx, "closed", stopOwned=p["stopOwned"], mode=p["mode"], ownership=p["ownership"])
    return {"ownedStopped": False}


run_plugin(
    identity={"id": "org.example.python", "version": "1.0.0"},
    runtime={"name": "independent-python", "version": "1.0.0", "transport": "stdio"},
    capabilities={
        "input": {"text": True, "mediaTypes": [], "maxMediaBytes": 0},
        "sessions": {"load": False, "import": False, "continuity": "unverified"},
        "output": {"text": "snapshots", "tools": False, "usage": "unknown"},
        "operations": {"nativeDedupe": "none", "nativeReplay": "none", "cancel": "cooperative", "steer": False},
        "interactions": {"permissions": "exact-request", "questions": False},
        "configuration": {"model": False, "thinking": False, "compact": False}, "fleetTools": False,
    },
    handlers={"session.open": opened, "operation.submit": submit, "operation.cancel": cancelled,
              "interaction.respond": respond, "session.snapshot": snapshot},
    on_initialize=initialize, on_close=closed,
)
