"""Deterministic native modules used only by guarded-launcher subprocess tests."""
import json
import os
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


class FakeAgent:
    def __init__(self):
        self.states = {}
        self.session_manager = SimpleNamespace(get_session=self.get_session,
                                               _sessions=self.states, _lock=Lock())

    def get_session(self, session_id):
        if session_id not in self.states:
            record("implicit_restore", session_id=session_id)
        return self.states.get(session_id)

    async def initialize(self, **kwargs):
        return SimpleNamespace(field_meta={"hermes": {"preserved": True}},
                               agent_capabilities=SimpleNamespace(load_session=True,
                                   session_capabilities=SimpleNamespace(fork={}, resume={})))

    async def new_session(self, cwd, **kwargs):
        state = SimpleNamespace(session_id="native-one", mode="default", cwd=cwd,
                                agent=SimpleNamespace(session_id="internal-one"))
        self.states[state.session_id] = state
        record("new", cwd=cwd)
        return SimpleNamespace(session_id=state.session_id, field_meta={})

    def _edit_approval_policy_for_state(self, state):
        return ("ask" if state.mode == "default" else "session", state.cwd)

    async def prompt(self, prompt, session_id, **kwargs):
        record("prompt", session_id=session_id, text="\n".join(part.text for part in prompt))
        return SimpleNamespace(stop_reason="end_turn", field_meta={})

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
