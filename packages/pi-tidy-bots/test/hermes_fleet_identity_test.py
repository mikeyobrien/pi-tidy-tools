import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar, Context
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from threading import Lock
import unittest

spec = spec_from_file_location("native_fleet", Path(__file__).parents[1] / "backends/hermes/native_fleet.py")
module = module_from_spec(spec)
spec.loader.exec_module(module)


class FleetIdentityTest(unittest.TestCase):
    def fixture(self, retries=1, metadata=None, fail_schedule=False):
        calls = []
        effects = []
        approval = SimpleNamespace(_approval_session_id=ContextVar("native_session", default="native-one"),
                                   _approval_tool_call_id=ContextVar("tool_call", default="native-tool-one"))
        class Session:
            async def call_tool(self, name, arguments=None, **kwargs):
                calls.append({"name": name, "arguments": arguments, **kwargs})
                return {"ok": True}
        mcp = SimpleNamespace()
        def schedule(factory, timeout=30):
            if fail_schedule:
                raise RuntimeError("loop unavailable")
            # A fresh thread/context reproduces the context-loss boundary.
            with ThreadPoolExecutor(max_workers=1) as executor:
                return executor.submit(lambda: Context().run(asyncio.run, factory() if callable(factory) else factory)).result(timeout=2)
        def make_handler(server, tool, timeout):
            def handler(arguments, **kwargs):
                effects.append("entered")
                for _ in range(retries):
                    result = mcp._run_on_mcp_loop(lambda: Session().call_tool(tool, arguments, **({"meta": metadata} if metadata is not None else {})), timeout=timeout)
                return result
            return handler
        mcp._make_tool_handler = make_handler
        mcp._run_on_mcp_loop = schedule
        active = {"sessionId": "acp-one", "nativeSessionId": "native-one", "promptId": "prompt-one"}
        module.install_fleet_identity(mcp, Session, approval, lambda: active)
        return mcp, Session, approval, active, calls, effects

    def test_native_identity_survives_thread_handoff_and_reconnect_retry(self):
        mcp, _, _, _, calls, _ = self.fixture(retries=2)
        result = mcp._make_tool_handler("tidy-fleet", "fleet_send", 2)({"target": "peer", "text": "task"})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[0]["meta"], {"tidy": {"sessionId": "acp-one", "promptId": "prompt-one", "nativeToolCallId": "native-tool-one", "toolName": "fleet_send"}})
        self.assertEqual(calls[0]["arguments"], {"target": "peer", "text": "task"})

    def test_missing_or_foreign_identity_never_enters_native_handler(self):
        for native_session, tool in [("foreign", "tool"), ("native-one", ""), ("native-one", "x" * 257)]:
            mcp, _, approval, _, calls, effects = self.fixture()
            session_token = approval._approval_session_id.set(native_session)
            tool_token = approval._approval_tool_call_id.set(tool)
            try:
                with self.assertRaises(module.FleetIdentityUnavailable):
                    mcp._make_tool_handler("tidy-fleet", "fleet_send", 2)({})
                self.assertEqual(calls, [])
                self.assertEqual(effects, [])
            finally:
                approval._approval_session_id.reset(session_token)
                approval._approval_tool_call_id.reset(tool_token)

    def test_context_is_reset_and_other_servers_remain_unmodified(self):
        mcp, Session, _, _, calls, _ = self.fixture()
        mcp._make_tool_handler("tidy-fleet", "fleet_discover", 2)({})
        mcp._make_tool_handler("other", "other_tool", 2)({})
        asyncio.run(Session().call_tool("direct", {}))
        self.assertNotIn("meta", calls[1])
        self.assertNotIn("meta", calls[2])

    def test_existing_correlation_cannot_override_guarded_identity(self):
        mcp, _, _, _, calls, _ = self.fixture(metadata={"tidy": {"nativeToolCallId": "forged"}})
        with self.assertRaises(module.FleetIdentityUnavailable):
            mcp._make_tool_handler("tidy-fleet", "fleet_send", 2)({})
        self.assertEqual(calls, [])

    def test_failed_scheduling_never_enters_client(self):
        mcp, _, _, _, calls, _ = self.fixture(fail_schedule=True)
        with self.assertRaises(RuntimeError):
            mcp._make_tool_handler("tidy-fleet", "fleet_send", 2)({})
        self.assertEqual(calls, [])

    def test_registration_requires_the_private_http_descriptor(self):
        registration = module.FleetRegistration(None)
        def server(**changes):
            return SimpleNamespace(**{"type": "http", "name": "tidy-fleet", "url": "http://127.0.0.1:1234/mcp",
                "headers": [SimpleNamespace(name="Authorization", value="Bearer " + "a" * 64)], **changes})
        registration.validate([server()])
        for servers in [[], [server(), server()], [server(type="stdio")], [server(name="foreign")],
                        [server(url="http://localhost:1234/mcp")], [server(url="http://127.0.0.1:1234/mcp?token=x")],
                        [server(headers=[])], [server(headers=[SimpleNamespace(name="Authorization", value="Bearer short")])]]:
            with self.assertRaises(module.FleetIdentityUnavailable):
                registration.validate(servers)

    def test_registration_requires_both_exact_provenance_and_agent_visibility(self):
        mcp = SimpleNamespace(_lock=Lock(), _mcp_tool_server_names={}, mcp_prefixed_tool_name=lambda server, tool: tool)
        registration = module.FleetRegistration(mcp)
        state = SimpleNamespace(agent=SimpleNamespace(valid_tool_names={"fleet_send", "fleet_discover"}))
        for mapping in [{}, {"fleet_send": "tidy-fleet"}, {"fleet_send": "foreign", "fleet_discover": "tidy-fleet"},
                        {"fleet_send": "tidy-fleet", "fleet_discover": "tidy-fleet", "unexpected": "tidy-fleet"}]:
            mcp._mcp_tool_server_names = mapping
            with self.assertRaises(module.FleetIdentityUnavailable):
                registration.verify(state)
        mcp._mcp_tool_server_names = {"fleet_send": "tidy-fleet", "fleet_discover": "tidy-fleet"}
        registration.verify(state)
        state.agent.valid_tool_names.clear()
        with self.assertRaises(module.FleetIdentityUnavailable):
            registration.verify(state)


if __name__ == "__main__":
    unittest.main()
