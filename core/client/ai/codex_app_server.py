"""Fresh, tool-free Codex app-server turns for genuine answer deltas.

The authentication home is inherited unchanged, including the CLI's existing
global personal-instruction boundary. Config discovery never creates a thread;
a second process disables every discovered MCP entry before any model request.
Both effective configurations are checked rather than trusting table merges.
"""

import asyncio
from hashlib import sha256
import json
from pathlib import Path
import re
from uuid import UUID

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import is_windows, write_new
from core.runtime.client_process import start_owned_process
from .contracts import AIAdapterError, MAX_EVENTS, MAX_RESULT_BYTES, MAX_TRACE_BYTES
from .question_profile import FILENAME, INSTRUCTIONS, SETTINGS

_STATUS_NOTICES = {"account/updated", "account/rateLimits/updated", "deprecationNotice", "configWarning",
                   "remoteControl/status/changed"}

def _settings(directory):
    from .codex import _DISABLED
    return {
        "mcp_servers": {}, "plugins": {}, "hooks": {}, "notify": [],
        "instructions": "", "developer_instructions": "",
        "model_instructions_file": str(directory / FILENAME),
        "model_provider": "openai", "openai_base_url": "", "model": "",
        "chatgpt_base_url": "https://chatgpt.com/backend-api/",
        "project_doc_max_bytes": 0, "web_search": "disabled",
        "approval_policy": "never", "sandbox_mode": "read-only",
        "otel.exporter": "none", "otel.trace_exporter": "none", "otel.metrics_exporter": "none",
        "otel.log_user_prompt": False, "otel.log_agent_responses": False, "otel.log_sse_deltas": False,
        "otel.headers_helper": "", "analytics.enabled": False,
        "agents.enabled": False, "suppress_unstable_features_warning": True,
        "features.skip_host_skill_discovery": True,
        "features.omit_skill_descriptions": True,
        **dict.fromkeys(SETTINGS, False),
        **{"features." + key: False for key in (*_DISABLED, "code_mode", "code_mode_only")},
    }


def _lookup(value, key):
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            raise AIAdapterError("ai_cli_incompatible")
        value = value[part]
    return value


def _verify_config(config, settings, *, require_disabled):
    if not isinstance(config, dict):
        raise AIAdapterError("ai_cli_incompatible")
    # Empty tables merge with lower layers; feature gates disable hooks/plugins.
    # MCP has no equivalent global gate, so inspect every effective entry.
    for key, expected in settings.items():
        if key in {"mcp_servers", "plugins", "hooks"} or key.startswith("mcp_servers."):
            continue
        actual = _lookup(config, key)
        if type(actual) is not type(expected) or actual != expected:
            raise AIAdapterError("ai_cli_incompatible")
    servers = config.get("mcp_servers", {})
    providers = config.get("model_providers", {})
    if not isinstance(providers, dict) or providers.get("openai") not in (None, {}):
        raise AIAdapterError("ai_cli_incompatible")
    if config.get("chatgpt_base_url") not in (None, "https://chatgpt.com/backend-api/"):
        raise AIAdapterError("ai_cli_incompatible")
    if config.get("model_catalog_json") is not None:
        raise AIAdapterError("ai_cli_incompatible")
    if not isinstance(servers, dict) or len(servers) > 256:
        raise AIAdapterError("ai_cli_incompatible")
    for name, server in servers.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", name) or not isinstance(server, dict):
            raise AIAdapterError("ai_cli_incompatible")
        if require_disabled and server.get("enabled") is not False:
            raise AIAdapterError("ai_cli_incompatible")
    return set(servers)


def _arguments(executable, settings):
    result = [*executable, "app-server", "--stdio"]
    for key, value in settings.items():
        result.extend(["-c", key + "=" + ("{}" if value == {} else json.dumps(value, ensure_ascii=False))])
    return result


