"""합성 Claude 실행 파일로 provider 선택·출력·격리·프로세스 회수를 검사한다."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.client.ai import CodexAdapter, ClaudeAdapter, create_adapter
from core.client.ai import claude
from core.client.ai.contracts import AIAdapterError
from core.runtime import client_process
from core.tests.runtime.test_personal_ai_runner import SCHEMA
from tools import runtime_doctor


@unittest.skipUnless(os.name == "posix", "Synthetic executable uses a POSIX shebang; Windows branches are mocked separately.")
class ClaudeAIRunnerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wiki-claude-runner-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def cli(self, body, *, flags=claude._REQUIRED_FLAGS):
        path = self.root / ("fake-claude-" + str(len(list(self.root.iterdir()))))
        path.write_text(f"#!{Path(sys.executable).resolve()}\nimport json, os, sys, time\nfrom pathlib import Path\n"
            "if '--version' in sys.argv:\n print('claude-test 1.0'); raise SystemExit(0)\n"
            f"if '--help' in sys.argv:\n print({' '.join(flags)!r}); raise SystemExit(0)\n" + body)
        path.chmod(0o700)
        return str(path)

    async def test_structured_output_preserves_input_provenance_and_isolation(self):
        cli = self.cli("""prompt = sys.stdin.read()
for name in ('LLM_WIKI_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS'):
 assert name not in os.environ
