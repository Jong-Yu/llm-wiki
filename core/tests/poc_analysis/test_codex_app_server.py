"""No-model protocol checks for the opt-in Codex answer transport."""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.codex import CodexAdapter
from core.client.ai.codex_app_server import _Turn, _Wire, _arguments, _settings, _verify_config, execute
from core.client.ai.contracts import AIAdapterError
from core.common.json_codec import canonical_json_bytes


def config_from(settings):
    result = {}
    for key, value in settings.items():
        target = result
        parts = key.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = deepcopy(value)
    return result


class AppServerConfigTests(unittest.TestCase):
    def test_effective_mcp_entries_must_all_be_disabled_before_model(self):
        settings = _settings(Path("/fixture"))
        config = config_from(settings)
        config["mcp_servers"] = {"one": {"enabled": False}, "new-entry": {"enabled": True}}
        self.assertEqual(_verify_config(config, settings, require_disabled=False), {"one", "new-entry"})
        with self.assertRaises(AIAdapterError):
            _verify_config(config, settings, require_disabled=True)
        config["mcp_servers"]["new-entry"]["enabled"] = False
        self.assertEqual(len(_verify_config(config, settings, require_disabled=True)), 2)

    def test_merged_hooks_plugins_are_inert_only_with_feature_gates(self):
        settings = _settings(Path("/fixture"))
        config = config_from(settings)
        config["hooks"] = {"SessionStart": [{"command": "must-not-run"}]}
        config["plugins"] = {"fixture": {"enabled": True}}
        _verify_config(config, settings, require_disabled=True)
        for feature in ("hooks", "plugins", "shell_tool", "apps"):
            changed = deepcopy(config)
            changed["features"][feature] = True
            with self.subTest(feature=feature), self.assertRaises(AIAdapterError):
                _verify_config(changed, settings, require_disabled=True)

    def test_policy_instruction_and_notify_overrides_are_effective_not_assumed(self):
        settings = _settings(Path("/fixture"))
        config = config_from(settings)
        for key, value in (("notify", ["command"]), ("developer_instructions", "injected"),
                           ("project_doc_max_bytes", 1), ("model_provider", "external"),
                           ("openai_base_url", "https://invalid.example"), ("approval_policy", "on-request"),
                           ("sandbox_mode", "danger-full-access")):
            changed = deepcopy(config)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(AIAdapterError):
                _verify_config(changed, settings, require_disabled=True)

    def test_custom_builtin_provider_config_is_rejected(self):
        settings = _settings(Path("/fixture"))
        config = config_from(settings)
        config["model_providers"] = {"openai": {"base_url": "https://invalid.example"}}
        with self.assertRaises(AIAdapterError):
            _verify_config(config, settings, require_disabled=True)

    def test_dotted_mcp_names_cannot_escape_override_path(self):
        settings = _settings(Path("/fixture"))
        config = config_from(settings)
        for name in ('bad.name', 'bad"name', "bad\nname"):
            config["mcp_servers"] = {name: {"enabled": True}}
            with self.subTest(name=name), self.assertRaises(AIAdapterError):
                _verify_config(config, settings, require_disabled=False)
        args = _arguments(["codex"], {"mcp_servers.safe-name.enabled": False})
        self.assertIn("mcp_servers.safe-name.enabled=false", args)


class AppServerTurnTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.state = _Turn(str(uuid4()), "turn-1", self.events.append)

    def notice(self, method, **params):
        return {"method": method, "params": {"threadId": self.state.thread_id,
                "turnId": self.state.turn_id, **params}}

    def start(self, phase="final_answer"):
        self.state.accept(self.notice("item/started", item={"type": "agentMessage", "id": "answer", "text": "", "phase": phase}))

    def test_provider_deltas_arrive_before_complete_and_keep_phase(self):
        self.start()
        for delta in ('{"action":"answer",', '"content":"한글"}'):
            self.state.accept(self.notice("item/agentMessage/delta", itemId="answer", delta=delta))
        self.assertFalse(self.state.completed)
        self.assertEqual(self.events[-1]["text"], '{"action":"answer","content":"한글"}')
        self.assertTrue(all(event["phase"] == "final" for event in self.events))
        self.state.accept(self.notice("item/completed", item={"type": "agentMessage", "id": "answer",
            "text": self.events[-1]["text"], "phase": "final_answer"}))
        self.state.accept(self.notice("turn/completed", turn={"id": "turn-1", "status": "completed"}))
        self.assertTrue(self.state.completed)

    def test_commentary_is_explicitly_not_final_body(self):
        self.start("commentary")
        self.state.accept(self.notice("item/agentMessage/delta", itemId="answer", delta='{"action":"answer"}'))
        self.assertEqual(self.events[-1]["phase"], "commentary")

    def test_private_reasoning_never_emits(self):
        self.state.accept(self.notice("item/reasoning/textDelta", delta="private"))
        self.state.accept(self.notice("item/started", item={"type": "reasoning", "id": "private", "text": "private"}))
        self.assertEqual(self.events, [])

    def test_tools_and_unsolicited_server_activity_fail(self):
        for kind in ("commandExecution", "mcpToolCall", "webSearch", "fileChange"):
            with self.subTest(kind=kind), self.assertRaises(AIAdapterError) as caught:
                self.state.accept(self.notice("item/started", item={"type": kind, "id": "tool"}))
            self.assertEqual(caught.exception.code, "ai_unexpected_tool_activity")

    def test_final_rewrite_or_phase_switch_is_not_silently_accepted(self):
        self.start()
        self.state.accept(self.notice("item/agentMessage/delta", itemId="answer", delta="prefix"))
        for text, phase in (("different", "final_answer"), ("prefix", "commentary")):
            with self.subTest(text=text), self.assertRaises(AIAdapterError):
                self.state.accept(self.notice("item/completed", item={"type": "agentMessage", "id": "answer",
                    "text": text, "phase": phase}))

    def test_foreign_thread_and_unstarted_delta_fail(self):
        for params in ({"itemId": "unknown", "delta": "text"},
                       {"threadId": str(uuid4()), "itemId": "answer", "delta": "text"}):
            with self.subTest(params=params), self.assertRaises(AIAdapterError):
                self.state.accept(self.notice("item/agentMessage/delta", **params))

    def test_incomplete_or_failed_turn_is_not_a_result(self):
        for status in ("completed", "failed", "interrupted"):
            with self.subTest(status=status), self.assertRaises(AIAdapterError):
                self.state.accept(self.notice("turn/completed", turn={"id": "turn-1", "status": status}))

    def test_multibyte_result_limit_is_bytes(self):
        self.start()
        with patch("core.client.ai.codex_app_server.MAX_RESULT_BYTES", 4), self.assertRaises(AIAdapterError) as caught:
            self.state.accept(self.notice("item/agentMessage/delta", itemId="answer", delta="한글"))
        self.assertEqual(caught.exception.code, "ai_output_limit")


class AppServerAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def protocol_fixture(self, directory, *, changed_config=False, stall=False, callback=None, timeout=1):
        processes, cleaned = [], []
        class Process:
            pass
        async def start(arguments, **kwargs):
            process = Process()
            process.settings = {}
            for index, arg in enumerate(arguments):
                if arg == "-c":
                    key, value = arguments[index + 1].split("=", 1)
                    process.settings[key] = json.loads(value)
            process.methods = []
            process.index = len(processes)
            processes.append(process)
            return process
        async def cleanup(process, tasks):
            cleaned.append(process.index)
        class Wire:
            def __init__(self, process):
                self.process, self.tasks, self.pending = process, [], []
                self.digest, self.stderr_digest = sha256(), sha256()
                self.notices = [
                    {"method": "item/started", "params": {"threadId": identity, "turnId": "turn",
                        "item": {"type": "agentMessage", "id": "answer", "phase": "final_answer", "text": ""}}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": identity, "turnId": "turn",
                        "itemId": "answer", "delta": '{"content":"live"}'}},
                    {"method": "item/completed", "params": {"threadId": identity, "turnId": "turn",
                        "item": {"type": "agentMessage", "id": "answer", "phase": "final_answer", "text": '{"content":"live"}'}}},
                    {"method": "turn/completed", "params": {"threadId": identity, "turn": {"id": "turn", "status": "completed"}}}]
            async def send(self, value):
                pass
            async def request(self, identity, method, params):
                self.process.methods.append(method)
                if method == "config/read":
                    config = config_from(self.process.settings)
                    config["mcp_servers"].setdefault("fixture", {"enabled": True})
                    if changed_config and self.process.index == 1:
                        config["mcp_servers"]["new-server"] = {"enabled": True}
                    return {"config": config}
                if method == "model/list":
                    return {"data": [{"model": "fixture", "isDefault": True}]}
                if method == "thread/start":
                    return {"thread": {"id": identity_string, "ephemeral": True}, "approvalPolicy": "never", "cwd": str(directory),
                        "modelProvider": "openai", "sandbox": {"type": "readOnly", "networkAccess": False}}
                if method == "turn/start":
                    return {"turn": {"id": "turn"}}
                return {}
            async def receive(self):
                if stall and len(self.notices) == 2:
                    await asyncio.sleep(10)
                return self.notices.pop(0)
        identity = identity_string = str(uuid4())
        with patch("core.client.ai.codex_app_server.start_owned_process", start), \
             patch("core.client.ai.codex_app_server._Wire", Wire), patch("core.client.ai.codex._cleanup", cleanup), \
             patch("core.client.ai.codex_app_server.is_windows", return_value=False):
            try:
                result = await execute(["fixture"], directory=directory, environment={}, prompt="synthetic", schema={},
                                       model=None, timeout=timeout, on_event=callback)
                return result, processes, cleaned
            except BaseException as error:
                error.fixture_processes, error.fixture_cleaned = processes, cleaned
                raise

    async def test_config_discovery_has_no_thread_and_model_is_requested_once(self):
        with TemporaryDirectory() as root:
            directory = Path(root).resolve()
            result, processes, cleaned = await self.protocol_fixture(directory)
            self.assertEqual(processes[0].methods, ["initialize", "config/read"])
            self.assertEqual(processes[1].methods.count("turn/start"), 1)
            self.assertEqual(cleaned, [0, 1])
            self.assertEqual(json.loads((directory / "result.json").read_text()), {"content": "live"})

    async def test_new_effective_mcp_entry_fails_before_model(self):
        with TemporaryDirectory() as root:
            directory = Path(root).resolve()
            with self.assertRaises(AIAdapterError) as caught:
                await self.protocol_fixture(directory, changed_config=True)
            self.assertEqual(caught.exception.fixture_cleaned, [0, 1])
            self.assertNotIn("thread/start", caught.exception.fixture_processes[1].methods)
            self.assertFalse((directory / "result.json").exists())

    async def test_timeout_and_cancellation_after_delta_cleanup_without_result(self):
        for cancel in (False, True):
            received = []
            def callback(event):
                received.append(event)
                if cancel:
                    raise asyncio.CancelledError()
            with self.subTest(cancel=cancel), TemporaryDirectory() as root:
                directory = Path(root).resolve()
                with self.assertRaises(asyncio.CancelledError if cancel else TimeoutError) as caught:
                    await self.protocol_fixture(directory, stall=True, callback=callback, timeout=.02)
                self.assertEqual(caught.exception.fixture_cleaned, [0, 1])
                self.assertTrue(received)
                self.assertFalse((directory / "result.json").exists())

    async def test_server_approval_is_declined_before_failure(self):
        wire = object.__new__(_Wire)
        wire.queue = asyncio.Queue()
        replies = []
        async def send(value):
            replies.append(value)
        wire.send = send
        await wire.queue.put({"id": 25, "method": "item/commandExecution/requestApproval", "params": {}})
        with self.assertRaises(AIAdapterError) as caught:
            await wire.receive()
        self.assertEqual(caught.exception.code, "ai_unexpected_tool_activity")
        self.assertEqual(replies, [{"id": 25, "result": {"decision": "decline"}}])

    async def test_stream_opt_in_uses_same_strict_result_validation(self):
        schema = {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]}
        async def execute(executable, **kwargs):
            (kwargs["directory"] / "result.json").write_text('{"content":"live"}')
            return canonical_json_bytes({"type": "turn.completed"}), {"transport": "app-server", "config_verified": True}
        adapter = CodexAdapter()
        adapter._capabilities = (["fixture"], "fixture")
        adapter._question_profile_checked = True
        with TemporaryDirectory() as root, patch("core.client.ai.codex_app_server.execute", execute):
            result = await adapter.run(prompt="frozen", schema=schema, directory=Path(root).resolve() / "run",
                                       question_profile=True, stream_answer=True)
            self.assertEqual(result["value"], {"content": "live"})
            self.assertTrue(result["execution"]["answer_stream"]["config_verified"])

    async def test_opt_in_requires_normal_question_and_boolean(self):
        with TemporaryDirectory() as root:
            for extra in ({"stream_answer": True}, {"stream_answer": 1, "question_profile": True},
                          {"stream_answer": True, "question_profile": True, "template_profile": True}):
                with self.subTest(extra=extra), self.assertRaises(AIAdapterError) as caught:
                    await CodexAdapter().run(prompt="frozen", schema={}, directory=Path(root) / "run", **extra)
                self.assertEqual(caught.exception.code, "ai_invalid_input")
            self.assertEqual(list(Path(root).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
