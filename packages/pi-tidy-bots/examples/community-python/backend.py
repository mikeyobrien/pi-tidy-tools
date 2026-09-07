#!/usr/bin/env python3
"""Installed external backend fixture. No TypeScript or gateway source imports."""
import asyncio
import json
import os
import select
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent / "sdk"))
from tidy_backend_sdk import run_plugin

mode = "normal"
owned = None
launch_id = None
control_fd = None
attached_pid = None
pending_submits = {}


def record(ctx, kind, **values):
    path = Path(ctx.initialization["dataDir"]) / "native-calls.jsonl"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"kind": kind, **values}) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_raw_frame(payload):
    """Write adversarial transport bytes without SDK framing/validation."""
    view = memoryview(payload)
    fd = sys.stdout.fileno()
    while view:
        try:
            written = os.write(fd, view)
            view = view[written:]
        except BlockingIOError:
            select.select([], [fd], [], 1.0)
    sys.stdout.flush()


async def initialize(config, ctx):
    global mode, attached_pid
    mode = config.get("mode", "normal")
    if mode == "attached":
        ctx.ownership = "attached"
        attached_pid = config["externalPid"]
    record(ctx, "initialized")


async def opened(p, ctx):
    global owned, launch_id, control_fd
    record(ctx, "open", openId=p["openId"])
    if mode == "crash-open":
        os._exit(17)
    if mode == "owned":
        owned = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(600)")
        record(ctx, "owned", pid=owned.pid)
    if mode == "registered-owned":
        launch_id = "tidy-launch-" + str(uuid4())
        prepared = await ctx.owned_process("prepare", {"launchId": launch_id})
        if prepared.get("launcherProtocol") != 2:
            raise ValueError("Unsupported launcher protocol")
        read_fd, control_fd = os.pipe()
        effect = str(Path(ctx.initialization["dataDir"]) / "child-effect")
        try:
            owned = await asyncio.create_subprocess_exec(
                prepared["executable"], prepared["launcherPath"], launch_id, "--control-fd=" + str(read_fd),
                sys.executable, "-I", "-c", "from pathlib import Path;import time;Path(" + repr(effect) + ").write_text('started');time.sleep(600)",
                env={}, pass_fds=(read_fd,), start_new_session=True,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            admitted = await ctx.owned_process("record", {"launchId": launch_id, "pid": owned.pid})
            if admitted.get("state") != "started" or admitted.get("identity", {}).get("pid") != owned.pid:
                raise ValueError("Missing ownership receipt")
            os.write(control_fd, (json.dumps({"activate": launch_id, "env": {}}) + "\n").encode())
            record(ctx, "registered", launchId=launch_id, pid=owned.pid)
        finally:
            os.close(read_fd)
    return {"status": "opened", "nativeReference": "python:" + p["openId"]}


async def submit(p, ctx):
    global pending_submits
    record(ctx, "submit", operationId=p["operationId"], text=p["input"][0]["text"])
    if mode == "crash-submit":
        os._exit(18)
    if mode == "marker-crash":
        record(ctx, "malformed", mode=mode, operationId=p["operationId"])
        os._exit(19)
    if mode in ("cancel-ack", "cancel-delayed", "cancel-lost"):
        pending_submits[p["operationId"]] = {"params": p, "cancelled": asyncio.Event()}
        try:
            await ctx.emit({"operationId": p["operationId"], "turnId": p["turnId"], "type": "turn.started", "payload": {}})
            await pending_submits[p["operationId"]]["cancelled"].wait()
        finally:
            pending_submits.pop(p["operationId"], None)
        return {"disposition": "accepted"}
    if mode in ("malformed-json", "malformed-event", "oversize", "nonfinite"):
        record(ctx, "malformed", mode=mode, operationId=p["operationId"])
        if mode == "malformed-json":
            raw = b'{"jsonrpc":"2.0","method":"event","params":\n'
        elif mode == "malformed-event":
            raw = (json.dumps({"jsonrpc": "2.0", "method": "event", "params": {
                "type": "not-a-protocol-event", "payload": {}}}) + "\n").encode()
        elif mode == "nonfinite":
            raw = b'{"jsonrpc":"2.0","method":"event","params":{"type":"turn.started","payload":{"value":NaN}}}\n'
        else:
            raw = (b'{"jsonrpc":"2.0","method":"event","params":{"type":"turn.started","payload":{"padding":"' +
                   (b"x" * (2 * 1024 * 1024)) + b'"}}}\n')
        write_raw_frame(raw)
        # Exercise the host's post-fault isolation path; this must not become
        # a successful canonical completion if the host has closed the pipe.
        await ctx.emit({"operationId": p["operationId"], "turnId": p["turnId"], "type": "turn.started", "payload": {}})
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
    global pending_submits
    record(ctx, "cancel", operationId=p["operationId"], targetOperationId=p["targetOperationId"])
    target = pending_submits.get(p["targetOperationId"])
    if mode == "cancel-lost":
        os._exit(20)
    if mode == "cancel-ack" and target is not None:
        ids = {"operationId": target["params"]["operationId"], "turnId": target["params"]["turnId"]}
        await ctx.emit({**ids, "type": "turn.terminal", "payload": {"execution": "cancelled", "observation": "complete"}})
        target["cancelled"].set()
    return {"status": "requested"}


async def respond(p, ctx):
    record(ctx, "decision", operationId=p["operationId"], optionId=p["optionId"])
    return {"status": "applied"}


async def snapshot(p, ctx):
    return {"sourceSequence": ctx.store.sequence, "nativeOutcome": "unknown"}


async def closed(p, ctx):
    global control_fd
    if launch_id is not None:
        if control_fd is not None:
            os.close(control_fd)
            control_fd = None
        if owned is not None:
            await owned.wait()
        for method in ("prepare", "record"):
            try:
                await ctx.owned_process(method, {"launchId": launch_id})
                raise ValueError("Cleanup admitted native launch")
            except Exception as error:
                if getattr(error, "code", None) != "plugin_closed":
                    raise
                record(ctx, "cleanup_denied", method=method)
        inspected = await ctx.owned_process("inspect", {"launchId": launch_id})
        stopped = await ctx.owned_process("stopped", {"launchId": launch_id})
        if stopped.get("state") != "stopped":
            raise ValueError("Cleanup lacks ownership proof")
        record(ctx, "cleanup_confirmed", inspected=inspected["launchId"], stopped=stopped["launchId"])
        return {"ownedStopped": True}
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
    identity={"id": "org.example.tidy-community-python", "version": "1.0.0"},
    runtime={"name": "community-python-example", "version": "1.0.0", "transport": "stdio"},
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
