"""Owned ACP entry point with explicit profile and per-prompt approval checks."""

import argparse
import asyncio
from concurrent.futures import Future
from importlib import metadata
from importlib.util import module_from_spec, spec_from_file_location
import os
from pathlib import Path
import sys
from threading import Lock
from uuid import uuid4


HERMES_VERSION = "0.20.5"
ACP_VERSION = "0.9.0"
GUARD_VERSION = 4


class ApprovalPolicyUnavailable(Exception):
    """Safe diagnostic: never include native configuration or secret values."""


def receipt_permission_factory(factory, *, edit=False):
    """Observe the pinned synchronous callback, not merely its ACP response.

    Each invocation gets its own closure, including when native workers overlap.
    A timeout, failed mapping or automatic approval never produces an applied
    receipt. Failure to deliver evidence prevents an allow result escaping.
    """
    def create(request_permission_fn, loop, session_id, *args, **kwargs):
        owner = getattr(request_permission_fn, "__self__", None)
        if not callable(getattr(owner, "tidy_permission_consumed", None)):
            raise ApprovalPolicyUnavailable()

        def callback(*call_args, **call_kwargs):
            permission_id = str(uuid4())
            observed = {}

            async def request(*request_args, **request_kwargs):
                request_kwargs["tidy"] = {"permissionId": permission_id}
                response = await request_permission_fn(*request_args, **request_kwargs)
                # Both pinned callbacks read only response.outcome after their
                # future.result(). A response arriving after the worker timeout
                # must not count as consumption, even when its choice is deny.
                class ConsumedResponse:
                    @property
                    def outcome(self):
                        outcome = response.outcome
                        if getattr(outcome, "outcome", None) == "selected":
                            observed["choice"] = getattr(outcome, "option_id", None)
                        return outcome
                return ConsumedResponse()

            native = factory(request, loop, session_id, *args, **kwargs)
            result = native(*call_args, **call_kwargs)
            if (edit and type(result) is not bool) or (not edit and result not in ("once", "deny", "timeout")):
                raise ApprovalPolicyUnavailable()
            choice = observed.get("choice")
            expected = ((True if choice == "allow_once" else False) if edit
                        else ("once" if choice == "allow_once" else "deny"))
            if choice in ("allow_once", "deny") and type(result) is type(expected) and result == expected:
                future = asyncio.run_coroutine_threadsafe(
                    owner.tidy_permission_consumed(session_id, permission_id, choice), loop)
                try:
                    future.result(timeout=5)
                except BaseException:
                    future.cancel()
                    raise ApprovalPolicyUnavailable()
            elif result is True or result in ("once", "session", "always"):
                raise ApprovalPolicyUnavailable()
            return result

        return callback
    return create