class _Wire:
    def __init__(self, process):
        self.process = process
        self.queue = asyncio.Queue()
        self.remaining = MAX_TRACE_BYTES
        self.count = 0
        self.digest = sha256()
        self.stderr_digest = sha256()
        self.pending = []
        self.tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._stderr())]

    def _consume(self, raw):
        self.remaining -= len(raw)
        if self.remaining < 0:
            raise AIAdapterError("ai_output_limit")

    async def _read(self):
        from .codex import _object
        pending = bytearray()
        try:
            while block := await self.process.stdout.read(65536):
                self._consume(block)
                self.digest.update(block)
                pending.extend(block)
                while b"\n" in pending:
                    line, _, pending = pending.partition(b"\n")
                    if not line.strip():
                        continue
                    self.count += 1
                    if self.count > MAX_EVENTS:
                        raise AIAdapterError("ai_output_limit")
                    try:
                        value = json.loads(line, object_pairs_hook=_object)
                    except (ValueError, UnicodeError):
                        raise AIAdapterError("ai_invalid_events") from None
                    if not isinstance(value, dict):
                        raise AIAdapterError("ai_invalid_events")
                    await self.queue.put(value)
            if pending.strip():
                raise AIAdapterError("ai_invalid_events")
            await self.queue.put(AIAdapterError("ai_incomplete_turn"))
        except Exception as error:
            await self.queue.put(error)

    async def _stderr(self):
        try:
            while block := await self.process.stderr.read(65536):
                self._consume(block)
                self.stderr_digest.update(block)
        except Exception as error:
            await self.queue.put(error)

    async def send(self, value):
        self.process.stdin.write(canonical_json_bytes(value))
        await self.process.stdin.drain()

    async def receive(self):
        value = await self.queue.get()
        if isinstance(value, BaseException):
            raise value
        if "method" in value and "id" in value:
            # Answer pending approvals before terminating the owned process.
            if value["method"] in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
                reply = {"id": value["id"], "result": {"decision": "decline"}}
            else:
                reply = {"id": value["id"], "error": {"code": -32601, "message": "Tools are disabled"}}
            await self.send(reply)
            raise AIAdapterError("ai_unexpected_tool_activity")
        return value

    async def request(self, identity, method, params):
        await self.send({"id": identity, "method": method, "params": params})
        while True:
            value = await self.receive()
            if "method" in value:
                self.pending.append(value)
                continue
            if value.get("id") != identity:
                raise AIAdapterError("ai_invalid_events")
            if "error" in value:
                raise AIAdapterError("ai_cli_incompatible" if method in {"initialize", "config/read", "model/list"}
                                     else "ai_login_or_execution_failed")
            result = value.get("result")
            if not isinstance(result, dict):
                raise AIAdapterError("ai_invalid_events")
            return result


