"""Deterministic native modules used only by guarded-launcher subprocess tests."""
import json
import asyncio
from uuid import uuid4
import os
import subprocess
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from threading import Lock


def profile():
    return Path(os.environ["HERMES_HOME"])


def record(kind, **values):
    with (profile() / "effects.jsonl").open("a") as output:
        output.write(json.dumps({"kind": kind, **values}) + "\n")


def config():
    return json.loads((profile() / "config.yaml").read_text())


def module(name, **attributes):
    result = ModuleType(name)
    result.__dict__.update(attributes)
    sys.modules[name] = result
    return result


def load_environment(**kwargs):
    record("unscoped_environment_loaded")
    os.environ["UNSCOPED_DOTENV_SECRET"] = "dummy-secret"
    return []


class FakeConversation:
    session_id = "internal-one"

    def run_conversation(self, user_message, **kwargs):
        if user_message == "[executor-error]":
            raise RuntimeError("private native exception")
        if user_message == "[result-error]":
            return {"error": "private provider error", "final_response": "private provider error",
                    "messages": [{"role": "assistant", "reasoning": "private thought"}]}
        if user_message == "[malformed-result]":
            return {"final_response": {"private": "native data"}}
        if user_message == "[interrupted]":
            return {"final_response": "Partial answer", "interrupted": True}
        return {"final_response": "Transformed final answer", "response_transformed": True,
                "messages": [{"role": "assistant", "reasoning": "private thought"}]}


class FakeAgent:
    def __init__(self):
        self.states = {}
        self.session_manager = SimpleNamespace(get_session=self.get_session,
                                               _sessions=self.states, _lock=Lock())

    def on_connect(self, connection):
        self.connection = connection

    def get_session(self, session_id):
        if session_id not in self.states:
            record("implicit_restore", session_id=session_id)
        return self.states.get(session_id)

    async def initialize(self, **kwargs):
        return SimpleNamespace(protocolVersion=1,
                               agentInfo={"name": "hermes-agent", "version": "0.20.5"},
                               field_meta={"hermes": {"preserved": True}},
                               agent_capabilities=SimpleNamespace(load_session=True,
                                   session_capabilities=SimpleNamespace(fork={}, resume={})))

    async def new_session(self, cwd, **kwargs):
        state = SimpleNamespace(session_id="native-one", mode="default", cwd=cwd,
                                agent=FakeConversation())
        self.states[state.session_id] = state
        record("new", cwd=cwd)
        return SimpleNamespace(session_id=state.session_id, field_meta={})

    def _edit_approval_policy_for_state(self, state):
        return ("ask" if state.mode == "default" else "session", state.cwd)

    async def prompt(self, prompt, session_id, **kwargs):
        text = "\n".join(part.text for part in prompt)
        record("prompt", session_id=session_id, text=text)
        if text == "[executor-not-started]":
            return SimpleNamespace(stop_reason="end_turn", field_meta={})
        try:
            self.states[session_id].agent.run_conversation(user_message=text)
        except Exception:
            pass  # Pinned Hermes can return end_turn after an executor error.
        if text == "[cancel-wait]":
            cancellation = json.loads(sys.stdin.readline())
            if (cancellation.get("method") != "session/cancel" or "id" in cancellation
                    or cancellation.get("params") != {"sessionId": session_id}):
                raise ValueError("Uncorrelated fixture cancellation")
            record("cancel", session_id=session_id)
            return SimpleNamespace(stop_reason="cancelled", field_meta={})
        if text == "[permission-callback]":
            self.connection.use_permission_bridge()
            factory = sys.modules["acp_adapter.permissions"].make_approval_callback
            callback = factory(self.connection.request_permission, asyncio.get_running_loop(), session_id)
            result = await asyncio.to_thread(callback)
            record("prompt_permission", nativeResult=result)
        if text == "[ownership-bridge]":
            params = {"sessionId": session_id, "launchId": "tidy-launch-" + str(uuid4())}
            prepared = await self.connection.ext_method("tidy/ownership.prepare", params)
            if prepared.get("launcherProtocol") != 2:
                raise ValueError("Unsupported native launcher protocol")
            await self.connection.ext_method("tidy/ownership.inspect", params)
            await self.connection.ext_method("tidy/ownership.stopped", params)
            record("ownership_reconciled", launchId=params["launchId"])
        if text in ("[owned-worker]", "[owned-worker-buffered]"):
            def worker():
                registry = sys.modules["tools.process_registry"]
                child = registry.ProcessRegistry().spawn_local("worker", cwd=self.states[session_id].cwd, env_vars={})
                if text == "[owned-worker-buffered]":
                    child.wait(timeout=5)
                    self._fixture_buffered_worker = child
                    return
                output, error = child.communicate(timeout=5)
                record("worker_result", code=child.returncode, output=output, error=error)
            await asyncio.to_thread(worker)
        if text == "[update-error]":
            try:
                await self.connection.session_update(session_id, {"fail": True})
            except Exception:
                pass  # Native worker callbacks also swallow send failures.
        return SimpleNamespace(stop_reason="end_turn", field_meta={"hermes": {"preserved": True}})

    async def set_session_mode(self, mode_id, session_id, **kwargs):
        self.states[session_id].mode = mode_id
        record("mode", mode=mode_id)
        return SimpleNamespace()

    async def set_config_option(self, **kwargs):
        record("config", **kwargs)
        return SimpleNamespace()


