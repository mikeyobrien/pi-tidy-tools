"""Gated local pipe workers. PTY, remote and cgroup ownership remain separate profiles."""

import asyncio
import json
import os
from pathlib import Path
import re
import subprocess
from threading import Lock
from uuid import uuid4


class NativeOwnershipUnavailable(Exception):
    """Public diagnostics never include argv, environment or native error text."""


class NativeWorkers:
    def __init__(self, connection, loop, session):
        self.connection, self.loop, self.session = connection, loop, session
        self.lock = Lock()
        self.workers = {}
        self.closed = False
        self.failed = False
        self.popen = subprocess.Popen

    async def request(self, method, launch_id, session_id, **params):
        return await self.connection.ext_method("tidy/ownership." + method, {
            "sessionId": session_id, "launchId": launch_id, **params,
        })

    def call(self, method, launch_id, session_id, **params):
        request = self.request(method, launch_id, session_id, **params)
        try:
            future = asyncio.run_coroutine_threadsafe(request, self.loop)
        except BaseException:
            request.close()
            self.failed = True
            raise NativeOwnershipUnavailable() from None
        try:
            return future.result(timeout=10)
        except BaseException:
            future.cancel()
            self.failed = True
            raise NativeOwnershipUnavailable() from None

    def spawn(self, args, **kwargs):
        # The event-loop thread cannot synchronously wait for its own RPC.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise NativeOwnershipUnavailable()
        session_id = self.session()
        allowed = {"cwd", "env", "stdin", "stdout", "stderr", "text", "encoding", "errors", "bufsize", "start_new_session", "close_fds"}
        environment = kwargs.get("env")
        cwd = kwargs.get("cwd")
        if (not session_id or set(kwargs) - allowed or kwargs.get("start_new_session") is not True
                or kwargs.get("close_fds", True) is not True
                or not isinstance(args, (list, tuple)) or not args
                or any(not isinstance(arg, str) or "\0" in arg for arg in args)
                or not Path(args[0]).is_absolute() or Path(args[0]).name == "systemd-run"
                or not isinstance(cwd, str) or not Path(cwd).is_absolute() or "\0" in cwd
                or not isinstance(environment, dict)
                or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                       or not isinstance(value, str) or "\0" in value for key, value in environment.items())):
            raise NativeOwnershipUnavailable()
        args, environment = list(args), dict(environment)
        launch_id = "tidy-launch-" + str(uuid4())
        activation = (json.dumps({"activate": launch_id, "env": environment}, ensure_ascii=False) + "\n").encode()
        if len(activation) > 1024 * 1024:
            raise NativeOwnershipUnavailable()
        with self.lock:
            if self.closed or self.failed or len(self.workers) >= 4096:
                raise NativeOwnershipUnavailable()
            entry = {"session": session_id, "process": None, "control": None, "activated": False, "admitting": True}
            self.workers[launch_id] = entry
        prepared = self.call("prepare", launch_id, session_id)
        if (not isinstance(prepared, dict) or prepared.get("launchId") != launch_id
                or prepared.get("state") != "prepared" or prepared.get("launcherProtocol") != 2
                or any(not isinstance(prepared.get(key), str) or not Path(prepared[key]).is_absolute()
                       or "\0" in prepared[key] for key in ("launcherPath", "executable"))):
            self.failed = True
            raise NativeOwnershipUnavailable()
        read_fd, write_fd = os.pipe()
        process = None
        try:
            bootstrap = {key: value for key, value in kwargs.items() if key not in ("env", "start_new_session", "close_fds")}
            process = self.popen([prepared["executable"], prepared["launcherPath"], launch_id,
                                  "--control-fd=" + str(read_fd), *args],
                                 env={}, start_new_session=True, close_fds=True, pass_fds=(read_fd,), **bootstrap)
            with self.lock:
                entry["process"], entry["control"] = process, write_fd
                if self.closed:
                    raise NativeOwnershipUnavailable()
            recorded = self.call("record", launch_id, session_id, pid=process.pid)
            identity = recorded.get("identity") if isinstance(recorded, dict) else None
            if (not isinstance(recorded, dict) or recorded.get("launchId") != launch_id
                    or recorded.get("state") != "started" or not isinstance(identity, dict)
                    or identity.get("pid") != process.pid or identity.get("token") != launch_id):
                raise NativeOwnershipUnavailable()
            with self.lock:
                if self.closed or self.failed or process.poll() is not None:
                    raise NativeOwnershipUnavailable()
                # A partial write followed by failure is never retried as a new launch.
                remaining = memoryview(activation)
                while remaining:
                    written = os.write(write_fd, remaining)
                    if written <= 0:
                        raise NativeOwnershipUnavailable()
                    remaining = remaining[written:]
                entry["activated"] = True
            return process
        except BaseException:
            self.failed = True
            with self.lock:
                if entry["control"] is not None:
                    os.close(entry["control"])
                    entry["control"] = None
                elif process is None:
                    os.close(write_fd)
            if process is not None:
                try:
                    process.wait(timeout=12)
                except BaseException:
                    # Retain the handle for close/root reconciliation without
                    # exposing subprocess arguments in a cleanup exception.
                    pass
            raise NativeOwnershipUnavailable() from None
        finally:
            os.close(read_fd)
            with self.lock:
                entry["admitting"] = False

    async def reap(self):
        with self.lock:
            finished = [(key, entry) for key, entry in self.workers.items()
                        if not entry["admitting"] and entry["process"] is not None and entry["process"].poll() is not None]
        for launch_id, entry in finished:
            with self.lock:
                if entry["control"] is not None:
                    os.close(entry["control"])
                    entry["control"] = None
            try:
                result = await asyncio.wait_for(self.request("stopped", launch_id, entry["session"]), timeout=10)
                if not isinstance(result, dict) or result.get("launchId") != launch_id or result.get("state") != "stopped":
                    raise NativeOwnershipUnavailable()
            except BaseException:
                self.failed = True
                raise NativeOwnershipUnavailable() from None
            with self.lock:
                # Native readers may still be draining buffered output. They own
                # the streams; this lifecycle observer must not close them.
                entry["process"] = None

    async def close(self):
        with self.lock:
            self.closed = True
            processes = []
            for entry in self.workers.values():
                if entry["control"] is not None:
                    os.close(entry["control"])
                    entry["control"] = None
                if entry["process"] is not None:
                    processes.append(entry["process"])
        # The trusted wrappers receive EOF and terminate their own groups.
        await asyncio.gather(*(asyncio.to_thread(process.wait, timeout=12) for process in processes))


def install_workers(registry, owner):
    original = registry.subprocess
    original_spawn = registry.ProcessRegistry.spawn_local

    class SubprocessProxy:
        def __getattr__(self, name):
            return getattr(original, name)

        def Popen(self, args, **kwargs):
            current = owner()
            if current is None:
                raise NativeOwnershipUnavailable()
            return current.spawn(args, **kwargs)

    def spawn_local(self, command, cwd=None, task_id="", session_key="", env_vars=None, use_pty=False):
        if use_pty:
            raise NativeOwnershipUnavailable()
        return original_spawn(self, command, cwd=cwd, task_id=task_id, session_key=session_key, env_vars=env_vars, use_pty=False)

    def unsupported(*args, **kwargs):
        raise NativeOwnershipUnavailable()

    registry.subprocess = SubprocessProxy()
    registry.ProcessRegistry.spawn_local = spawn_local
    registry.ProcessRegistry.spawn_via_env = unsupported
