"""실제 CLI/모델 없이 질문 전용 프로필의 범위·호환·실패 기록을 검사한다."""

import asyncio
from hashlib import sha256
import inspect
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.codex import CodexAdapter
from core.client.ai.claude import ClaudeAdapter
from core.client.ai.contracts import AIAdapterError
from core.client.ai.question_profile import FEATURE, FILENAME, INSTRUCTIONS, SETTINGS, VERSION
from core.common.json_codec import canonical_json_bytes


SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}},
          "required": ["answer"], "additionalProperties": False}
VALUE = {"answer": "A condition and its exception remain uncertain."}
EVENTS = b'{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}'
FEATURES = b"other_feature\tstable\ttrue\nomit_skill_descriptions\tunder development\tfalse\n"
FILES = {"execution.json", "prompt.txt", "result.json", "schema.json", "source-schema.json", "trace.jsonl"}


def codex(**kwargs):
    adapter = CodexAdapter(**kwargs)
    adapter._capabilities = (["codex-fixture"], "isolated-fixture")
    return adapter


def mock_execute(calls, *, features=FEATURES, failure=None):
    async def execute(arguments, **kwargs):
        calls.append((arguments, kwargs))
        if arguments[1:] == ["features", "list"]:
            if isinstance(features, BaseException):
                raise features
            return features if isinstance(features, tuple) else (0, features, b"")
        if failure is not None:
            raise failure
        Path(kwargs["result_path"]).write_bytes(canonical_json_bytes(VALUE))
        return 0, EVENTS, b""
    return execute


class QuestionCliProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_and_explicit_false_keep_existing_arguments_files_and_metadata(self):
        calls, results = [], []
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", mock_execute(calls)), \
                patch("core.client.ai.codex.time.monotonic", return_value=10):
            for index, options in enumerate(({}, {"question_profile": False})):
                directory = Path(root).resolve() / str(index)
                results.append(await codex(model="chosen-model").run(prompt="frozen", schema=SCHEMA,
                    directory=directory, **options))
                self.assertEqual({path.name for path in directory.iterdir()}, FILES)
                self.assertNotIn("question_profile", results[-1]["execution"])
                arguments = calls[-1][0]
                expected = ["codex-fixture", "exec", "--sandbox", "read-only", "-C", str(directory),
                    "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json",
                    "--output-schema", str(directory / "schema.json"),
                    "--output-last-message", str(directory / "result.json"),
                    "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
                    "-c", "agents.enabled=false", "-c", "suppress_unstable_features_warning=true"]
                for feature in ("apps", "plugins", "shell_tool", "multi_agent", "memories", "hooks", "computer_use",
                                "browser_use", "image_generation", "goals", "sleep_tool", "skill_search", "view_image"):
                    expected.extend(["--disable", feature])
                expected.extend(["--enable", "skip_host_skill_discovery", "--model", "chosen-model", "-"])
                self.assertEqual(arguments, expected)
            self.assertEqual(len(calls), 2)
            self.assertEqual(results[0], results[1])

    async def test_profile_writes_exact_instructions_hash_and_keeps_frozen_input_and_model(self):
        calls = []
        callback = lambda _: None
        adapter = codex(model="chosen-model", on_event=callback)
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", mock_execute(calls)), \
                patch.dict("os.environ", {"CODEX_HOME": "fixture-login-home", "WIKI_TEST_TOKEN": "never-forward"}):
            directory = Path(root).resolve() / "invocation"
            result = await adapter.run(prompt="frozen evidence", schema=SCHEMA, directory=directory, question_profile=True)
            self.assertEqual(calls[0][0], ["codex-fixture", "features", "list"])
            self.assertIsNone(calls[0][1]["directory"])
            self.assertNotIn("prompt", calls[0][1])
            arguments, options = calls[1]
            self.assertEqual(arguments[-3:], ["--model", "chosen-model", "-"])
            self.assertIn("model_instructions_file=" + json.dumps(str(directory / FILENAME)), arguments)
            self.assertEqual(arguments[arguments.index(FEATURE) - 1], "--enable")
            self.assertTrue(all(setting + "=false" in arguments for setting in SETTINGS))
            for preserved in ("read-only", "--ephemeral", "--ignore-user-config", "--json", "--output-schema",
                              "--output-last-message", "shell_tool", "multi_agent", 'web_search="disabled"'):
                self.assertIn(preserved, arguments)
            self.assertIs(options["on_event"], callback)
            self.assertEqual(options["environment"]["CODEX_HOME"], "fixture-login-home")
            self.assertNotIn("WIKI_TEST_TOKEN", options["environment"])
            self.assertEqual(options["prompt"], b"frozen evidence")
            self.assertEqual((directory / "prompt.txt").read_bytes(), options["prompt"])
            self.assertEqual((directory / "source-schema.json").read_bytes(), canonical_json_bytes(SCHEMA))
            instructions = (directory / FILENAME).read_bytes()
            self.assertEqual(instructions, INSTRUCTIONS.encode("utf-8"))
            self.assertEqual(result["value"], VALUE)
            self.assertEqual({path.name for path in directory.iterdir()}, FILES | {FILENAME})
            profile = result["execution"]["question_profile"]
            self.assertEqual(profile, {"version": VERSION, "instructions_file": FILENAME,
                "instructions_sha256": sha256(instructions).hexdigest(),
                "settings": {"model_instructions_file": str(directory / FILENAME), **dict.fromkeys(SETTINGS, False)},
                "enabled_features": [FEATURE], "feature_support_checked": True})
            self.assertEqual(json.loads((directory / "execution.json").read_bytes())["question_profile"], profile)
            self.assertFalse(adapter.persist_session)
            self.assertIsNone(adapter.session_id)

    async def test_successful_capability_check_is_cached_without_leaking_profile_mode(self):
        calls = []
        adapter = codex()
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", mock_execute(calls)):
            for index, enabled in enumerate((True, False, True)):
                directory = Path(root).resolve() / str(index)
                result = await adapter.run(prompt="frozen", schema=SCHEMA, directory=directory, question_profile=enabled)
                self.assertEqual("question_profile" in result["execution"], enabled)
                self.assertEqual((directory / FILENAME).exists(), enabled)
                self.assertEqual(FEATURE in calls[-1][0], enabled)
            result = await codex().run(prompt="frozen", schema=SCHEMA, directory=Path(root).resolve() / "other")
            self.assertNotIn("question_profile", result["execution"])
            self.assertNotIn(FEATURE, calls[-1][0])
            self.assertEqual(sum(args[1:] == ["features", "list"] for args, _ in calls), 1)

    async def test_profile_requires_exact_boolean_and_refuses_sessions_or_web_before_any_cli(self):
        calls = []
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", mock_execute(calls)):
            for index, flag in enumerate((None, 0, 1, "true", [], {})):
                with self.subTest(flag=flag), self.assertRaises(AIAdapterError) as caught:
                    await codex().run(prompt="frozen", schema=SCHEMA, directory=Path(root) / str(index), question_profile=flag)
                self.assertEqual(caught.exception.code, "ai_invalid_input")
            for index, options in enumerate(({"session_id": str(uuid4())}, {"web_search": True}, {"persist_session": True})):
                adapter = codex()
                if options.get("persist_session"):
                    adapter.persist_session = True
                    options = {}
                with self.subTest(options=options), self.assertRaises(AIAdapterError) as caught:
                    await adapter.run(prompt="frozen", schema=SCHEMA, directory=Path(root) / ("combo" + str(index)),
                                      question_profile=True, **options)
                self.assertEqual(caught.exception.code, "ai_invalid_input")
            self.assertEqual(calls, [])
            self.assertEqual(list(Path(root).iterdir()), [])

    async def test_missing_malformed_or_failed_feature_listing_stops_before_ai_without_fallback(self):
        for features in (b"not_omit_skill_descriptions experimental false\n", b"omit_skill_descriptions_suffix stable true\n",
                         b"omit_skill_descriptions\n", b"\xff", (1, FEATURES, b"private error")):
            calls = []
            adapter = codex()
            with self.subTest(features=features), TemporaryDirectory() as root, \
                    patch("core.client.ai.codex._execute", mock_execute(calls, features=features)):
                directory = Path(root).resolve() / "invocation"
                with self.assertRaises(AIAdapterError) as caught:
                    await adapter.run(prompt="frozen", schema=SCHEMA, directory=directory, question_profile=True)
                self.assertEqual(caught.exception.code, "ai_cli_incompatible")
                self.assertEqual(len(calls), 1)
                self.assertFalse(adapter._question_profile_checked)
                record = json.loads((directory / "execution.json").read_bytes())
                self.assertEqual(record["status"], "failed")
                self.assertEqual(record["error_code"], "ai_cli_incompatible")
                self.assertFalse(record["question_profile"]["feature_support_checked"])
                self.assertNotIn("private error", json.dumps(record))

    async def test_feature_query_system_failure_is_recorded_without_ai_attempt(self):
        for failure in (OSError("private path"), TimeoutError("private process")):
            calls = []
            with self.subTest(failure=type(failure).__name__), TemporaryDirectory() as root, \
                    patch("core.client.ai.codex._execute", mock_execute(calls, features=failure)):
                directory = Path(root).resolve() / "invocation"
                with self.assertRaises(AIAdapterError) as caught:
                    await codex().run(prompt="frozen", schema=SCHEMA, directory=directory, question_profile=True)
                self.assertEqual(caught.exception.code, "ai_cli_unavailable")
                self.assertEqual(len(calls), 1)
                record = json.loads((directory / "execution.json").read_bytes())
                self.assertEqual(record["error_code"], "ai_cli_unavailable")
                self.assertFalse(record["question_profile"]["feature_support_checked"])

    async def test_execution_failure_keeps_profile_record_and_never_retries(self):
        for failure, code in ((AIAdapterError("ai_execution_failed"), "ai_execution_failed"),
                              (TimeoutError(), "ai_timeout")):
            calls = []
            with self.subTest(code=code), TemporaryDirectory() as root, \
                    patch("core.client.ai.codex._execute", mock_execute(calls, failure=failure)):
                directory = Path(root).resolve() / "invocation"
                with self.assertRaises(AIAdapterError) as caught:
                    await codex().run(prompt="frozen", schema=SCHEMA, directory=directory, question_profile=True)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(len(calls), 2)
                record = json.loads((directory / "execution.json").read_bytes())
                self.assertEqual(record["status"], "failed")
                self.assertEqual(record["error_code"], code)
                self.assertTrue(record["question_profile"]["feature_support_checked"])

    async def test_cancellation_during_feature_check_or_ai_is_recorded_and_propagated(self):
        for during_features in (True, False):
            calls = []
            options = {"features": asyncio.CancelledError()} if during_features else {"failure": asyncio.CancelledError()}
            with self.subTest(during_features=during_features), TemporaryDirectory() as root, \
                    patch("core.client.ai.codex._execute", mock_execute(calls, **options)):
                directory = Path(root).resolve() / "invocation"
                with self.assertRaises(asyncio.CancelledError):
                    await codex().run(prompt="frozen", schema=SCHEMA, directory=directory, question_profile=True)
                self.assertEqual(len(calls), 1 if during_features else 2)
                record = json.loads((directory / "execution.json").read_bytes())
                self.assertEqual(record["status"], "cancelled")
                self.assertEqual(record["error_code"], "ai_cancelled")
                self.assertEqual(record["question_profile"]["feature_support_checked"], not during_features)

    async def test_profile_still_rejects_host_tool_events_and_invalid_structured_answer(self):
        for raw, events, code in ((canonical_json_bytes(VALUE),
                b'{"type":"item.started","item":{"type":"command_execution"}}', "ai_unexpected_tool_activity"),
                (b'{"unrecognized":"field"}', EVENTS, "ai_invalid_result")):
            calls = []
            async def execute(arguments, **kwargs):
                calls.append(arguments)
                if arguments[1:] == ["features", "list"]:
                    return 0, FEATURES, b""
                Path(kwargs["result_path"]).write_bytes(raw)
                return 0, events, b""
            with self.subTest(code=code), TemporaryDirectory() as root, patch("core.client.ai.codex._execute", execute):
                with self.assertRaises(AIAdapterError) as caught:
                    await codex().run(prompt="frozen", schema=SCHEMA, directory=Path(root).resolve() / "invocation",
                                      question_profile=True)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(len(calls), 2)

    async def test_claude_contract_and_default_execution_do_not_gain_profile(self):
        self.assertNotIn("question_profile", inspect.signature(ClaudeAdapter.run).parameters)
        calls = []
        async def execute(arguments, **kwargs):
            calls.append(arguments)
            kwargs["event_parser"](json.dumps({"type": "result", "subtype": "success", "is_error": False,
                "structured_output": VALUE}), kwargs["on_event"])
            return 0, b"", b""
        adapter = ClaudeAdapter(model="chosen-model")
        adapter._capabilities = (["claude-fixture"], "isolated-fixture")
        with TemporaryDirectory() as root, patch("core.client.ai.claude._execute", execute), \
                patch("core.client.ai.codex._execute", side_effect=AssertionError("Codex must not execute")):
            directory = Path(root).resolve() / "invocation"
            result = await adapter.run(prompt="frozen", schema=SCHEMA, directory=directory)
            self.assertNotIn("question_profile", result["execution"])
            self.assertFalse((directory / FILENAME).exists())
            self.assertEqual(len(calls), 1)
            self.assertIn("--safe-mode", calls[0])
            self.assertEqual(calls[0][-2:], ["--model", "chosen-model"])
            self.assertNotIn(FEATURE, calls[0])


if __name__ == "__main__":
    unittest.main()