class _Turn:
    def __init__(self, thread_id, turn_id, callback):
        self.thread_id, self.turn_id, self.callback = thread_id, turn_id, callback
        self.items = {}
        self.final = None
        self.usage = None
        self.completed = False
        self.events = [{"type": "thread.started", "thread_id": thread_id}, {"type": "turn.started"}]

    def _emit(self, item_id, item, event):
        if len(item["text"].encode("utf-8")) > MAX_RESULT_BYTES:
            raise AIAdapterError("ai_output_limit")
        if self.callback is not None:
            self.callback({"type": "agent_message", "kind": "public_text", "text": item["text"],
                           "event": event, "item_id": item_id,
                           "phase": "final" if item["phase"] == "final_answer" else item["phase"]})

    def accept(self, value):
        method, params = value.get("method"), value.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            raise AIAdapterError("ai_invalid_events")
        # app-server also emits legacy copies; never forward their bodies.
        if method.startswith("codex/event/"):
            if method.rsplit("/", 1)[-1] not in {
                "thread_name_updated", "task_started", "task_complete", "token_count",
                "agent_message", "agent_message_delta", "agent_reasoning", "agent_reasoning_delta",
                "agent_reasoning_raw_content", "agent_reasoning_raw_content_delta", "agent_reasoning_section_break",
                "item_started", "item_completed", "session_configured", "warning"}:
                raise AIAdapterError("ai_unexpected_tool_activity")
            return
        if method in {"thread/started", "thread/status/changed"}:
            thread = params.get("thread")
            identity = params.get("threadId") or (thread.get("id") if isinstance(thread, dict) else None)
            if identity != self.thread_id:
                raise AIAdapterError("ai_session_mismatch")
            return
        if method in _STATUS_NOTICES | {"model/rerouted"}:
            return
        turn = params.get("turn")
        turn = turn if isinstance(turn, dict) else {}
        if params.get("threadId") != self.thread_id or params.get("turnId", turn.get("id")) != self.turn_id:
            raise AIAdapterError("ai_session_mismatch")
        if method == "turn/started":
            return
        if method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage")
            usage = usage.get("last") if isinstance(usage, dict) else None
            if isinstance(usage, dict):
                self.usage = {target: usage[source] for source, target in (
                    ("inputTokens", "input_tokens"), ("cachedInputTokens", "cached_input_tokens"),
                    ("outputTokens", "output_tokens")) if type(usage.get(source)) is int and usage[source] >= 0}
            return
        if method.startswith("item/reasoning/"):
            return
        if method in {"item/started", "item/completed"}:
            item = params.get("item")
            if not isinstance(item, dict):
                raise AIAdapterError("ai_invalid_events")
            kind, identity = item.get("type"), item.get("id")
            if kind not in {"agentMessage", "reasoning", "userMessage"}:
                raise AIAdapterError("ai_unexpected_tool_activity")
            if not isinstance(identity, str) or not 1 <= len(identity) <= 256:
                raise AIAdapterError("ai_invalid_events")
            if kind != "agentMessage":
                return
            if item.get("phase") not in {None, "commentary", "final_answer"} or not isinstance(item.get("text"), str):
                raise AIAdapterError("ai_invalid_events")
            if method == "item/started":
                if identity in self.items:
                    raise AIAdapterError("ai_invalid_events")
                self.items[identity] = {"text": item["text"], "phase": item.get("phase"), "done": False}
                return
            previous = self.items.get(identity)
            if (previous is None or previous["done"] or not item["text"].startswith(previous["text"])
                    or previous["phase"] != item.get("phase")):
                raise AIAdapterError("ai_invalid_events")
            previous.update(text=item["text"], done=True)
            self._emit(identity, previous, "item.completed")
            if item.get("phase") == "final_answer" or item.get("phase") is None and item["text"].lstrip().startswith("{"):
                if self.final is not None:
                    raise AIAdapterError("ai_invalid_result")
                self.final = item["text"]
            self.events.append({"type": "item.completed", "item": {"type": "agent_message"}})
            return
        if method == "item/agentMessage/delta":
            identity, delta = params.get("itemId"), params.get("delta")
            item = self.items.get(identity) if isinstance(identity, str) else None
            if item is None or item["done"] or not isinstance(delta, str):
                raise AIAdapterError("ai_invalid_events")
            item["text"] += delta
            self._emit(identity, item, "item.updated")
            return
        if method == "turn/completed":
            if turn.get("status") != "completed":
                raise AIAdapterError("ai_execution_failed")
            if self.final is None or any(not item["done"] for item in self.items.values()):
                raise AIAdapterError("ai_incomplete_turn")
            self.events.append({"type": "turn.completed", "usage": self.usage})
            self.completed = True
            return
        if method == "error":
            raise AIAdapterError("ai_execution_failed")
        raise AIAdapterError("ai_unexpected_tool_activity")


