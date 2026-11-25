"""AI 호출 전 실행 준비 실패를 CLI 설치 문제로 가리지 않고, Windows 자식 프로세스가 콘솔 창을 만들지 않는지 검사한다."""

import asyncio
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, call, patch

from core.client.ai import claude as claude_module
from core.client.ai import codex as codex_module
from core.client.ai.claude import ClaudeAdapter
from core.client.ai.codex import CodexAdapter
from core.client.ai.contracts import AIAdapterError
from core.runtime import client_process
from core.runtime.client_platform import ClientPlatformError, platform_error_code


class PlatformErrorCodeTests(unittest.TestCase):
    def test_known_codes_get_fixed_ai_prefix_and_unknown_errors_are_hidden(self):
        self.assertEqual(platform_error_code(ClientPlatformError("ai_process_job_failed")), "ai_process_job_failed")
        self.assertEqual(platform_error_code(ClientPlatformError("windows_file_unavailable")),
                         "ai_windows_file_unavailable")
        for error in (ClientPlatformError("C:\\Users\\private\\token"), OSError("ai_process_job_failed"),
                      ValueError("windows_file_unavailable")):
            with self.subTest(error=type(error).__name__):
                self.assertIsNone(platform_error_code(error))


class PreflightErrorTests(unittest.IsolatedAsyncioTestCase):
    """준비 실패는 고정 코드로 남기고, 그 밖의 실행 실패만 CLI 사용 불가로 둔다."""

    async def check(self, module, adapter_type, error):
        adapter = adapter_type(cli="fixture-cli")
        with patch.object(module, "cli_command", return_value=["fixture-cli"]), \
                patch.object(module, "_execute", AsyncMock(side_effect=error)):
            with self.assertRaises(AIAdapterError) as raised:
                await adapter.preflight()
        return raised.exception.code

    async def test_job_failure_is_not_reported_as_missing_cli(self):
        for module, adapter_type in ((claude_module, ClaudeAdapter), (codex_module, CodexAdapter)):
            with self.subTest(adapter=adapter_type.__name__):
                self.assertEqual(await self.check(module, adapter_type, ClientPlatformError("ai_process_job_failed")),
                                 "ai_process_job_failed")
                self.assertEqual(await self.check(module, adapter_type, FileNotFoundError("fixture-cli")),
                                 "ai_cli_unavailable")
                self.assertEqual(await self.check(module, adapter_type, ClientPlatformError("raw C:\\path")),
                                 "ai_cli_unavailable")


