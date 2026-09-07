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
from contextvars import ContextVar
from urllib.request import Request, urlopen


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
        if isinstance(user_message, list):
            record("native_image_input", content=user_message)
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


class FakeHistoryDB:
    """JSON-backed disposable persistence; this does not certify Hermes SQLite."""
    def get_session(self, sid):
        path = profile() / "state.db"
        if not path.exists():
            return None
        value = json.loads(path.read_text())
        return value["row"] if value["row"]["id"] == sid else None

    def get_messages_as_conversation(self, sid, repair_alternation=False):
        if config().get("historyReadError"):
            raise RuntimeError("private database failure")
        value = json.loads((profile() / "state.db").read_text())
        messages = value["messages"] if value["row"]["id"] == sid else []
        # Pinned Hermes SessionDB stamps load-time bookkeeping onto every
        # decoded row. Live ACP history after a turn does not carry these keys.
        return [{**message, "_db_persisted": True, "timestamp": 1.0} for message in messages]

    def save(self, state):
        (profile() / "state.db").write_text(json.dumps({"row": {"id":state.session_id, "source":"acp",
            "model":state.model, "model_config":json.dumps({"cwd":state.cwd})}, "messages":state.history}))


class FakeAgent:
    def __init__(self):
        self.states = {}
        self.session_manager = SimpleNamespace(get_session=self.get_session,
                                               _sessions=self.states, _lock=Lock())
        if config().get("historyPersistence"):
            self.session_manager._db_instance = FakeHistoryDB()

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
                               agent_capabilities=SimpleNamespace(load_session=True, prompt_capabilities=SimpleNamespace(image=True),
                                   session_capabilities=SimpleNamespace(fork={}, resume={})))

    async def new_session(self, cwd, **kwargs):
        if config().get("newSessionError"):
            raise RuntimeError("private native startup failure")
        if "SMOKE_HERMES_BASE_URL" in os.environ:
            record("explicit_environment", name="SMOKE_HERMES_BASE_URL",
                   value=os.environ["SMOKE_HERMES_BASE_URL"])
        state = SimpleNamespace(session_id="native-one", mode="default", cwd=cwd,
                                agent=FakeConversation())
        if config().get("omitMode"):
            del state.mode
        if config().get("historyPersistence"):
            state.agent.session_id = state.session_id
            state.agent.model = "fixture"
            state.history, state.model, state.is_running, state.queued_prompts = [], "fixture", False, []
            self.session_manager._db_instance.save(state)
        self.states[state.session_id] = state
        await self._register_fixture_mcp(state, kwargs.get("mcp_servers"))
        record("new", cwd=cwd)
        return SimpleNamespace(session_id=state.session_id, field_meta={})

    async def _register_fixture_mcp(self, state, servers):
        if servers:
            mcp = sys.modules["tools.mcp_tool"]
            descriptor = servers[0]
            mcp.descriptor = descriptor
            listed = await asyncio.to_thread(mcp_request, "tools/list", {})
            state.agent.valid_tool_names = set()
            for tool in listed["tools"]:
                if config().get("fleetRegistration") == "missing":
                    continue
                name = mcp.mcp_prefixed_tool_name("tidy-fleet", tool["name"])
                mcp._mcp_tool_server_names[name] = "tidy-fleet"
                mcp.handlers[tool["name"]] = mcp._make_tool_handler("tidy-fleet", tool["name"], 3)
                if config().get("fleetRegistration") != "hidden":
                    state.agent.valid_tool_names.add(name)
            record("mcp_registered", count=len(state.agent.valid_tool_names))

    async def load_session(self, cwd, session_id, mcp_servers=None, **kwargs):
        record("load", session_id=session_id)
        db = self.session_manager._db_instance
        row = db.get_session(session_id)
        if row is None:
            return None
        state = SimpleNamespace(session_id=session_id, mode="default", cwd=cwd, agent=FakeConversation(),
                                model=row["model"], history=db.get_messages_as_conversation(session_id),
                                is_running=False, queued_prompts=[])
        state.agent.session_id = session_id
        state.agent.model = state.model
        if config().get("historyRestore") == "empty":
            state.history = []
        if config().get("historyRestore") == "policy":
            state.mode = "session"
        if config().get("historyRestore") == "rotated":
            state.agent.session_id = "rotated"
        self.states[session_id] = state
        await self._register_fixture_mcp(state, mcp_servers)
        await self.connection.session_update(session_id, {"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"PRIVATE_REPLAY"}})
        return SimpleNamespace(field_meta={})

    def _edit_approval_policy_for_state(self, state):
        return ("ask" if getattr(state, "mode", "default") == "default" else "session", state.cwd)

    async def prompt(self, prompt, session_id, **kwargs):
        text = "\n".join(part.text for part in prompt if part.type == "text")
        images = [part for part in prompt if part.type == "image"]
        record("prompt", session_id=session_id, text=text)
        content = ([{"type": "text", "text": text}] + [{"type": "image_url", "image_url": {"url": "data:" + part.mime_type + ";base64," + part.data}} for part in images]) if images else text
        if text == "[executor-not-started]":
            return SimpleNamespace(stop_reason="end_turn", field_meta={})
        try:
            self.states[session_id].agent.run_conversation(user_message=content)
        except Exception:
            pass  # Pinned Hermes can return end_turn after an executor error.
        if text in ("[fleet-send]", "[fleet-send:pi]"):
            def invoke():
                approval = sys.modules["tools.approval"]
                session_token = approval._approval_session_id.set(self.states[session_id].agent.session_id)
                tool_token = approval._approval_tool_call_id.set("native-tool-one")
                try:
                    for _ in range(2):
                        result = sys.modules["tools.mcp_tool"].handlers["fleet_send"]({"target": "pi" if text == "[fleet-send:pi]" else "peer", "text": "fixture task"})
                        record("fleet_result", result=result)
                finally:
                    approval._approval_session_id.reset(session_token)
                    approval._approval_tool_call_id.reset(tool_token)
            await asyncio.to_thread(invoke)
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
        if config().get("historyPersistence"):
            state = self.states[session_id]
            state.history += [{"role":"user", "content":content}, {"role":"assistant", "content":"Transformed final answer"}]
            self.session_manager._db_instance.save(state)
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
                   "session_capabilities": "sessionCapabilities", "prompt_capabilities": "promptCapabilities"}
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
            record(
                "startup_failure" if method == "tidy/startup_failure" else "permission_receipt",
                **params,
            )
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
                servers = [SimpleNamespace(**{**server, "headers": [SimpleNamespace(**header) for header in server.get("headers", [])]}) for server in params.get("mcpServers", [])]
                result = await agent.new_session(cwd=params["cwd"], mcp_servers=servers)
            elif method == "session/prompt":
                result = await agent.prompt(session_id=params.get("sessionId", "native-one"), prompt=[SimpleNamespace(**{("mime_type" if key == "mimeType" else key): value for key, value in part.items()}) for part in params["prompt"]], **params.get("_meta", {}))
                child = getattr(agent, "_fixture_buffered_worker", None)
                if child is not None:
                    record("worker_result", code=child.returncode, output=child.stdout.read(), error=child.stderr.read())
                    child.stdout.close()
                    child.stderr.close()
                    del agent._fixture_buffered_worker
            elif method == "session/load":
                servers = [SimpleNamespace(**{**server, "headers": [SimpleNamespace(**header) for header in server.get("headers", [])]}) for server in params.get("mcpServers", [])]
                result = await agent.load_session(cwd=params["cwd"], session_id=params["sessionId"], mcp_servers=servers)
            elif method in ("session/resume", "session/fork"):
                handler = {"session/resume": agent.resume_session, "session/fork": agent.fork_session}[method]
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


def mcp_request(method, params):
    descriptor = sys.modules["tools.mcp_tool"].descriptor
    headers = {header.name: header.value for header in descriptor.headers}
    headers.update({"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    request = Request(descriptor.url, data=json.dumps({"jsonrpc": "2.0", "id": str(uuid4()), "method": method, "params": params}).encode(), headers=headers)
    with urlopen(request, timeout=3) as response:
        return json.load(response)["result"]


def install():
    module("yaml", safe_load=json.loads)
    module("hermes_constants", get_hermes_home=profile)
    module("hermes_cli.config", load_config_readonly=config)
    module("hermes_cli.env_loader", load_hermes_dotenv=load_environment)
    approval = module("tools.approval", _YOLO_MODE_FROZEN=False,
                      _approval_session_id=ContextVar("native_session", default=None),
                      _approval_tool_call_id=ContextVar("native_tool", default=None),
                      _get_approval_mode=lambda: config().get("approvals", {}).get("mode", "manual"),
                      _permanent_approved=set(), _session_approved={},
                      is_approval_bypass_active_for_session=lambda key: False)
    module("tools", approval=approval)
    class ClientSession:
        async def call_tool(self, name, arguments=None, **kwargs):
            return await asyncio.to_thread(mcp_request, "tools/call", {"name": name, "arguments": arguments, "_meta": kwargs.get("meta")})
    module("mcp", ClientSession=ClientSession)
    mcp = module("tools.mcp_tool", _lock=Lock(), _mcp_tool_server_names={}, handlers={},
                 mcp_prefixed_tool_name=lambda server, tool: "mcp__" + server.replace("-", "_") + "__" + tool)
    mcp._run_on_mcp_loop = lambda factory, timeout=30: asyncio.run(factory() if callable(factory) else factory)
    def make_handler(server, tool, timeout):
        return lambda args, **kwargs: mcp._run_on_mcp_loop(lambda: ClientSession().call_tool(tool, args), timeout=timeout)
    mcp._make_tool_handler = make_handler
    sys.modules["tools"].mcp_tool = mcp
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
