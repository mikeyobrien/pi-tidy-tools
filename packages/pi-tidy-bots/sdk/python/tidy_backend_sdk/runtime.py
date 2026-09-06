"""Async, bounded stdio runtime for independently installed Python backends."""

import asyncio
import inspect
import os
from pathlib import Path
import sys

from .protocol import (CORE_METHODS, DEFAULT_LIMITS, MUTATING, SDKError, encode_frame,
                       identity, integer, limits, parse_frame, validate_capabilities)
from .store import DurableStore


async def _call(function, *args):
    value = function(*args)
    return await value if inspect.isawaitable(value) else value


class PluginRuntime:
    def __init__(self, *, identity, runtime, capabilities, handlers, on_initialize=None,
                 on_close=None, on_gap=None, ownership="owned"):
        if ownership not in ("owned", "attached"):
            raise SDKError("invalid_config")
        self.identity = dict(identity)
        self.runtime = dict(runtime)
        self.capabilities = validate_capabilities(capabilities)
        self.handlers = dict(handlers)
        if any(not inspect.iscoroutinefunction(handler) for handler in self.handlers.values()) or any(hook is not None and not inspect.iscoroutinefunction(hook) for hook in (on_initialize, on_close, on_gap)):
            raise SDKError("invalid_config", "Handlers and lifecycle hooks must be async")
        self.on_initialize, self.on_close, self.on_gap = on_initialize, on_close, on_gap
        self.ownership = ownership
        self.initialization = None
        self.store = None
        self.limits = limits()
        self.state = "starting"
        self._requests = set()
        self._handlers = set()
        self._rpc_ids = set()
        self._reverse = {}
        self._counter = 0
        self._output_bytes = 0
        self._write_lock = asyncio.Lock()
        self._credits = asyncio.Event()
        self._closing = asyncio.Event()
        self._cleanup_task = None
        self._shutdown_deadline = None
        self._cleanup_ownership_open = False

    async def _write(self, value):
        frame = encode_frame(value, self.limits["maxFrameBytes"])
        if self._output_bytes + len(frame) > 2 * self.limits["maxFrameBytes"]:
            raise SDKError("resource_limit", "Host output pipe is backpressured")
        self._output_bytes += len(frame)
        try:
            async with self._write_lock:
                view = memoryview(frame)
                while view:
                    try:
                        written = os.write(sys.stdout.fileno(), view)
                        if written <= 0:
                            raise BrokenPipeError()
                        view = view[written:]
                    except BlockingIOError:
                        loop = asyncio.get_running_loop()
                        ready = loop.create_future()
                        fd = sys.stdout.fileno()
                        loop.add_writer(fd, lambda: None if ready.done() else ready.set_result(None))
                        try:
                            await asyncio.wait_for(ready, self.limits["inspectTimeoutMs"] / 1000)
                        finally:
                            loop.remove_writer(fd)
        except (BrokenPipeError, OSError, asyncio.TimeoutError) as error:
            self._cleanup_ownership_open = False
            self.state = "closing"
            self._closing.set()
            raise SDKError("host_eof") from error
        finally:
            self._output_bytes -= len(frame)

    async def _response(self, request, result=None, error=None):
        if "id" not in request:
            return
        if error:
            code = error.code if isinstance(error, SDKError) else "native_failure"
            # Diagnostics are stable safe codes; native exception strings may
            # contain credentials, paths, model context or untrusted output.
            value = {"jsonrpc": "2.0", "id": request["id"], "error": {
                "code": -32601 if code == "method_not_found" else -32000,
                "message": code, "data": {"code": code}}}
        else:
            value = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        await self._write(value)

    def _binding(self, params):
        if params.get("bindingId") != self.initialization["bindingId"] or params.get("leaseGeneration") != self.initialization["leaseGeneration"]:
            raise SDKError("stale_binding")

    def _capability(self, method, params):
        c = self.capabilities
        permitted = {
            "operation.cancel": c["operations"]["cancel"] != "unsupported",
            "interaction.respond": c["interactions"]["permissions"] != "none" or c["interactions"]["questions"],
            "operation.steer": c["operations"]["steer"],
            "session.compact": c["configuration"]["compact"],
            "session.configure": c["configuration"]["model"] or c["configuration"]["thinking"],
            "session.import": c["sessions"]["import"],
        }
        if method in permitted and not permitted[method]:
            raise SDKError("capability_unavailable")
        if method == "session.open":
            if not all(identity(params.get(key)) for key in ("operationId", "conversationId", "cwd", "policyRevision")) or not Path(params["cwd"]).is_absolute():
                raise SDKError("invalid_payload")
            if params.get("mode") not in ("new", "load"):
                raise SDKError("invalid_payload")
            if params["mode"] == "load" and not c["sessions"]["load"]:
                raise SDKError("continuity_unverified")
            if params["mode"] == "load" and not identity(params.get("nativeReference")):
                raise SDKError("session_not_found")
        if method in ("operation.cancel", "interaction.respond"):
            if not identity(params.get("targetOperationId")) or params.get("operationId") == params["targetOperationId"]:
                raise SDKError("invalid_payload", "A control has a distinct immutable identity")
        if method == "interaction.respond" and not all(identity(params.get(key)) for key in ("instanceId", "interactionId", "optionId")):
            raise SDKError("invalid_payload")
        if method == "operation.submit":
            if not all(identity(params.get(key)) for key in ("conversationId", "turnId", "policyRevision")) or not isinstance(params.get("input"), list) or not params["input"]:
                raise SDKError("invalid_payload")
            for part in params["input"]:
                if not isinstance(part, dict):
                    raise SDKError("invalid_payload")
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    continue
                if part.get("type") == "artifact" and identity(part.get("artifactId")) and part.get("mediaType") in c["input"]["mediaTypes"]:
                    continue
                raise SDKError("capability_unavailable")

    async def _deadline(self, handler, params, timeout):
        task = asyncio.create_task(_call(handler, params, self))
        self._handlers.add(task)
        task.add_done_callback(self._handlers.discard)
        done, _ = await asyncio.wait({task}, timeout=timeout / 1000)
        if not done:
            task.cancel()
            # Do not wait indefinitely for a native wrapper that ignores task
            # cancellation. Its durable reservation remains unknown and EOF
            # cleanup still receives the owned-resource hook.
            task.add_done_callback(lambda value: None if value.cancelled() else value.exception())
            raise SDKError("request_timeout")
        return task.result()

    async def _initialize(self, request):
        p = request.get("params", {})
        version = p.get("protocol", {})
        expected = p.get("expectedPlugin", {})
        if self.state != "starting" or not isinstance(version, dict) or version.get("major") != 1 or not integer(version.get("minMinor")) or not integer(version.get("maxMinor")) or not (version["minMinor"] <= 0 <= version["maxMinor"]):
            raise SDKError("initialize_failed")
        if not isinstance(expected, dict) or expected.get("id") != self.identity.get("id") or expected.get("version") != self.identity.get("version"):
            raise SDKError("initialize_failed")
        if not all(identity(p.get(key)) for key in ("bindingId", "instanceId", "workspace", "dataDir")) or not integer(p.get("leaseGeneration"), 1) or not isinstance(p.get("config"), dict):
            raise SDKError("initialize_failed")
        for key, env in (("bindingId", "TIDY_BINDING_ID"), ("instanceId", "TIDY_INSTANCE_ID"), ("leaseGeneration", "TIDY_LEASE_GENERATION"), ("workspace", "TIDY_WORKSPACE"), ("dataDir", "TIDY_DATA_DIR")):
            if env in os.environ and str(p[key]) != os.environ[env]:
                raise SDKError("stale_binding")
        if not Path(p["dataDir"]).is_absolute() or not Path(p["workspace"]).is_absolute():
            raise SDKError("invalid_config")
        self.state = "initializing"
        self.limits = limits(p.get("limits", {}))
        self.initialization = p
        self.store = DurableStore(p["dataDir"], self.identity["id"], p["bindingId"], p["leaseGeneration"], self.limits)
        if self.on_initialize:
            await self._deadline(self.on_initialize, p["config"], self.limits["initializeTimeoutMs"])
        self.state = "ready"
        await self._response(request, {
            "protocol": {"major": 1, "minor": 0}, "plugin": self.identity,
            "runtime": self.runtime, "methods": CORE_METHODS + sorted(set(self.handlers) - set(CORE_METHODS)),
            "capabilities": self.capabilities, "health": "degraded" if self.store.observation_lost else "ready"})

    async def emit(self, event, *, can_pause=True):
        if self.state != "ready":
            raise SDKError("plugin_closed")
        while True:
            self._credits.clear()
            try:
                frame = self.store.append(event)
            except SDKError as error:
                if error.code != "resource_limit":
                    raise
                if not can_pause:
                    await self.observation_gap("native_producer_cannot_pause")
                    raise SDKError("observation_gap") from error
                try:
                    await asyncio.wait_for(self._credits.wait(), self.limits["inspectTimeoutMs"] / 1000)
                except asyncio.TimeoutError as timeout:
                    await self.observation_gap("event_backpressure_timeout")
                    raise SDKError("observation_gap") from timeout
                if self.state != "ready":
                    raise SDKError("plugin_closed")
                continue
            # Never append again after a committed frame encounters a pipe
            # failure. Its original sequence/identity remains replayable.
            self.store.mark_sent(frame["sourceSequence"])
            await self._write({"jsonrpc": "2.0", "method": "event", "params": frame})
            return frame

    async def observation_gap(self, reason="native_observation_lost"):
        # Do not echo arbitrary/native diagnostics in the wire gap reason.
        safe = reason if reason in {"native_observation_lost", "native_producer_cannot_pause", "event_backpressure_timeout"} else "native_observation_lost"
        event = self.store.mark_gap(safe)
        self.store.mark_sent(event["sourceSequence"])
        await self._write({"jsonrpc": "2.0", "method": "event", "params": event})
        if self.on_gap:
            await self._deadline(self.on_gap, {"reason": safe}, self.limits["shutdownTimeoutMs"])

    async def owned_process(self, method, params):
        """Lifecycle metadata only; record must return started before activation.

        Persist the launch ID before spawn. A lost response requires inspection,
        never an assumption that native execution was authorized.
        """
        cleanup = self.state == "closing" and self._cleanup_ownership_open and method in ("inspect", "stopped")
        if (self.state != "ready" and not cleanup) or self.initialization is None:
            raise SDKError("plugin_closed")
        service = "ownership." + str(method)
        services = self.initialization.get("ownershipServices", [])
        if method not in ("prepare", "record", "inspect", "stopped") or not isinstance(services, list) or service not in services:
            raise SDKError("capability_unavailable")
        if not isinstance(params, dict):
            raise SDKError("invalid_request")
        if len(self._reverse) >= self.limits["maxPendingRequests"]:
            raise SDKError("resource_limit")
        self._counter += 1
        rpc_id = self.initialization["instanceId"] + ":ownership:" + str(self._counter)
        future = asyncio.get_running_loop().create_future()
        self._reverse[rpc_id] = future
        try:
            await self._write({"jsonrpc": "2.0", "id": rpc_id, "method": service, "params": {
                **params, "bindingId": self.initialization["bindingId"],
                "leaseGeneration": self.initialization["leaseGeneration"],
            }})
            return await asyncio.wait_for(future, self.limits["commandTimeoutMs"] / 1000)
        except asyncio.TimeoutError:
            raise SDKError("request_timeout", "Child ownership requires inspection; do not activate") from None
        finally:
            self._reverse.pop(rpc_id, None)

    async def host_call(self, name, arguments, *, operation_id=None, tool_call_id=None,
                        action_id=None, payload_digest=None, call_id=None):
        if self.state != "ready":
            raise SDKError("plugin_closed")
        if name not in ("fleet.discover", "fleet.send", "operator.enqueue", "artifact.read"):
            raise SDKError("capability_unavailable")
        if name.startswith("fleet.") and not self.capabilities["fleetTools"]:
            raise SDKError("capability_unavailable")
        mutating = name in ("fleet.send", "operator.enqueue")
        p = {"name": name, "arguments": arguments, "callId": call_id or action_id or "call-" + str(self._counter),
             "bindingId": self.initialization["bindingId"], "leaseGeneration": self.initialization["leaseGeneration"]}
        key = None
        if mutating:
            p.update(operationId=operation_id, toolCallId=tool_call_id, actionId=action_id, payloadDigest=payload_digest)
            key, created, result = self.store.reserve("host.call", p)
            if not created:
                return result
        if len(self._reverse) >= self.limits["maxPendingRequests"]:
            raise SDKError("resource_limit")
        self._counter += 1
        rpc_id = self.initialization["instanceId"] + ":python:" + str(self._counter)
        future = asyncio.get_running_loop().create_future()
        self._reverse[rpc_id] = future
        try:
            await self._write({"jsonrpc": "2.0", "id": rpc_id, "method": "host.call", "params": p})
            result = await asyncio.wait_for(future, self.limits["commandTimeoutMs"] / 1000)
            if key:
                self.store.complete(key, result)
            return result
        except (SDKError, asyncio.TimeoutError):
            if key:
                return {"status": "unknown"}
            raise SDKError("request_timeout")
        finally:
            self._reverse.pop(rpc_id, None)

    async def _cleanup(self, reason, mode="interrupt", *, orderly=False):
        if self._cleanup_task:
            return await self._cleanup_task
        self._cleanup_ownership_open = orderly
        async def cleanup():
            self.state = "closing"
            loop = asyncio.get_running_loop()
            self._shutdown_deadline = loop.time() + self.limits["shutdownTimeoutMs"] / 1000
            self._credits.set()
            result = {"status": "closed", "ownership": self.ownership, "nativeOutcome": "unknown"}
            # Stop native submissions already in flight before the ownership
            # hook certifies shutdown. A wrapper that ignores cancellation is
            # not evidence of a clean owner even if its cleanup hook returns.
            active = set(self._handlers)
            for task in active:
                task.cancel()
            pending = set()
            if active:
                _, pending = await asyncio.wait(active, timeout=self.limits["shutdownTimeoutMs"] / 2000)
            if self.on_close:
                try:
                    remaining = max(0, self._shutdown_deadline - loop.time()) * 1000
                    evidence = await self._deadline(self.on_close, {"reason": reason, "mode": mode,
                        "ownership": self.ownership, "stopOwned": self.ownership == "owned"}, remaining)
                    if not pending and self.ownership == "owned" and isinstance(evidence, dict) and evidence.get("ownedStopped") is True:
                        result["ownedStopped"] = True
                except BaseException:
                    result["status"] = "unknown"
            return result
        self._cleanup_task = asyncio.create_task(cleanup())
        try:
            return await self._cleanup_task
        finally:
            self._cleanup_ownership_open = False

    async def _dispatch(self, request):
        method, p = request["method"], request.get("params", {})
        try:
            if self.state != "ready":
                raise SDKError("not_initialized" if self.state == "starting" else "plugin_closed")
            self._binding(p)
            if method == "initialize":
                raise SDKError("initialize_failed")
            if method == "events.ack":
                self.store.ack(p.get("sourceSequence"))
                self._credits.set()
                return
            if method == "events.replay":
                result, events = self.store.replay(p.get("afterSourceSequence", p.get("afterSequence", p.get("after", 0))))
                for event in events:
                    self.store.mark_sent(event["sourceSequence"])
                    await self._write({"jsonrpc": "2.0", "method": "event", "params": event})
                await self._response(request, result)
                return
            if method in ("shutdown", "session.close"):
                mode = "interrupt"
                if method == "session.close":
                    mode = p.get("mode")
                    if mode not in ("drain", "interrupt"):
                        raise SDKError("invalid_payload", "Close mode must be drain or interrupt")
                    # This SDK does not implement native draining. Reject it
                    # before changing admission, cancelling a handler or calling
                    # the lifecycle hook; drain never implies interrupt.
                    if mode == "drain":
                        raise SDKError("capability_unavailable", "Native drain is unsupported")
                result = await self._cleanup(method, mode, orderly=True)
                await self._response(request, result)
                self._closing.set()
                return
            if method == "health":
                await self._response(request, {"health": "degraded" if self.store.observation_lost else "ready"})
                return
            if method == "operation.inspect":
                if not identity(p.get("operationId")):
                    raise SDKError("invalid_payload")
                await self._response(request, self.store.inspect(p["operationId"]))
                return
            if method == "session.snapshot" and method not in self.handlers:
                await self._response(request, {"sourceSequence": self.store.sequence, "observation": "reconciliation_required", "disposition": "unknown"})
                return
            if method not in self.handlers:
                raise SDKError("capability_unavailable" if method in CORE_METHODS or method in MUTATING else "method_not_found")
            self._capability(method, p)
            key = None
            if method in MUTATING:
                key, created, result = self.store.reserve(method, p)
                if not created:
                    await self._response(request, result)
                    return
                # A retained decision can be inspected under a replacement
                # process, but a fresh decision cannot target that old instance.
                if method == "interaction.respond" and p["instanceId"] != self.initialization["instanceId"]:
                    self.store.complete(key, {"status": "stale"})
                    await self._response(request, {"status": "stale"})
                    return
            timeout = self.limits["inspectTimeoutMs"] if method == "session.snapshot" else self.limits["commandTimeoutMs"]
            try:
                result = await self._deadline(self.handlers[method], p, timeout)
                if not isinstance(result, dict):
                    raise SDKError("invalid_result")
                # Verify the full response can be transmitted before recording
                # its result; an oversized native result remains unknown.
                encode_frame({"jsonrpc": "2.0", "id": request["id"], "result": result}, self.limits["maxFrameBytes"])
                if key:
                    result = self.store.complete(key, result)
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                if key:
                    _, _, result = self.store.reserve(method, p)
                else:
                    raise
            await self._response(request, result)
        except Exception as error:
            await self._response(request, error=error)
        finally:
            self._rpc_ids.discard(request.get("id"))

    async def run(self):
        reader = asyncio.StreamReader(limit=self.limits["maxFrameBytes"])
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
        os.set_blocking(sys.stdout.fileno(), False)
        reason = "host_eof"
        try:
            while not self._closing.is_set():
                incoming = asyncio.create_task(reader.readline())
                closing = asyncio.create_task(self._closing.wait())
                done, pending = await asyncio.wait({incoming, closing}, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                if closing in done:
                    break
                raw = incoming.result()
                if not raw:
                    break
                if len(raw) > self.limits["maxFrameBytes"]:
                    raise SDKError("resource_limit")
                message = parse_frame(raw)
                if "method" not in message:
                    future = self._reverse.get(message["id"])
                    if future and not future.done():
                        if "error" in message:
                            future.set_exception(SDKError("host_failure"))
                        else:
                            future.set_result(message["result"])
                    continue
                if self.state == "starting":
                    if message.get("method") != "initialize" or "id" not in message:
                        await self._response(message, error=SDKError("not_initialized"))
                        raise SDKError("not_initialized")
                    try:
                        await self._initialize(message)
                    except BaseException as error:
                        await self._response(message, error=error)
                        raise
                    continue
                if "id" not in message and message["method"] != "events.ack":
                    raise SDKError("invalid_frame", "Only acknowledgements are host notifications")
                if len(self._requests) >= self.limits["maxPendingRequests"] or message.get("id") in self._rpc_ids:
                    raise SDKError("resource_limit")
                if "id" in message:
                    self._rpc_ids.add(message["id"])
                task = asyncio.create_task(self._dispatch(message))
                self._requests.add(task)
                task.add_done_callback(self._requests.discard)
                task.add_done_callback(lambda value: None if value.cancelled() else value.exception())
        except BaseException:
            reason = "protocol_failure"
        finally:
            self._cleanup_ownership_open = False
            transport.close()
            self._closing.set()
            for future in self._reverse.values():
                if not future.done():
                    future.set_exception(SDKError("host_eof"))
            cleanup = await self._cleanup(reason)
            tasks = self._requests | self._handlers
            for task in tasks:
                task.cancel()
            if tasks:
                remaining = max(0, self._shutdown_deadline - asyncio.get_running_loop().time())
                _, pending = await asyncio.wait(tasks, timeout=remaining)
                if pending:
                    cleanup.pop("ownedStopped", None)
            if self.store:
                self.store.close(clean=cleanup.get("ownedStopped") is True)


def run_plugin(**options):
    # Explicit bounded task cleanup in run(), rather than asyncio.run's
    # unbounded wait for an adapter coroutine that ignores cancellation.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.set_exception_handler(lambda _loop, _context: None)
    try:
        loop.run_until_complete(PluginRuntime(**options).run())
    finally:
        loop.close()
