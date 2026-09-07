"""Pinned Hermes MCP identity bridge; activation belongs to the guarded adapter."""

from contextvars import ContextVar
from inspect import iscoroutine
from urllib.parse import urlsplit


class FleetIdentityUnavailable(Exception):
    """No native arguments or provider diagnostics enter the public error."""


class FleetRegistration:
    """Verify pinned registry provenance after ACP's best-effort registration."""
    def __init__(self, mcp_tool):
        self.mcp_tool = mcp_tool

    def validate(self, servers):
        if not isinstance(servers, list) or len(servers) != 1:
            raise FleetIdentityUnavailable()
        server = servers[0]
        url = urlsplit(getattr(server, "url", ""))
        headers = getattr(server, "headers", [])
        if (getattr(server, "type", None) != "http" or getattr(server, "name", None) != "tidy-fleet"
                or url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
                or url.username or url.password or url.path != "/mcp" or url.query or url.fragment
                or len(headers) != 1 or getattr(headers[0], "name", None) != "Authorization"):
            raise FleetIdentityUnavailable()
        value = getattr(headers[0], "value", "")
        if not isinstance(value, str) or not value.startswith("Bearer ") or len(value) != 71 or any(
                c not in "0123456789abcdef" for c in value[7:]):
            raise FleetIdentityUnavailable()

    def verify(self, state):
        names = {self.mcp_tool.mcp_prefixed_tool_name("tidy-fleet", tool)
                 for tool in ("fleet_discover", "fleet_send")}
        with self.mcp_tool._lock:
            registered = {name for name, server in self.mcp_tool._mcp_tool_server_names.items()
                          if server == "tidy-fleet"}
        if registered != names or not names.issubset(getattr(state.agent, "valid_tool_names", set())):
            raise FleetIdentityUnavailable()


def install_fleet_identity(mcp_tool, client_session, approval, active):
    """Wrap only the adapter-owned MCP server. No native source files change.

    Hermes 0.20.5 model_tools binds observability context around registry
    dispatch. MCP 2.0 accepts request metadata. Its native reconnect retries
    remain inside one handler invocation and must preserve this identity.
    """
    invocation = ContextVar("tidy_fleet_invocation", default=None)
    factory = mcp_tool._make_tool_handler
    schedule = mcp_tool._run_on_mcp_loop
    call_tool = client_session.call_tool

    def valid(value):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= 256 and "\0" not in value

    def make_handler(server_name, tool_name, tool_timeout):
        handler = factory(server_name, tool_name, tool_timeout)
        if server_name != "tidy-fleet":
            return handler

        def guarded(args, **kwargs):
            if tool_name not in ("fleet_discover", "fleet_send"):
                raise FleetIdentityUnavailable()
            session = active()
            native_session = approval._approval_session_id.get()
            native_tool = approval._approval_tool_call_id.get()
            if (not isinstance(session, dict) or not valid(session.get("sessionId"))
                    or not valid(session.get("nativeSessionId")) or native_session != session["nativeSessionId"]
                    or not valid(session.get("promptId")) or not valid(native_tool)):
                raise FleetIdentityUnavailable()
            identity = {"sessionId": session["sessionId"], "promptId": session["promptId"], "nativeToolCallId": native_tool, "toolName": tool_name}
            token = invocation.set(identity)
            try:
                return handler(args, **kwargs)
            finally:
                invocation.reset(token)
        return guarded

    def run_on_loop(coro_or_factory, timeout=30):
        identity = invocation.get()
        if identity is None:
            return schedule(coro_or_factory, timeout=timeout)
        entered = False

        async def correlated():
            nonlocal entered
            entered = True
            token = invocation.set(identity)
            try:
                coroutine = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
                return await coroutine
            finally:
                invocation.reset(token)
        # Pass a factory, so a missing MCP loop does not leak a coroutine.
        try:
            return schedule(correlated, timeout=timeout)
        except BaseException:
            if not entered and iscoroutine(coro_or_factory):
                coro_or_factory.close()
            raise

    async def correlated_call(self, name, arguments=None, *args, **kwargs):
        identity = invocation.get()
        if identity is None:
            return await call_tool(self, name, arguments, *args, **kwargs)
        if name != identity["toolName"]:
            raise FleetIdentityUnavailable()
        metadata = kwargs.get("meta")
        if metadata is not None and (not isinstance(metadata, dict) or "tidy" in metadata):
            raise FleetIdentityUnavailable()
        kwargs["meta"] = {**(metadata or {}), "tidy": dict(identity)}
        return await call_tool(self, name, arguments, *args, **kwargs)

    mcp_tool._make_tool_handler = make_handler
    mcp_tool._run_on_mcp_loop = run_on_loop
    client_session.call_tool = correlated_call
