"""검색어 CLI가 실제 실패 유형만 공개하고 원시 오류는 감추는지 검사한다."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from core.client.ai.contracts import AIAdapterError
from core.runtime.client_platform import ClientPlatformError
from tools import search_terms_cli


class SearchTermsPlatformErrorTests(unittest.TestCase):
    def invoke(self, *, error=None, value=None, question="연결 확인"):
        """실제 main의 파일 읽기·어댑터 실행·JSON 출력까지 격리해 호출한다."""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            question_file = root / "question.txt"
            question_file.write_text(question, encoding="utf-8")
            run = AsyncMock(side_effect=error, return_value={"value": value})
            adapter = SimpleNamespace(run=run)
            output, errors = StringIO(), StringIO()
            with patch.object(search_terms_cli, "create_adapter", return_value=adapter) as factory, \
                    redirect_stdout(output), redirect_stderr(errors):
                code = search_terms_cli.main([
                    "--work-dir", str(root / "work"),
                    "--question-file", str(question_file),
                    "--ai-provider", "claude", "--ai-cli", "fixture-cli",
                ])
            self.assertEqual(question_file.read_text(encoding="utf-8"), question)
            self.assertEqual(errors.getvalue(), "")
            raw = output.getvalue()
            self.assertEqual(len(raw.splitlines()), 1)
            return code, json.loads(raw), run, factory, raw

    def test_fixed_platform_errors_reach_cli_result_without_raw_exception(self):
        expected = {
            "windows_security_dependency_missing": "ai_windows_security_dependency_missing",
            "windows_directory_unavailable": "ai_windows_directory_unavailable",
            "windows_file_unavailable": "ai_windows_file_unavailable",
            "private_directory_required": "ai_private_directory_required",
            "private_file_required": "ai_private_file_required",
            "unsupported_file_acl": "ai_unsupported_file_acl",
            "unsafe_file_path": "ai_unsafe_file_path",
            "file_limit": "ai_file_limit",
            "file_changed": "ai_file_changed",
            "ai_cli_unavailable": "ai_cli_unavailable",
            "ai_cli_native_executable_required": "ai_cli_native_executable_required",
            "ai_process_job_failed": "ai_process_job_failed",
        }
        for failure, result in expected.items():
            with self.subTest(failure=failure):
                code, output, run, _, _ = self.invoke(error=ClientPlatformError(failure))
                self.assertEqual(code, 1)
                self.assertEqual(output, {
                    "protocol": "search-terms-cli-v1", "ok": False,
                    "error": {"code": result},
                })
                run.assert_awaited_once()

    def test_unknown_errors_and_lookalike_types_do_not_expose_paths_or_tokens(self):
        secret = "C:\\Users\\private\\token=do-not-disclose"
        for error in (
            ClientPlatformError(secret), RuntimeError(secret),
            ValueError("windows_file_unavailable"),
            ClientPlatformError("windows_file_unavailable " + secret),
        ):
            with self.subTest(error_type=type(error).__name__):
                code, output, _, _, raw = self.invoke(error=error)
                self.assertEqual(code, 1)
                self.assertEqual(output["error"], {"code": "search_terms_failed"})
                self.assertNotIn(secret, raw)
                self.assertNotIn("do-not-disclose", raw)

    def test_existing_ai_error_and_grouped_error_codes_keep_their_contract(self):
        for error in (
            AIAdapterError("ai_timeout"),
            ExceptionGroup("private diagnostic", [AIAdapterError("ai_timeout"), AIAdapterError("ai_timeout")]),
        ):
            with self.subTest(error_type=type(error).__name__):
                code, output, _, _, raw = self.invoke(error=error)
                self.assertEqual(code, 1)
                self.assertEqual(output["error"], {"code": "ai_timeout"})
                self.assertNotIn("private diagnostic", raw)

    def test_success_still_uses_question_file_and_normalizes_terms(self):
        code, output, run, factory, _ = self.invoke(value={"terms": [" 연결 ", "연결", "API", "x", 12]})
        self.assertEqual(code, 0)
        self.assertEqual(output, {"protocol": "search-terms-cli-v1", "ok": True, "terms": ["연결", "API"]})
        factory.assert_called_once_with("claude", cli="fixture-cli", model=None, timeout_seconds=60)
        self.assertTrue(run.call_args.kwargs["prompt"].endswith("QUESTION:\n연결 확인"))
        self.assertEqual(run.call_args.kwargs["directory"].name, "invocation")

    def test_empty_question_never_creates_or_calls_adapter(self):
        code, output, run, factory, _ = self.invoke(question="")
        self.assertEqual(code, 1)
        self.assertEqual(output["error"], {"code": "invalid_question"})
        factory.assert_not_called()
        run.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
