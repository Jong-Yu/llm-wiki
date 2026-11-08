"""실행 ID를 명시한 이어 실행·도구 차단·서로 다른 결과 보관을 검사한다."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.codex import CodexAdapter
from core.client.ai.claude import ClaudeAdapter
from core.client.ai.contracts import AIAdapterError

SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}},
          "required": ["answer"], "additionalProperties": False}


class SessionContinuation(unittest.IsolatedAsyncioTestCase):
    async def test_codex_explicit_session_schema_switch_and_isolation(self):
        session = str(uuid4())
        calls = []
        async def execute(arguments, **kwargs):
            calls.append(arguments)
            Path(kwargs["result_path"]).write_text('{"answer":"kept"}')
            return 0, b"\n".join(json.dumps(event).encode() for event in [
                {"type": "thread.started", "thread_id": session}, {"type": "turn.started"},
                {"type": "turn.completed", "usage": {"input_tokens": 10 * len(calls), "output_tokens": 2 * len(calls)}}]), b""
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        adapter.persist_session = True
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", execute):
            first = await adapter.run(prompt="remember", schema=SCHEMA, directory=Path(root).resolve()/"first")
            second = await adapter.run(prompt="recall", schema=SCHEMA, directory=Path(root).resolve()/"second", session_id=session)
            self.assertEqual(first["execution"]["session_id"], second["execution"]["session_id"])
            self.assertNotIn("--ephemeral", calls[0])
            self.assertNotIn("resume", calls[0])
            self.assertEqual(calls[1][calls[1].index("resume")+1], session)
            self.assertNotIn("--last", calls[1])
            self.assertIn("read-only", calls[1])
            self.assertIn("shell_tool", calls[1])
            self.assertIn("--output-schema", calls[1])
            self.assertTrue((Path(root).resolve()/"first/result.json").exists())
            self.assertTrue((Path(root).resolve()/"second/result.json").exists())
            self.assertEqual(second["execution"]["provider_session_usage"], {"input_tokens": 20, "output_tokens": 4})
            self.assertEqual(second["execution"]["token_usage"]["tokens"], {"input_tokens": 10, "output_tokens": 2})
            restarted = CodexAdapter()
            restarted._capabilities = adapter._capabilities
            third = await restarted.run(prompt="after restart", schema=SCHEMA,
                directory=Path(root).resolve()/"third", session_id=session)
            self.assertEqual(third["execution"]["provider_session_usage"], {"input_tokens": 30, "output_tokens": 6})
            self.assertIsNone(third["execution"]["token_usage"])

    async def test_codex_mismatched_session_and_tool_activity_rejected(self):
        session = str(uuid4())
        async def execute(arguments, **kwargs):
            Path(kwargs["result_path"]).write_text('{"answer":"kept"}')
            return 0, (json.dumps({"type":"thread.started", "thread_id":str(uuid4())})+'\n'+
                       json.dumps({"type":"turn.completed"})).encode(), b""
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", execute):
            with self.assertRaises(AIAdapterError) as error:
                await adapter.run(prompt="recall", schema=SCHEMA, directory=Path(root).resolve()/"run", session_id=session)
            self.assertEqual(error.exception.code, "ai_session_mismatch")

    async def test_claude_resume_keeps_origin_directory(self):
        session = str(uuid4())
        calls = []
        async def execute(arguments, **kwargs):
            calls.append((arguments, kwargs["directory"]))
            event = {"type":"result", "subtype":"success", "is_error":False,
                     "session_id":session, "structured_output":{"answer":"kept"}}
            kwargs["event_parser"](json.dumps(event).encode(), lambda _: None)
            return 0, json.dumps(event).encode(), b""
        adapter = ClaudeAdapter()
        adapter._capabilities = (["claude"], "isolated-fixture")
        adapter.persist_session = True
        with TemporaryDirectory() as root, patch("core.client.ai.claude._execute", execute):
            first = await adapter.run(prompt="remember", schema=SCHEMA, directory=Path(root).resolve()/"first")
            second = await adapter.run(prompt="recall", schema=SCHEMA, directory=Path(root).resolve()/"second", session_id=session)
            self.assertEqual(first["execution"]["session_id"], second["execution"]["session_id"])
            self.assertEqual(calls[0][1], calls[1][1])
            self.assertNotIn("--no-session-persistence", calls[0][0])
            self.assertIn("--resume", calls[1][0])
            self.assertIn("--safe-mode", calls[1][0])
            self.assertEqual(calls[1][0][calls[1][0].index("--tools")+1], "")


if __name__ == "__main__":
    unittest.main()