assert os.environ['CLAUDE_CONFIG_DIR'].endswith('login-config')
assert '--safe-mode' in sys.argv and '--bare' not in sys.argv
assert sys.argv[sys.argv.index('--tools') + 1] == ''
assert sys.argv[sys.argv.index('--setting-sources') + 1] == ''
assert json.loads(sys.argv[sys.argv.index('--settings') + 1]) == {'disableAllHooks': True}
assert sys.argv[sys.argv.index('--permission-mode') + 1] == 'dontAsk'
assert sys.argv[sys.argv.index('--permission-prompts') + 1] == 'none'
assert json.loads(sys.argv[sys.argv.index('--mcp-config') + 1]) == {'mcpServers': {}}
assert all(flag in sys.argv for flag in ('--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome'))
assert sys.argv[sys.argv.index('--model') + 1] == 'chosen-model'
schema = json.loads(sys.argv[sys.argv.index('--json-schema') + 1])
assert schema['required'] == ['content']
print(json.dumps({'type':'system', 'subtype':'init', 'model':'reported-model', 'apiKeySource':'PRIVATE-ACCOUNT'}))
print(json.dumps({'type':'assistant', 'message':{'content':[{'type':'thinking','thinking':'PRIVATE-THINKING'}, {'type':'text','text':'public preview'}]}}),flush=True)
time.sleep(.1)
print(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','name':'StructuredOutput','id':'reply','input':{'content':prompt}}]}}))
print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'reply','content':'PRIVATE-INTERNAL'}]}}))
print(json.dumps({'type':'result','subtype':'success','is_error':False,'structured_output':{'content':prompt},'result':'PRIVATE-UNUSED-TEXT'}))
print('PRIVATE-STDERR',file=sys.stderr)
""")
        adapter, seen = ClaudeAdapter(cli=cli, model="chosen-model"), []
        prompt = "전체 원문\r\n조건과 예외 🌱\n"
        with patch.dict(os.environ, {key: "PRIVATE-SECRET" for key in
                ("LLM_WIKI_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "NODE_OPTIONS")} | {
                "CLAUDE_CONFIG_DIR": str(self.root / "login-config")}):
            result = await adapter.run(prompt=prompt, schema=SCHEMA, directory=self.root / "stage", on_event=seen.append)
        self.assertEqual(result["value"], {"content": prompt})
        self.assertEqual([value["text"] for value in seen], ["public preview", claude.canonical_json_bytes({"content":prompt}).decode()])
        self.assertEqual((self.root / "stage/prompt.txt").read_bytes(), prompt.encode())
        self.assertEqual(result["execution"]["provider"], "claude")
        self.assertEqual(result["execution"]["reported_model"], "reported-model")
        self.assertEqual(result["execution"]["prompt_sha256"], sha256(prompt.encode()).hexdigest())
        self.assertEqual(result["execution"]["output_sha256"], sha256((self.root / "stage/result.json").read_bytes()).hexdigest())
        all_bytes = b"".join(path.read_bytes() for path in (self.root / "stage").iterdir())
        self.assertNotIn(b"PRIVATE-", all_bytes)
        with self.assertRaises(FileExistsError):
            await adapter.run(prompt=prompt, schema=SCHEMA, directory=self.root / "stage")

    async def test_invalid_events_missing_payload_wrong_schema_and_failures_are_rejected(self):
        cases = [
            ({"type":"result","subtype":"error_max_turns","is_error":True,"errors":["PRIVATE-ERROR"]}, "ai_execution_failed"),
            ({"type":"result","subtype":"success","is_error":False,"result":'{"content":"not structured"}'}, "ai_invalid_result"),
            ({"type":"result","subtype":"success","is_error":False,"structured_output":{"content":42}}, "ai_invalid_result"),
            ({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"x","input":{}}]}}, "ai_unexpected_tool_activity"),
            ({"type":"assistant","message":{"content":[{"type":"server_tool_use","name":"web_search","id":"x","input":{}}]}}, "ai_unexpected_tool_activity"),
            ({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown"}]}}, "ai_unexpected_tool_activity"),
            ({"type":"system","subtype":"hook_started","command":"PRIVATE-HOOK"}, "ai_unexpected_tool_activity"),
            ({"type":"result","subtype":"success","is_error":False,"structured_output":{"content":"x"},"permission_denials":[{}]}, "ai_unexpected_tool_activity"),
            ({"type":"system","subtype":"init"}, "ai_incomplete_turn"),
        ]
        for index, (event, code) in enumerate(cases):
            with self.subTest(code=code, index=index):
                directory = self.root / f"failed-{index}"
                adapter = ClaudeAdapter(cli=self.cli(f"print({json.dumps(event)!r})\n"))
                with self.assertRaises(AIAdapterError) as error:
                    await adapter.run(prompt="fixture", schema=SCHEMA, directory=directory)
                self.assertEqual(error.exception.code, code)
                self.assertEqual(json.loads((directory / "execution.json").read_text())["status"], "failed")
                self.assertNotIn("PRIVATE", (directory / "trace.jsonl").read_text())
        for text in ('not json', '{"type":"result","type":"result"}', '{"type":NaN}'):
            with self.assertRaises(AIAdapterError) as error:
                await ClaudeAdapter(cli=self.cli(f"print({text!r})\n")).run(prompt="x", schema=SCHEMA,
                    directory=self.root / ("json-" + str(len(list(self.root.iterdir())))))
            self.assertEqual(error.exception.code, "ai_invalid_events")

    async def test_optional_keys_are_not_made_required_and_both_schemas_are_checked(self):
        source = {**SCHEMA, "properties": {**SCHEMA["properties"], "optional": {"type":"string"}}}
        body = "print(json.dumps({'type':'result','subtype':'success','is_error':False,'structured_output':{'content':'ok'}}))\n"
        adapter = ClaudeAdapter(cli=self.cli(body))
        result = await adapter.run(prompt="fixture", schema=source, directory=self.root / "optional")
        self.assertEqual(result["value"], {"content":"ok"})
        with self.assertRaises(AIAdapterError) as error:
            await adapter.run(prompt="fixture", schema=source, output_schema={**source,"required":["content","optional"]},
                              directory=self.root / "required")
        self.assertEqual(error.exception.code, "ai_invalid_result")
        self.assertEqual(json.loads((self.root / "required/result.json").read_text()), {"content":"ok"})

    async def test_timeout_cancel_and_callback_cancel_reap_owned_process(self):
        cli = self.cli("Path('pid').write_text(str(os.getpid()))\n"
            "print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'preview'}]}}),flush=True)\ntime.sleep(30)\n")
        for mode in ("timeout", "cancel", "callback"):
            directory = self.root / mode
            def preview(_):
                if mode == "callback":
                    raise asyncio.CancelledError()
            adapter = ClaudeAdapter(cli=cli, timeout_seconds=.15 if mode == "timeout" else 5)
            task = asyncio.create_task(adapter.run(prompt="fixture", schema=SCHEMA, directory=directory, on_event=preview))
            while not (directory / "pid").exists():
                if task.done(): await task
                await asyncio.sleep(.01)
            pid = int((directory / "pid").read_text())
            if mode == "cancel": task.cancel()
            if mode == "timeout":
                with self.assertRaises(AIAdapterError) as error: await task
                self.assertEqual(error.exception.code, "ai_timeout")
            else:
                with self.assertRaises(asyncio.CancelledError): await task
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            metadata = json.loads((directory / "execution.json").read_text())
            self.assertEqual(metadata["status"], "failed" if mode == "timeout" else "cancelled")

    async def test_input_trace_limits_and_missing_required_flags_fail_closed(self):
        with patch.object(claude, "_MAX_STDIN_BYTES", 3):
            with self.assertRaises(AIAdapterError) as error:
                await ClaudeAdapter(cli="not-installed").run(prompt="long", schema=SCHEMA, directory=self.root / "no-run")
            self.assertEqual(error.exception.code, "ai_input_limit")
        self.assertFalse((self.root / "no-run").exists())
        with self.assertRaises(AIAdapterError) as error:
            await ClaudeAdapter(cli=self.cli("", flags=("--print",))).preflight()
        self.assertEqual(error.exception.code, "ai_cli_incompatible")
        cli = self.cli("print(json.dumps({'type':'system','subtype':'init'}))\n" * 3)
        with patch("core.client.ai.codex.MAX_EVENTS", 2):
            with self.assertRaises(AIAdapterError) as error:
                await ClaudeAdapter(cli=cli).run(prompt="x", schema=SCHEMA, directory=self.root / "events")
            self.assertEqual(error.exception.code, "ai_output_limit")
        cli = self.cli("sys.stdout.write('x' * 4096)\n")
        adapter = ClaudeAdapter(cli=cli)
        await adapter.preflight()
        with patch("core.client.ai.codex.MAX_TRACE_BYTES", 1024):
            with self.assertRaises(AIAdapterError) as error:
                await adapter.run(prompt="x", schema=SCHEMA, directory=self.root / "bytes")
            self.assertEqual(error.exception.code, "ai_output_limit")

    async def test_doctor_reports_provider_login_without_identity_or_model_call(self):
        cli = self.cli("assert sys.argv[-2:] == ['auth','status']\n"
            "assert '--safe-mode' in sys.argv\n"
            "print(json.dumps({'loggedIn':False,'email':'PRIVATE-EMAIL','token':'PRIVATE-TOKEN'}))\nraise SystemExit(1)\n")
        args = SimpleNamespace(ai_provider="claude", ai_cli=cli, skip_ai=False, server=None, ocr_language="eng")
        with patch.object(runtime_doctor, "dependencies", return_value=[]), patch("core.runtime.desktop_bridge.capabilities", return_value={}):
            result = await runtime_doctor.diagnose(args)
        self.assertEqual(result["ai"]["provider"], "claude")
        self.assertEqual(result["ai"]["login"], "not_logged_in")
        self.assertEqual(result["ai"]["action"], "run_claude_login_yourself")
        self.assertEqual(result["model_execution"], "not_run")
        self.assertNotIn("PRIVATE", json.dumps(result))


class ProviderAndCommandTests(unittest.TestCase):
    def test_factory_keeps_codex_default_and_selects_only_requested_provider(self):
        self.assertIs(type(create_adapter()), CodexAdapter)
        self.assertEqual(create_adapter().cli, "codex")
        self.assertIs(type(create_adapter("claude")), ClaudeAdapter)
        self.assertEqual(create_adapter("claude").cli, "claude")
        self.assertEqual(create_adapter("claude", cli="explicit-path").cli, "explicit-path")
        for invalid in ("unknown", "", None):
            with self.assertRaises(AIAdapterError): create_adapter(invalid)

    def test_command_limits_reject_without_truncation_on_each_platform(self):
        with patch.object(claude, "is_windows", return_value=True):
            claude._check_argument_size(["claude.exe", "short"], {})
            with self.assertRaises(AIAdapterError): claude._check_argument_size(["claude.exe", "한" * 33000], {})
        with patch.object(claude, "is_windows", return_value=False), patch.object(claude.sys, "platform", "linux"), patch.object(claude.os, "sysconf", side_effect=lambda key: 4096 if key == "SC_PAGESIZE" else 2097152):
            with self.assertRaises(AIAdapterError): claude._check_argument_size(["claude", "s" * 131072], {})
        with patch.object(claude, "is_windows", return_value=False), patch.object(claude.sys, "platform", "darwin"), patch.object(claude.os, "sysconf", return_value=262144):
            with self.assertRaises(AIAdapterError): claude._check_argument_size(["claude", "s" * 260000], {})

    def test_windows_known_claude_npm_shim_and_native_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "node_modules/@anthropic-ai/claude-code/cli.js"
            script.parent.mkdir(parents=True)
            script.write_text("fixture")
            with patch.object(client_process, "is_windows", return_value=True), patch.object(client_process.shutil, "which", side_effect=[str(root / "claude.cmd"), "node.exe"]):
                self.assertEqual(client_process.cli_command("claude"), ["node.exe", str(script)])
            with patch.object(client_process, "is_windows", return_value=True), patch.object(client_process.shutil, "which", return_value=str(root / "claude.exe")):
                self.assertEqual(client_process.cli_command("claude"), [str(root / "claude.exe")])


if __name__ == "__main__":
    unittest.main()
