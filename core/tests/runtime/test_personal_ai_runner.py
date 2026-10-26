"""실제 AI 대신 작은 실행 파일로 CLI 경계·중단·잘못된 결과 거부만 확인한다."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from core.client.ai.codex import CodexAdapter
from core.client.ai.contracts import AIAdapterError


SCHEMA = {"type": "object", "additionalProperties": False,
          "properties": {"content": {"type": "string"}}, "required": ["content"]}


class PersonalAIRunnerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wiki-ai-runner-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def cli(self, body):
        path = self.root / ("fake-codex-" + str(len(list(self.root.iterdir()))))
        # 도움말/버전도 가짜 프로세스가 답한다. 어떤 테스트도 개인 AI 계정으로 연결하지 않는다.
        # 프로젝트 경로에는 공백이 있으므로 shebang에는 venv 별칭이 아닌 실제 Python 경로를 쓴다.
        prefix = f"#!{Path(sys.executable).resolve()}\nimport json, os, sys, time\nfrom pathlib import Path\n"
        prefix += "if '--version' in sys.argv:\n print('codex-test 1.0'); raise SystemExit(0)\n"
        prefix += "if '--help' in sys.argv:\n print('--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox --skip-git-repo-check --disable --enable'); raise SystemExit(0)\n"
        path.write_text(prefix + body, encoding="utf-8")
        path.chmod(0o700)
        return str(path)

    async def test_structured_subprocess_preserves_input_and_hides_parent_credentials(self):
        cli = self.cli("""prompt = sys.stdin.read()
assert 'LLM_WIKI_TOKEN' not in os.environ and 'OPENAI_API_KEY' not in os.environ
assert sys.argv[-1] == '-' and '--ephemeral' in sys.argv and '--ignore-user-config' in sys.argv
assert 'suppress_unstable_features_warning=true' in sys.argv
assert '--model' in sys.argv and sys.argv[sys.argv.index('--model') + 1] == 'chosen-model'
schema = json.loads(Path(sys.argv[sys.argv.index('--output-schema') + 1]).read_text())
assert schema['required'] == ['content']
output = Path(sys.argv[sys.argv.index('--output-last-message') + 1])
output.write_text(json.dumps({'content': prompt}, ensure_ascii=False))
print(json.dumps({'type': 'thread.started', 'thread_id': 'synthetic'}))
print(json.dumps({'type': 'turn.started'}))
print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'PRIVATE-TRACE-CONTENT'}}))
print(json.dumps({'type': 'turn.completed'}))
print('PRIVATE-ERROR-CONTENT', file=sys.stderr)
""")
        adapter = CodexAdapter(cli=cli, model="chosen-model")
        self.assertTrue((await adapter.preflight())["capabilities_checked"])
        prompt = "원문 전체\r\n조건과 예외 🌱\n"
        with patch.dict(os.environ, {"LLM_WIKI_TOKEN": "server-secret", "OPENAI_API_KEY": "api-secret"}):
            result = await adapter.run(prompt=prompt, schema=SCHEMA, directory=self.root / "stage")
        self.assertEqual(result["value"], {"content": prompt})
        self.assertEqual((self.root / "stage/prompt.txt").read_bytes(), prompt.encode())
        self.assertEqual(result["execution"]["prompt_sha256"], sha256(prompt.encode()).hexdigest())
        record = json.loads((self.root / "stage/execution.json").read_text())
        self.assertEqual(record["status"], "completed")
        self.assertEqual(record["evidence_kind"], "client_observed")
        self.assertEqual(record["model_selection"], "explicit")
        all_files = b"".join(path.read_bytes() for path in (self.root / "stage").iterdir())
        for secret in (b"server-secret", b"api-secret", b"PRIVATE-TRACE-CONTENT", b"PRIVATE-ERROR-CONTENT"):
            self.assertNotIn(secret, all_files)
        with self.assertRaises(FileExistsError):
            await adapter.run(prompt=prompt, schema=SCHEMA, directory=self.root / "stage")

    async def test_timeout_and_task_cancel_reap_only_the_owned_process(self):
        cli = self.cli("Path('pid').write_text(str(os.getpid()))\ntime.sleep(30)\n")
        for cancel in (False, True):
            directory = self.root / ("cancel" if cancel else "timeout")
            adapter = CodexAdapter(cli=cli, timeout_seconds=5 if cancel else 0.1)
            task = asyncio.create_task(adapter.run(prompt="fixture", schema=SCHEMA, directory=directory))
            while not (directory / "pid").exists():
                if task.done():
                    await task
                await asyncio.sleep(0.01)
            pid = int((directory / "pid").read_text())
            if cancel:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            else:
                with self.assertRaises(AIAdapterError) as error:
                    await task
                self.assertEqual(error.exception.code, "ai_timeout")
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            record = json.loads((directory / "execution.json").read_text())
            self.assertEqual(record["status"], "cancelled" if cancel else "failed")

    async def test_failed_tool_events_and_invalid_json_never_become_success(self):
        cases = [
            ("print(json.dumps({'type':'turn.failed'}))\n", "ai_execution_failed", None),
            ("print(json.dumps({'type':'item.completed','item':{'type':'error','message':'PRIVATE-FAILURE-DETAIL'}}))\n", "ai_execution_failed", "error"),
            ("print(json.dumps({'type':'item.completed','item':{'type':'command_execution'}}))\n", "ai_unexpected_tool_activity", "command_execution"),
            ("print(json.dumps({'type':'turn.completed'}))\nPath(sys.argv[sys.argv.index('--output-last-message')+1]).write_text('{bad json')\n", "ai_invalid_result", None),
        ]
        for index, (body, expected, item_type) in enumerate(cases):
            with self.subTest(code=expected):
                adapter = CodexAdapter(cli=self.cli(body))
                directory = self.root / f"rejected-{index}"
                with self.assertRaises(AIAdapterError) as error:
                    await adapter.run(prompt="fixture", schema=SCHEMA, directory=directory)
                self.assertEqual(error.exception.code, expected)
                self.assertEqual(json.loads((directory / "execution.json").read_text())["status"], "failed")
                trace = (directory / "trace.jsonl").read_text()
                self.assertNotIn("PRIVATE-FAILURE-DETAIL", trace)
                if item_type is not None:
                    self.assertEqual(json.loads(trace.splitlines()[-1])["item_type"], item_type)
        # 원본 스키마만 만족하고 실제 CLI의 필수 출력 키를 빠뜨린 결과도 성공으로 처리하지 않는다.
        source_schema = {"type": "object", "additionalProperties": False,
            "properties": {"content": {"type": "string"}, "detail": {"type": "string"}}, "required": ["content"]}
        output_schema = {**source_schema, "required": ["content", "detail"]}
        body = "print(json.dumps({'type':'turn.completed'}))\nPath(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps({'content':'fixture'}))\n"
        directory = self.root / "rejected-effective-schema"
        with self.assertRaises(AIAdapterError) as error:
            await CodexAdapter(cli=self.cli(body)).run(prompt="fixture", schema=source_schema,
                output_schema=output_schema, directory=directory)
        self.assertEqual(error.exception.code, "ai_invalid_result")
        self.assertEqual(json.loads((directory / "source-schema.json").read_text()), source_schema)
        self.assertEqual(json.loads((directory / "schema.json").read_text())["required"], ["content", "detail"])


if __name__ == "__main__":
    unittest.main()