def wire(value):
    if isinstance(value, SimpleNamespace):
        value = vars(value)
    if isinstance(value, dict):
        aliases = {"field_meta": "_meta", "stop_reason": "stopReason", "session_id": "sessionId",
                   "agent_capabilities": "agentCapabilities", "load_session": "loadSession",
                   "session_capabilities": "sessionCapabilities"}
        return {aliases.get(key, key): wire(item) for key, item in value.items()}
    return value


async def run_agent(agent, **kwargs):
    class Connection:
        choice = "allow_once"
        fail_receipts = False
        permission_bridge = False

        def use_permission_bridge(self):
            self.permission_bridge = True

        async def ext_notification(self, method, params):
            if self.fail_receipts:
                raise RuntimeError("private receipt write failure")
            record("permission_receipt", **params)
            print(json.dumps({"jsonrpc": "2.0", "method": "_" + method, "params": params}), flush=True)

        async def ext_method(self, method, params):
            request_id = "native-" + str(uuid4())
            print(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": "_" + method, "params": params}), flush=True)
            response = json.loads(sys.stdin.readline())
            if response.get("id") != request_id or "result" not in response:
                raise ValueError("Native lifecycle request failed")
            return response["result"]

        async def session_update(self, session_id, update):
            if update.get("fail"):
                raise RuntimeError("private update-send failure")

        async def request_permission(self, session_id, tool_call, options, **kwargs):
            record("permission_options", options=[option.option_id for option in options])
            record("permission_identity", tidy=kwargs.get("tidy"))
            if self.permission_bridge:
                print(json.dumps({"jsonrpc": "2.0", "id": 701, "method": "session/request_permission", "params": {
                    "sessionId": session_id, "toolCall": tool_call, "_meta": kwargs,
                    "options": [{"optionId": option.option_id, "kind": option.kind, "name": option.option_id} for option in options],
                }}), flush=True)
                response = json.loads(sys.stdin.readline())
                if response.get("id") != 701 or "result" not in response:
                    raise ValueError("Uncorrelated permission fixture response")
                outcome = response["result"]["outcome"]
                return SimpleNamespace(outcome=SimpleNamespace(outcome=outcome["outcome"], option_id=outcome.get("optionId")))
            return SimpleNamespace(outcome=SimpleNamespace(outcome="selected", option_id=self.choice))

    connection = Connection()
    agent.on_connect(connection)
    for line in sys.stdin:
        request = json.loads(line)
        method, params = request["method"], request.get("params", {})
        try:
            if method == "initialize":
                result = await agent.initialize()
            elif method == "session/new":
                result = await agent.new_session(cwd=params["cwd"])
            elif method == "session/prompt":
                result = await agent.prompt(session_id=params.get("sessionId", "native-one"), prompt=[SimpleNamespace(**part) for part in params["prompt"]])
                child = getattr(agent, "_fixture_buffered_worker", None)
                if child is not None:
                    record("worker_result", code=child.returncode, output=child.stdout.read(), error=child.stderr.read())
                    child.stdout.close()
                    child.stderr.close()
                    del agent._fixture_buffered_worker
            elif method in ("session/load", "session/resume", "session/fork"):
                handler = {"session/load": agent.load_session, "session/resume": agent.resume_session, "session/fork": agent.fork_session}[method]
                result = await handler(**params)
            elif method == "session/set_mode":
                result = await agent.set_session_mode(mode_id=params["modeId"], session_id="native-one")
            elif method == "session/set_config_option":
                result = await agent.set_config_option(config_id=params["configId"], value=params["value"], session_id="native-one")
            elif method == "fixture/state":
                # Simulate native policy changes between prompts, including
                # state that is not visible in the profile configuration file.
                if "mode" in params:
                    agent.states["native-one"].mode = params["mode"]
                if "sessionAllow" in params:
                    sys.modules["tools.approval"]._session_approved["native-one"] = set(params["sessionAllow"])
                if "yolo" in params:
                    os.environ["HERMES_YOLO_MODE"] = params["yolo"]
                if params.get("evict"):
                    agent.states.clear()
                result = {}
            elif method == "fixture/environment":
                result = {"keys": sorted(os.environ)}
            elif method == "fixture/unsupported-worker":
                registry = sys.modules["tools.process_registry"].ProcessRegistry()
                if params["mode"] == "pty":
                    registry.spawn_local("worker", cwd=str(profile()), env_vars={}, use_pty=True)
                else:
                    registry.spawn_via_env("worker")
            elif method == "fixture/callback":
                connection.choice = params.get("choice", "allow_once")
                connection.fail_receipts = params.get("failReceipts", False)
                edit = params.get("edit", False)
                factory = (sys.modules["acp_adapter.edit_approval"].make_acp_edit_approval_requester if edit
                           else sys.modules["acp_adapter.permissions"].make_approval_callback)
                callback = factory(agent.connection.request_permission, asyncio.get_running_loop(), "native-one",
                                   mode=params.get("mode", "normal"))
                result = {"nativeResult": await asyncio.to_thread(callback)}
                record("callback_returned", **result)
            elif method == "fixture/permission":
                connection.choice = params["choice"]
                options = [SimpleNamespace(option_id=key, kind=kind) for key, kind in (
                    ("allow_once", "allow_once"), ("allow_session", "allow_always"),
                    ("allow_always", "allow_always"), ("deny", "reject_once"))]
                result = await agent.connection.request_permission(session_id="native-one", tool_call={}, options=options)
                record("permission_consumed", choice=result.outcome.option_id)
            else:
                raise ValueError("fixture_unknown_method")
            response = {"jsonrpc": "2.0", "id": request["id"], "result": wire(result)}
        except Exception:
            response = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32000, "message": "native_policy_refusal"}}
        print(json.dumps(response), flush=True)


