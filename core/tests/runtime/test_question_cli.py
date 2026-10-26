"""실제 loopback 서버/질문 CLI/합성 Codex 프로세스로 프레이밍과 중단을 검사한다."""

import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from core.paths import PROJECT_DIR
from core.tests.api import test_personal_api as fixture
from core.tests.runtime import test_question_client as question_fixture
from core.tests.runtime import test_personal_ai_workflow as server_fixture


@unittest.skipUnless(os.name == "posix", "The synthetic executable fixture uses a POSIX shebang; not actual Windows verification.")
class QuestionCliTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.PersonalApiTests.save_policy
    seed = fixture.PersonalApiTests.seed
    value = fixture.PersonalApiTests.value
    context = fixture.PersonalApiTests.context
    question = question_fixture.QuestionClientTests.question
    server = server_fixture.PersonalAIWorkflowTests.server

    def setUp(self):
        fixture.PersonalApiTests.setUp(self)
        self.server_arguments = []
        self.token_path = self.root.resolve() / "personal.token"
        self.token_path.write_text(self.tokens["alice"], encoding="ascii")
        self.token_path.chmod(0o600)

    def fake_cli(self):
        path = self.root.resolve() / "synthetic-codex"
        body = f"#!{Path(sys.executable).resolve()}\n"
        body += '''import json,os,sys,time
from pathlib import Path
if '--version' in sys.argv:
 print('codex-question-fixture 1.0'); raise SystemExit(0)
if '--help' in sys.argv:
 print('--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox --skip-git-repo-check --disable --enable'); raise SystemExit(0)
assert 'LLM_WIKI_TOKEN' not in os.environ and 'OPENAI_API_KEY' not in os.environ
Path('fixture.pid').write_text(str(os.getpid()))
fixed = json.loads(sys.stdin.read().splitlines()[-1])
doc = fixed['basis']['documents'][0]
answer = {'content':'실제 프로세스의 합성 답변', 'citations':[{'kind':'document', 'document':doc['document'], 'source_revision':doc['source_revision'], 'quote':doc['content'].splitlines()[0]}]}
print(json.dumps({'type':'thread.started','thread_id':'synthetic'}),flush=True)
print(json.dumps({'type':'turn.started'}),flush=True)
print(json.dumps({'type':'item.updated','item':{'type':'agent_message','id':'m1','text':'{"content":"실제 프로세스'}}),flush=True)
time.sleep(0.4)
Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps(answer,ensure_ascii=False),encoding='utf-8')
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','id':'m1','text':json.dumps(answer,ensure_ascii=False)}}),flush=True)
print(json.dumps({'type':'turn.completed'}),flush=True)
'''
        path.write_text(body, encoding="utf-8")
        path.chmod(0o700)
        if getattr(self, "provider", "codex") == "claude":
            from core.tests.runtime.claude_fixture import as_claude
            as_claude(path)
        return path

    async def invoke(self, url, question, *, cancel=None):
        command = [sys.executable, "-B", "-m", "tools.question_cli", "--server", url,
            "--tenant", "alpha", "--profile", "business", "--token-file", str(self.token_path),
            "--work-dir", str(self.root.resolve() / "client"), "--run-ai", "--ai-cli", str(self.fake_cli()),
            "--ai-provider", getattr(self, "provider", "codex")]
        for key, value in question.items():
            command.extend(["--" + key.replace("_", "-"), value])
        process = await asyncio.create_subprocess_exec(*command, cwd=PROJECT_DIR,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        events = []
        try:
            while True:
                line = await asyncio.wait_for(process.stdout.readline(), 20)
                if not line:
                    break
                event = json.loads(line)
                self.assertEqual(event["protocol"], "question-cli-v1")
                self.assertNotIn(self.tokens["alice"], line.decode())
                events.append(event)
                if event["type"] == "answer_preview" and len([item for item in events if item["type"] == "answer_preview"]) == 1:
                    self.assertIsNone(process.returncode)
                    self.assertFalse(event["saved"])
                    if cancel == "stdin":
                        process.stdin.write(b'{"type":"cancel"}\n')
                        await process.stdin.drain()
                    elif cancel == "signal":
                        process.terminate()
            await asyncio.wait_for(process.wait(), 10)
            stderr = await process.stderr.read()
            self.assertEqual(stderr, b"")
            self.assertEqual(len([item for item in events if item["type"] == "result"]), 1)
            result = events[-1]
            self.assertEqual(result["type"], "result")
            self.assertEqual(process.returncode, 130 if cancel else 0, result)
            pid = int((Path(result["work_dir"]) / "invocation/fixture.pid").read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            return result, events
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_actual_cli_success_and_generated_text_before_storage(self):
        async with self.server() as (http, url):
            question = await self.question(http)
            with patch.dict(os.environ, {"LLM_WIKI_TOKEN": "never-pass-server-secret", "OPENAI_API_KEY": "never-pass-key"}):
                result, events = await self.invoke(url, question)
            self.assertEqual((result["status"], result["saved"]), ("stored", True), result)
            self.assertTrue(any(item.get("phase") == "submitting" for item in events))
            receipt = self.value(await http.get(self.base + "/question-runs/" + result["question_run_id"] + "/answers/" + result["request_id"], params={"profile": "business"}))
            self.assertTrue(receipt["saved"])
            execution = json.loads((Path(result["work_dir"]) / "invocation/execution.json").read_text())
            self.assertEqual(execution["provider"], getattr(self, "provider", "codex"))
            content = b"".join(p.read_bytes() for p in Path(result["work_dir"]).rglob("*") if p.is_file())
            self.assertNotIn(b"never-pass-server-secret", content)
            self.assertNotIn(b"never-pass-key", content)

    async def test_actual_cli_stdin_and_signal_cancel_reap_process_and_confirm_server(self):
        async with self.server() as (http, url):
            for cancel in ("stdin", "signal"):
                with self.subTest(cancel=cancel):
                    question = await self.question(http)
                    result, _ = await self.invoke(url, question, cancel=cancel)
                    self.assertEqual((result["status"], result["saved"], result["cancellation"]), ("cancelled", False, "confirmed"), result)
                    stored = self.value(await http.get(self.base + "/conversations/" + question["conversation_id"]))
                    self.assertEqual(len(stored["record"]["events"]), 1)


if __name__ == "__main__":
    unittest.main()