async def _session(executable, settings, directory, environment, *, prompt=None, schema=None, model=None, callback=None):
    from .codex import _cleanup
    process = await start_owned_process(_arguments(executable, settings), cwd=directory, env=environment,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    job = getattr(process, "_wiki_job", None)
    wire = _Wire(process)
    turn_requested = False
    try:
        if is_windows():
            process.stdin.write(b"\0")
            await process.stdin.drain()
        await wire.request(1, "initialize", {"clientInfo": {"name": "llm_wiki", "version": "0.1.2"},
                                            "capabilities": {"experimentalApi": False}})
        await wire.send({"method": "initialized", "params": {}})
        response = await wire.request(2, "config/read", {"cwd": str(directory), "includeLayers": False})
        servers = _verify_config(response.get("config"), settings, require_disabled=prompt is not None)
        if any(notice.get("method") not in _STATUS_NOTICES for notice in wire.pending):
            raise AIAdapterError("ai_unexpected_tool_activity")
        if prompt is None:
            return servers
        if model is None:
            catalog = await wire.request(5, "model/list", {})
            entries = catalog.get("data")
            if not isinstance(entries, list):
                raise AIAdapterError("ai_cli_incompatible")
            defaults = [entry.get("model") for entry in entries
                        if isinstance(entry, dict) and entry.get("isDefault") is True]
            if len(defaults) != 1 or not isinstance(defaults[0], str) or not 1 <= len(defaults[0]) <= 200:
                raise AIAdapterError("ai_cli_incompatible")
            model = defaults[0]
        config = {key: value for key, value in settings.items() if not key.startswith("mcp_servers.")}
        config["mcp_servers"] = {name: {"enabled": False} for name in servers}
        params = {"cwd": str(directory), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
                  "baseInstructions": INSTRUCTIONS, "developerInstructions": "", "config": config}
        if model is not None:
            params["model"] = model
        thread = await wire.request(3, "thread/start", params)
        try:
            thread_id = str(UUID(thread["thread"]["id"]))
        except (KeyError, TypeError, ValueError, AttributeError):
            raise AIAdapterError("ai_invalid_session") from None
        sandbox = thread.get("sandbox")
        if (thread.get("approvalPolicy") != "never" or thread.get("modelProvider") != "openai"
                or thread["thread"].get("ephemeral") is not True
                or Path(thread.get("cwd", "")).resolve() != directory.resolve()
                or not isinstance(sandbox, dict) or sandbox.get("type") != "readOnly"
                or sandbox.get("networkAccess") is not False):
            raise AIAdapterError("ai_cli_incompatible")
        turn_requested = True
        turn = await wire.request(4, "turn/start", {"threadId": thread_id,
            "input": [{"type": "text", "text": prompt}], "outputSchema": schema})
        turn_value = turn.get("turn")
        turn_id = turn_value.get("id") if isinstance(turn_value, dict) else None
        if not isinstance(turn_id, str) or not 1 <= len(turn_id) <= 256:
            raise AIAdapterError("ai_invalid_events")
        state = _Turn(thread_id, turn_id, callback)
        for notice in wire.pending:
            state.accept(notice)
        while not state.completed:
            state.accept(await wire.receive())
        write_new(directory / "result.json", state.final.encode("utf-8"))
        if isinstance(thread.get("model"), str):
            state.events[-1]["model"] = thread["model"]
        return b"".join(canonical_json_bytes(event) for event in state.events), {
            "transport": "app-server", "config_verified": True, "mcp_disabled_count": len(servers),
            "raw_stdout_sha256": wire.digest.hexdigest(), "raw_stderr_sha256": wire.stderr_digest.hexdigest()}
    except AIAdapterError as error:
        if not turn_requested and error.code == "ai_incomplete_turn":
            raise AIAdapterError("ai_cli_incompatible") from error
        raise
    finally:
        cleanup = asyncio.create_task(_cleanup(process, wire.tasks))
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        try:
            cleanup.result()
        finally:
            if job is not None:
                job.close()


async def execute(executable, *, directory, environment, prompt, schema, model, timeout, on_event):
    async def run():
        settings = _settings(directory)
        servers = await _session(executable, settings, directory, environment)
        for name in sorted(servers):
            settings['mcp_servers.' + name + '.enabled'] = False
        return await _session(executable, settings, directory, environment,
                              prompt=prompt, schema=schema, model=model, callback=on_event)
    return await asyncio.wait_for(run(), timeout)