def directory(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise ApprovalPolicyUnavailable()
    return path.resolve(strict=True)


class ApprovalGuard:
    def __init__(self, *, profile, home, config, approval, yaml, constants):
        self.profile, self.home = profile, home
        self.config, self.approval, self.yaml, self.constants = config, approval, yaml, constants

    def check(self, state=None, agent=None):
        try:
            if directory(os.environ.get("HOME", "")) != self.home:
                raise ApprovalPolicyUnavailable()
            if directory(os.environ.get("HERMES_HOME", "")) != self.profile:
                raise ApprovalPolicyUnavailable()
            if self.constants.get_hermes_home().resolve(strict=True) != self.profile:
                raise ApprovalPolicyUnavailable()
            if any(key.startswith(("TIDY_", "PI_TIDY_")) for key in os.environ):
                raise ApprovalPolicyUnavailable()
            if str(os.environ.get("HERMES_YOLO_MODE", "")).strip().lower() not in ("", "0", "false", "no", "off"):
                raise ApprovalPolicyUnavailable()
            # Require readable profile-local configuration. Hermes' ordinary
            # loader can degrade an unreadable file to defaults; that is not
            # sufficient evidence to begin a required-approval prompt.
            path = self.profile / "config.yaml"
            if path.is_symlink() or path.resolve(strict=True).parent != self.profile:
                raise ApprovalPolicyUnavailable()
            if not path.is_file() or path.stat().st_size > 1024 * 1024:
                raise ApprovalPolicyUnavailable()
            raw = self.yaml.safe_load(path.read_text(encoding="utf-8"))
            effective = self.config.load_config_readonly()
            for value in (raw, effective):
                if not isinstance(value, dict):
                    raise ApprovalPolicyUnavailable()
                approvals = value.get("approvals", {})
                if not isinstance(approvals, dict) or approvals.get("mode", "manual") != "manual":
                    raise ApprovalPolicyUnavailable()
                if value.get("command_allowlist"):
                    raise ApprovalPolicyUnavailable()
            if self.approval._YOLO_MODE_FROZEN is not False:
                raise ApprovalPolicyUnavailable()
            if self.approval._get_approval_mode() != "manual":
                raise ApprovalPolicyUnavailable()
            if self.approval._permanent_approved or any(self.approval._session_approved.values()):
                raise ApprovalPolicyUnavailable()
            if state is not None:
                if state.mode != "default" or agent._edit_approval_policy_for_state(state)[0] != "ask":
                    raise ApprovalPolicyUnavailable()
                keys = (state.session_id, state.agent.session_id)
                if any(not isinstance(key, str) or not key or
                       self.approval.is_approval_bypass_active_for_session(key) for key in keys):
                    raise ApprovalPolicyUnavailable()
        except ApprovalPolicyUnavailable:
            raise
        except Exception:
            raise ApprovalPolicyUnavailable() from None


def guarded_agent(base, guard, prompt_response, worker_type):
    class GuardedHermesACPAgent(base):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._tidy_created_sessions = set()
            self._tidy_active_prompt = False
            self._tidy_update_tickets = None
            self._tidy_update_lock = Lock()
            self._tidy_update_failed = False
            self._tidy_workers = None
            self._tidy_worker_session = None

        def _tidy_live_state(self, session_id):
            # The pinned SessionManager public getter restores history on a
            # cache miss. Inspect only its live map under its own lock.
            with self.session_manager._lock:
                return self.session_manager._sessions.get(session_id)

        def on_connect(self, connection):
            owner = self

            def worker_session():
                session_id = owner._tidy_worker_session
                if not owner._tidy_active_prompt or session_id is None:
                    raise ApprovalPolicyUnavailable()
                state = owner._tidy_live_state(session_id)
                if state is None:
                    raise ApprovalPolicyUnavailable()
                guard.check(state, owner)
                return session_id

            self._tidy_workers = worker_type(connection, asyncio.get_running_loop(), worker_session)

            class ExactPermissionClient:
                def __getattr__(self, name):
                    return getattr(connection, name)

                async def tidy_permission_consumed(self, session_id, permission_id, option_id):
                    if session_id not in owner._tidy_created_sessions:
                        raise ApprovalPolicyUnavailable()
                    state = owner._tidy_live_state(session_id)
                    if state is None:
                        raise ApprovalPolicyUnavailable()
                    guard.check(state, owner)
                    await connection.ext_notification("tidy/permission_consumed", {
                        "sessionId": session_id, "permissionId": permission_id,
                        "optionId": option_id, "evidence": "native_callback_returned",
                    })

                def session_update(self, *args, **kwargs):
                    # Native worker callbacks swallow update-send failures.
                    # Register before scheduling so even an unscheduled/dropped
                    # coroutine prevents a complete-observation claim.
                    ticket = Future()
                    with owner._tidy_update_lock:
                        tickets = owner._tidy_update_tickets
                        if tickets is not None:
                            pending = []
                            for prior in tickets:
                                if not prior.done():
                                    pending.append(prior)
                                elif prior.cancelled() or prior.result() is not True:
                                    owner._tidy_update_failed = True
                            tickets[:] = pending
                            if len(tickets) >= 256:
                                owner._tidy_update_failed = True
                                raise ApprovalPolicyUnavailable()
                            tickets.append(ticket)

                    async def forward():
                        try:
                            result = await connection.session_update(*args, **kwargs)
                        except BaseException:
                            if not ticket.done():
                                ticket.set_result(False)
                            raise
                        if not ticket.done():
                            ticket.set_result(True)
                        return result

                    return forward()

                async def request_permission(self, session_id, tool_call, options, **kwargs):
                    def check_live():
                        if session_id not in owner._tidy_created_sessions:
                            raise ApprovalPolicyUnavailable()
                        state = owner._tidy_live_state(session_id)
                        if state is None:
                            raise ApprovalPolicyUnavailable()
                        guard.check(state, owner)

                    check_live()
                    allowed = []
                    seen = set()
                    for option in options:
                        if option.option_id in seen:
                            raise ApprovalPolicyUnavailable()
                        seen.add(option.option_id)
                        if (option.option_id, option.kind) in (("allow_once", "allow_once"), ("deny", "reject_once")):
                            allowed.append(option)
                    allowed_ids = frozenset(option.option_id for option in allowed)
                    if "deny" not in allowed_ids:
                        raise ApprovalPolicyUnavailable()
                    result = await connection.request_permission(session_id=session_id, tool_call=tool_call, options=allowed, **kwargs)
                    check_live()
                    outcome = result.outcome
                    if outcome.outcome == "cancelled":
                        return result
                    if outcome.outcome != "selected" or outcome.option_id not in allowed_ids:
                        # Let Hermes' native callback observe failure. Never
                        # synthesize a broader choice or apply a mismatched one.
                        raise ApprovalPolicyUnavailable()
                    return result

            return super().on_connect(ExactPermissionClient())

        async def initialize(self, *args, **kwargs):
            guard.check()
            result = await super().initialize(*args, **kwargs)
            capabilities = getattr(result, "agent_capabilities", None)
            if capabilities is not None:
                capabilities.load_session = False
                sessions = getattr(capabilities, "session_capabilities", None)
                if sessions is not None:
                    sessions.fork = None
                    sessions.resume = None
            extra = dict(result.field_meta or {})
            extra["tidy"] = {"guardVersion": GUARD_VERSION,
                             "approvalPolicy": "ask",
                             "environment": "explicit", "ownedWorkers": "local-pipe-v1"}
            result.field_meta = extra
            return result

        async def new_session(self, *args, **kwargs):
            guard.check()
            result = await super().new_session(*args, **kwargs)
            state = self._tidy_live_state(result.session_id)
            if state is None:
                raise ApprovalPolicyUnavailable()
            guard.check(state, self)
            modes = getattr(result, "modes", None)
            if modes is not None:
                if modes.current_mode_id != "default":
                    raise ApprovalPolicyUnavailable()
                modes.available_modes = [mode for mode in modes.available_modes if mode.id == "default"]
            self._tidy_created_sessions.add(result.session_id)
            return result

        async def prompt(self, prompt, session_id, **kwargs):
            def refuse(code):
                return prompt_response(stop_reason="refusal", field_meta={"tidy": {
                    "rejectedBeforePrompt": True, "code": code,
                }})

            try:
                # Native get_session() can restore on a cache miss. A prompt
                # must never turn an unknown reference into an implicit load.
                if session_id not in self._tidy_created_sessions:
                    return refuse("session_not_found")
                if self._tidy_active_prompt:
                    return refuse("session_busy")
                if self._tidy_workers is None or self._tidy_workers.failed:
                    return refuse("native_ownership_unavailable")
                state = self._tidy_live_state(session_id)
                if state is None:
                    return refuse("session_not_found")
                guard.check(state, self)
                # Native slash commands include policy/session mutations.
                # These must use separately negotiated gateway controls.
                if any(getattr(block, "type", None) != "text" for block in prompt):
                    return refuse("capability_unavailable")
                text = "\n".join(block.text for block in prompt).strip()
                if not text:
                    return refuse("invalid_payload")
                if text.startswith("/"):
                    return refuse("capability_unavailable")
            except ApprovalPolicyUnavailable:
                return refuse("approval_policy_unavailable")
            # The pinned ACP server catches executor errors and can still return
            # end_turn. It also sends transformed final text as a plain chunk.
            # Capture only display text and lifecycle facts at the actual run
            # boundary; never copy the native history/reasoning or error data.
            native = state.agent
            original = getattr(native, "run_conversation", None)
            if not callable(original):
                return refuse("native_contract_unavailable")
            evidence = {"started": False, "settled": False, "failed": False,
                        "interrupted": False}
            had_override = "run_conversation" in vars(native)
            previous = vars(native).get("run_conversation")

            def observed_run(*args, **kwargs):
                if evidence["started"]:
                    raise ApprovalPolicyUnavailable()
                evidence["started"] = True
                try:
                    result = original(*args, **kwargs)
                    if not isinstance(result, dict):
                        evidence["failed"] = True
                        return result
                    evidence["failed"] = bool(result.get("error"))
                    evidence["interrupted"] = bool(result.get("interrupted"))
                    final_text = result.get("final_response", "")
                    if not isinstance(final_text, str):
                        evidence["failed"] = True
                    elif not evidence["failed"]:
                        evidence["finalText"] = final_text
                    return result
                except BaseException:
                    evidence["failed"] = True
                    raise
                finally:
                    evidence["settled"] = True

            self._tidy_active_prompt = True
            self._tidy_worker_session = session_id
            self._tidy_update_tickets = []
            self._tidy_update_failed = False
            native.run_conversation = observed_run
            try:
                response = await super().prompt(prompt=prompt, session_id=session_id, **kwargs)
                try:
                    await self._tidy_workers.reap()
                except Exception:
                    self._tidy_update_failed = True
                evidence["observationsComplete"] = False
                try:
                    with self._tidy_update_lock:
                        tickets = list(self._tidy_update_tickets)
                    sent = await asyncio.wait_for(asyncio.gather(*[
                        asyncio.wrap_future(ticket) for ticket in tickets
                    ]), timeout=5)
                    with self._tidy_update_lock:
                        evidence["observationsComplete"] = all(sent) and not self._tidy_update_failed and not self._tidy_workers.failed and all(
                            ticket.done() and not ticket.cancelled() and ticket.result() is True
                            for ticket in self._tidy_update_tickets)
                except Exception:
                    pass
                extra = dict(response.field_meta or {})
                extra["tidy"] = {"guardVersion": GUARD_VERSION,
                                 "turnEvidence": dict(evidence)}
                response.field_meta = extra
                return response
            finally:
                # Cancellation of the asyncio waiter need not stop its executor.
                # Keep admission latched closed if native settlement is unknown.
                if evidence["settled"]:
                    if had_override:
                        native.run_conversation = previous
                    else:
                        del native.run_conversation
                    self._tidy_active_prompt = False
                    self._tidy_worker_session = None
                    self._tidy_update_tickets = None

        async def set_session_mode(self, mode_id, session_id, **kwargs):
            if mode_id != "default" or session_id not in self._tidy_created_sessions:
                raise ApprovalPolicyUnavailable()
            state = self._tidy_live_state(session_id)
            if state is None:
                raise ApprovalPolicyUnavailable()
            guard.check(state, self)
            return await super().set_session_mode(mode_id=mode_id, session_id=session_id, **kwargs)

        async def set_config_option(self, config_id, value, session_id, **kwargs):
            if config_id != "edit_approval_policy" or value != "ask" or session_id not in self._tidy_created_sessions:
                raise ApprovalPolicyUnavailable()
            state = self._tidy_live_state(session_id)
            if state is None:
                raise ApprovalPolicyUnavailable()
            guard.check(state, self)
            return await super().set_config_option(config_id=config_id, value=value, session_id=session_id, **kwargs)

        async def load_session(self, *args, **kwargs):
            raise ApprovalPolicyUnavailable()

        async def resume_session(self, *args, **kwargs):
            raise ApprovalPolicyUnavailable()

        async def fork_session(self, *args, **kwargs):
            raise ApprovalPolicyUnavailable()

    return GuardedHermesACPAgent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--home", required=True)
    args = parser.parse_args()
    if not sys.flags.isolated:
        raise ApprovalPolicyUnavailable()
    source, profile, home = directory(args.source), directory(args.profile), directory(args.home)
    if directory(os.environ.get("HERMES_HOME", "")) != profile or directory(os.environ.get("HOME", "")) != home:
        raise ApprovalPolicyUnavailable()
    # -I excludes cwd, user site packages and PYTHONPATH. The administrator's
    # explicit runtime source is the only added import root.
    sys.path.insert(0, str(source))
    import hermes_cli
    if hermes_cli.__version__ != HERMES_VERSION or metadata.version("agent-client-protocol") != ACP_VERSION:
        raise ApprovalPolicyUnavailable()
    from hermes_cli import env_loader

    def explicit_environment_only(**kwargs):
        # run_agent imports this function and otherwise reads the installation
        # .env, external secret sources and managed environment. Provider keys
        # must instead be explicitly granted by the gateway to this child.
        return []

    env_loader.load_hermes_dotenv = explicit_environment_only
    import yaml
    import hermes_constants
    from hermes_cli import config
    from acp_adapter.entry import _setup_logging
    _setup_logging()
    from tools import approval
    guard = ApprovalGuard(profile=profile, home=home, config=config,
                          approval=approval, yaml=yaml, constants=hermes_constants)
    guard.check()
    import acp
    from acp.schema import PromptResponse
    # Patch the factories before server.py captures its direct import. Edits
    # import the module factory at prompt time. Both remain pinned to 0.20.5.
    from acp_adapter import permissions, edit_approval
    permissions.make_approval_callback = receipt_permission_factory(permissions.make_approval_callback)
    edit_approval.make_acp_edit_approval_requester = receipt_permission_factory(
        edit_approval.make_acp_edit_approval_requester, edit=True)
    from acp_adapter import server
    server.make_approval_callback = permissions.make_approval_callback
    HermesACPAgent = server.HermesACPAgent
    # Do not call entry.main(): it performs implicit environment loading and
    # configured MCP discovery. Fleet MCP registration belongs to the adapter.
    guard.check()
    spec = spec_from_file_location("tidy_hermes_native_owned", Path(__file__).with_name("native_owned.py"))
    owned = module_from_spec(spec)
    spec.loader.exec_module(owned)
    agent = guarded_agent(HermesACPAgent, guard, PromptResponse, owned.NativeWorkers)()
    from tools import process_registry
    owned.install_workers(process_registry, lambda: agent._tidy_workers)

    async def run():
        try:
            await acp.run_agent(agent, use_unstable_protocol=True)
        finally:
            if agent._tidy_workers is not None:
                await agent._tidy_workers.close()

    asyncio.run(run())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("tidy_hermes_native_unavailable", file=sys.stderr)
        sys.exit(2)
