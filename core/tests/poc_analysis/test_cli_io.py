"""공통 개인 CLI 인자·JSONL·협력 취소의 기존 실행 의미를 검사한다."""

import argparse
import asyncio
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import signal
import unittest
from unittest.mock import patch

from tools.cli_io import add_ai_arguments, cancellable, cancellation_handler, emit_json, _read_cancel


class CliIoTests(unittest.TestCase):
    def test_standard_ai_arguments_keep_defaults_and_accept_explicit_selection(self):
        parser = argparse.ArgumentParser()
        add_ai_arguments(parser)
        self.assertEqual(vars(parser.parse_args([])), {
            "ai_provider": "codex", "ai_cli": None, "ai_model": None, "ai_timeout": 900})
        selected = parser.parse_args(["--ai-provider", "claude", "--ai-cli", "/custom/cli", "--ai-model", "custom", "--ai-timeout", "12"])
        self.assertEqual((selected.ai_provider, selected.ai_cli, selected.ai_model, selected.ai_timeout),
            ("claude", "/custom/cli", "custom", 12))
        fast = argparse.ArgumentParser(); add_ai_arguments(fast, default_timeout=60)
        self.assertEqual(fast.parse_args([]).ai_timeout, 60)
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["--ai-provider", "unknown"])

    def test_jsonl_is_one_unicode_line_and_rejects_nan(self):
        output = StringIO()
        with redirect_stdout(output): emit_json({"text": "한글 😀"})
        self.assertEqual(output.getvalue().splitlines(), ['{"text": "한글 😀"}'])
        self.assertEqual(json.loads(output.getvalue()), {"text": "한글 😀"})
        with redirect_stdout(StringIO()), self.assertRaises(ValueError): emit_json({"value": float("nan")})

    def test_stdin_accepts_only_an_exact_cancel_command(self):
        for value, expected in (("", 0), ("not-json\n", 0), ('{"type":"cancel","extra":true}\n', 0),
                ('bad\n{"type":"cancel"}\n', 1), ("x" * 4097 + '\n{"type":"cancel"}\n', 0)):
            calls = []
            with self.subTest(value=value[:40]), patch("tools.cli_io.sys.stdin", StringIO(value)):
                _read_cancel(lambda: calls.append(True))
            self.assertEqual(len(calls), expected)


class CliCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_event_cancel_and_exception_restore_signal_handlers(self):
        event = asyncio.Event()
        original = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        with patch("tools.cli_io.sys.stdin.isatty", return_value=True):
            with self.assertRaisesRegex(ValueError, "fixture"):
                with cancellation_handler(event.set):
                    signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                    await asyncio.wait_for(event.wait(), 1)
                    raise ValueError("fixture")
        self.assertEqual({sig: signal.getsignal(sig) for sig in original}, original)

    async def test_task_cancel_runs_its_cleanup_and_restores_handlers(self):
        started, cleaned = asyncio.Event(), asyncio.Event()
        original = signal.getsignal(signal.SIGINT)

        async def operation():
            started.set()
            try: await asyncio.Event().wait()
            finally: cleaned.set()

        with patch("tools.cli_io.sys.stdin.isatty", return_value=True):
            task = asyncio.create_task(cancellable(operation()))
            await started.wait()
            signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(cleaned.is_set())
        self.assertEqual(signal.getsignal(signal.SIGINT), original)

    async def test_successful_task_keeps_its_return_value(self):
        async def operation(): return {"saved": True}
        with patch("tools.cli_io.sys.stdin.isatty", return_value=True):
            self.assertEqual(await cancellable(operation()), {"saved": True})


if __name__ == "__main__":
    unittest.main()