class CliCapabilityTests(unittest.IsolatedAsyncioTestCase):
    """각 제공자의 도움말·실행 경계와 성공 시에만 재사용하는 준비 결과를 검사한다."""

    adapters = ((codex_module, CodexAdapter, ("exec", "--help")),
                (claude_module, ClaudeAdapter, ("--help",)))

    async def test_provider_help_and_cached_version_keep_their_execution_boundary(self):
        environment = {"PATH": "/fixture/bin"}
        version = "한글" * 120
        for module, adapter_type, help_arguments in self.adapters:
            other = claude_module if module is codex_module else codex_module
            with self.subTest(adapter=adapter_type.__name__), \
                    patch.object(module, "cli_command", return_value=["fixture-cli"]) as command, \
                    patch.object(module, "_execute", AsyncMock(side_effect=[
                        (0, f"  {version}\n".encode(), b""),
                        (0, " ".join(module._REQUIRED_FLAGS).encode(), b""),
                    ])) as execute, \
                    patch.object(other, "cli_command", side_effect=AssertionError("wrong provider")), \
                    patch.object(other, "_execute", side_effect=AssertionError("wrong provider")):
                adapter = adapter_type(cli="fixture-cli")
                result = await adapter._check(environment)
                self.assertEqual(result, (["fixture-cli"], version[:200]))
                self.assertIs(await adapter._check(environment), result)
                self.assertEqual(command.call_args_list, [call("fixture-cli"), call("fixture-cli")])
                self.assertEqual(execute.await_args_list, [
                    call(["fixture-cli", "--version"], directory=None, environment=environment),
                    call(["fixture-cli", *help_arguments], directory=None, environment=environment),
                ])
                command.side_effect = ClientPlatformError("ai_cli_unavailable")
                with self.assertRaisesRegex(AIAdapterError, "ai_cli_unavailable"):
                    await adapter._check(environment)
                self.assertIs(adapter._capabilities, result)
                self.assertEqual(execute.await_count, 2)

    async def test_failed_probe_never_caches_and_a_later_probe_can_retry(self):
        version = (0, b"fixture 1.0", b"")
        for module, adapter_type, _ in self.adapters:
            help_output = (0, " ".join(module._REQUIRED_FLAGS).encode(), b"")
            failures = (
                ([(1, b"", b"")], AIAdapterError, "ai_cli_unavailable"),
                ([version, (1, b"", b"")], AIAdapterError, "ai_cli_unavailable"),
                ([version, (0, b"missing options", b"")], AIAdapterError, "ai_cli_incompatible"),
                ([version, asyncio.CancelledError()], asyncio.CancelledError, None),
                ([(0, b"\xff", b"")], UnicodeDecodeError, None),
            )
            for responses, error_type, code in failures:
                with self.subTest(adapter=adapter_type.__name__, failure=code or error_type.__name__), \
                        patch.object(module, "cli_command", return_value=["fixture-cli"]), \
                        patch.object(module, "_execute", AsyncMock(side_effect=responses)) as execute:
                    adapter = adapter_type(cli="fixture-cli")
                    with self.assertRaises(error_type) as raised:
                        await adapter._check({})
                    if code is not None:
                        self.assertEqual(raised.exception.code, code)
                    self.assertIsNone(adapter._capabilities)
                    execute.side_effect = [version, help_output]
                    self.assertEqual(await adapter._check({}), (["fixture-cli"], "fixture 1.0"))


class ClaudeRunErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_job_failure_during_call_is_not_reported_as_invalid_result(self):
        adapter = ClaudeAdapter(cli="fixture-cli")
        adapter._capabilities = (["fixture-cli"], "fixture 1.0")
        with TemporaryDirectory() as root, \
                patch.object(adapter, "preflight", AsyncMock()), \
                patch.object(claude_module, "_execute",
                             AsyncMock(side_effect=ClientPlatformError("ai_process_job_failed"))):
            # 어댑터는 심볼릭 링크를 지나는 폴더를 거부하므로 macOS의 /var를 실제 경로로 푼다.
            directory = Path(root).resolve() / "invocation"
            with self.assertRaises(AIAdapterError) as raised:
                await adapter.run(prompt="연결 확인", schema={"type": "object"}, directory=directory)
            execution = json.loads((directory / "execution.json").read_bytes())
        self.assertEqual(raised.exception.code, "ai_process_job_failed")
        self.assertEqual(execution["error_code"], "ai_process_job_failed")
        self.assertEqual(execution["status"], "failed")


class WindowsConsoleWindowTests(unittest.TestCase):
    """앱이 띄운 Python은 콘솔이 없으므로 자식 콘솔 프로그램도 창 없이 시작해야 한다."""

    def windows_flags(self):
        return patch.multiple(subprocess, create=True, CREATE_NO_WINDOW=0x08000000,
                              CREATE_NEW_PROCESS_GROUP=0x00000200)

    def test_owned_processes_start_without_console_window_on_windows(self):
        with self.windows_flags(), patch.object(client_process, "is_windows", return_value=True):
            self.assertEqual(client_process.spawn_options(), {"creationflags": 0x08000200})
            self.assertEqual(client_process.no_window_options(), {"creationflags": 0x08000000})

    def test_posix_keeps_process_group_and_adds_no_creation_flags(self):
        with patch.object(client_process, "is_windows", return_value=False):
            self.assertEqual(client_process.spawn_options(), {"start_new_session": True})
            self.assertEqual(client_process.no_window_options(), {})

    def test_bootstrap_child_is_started_without_console_window(self):
        source = (Path(client_process.__file__).with_name("windows_cli_bootstrap.py")).read_text(encoding="utf-8")
        self.assertIn('creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)', source)


if __name__ == "__main__":
    unittest.main()