def install():
    module("yaml", safe_load=json.loads)
    module("hermes_constants", get_hermes_home=profile)
    module("hermes_cli.config", load_config_readonly=config)
    module("hermes_cli.env_loader", load_hermes_dotenv=load_environment)
    approval = module("tools.approval", _YOLO_MODE_FROZEN=False,
                      _get_approval_mode=lambda: config().get("approvals", {}).get("mode", "manual"),
                      _permanent_approved=set(), _session_approved={},
                      is_approval_bypass_active_for_session=lambda key: False)
    module("tools", approval=approval)
    module("acp", run_agent=run_agent)
    module("acp.schema", PromptResponse=SimpleNamespace)
    registry = module("tools.process_registry", subprocess=subprocess)
    class ProcessRegistry:
        def spawn_local(self, command, cwd=None, task_id="", session_key="", env_vars=None, use_pty=False):
            record("registry_spawn", pty=use_pty)
            program = "from pathlib import Path;import sys;Path(" + repr(str(profile() / "worker-effect")) + ").write_text('started');print('worker output',flush=True);sys.exit(7)"
            return registry.subprocess.Popen([sys.executable, "-I", "-c", program], cwd=cwd, env=env_vars,
                                             start_new_session=True, text=True, encoding="utf-8", errors="replace",
                                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def spawn_via_env(self, *args, **kwargs):
            record("unowned_remote")
    registry.ProcessRegistry = ProcessRegistry
    sys.modules["tools"].process_registry = registry
    def fake_factory(request, loop, session_id, *, edit=False, mode="normal"):
        def callback():
            if mode == "automatic":
                return True if edit else "once"
            options = [SimpleNamespace(option_id=key, kind=kind) for key, kind in
                       (("allow_once", "allow_once"), ("deny", "reject_once"))]
            response = asyncio.run_coroutine_threadsafe(request(session_id=session_id, tool_call={}, options=options), loop).result(timeout=2)
            if mode == "timeout":
                return False if edit else "timeout"
            choice = response.outcome.option_id
            return (choice == "allow_once") if edit else ("once" if choice == "allow_once" else "deny")
        return callback
    module("acp_adapter.permissions", make_approval_callback=fake_factory)
    module("acp_adapter.edit_approval", make_acp_edit_approval_requester=lambda *args, **kwargs: fake_factory(*args, **kwargs, edit=True))
