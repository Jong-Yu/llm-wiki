"""실제 모델 없이 Windows 앱 호출 관측·비밀 제거·설정 보존을 검사한다."""

from contextlib import redirect_stderr, redirect_stdout
from hashlib import sha256
from io import StringIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.client.ai.contracts import AIAdapterError
from core.client.ai.claude import _Events as RuntimeEvents
from core.runtime.client_platform import ClientPlatformError
from tools import claude_call_diagnostic as diagnostic
from tools import search_terms_cli


SECRET = "PRIVATE-ACCOUNT-TOKEN-DO-NOT-EXPORT"


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.runtime = self.root / "runtime"
        for name in diagnostic._SOURCES:
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# fixture\n", encoding="utf-8")
        self.environment = {"APPDATA": str(self.root / "appdata"), "PATH": "fixture-bin",
                            "HOME": str(self.root / SECRET), "USER": SECRET,
                            "CLAUDE_CONFIG_DIR": str(self.root / "claude-login"),
                            "HTTPS_PROXY": "https://" + SECRET,
                            "ANTHROPIC_API_KEY": SECRET, "WIKI_TOKEN": SECRET}

    def profile(self, *, name="llm-wiki-app", runtime=None, python=None):
        path = Path(self.environment["APPDATA"]) / name / "runtime-settings" / "runtime.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        settings = {"root": str(runtime or self.runtime), "python": python or sys.executable,
                    "claude": str(self.root / SECRET / "claude.exe"), "provider": "claude",
                    "codex": "codex",
                    "models": {"claude": "custom-model", "codex": "default"},
                    "tesseract": "", "tessdata": ""}
        path.write_text(json.dumps({"version": 2, "settings": settings}), encoding="utf-8")
        return path

    def modules(self, *, error=None, subtype="init", exit_code=0, stderr=b"",
                version_output=None, real_events=False, system_extra=None):
        observed = {"calls": [], "environment": [], "work": None, "original_events": None}

        class Events:
            def __init__(self, **kwargs):
                self.result = None

            def __call__(self, line, callback):
                value = json.loads(line)
                if value.get("subtype") == "hook_response":
                    raise AIAdapterError("ai_cli_event_rejected", event="system:hook_response")
                if value.get("type") == "result":
                    self.result = value["structured_output"]
                callback({"text": SECRET})

        async def execute(arguments, **kwargs):
            observed["calls"].append(arguments)
            observed["environment"].append(dict(os.environ))
            print(SECRET)
            if "--print" in arguments:
                if error:
                    raise error
                parser = kwargs["event_parser"]
                parser(json.dumps({"type": "system", "subtype": subtype, "account": SECRET,
                                   **(system_extra or {})}), lambda _: None)
                parser(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                                   "structured_output": {"terms": [SECRET]}}), lambda _: None)
                return exit_code, SECRET.encode(), stderr
            return 0, version_output if "--version" in arguments and version_output is not None else SECRET.encode(), b""

        parser_type = RuntimeEvents if real_events else Events
        claude = SimpleNamespace(_Events=parser_type, _execute=execute)
        observed["original_events"], observed["original_execute"] = parser_type, execute

        class Adapter:
            async def run(self, *, prompt, schema, directory):
                observed["work"] = directory
                observed["prompt"] = prompt
                for phase in ("--version", "--help"):
                    await claude._execute(["claude.exe", phase])
                parser = claude._Events(web_search=False)
                code, _, _ = await claude._execute(["claude.exe", "--print"], event_parser=parser)
                if code:
                    raise AIAdapterError("ai_login_or_execution_failed")
                return {"value": parser.result}

        return claude, Adapter(), observed

    def collect(self, **kwargs):
        claude, adapter, observed = self.modules(**kwargs)
        before = dict(os.environ)
        with patch.object(diagnostic, "_load_runtime", return_value=(search_terms_cli, claude)), \
                patch.object(search_terms_cli, "create_adapter", return_value=adapter) as factory, \
                redirect_stdout(StringIO()) as output, redirect_stderr(StringIO()) as errors:
            report, settings = diagnostic.collect(self.runtime, True, source_environment=self.environment)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(dict(os.environ), before)
        self.assertIs(claude._Events, observed["original_events"])
        self.assertIs(claude._execute, observed["original_execute"])
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn(str(self.root), json.dumps(report))
        return report, factory, observed

    def test_metadata_only_never_imports_or_calls_cli_and_profiles_are_unchanged(self):
        profile = self.profile()
        original = profile.read_bytes()
        with patch.object(diagnostic, "_load_runtime", side_effect=AssertionError("must not import")):
            report, settings = diagnostic.collect(self.runtime, source_environment=self.environment)
        self.assertEqual(report["status"], "metadata_only")
        self.assertEqual(report["model_attempts"], 0)
        self.assertEqual(profile.read_bytes(), original)
        self.assertEqual(settings["model"], "custom-model")
        self.assertTrue(report["runtime_matches_bundled"])
        self.assertEqual(report["network_environment_names"], ["HTTPS_PROXY"])
        self.assertTrue(all(len(value) == 64 for value in report["source_sha256"].values()))

    def test_success_uses_one_exact_app_call_filters_environment_and_cleans_only_own_files(self):
        self.profile()
        unrelated = self.root / "keep.txt"
        unrelated.write_text(SECRET)
        report, factory, observed = self.collect()
        self.assertEqual(report["status"], "success")
        self.assertEqual(report["model_attempts"], 1)
        factory.assert_called_once_with("claude", cli=str(self.root / SECRET / "claude.exe"),
                                        model="custom-model", timeout_seconds=45)
        self.assertTrue(observed["prompt"].endswith("연결 확인"))
        self.assertEqual([item["phase"] for item in report["cli_stages"]], ["--version", "--help", "--print"])
        self.assertEqual([item["exit_code"] for item in report["cli_stages"]], [0, 0, 0])
        self.assertEqual(report["events"], [{"type": "system", "subtype": "init"},
                                            {"type": "result", "subtype": "success"}])
        self.assertEqual(report["cleanup"], "complete")
        self.assertFalse(observed["work"].parent.exists())
        self.assertEqual(unrelated.read_text(), SECRET)
        for values in observed["environment"]:
            self.assertNotIn("WIKI_TOKEN", values)
            self.assertNotIn("ANTHROPIC_API_KEY", values)
            # 프록시·인증서 설정은 터미널의 claude와 같게 넘긴다(D-143). 값은 보고서에 남지 않는다.
            self.assertEqual(values["HTTPS_PROXY"], self.environment["HTTPS_PROXY"])
            self.assertEqual(values["CLAUDE_CONFIG_DIR"], self.environment["CLAUDE_CONFIG_DIR"])
            self.assertEqual(values["PYTHONNOUSERSITE"], "1")

    def test_original_parser_rejection_remains_a_failure_without_retry(self):
        self.profile()
        report, factory, observed = self.collect(subtype="hook_response")
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["exception"][0]["category"], "adapter_error")
        self.assertEqual(report["exception"][0]["code"], "ai_cli_event_rejected")
        self.assertEqual(report["events"], [{"type": "system", "subtype": "hook_response"}])
        self.assertEqual(report["cli_stages"][-1]["status"], "raised")
        self.assertEqual(len(observed["calls"]), 3)
        self.assertEqual(report["cleanup"], "complete")

    def test_preflight_failure_does_not_count_as_a_model_call(self):
        self.profile()
        claude, _, _ = self.modules()
        with patch.object(diagnostic, "_load_runtime", return_value=(search_terms_cli, claude)), \
                patch.object(search_terms_cli, "create_adapter", side_effect=AIAdapterError("ai_cli_unavailable")):
            report, _ = diagnostic.collect(self.runtime, True, source_environment=self.environment)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["model_attempts"], 0)
        self.assertEqual(report["cli_stages"], [])
        self.assertEqual(report["exception"][0]["code"], "ai_cli_unavailable")

    def test_v3_real_parser_accepts_notices_and_rejects_isolation_breaks(self):
        self.profile()
        report, _, observed = self.collect(subtype="informational", real_events=True,
                                           version_output=b"2.1.319 (Claude Code)\n")
        self.assertEqual(report["protocol"], "claude-call-diagnostic-v3")
        self.assertEqual(report["cli_version"], "2.1.319")
        self.assertEqual(report["status"], "success")
        self.assertEqual(report["events"], [{"type": "system", "subtype": "informational"},
                                            {"type": "result", "subtype": "success"}])
        for subtype, extra in (("hook_started", None), ("informational", {"prevent_continuation": True})):
            with self.subTest(subtype=subtype):
                rejected, _, _ = self.collect(subtype=subtype, real_events=True, system_extra=extra)
                self.assertEqual(rejected["status"], "failed")
                self.assertEqual(rejected["exception"][0]["code"], "ai_cli_event_rejected")
        self.assertEqual(report["model_attempts"], 1)
        self.assertEqual(len(observed["calls"]), 3)
        self.assertEqual(report["cleanup"], "complete")
        self.assertEqual(set(report["source_sha256"]), {
            "core/runtime/client_platform.py", "core/runtime/client_process.py",
            "core/client/ai/claude.py", "tools/search_terms_cli.py"})

    def test_notice_summary_exposes_known_names_and_field_presence_only(self):
        for subtype in ("informational", "notification", "model_refusal_fallback", "model_refusal_no_fallback"):
            with self.subTest(subtype=subtype):
                result = diagnostic.event_summary(json.dumps({
                    "type": "system", "subtype": subtype, "message": SECRET,
                    "hook_name": SECRET, "level": SECRET, "account": SECRET, SECRET: SECRET,
                }))
                expected = {"type": "system", "subtype": subtype,
                            "fields_present": ["hook_name", "level", "message"]}
                if subtype == "informational":
                    expected["level"] = "other"
                self.assertEqual(result, expected)
                self.assertNotIn(SECRET, json.dumps(result))

    def test_notification_and_informational_classifiers_do_not_export_content(self):
        notification = diagnostic.event_summary(json.dumps({
            "type": "system", "subtype": "notification", "key": "config-two-files",
            "text": SECRET, "priority": "high", "color": SECRET,
        }))
        self.assertEqual(notification, {"type": "system", "subtype": "notification",
                                        "key": "config-two-files", "priority": "high",
                                        "fields_present": ["color", "key", "priority", "text"]})
        informational = diagnostic.event_summary(json.dumps({
            "type": "system", "subtype": "informational", "tag": "hook_no_verdict",
            "content": SECRET, "level": "warning", "prevent_continuation": True,
        }))
        self.assertEqual(informational, {"type": "system", "subtype": "informational",
                                         "tag": "hook_no_verdict", "level": "warning",
                                         "prevent_continuation": True,
                                         "fields_present": ["content", "level", "prevent_continuation", "tag"]})
        for subtype, field in (("notification", "key"), ("informational", "tag")):
            for value in (SECRET, {"secret": SECRET}):
                result = diagnostic.event_summary(json.dumps({"type": "system", "subtype": subtype,
                                                              field: value, "content": SECRET}))
                self.assertEqual(result[field], "other")
                if isinstance(value, str):
                    self.assertEqual(result[field + "_sha256"], sha256(SECRET.encode()).hexdigest())
                self.assertNotIn(SECRET, json.dumps(result))

    def test_unknown_notice_name_is_fingerprinted_without_exposing_raw_data(self):
        result = diagnostic.event_summary(json.dumps({"type": "system", "subtype": SECRET,
                                                       "message": SECRET}))
        self.assertEqual(result, {"type": "system", "subtype": "other",
                                  "subtype_sha256": sha256(SECRET.encode()).hexdigest(),
                                  "fields_present": ["message"]})
        self.assertNotIn(SECRET, json.dumps(result))
        for raw in ("broken " + SECRET, "null", "[]"):
            self.assertEqual(diagnostic.event_summary(raw), {"type": "invalid_json", "subtype": None})

    def test_version_output_keeps_only_exact_numeric_cli_version(self):
        for raw in (b"2.1.319 (Claude Code)\r\n", b"2.1.319\n"):
            self.assertEqual(diagnostic.cli_version(raw), "2.1.319")
        for raw in (SECRET.encode(), b"2.1.319 " + SECRET.encode(), b"2.1.319\n" + SECRET.encode(),
                    b"2.1.319-" + SECRET.encode(), b"2.1.319 (Claude Code)" + b" " * 257, None):
            self.assertIsNone(diagnostic.cli_version(raw))

    def test_nonzero_exit_and_stderr_are_only_fixed_labels(self):
        self.profile()
        report, _, _ = self.collect(exit_code=7, stderr=("TLS certificate " + SECRET).encode())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["cli_stages"][-1]["exit_code"], 7)
        self.assertEqual(report["cli_stages"][-1]["stderr_category"], "tls")
        self.assertEqual(report["exception"][0]["code"], "ai_login_or_execution_failed")

    def test_exception_frames_only_contain_runtime_modules_and_no_exception_message(self):
        path = self.runtime / "core/runtime/client_platform.py"
        code = compile("def fail():\n    raise AttributeError('" + SECRET + "')\nfail()", str(path), "exec")
        try:
            exec(code, {})
        except AttributeError as error:
            error.winerror = 5
            report = diagnostic.safe_exception(error, self.runtime)
        self.assertEqual(report[0]["category"], "attribute_error")
        self.assertEqual(report[0]["winerror"], 5)
        self.assertEqual(report[0]["frames"][-1], {"module": "core.runtime.client_platform", "function": "fail", "line": 2})
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn(str(self.root), json.dumps(report))

    def test_platform_exception_only_retains_exact_known_codes(self):
        for source, expected in (("private_directory_required", "ai_private_directory_required"),
                                 ("ai_process_job_failed", "ai_process_job_failed"),
                                 (SECRET + str(self.root), None)):
            with self.subTest(source=source):
                report = diagnostic.safe_exception(ClientPlatformError(source), self.runtime)
                self.assertEqual(report[0]["category"], "platform_error")
                self.assertEqual(report[0]["code"], expected)
                self.assertNotIn(SECRET, json.dumps(report))
                self.assertNotIn(str(self.root), json.dumps(report))

    def test_ambiguous_invalid_and_mismatched_profiles_do_not_attempt_model(self):
        profile = self.profile()
        self.profile(name="LLM Wiki")
        with patch.object(diagnostic, "_load_runtime", side_effect=AssertionError("must not import")):
            report, _ = diagnostic.collect(self.runtime, True, source_environment=self.environment)
        self.assertEqual(report["status"], "profile_ambiguous")
        self.assertEqual(report["model_attempts"], 0)
        profile.unlink()
        other = self.profile(name="LLM Wiki", python=str(self.root / "other-python.exe"))
        report, _ = diagnostic.collect(self.runtime, True, source_environment=self.environment, worker=True)
        self.assertEqual(report["status"], "python_mismatch")
        self.assertEqual(report["model_attempts"], 0)
        other.write_text("invalid " + SECRET)
        report, _ = diagnostic.collect(self.runtime, True, source_environment=self.environment)
        self.assertEqual(report["status"], "profile_invalid")
        self.assertNotIn(SECRET, json.dumps(report))

    def test_cleanup_failure_is_separate_and_does_not_replace_original_failure(self):
        self.profile()
        actual_rmtree = diagnostic.shutil.rmtree
        captured = []

        def fail_cleanup(path):
            captured.append(path)
            raise OSError(SECRET)

        try:
            with patch.object(diagnostic.shutil, "rmtree", side_effect=fail_cleanup):
                report, _, _ = self.collect(error=AttributeError(SECRET))
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["exception"][0]["category"], "attribute_error")
            self.assertEqual(report["cleanup"], "failed")
            self.assertTrue(captured[0].exists())
        finally:
            for path in captured:
                actual_rmtree(path)

    def test_profile_shape_size_and_links_match_app_rejections(self):
        profile = self.profile()
        original = profile.read_bytes()
        value = json.loads(original)
        value["settings"].pop("provider")
        profile.write_text(json.dumps(value))
        self.assertEqual(diagnostic.select_settings(self.runtime, self.environment)[1], "invalid")
        profile.write_bytes(original + b" " * 32768)
        self.assertEqual(diagnostic.select_settings(self.runtime, self.environment)[1], "invalid")
        profile.unlink()
        target = self.root / "linked.json"
        target.write_bytes(original)
        profile.symlink_to(target)
        self.assertEqual(diagnostic.select_settings(self.runtime, self.environment)[1], "invalid")
        self.assertEqual(target.read_bytes(), original)

    def test_main_writes_json_txt_and_preserves_existing_report(self):
        output = self.root / "report.txt"
        output.write_text(SECRET)
        with patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(output)]), 0)
        self.assertEqual(output.read_text(), SECRET)
        report = json.loads((self.root / "report-1.txt").read_text())
        self.assertEqual(report["status"], "metadata_only")
        self.assertNotIn(SECRET, json.dumps(report))

    def test_python_relaunch_is_structured_and_cannot_repeat(self):
        self.profile(python=str(self.root / "different-python.exe"))
        output = self.root / "report.txt"
        def child_writes_report(*args, **kwargs):
            diagnostic.write_report(output, {"status": "failed"})
            return SimpleNamespace(returncode=1)

        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(diagnostic.subprocess, "run", side_effect=child_writes_report) as run:
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(output), "--test"]), 1)
        arguments = run.call_args.args[0]
        self.assertIsInstance(arguments, list)
        self.assertIn("--worker", arguments)
        # 작업 프로세스는 앱과 같은 환경을 받으므로 네트워크 설정 이름을 따로 넘기지 않는다.
        self.assertEqual(run.call_args.kwargs["env"]["HTTPS_PROXY"], self.environment["HTTPS_PROXY"])
        self.assertNotIn("ANTHROPIC_API_KEY", run.call_args.kwargs["env"])
        with patch.dict(os.environ, self.environment, clear=True), patch.object(diagnostic.subprocess, "run") as run:
            worker_output = self.root / "worker.txt"
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(worker_output), "--test", "--worker"]), 1)
            run.assert_not_called()
        self.assertEqual(json.loads(worker_output.read_text())["status"], "python_mismatch")

    def test_broken_relaunch_returning_one_without_report_creates_fallback_report(self):
        self.profile(python=str(self.root / "broken-python.exe"))
        output = self.root / "report.txt"
        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(diagnostic.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(output), "--test"]), 1)
        self.assertEqual(json.loads(output.read_text())["status"], "relaunch_failed")

    def test_early_collection_failure_is_reported_without_raw_traceback_or_path(self):
        output = self.root / "report.txt"
        error = OSError(SECRET + str(self.root))
        error.winerror = 5
        with patch.object(diagnostic, "collect", side_effect=error), \
                redirect_stdout(StringIO()) as stdout, redirect_stderr(StringIO()) as stderr:
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(output), "--test"]), 1)
        report = json.loads(output.read_text())
        self.assertEqual(report["status"], "diagnostic_failed")
        self.assertEqual(report["exception"][0]["category"], "os_error")
        self.assertEqual(report["exception"][0]["winerror"], 5)
        self.assertNotIn(SECRET, output.read_text())
        self.assertNotIn(str(self.root), output.read_text())
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_runtime_path_resolution_failure_still_writes_safe_report(self):
        output = self.root / "report.txt"
        original_resolve = Path.resolve
        def fail_runtime(path, *args, **kwargs):
            if path == self.runtime:
                raise RuntimeError(SECRET)
            return original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", fail_runtime), \
                redirect_stdout(StringIO()) as stdout, redirect_stderr(StringIO()) as stderr:
            self.assertEqual(diagnostic.main(["--runtime", str(self.runtime), "--output", str(output)]), 1)
        report = json.loads(output.read_text())
        self.assertEqual(report["status"], "diagnostic_failed")
        self.assertEqual(report["exception"][0]["frames"], [])
        self.assertNotIn(SECRET, output.read_text())
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_launcher_is_ascii_crlf_with_explicit_test_and_quoted_paths(self):
        raw = Path("app/scripts/diagnose-claude-windows.cmd").read_bytes()
        raw.decode("ascii")
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
        self.assertIn(b"setlocal DisableDelayedExpansion\r\n", raw)
        self.assertIn(b'"%DIAGNOSTIC_PYTHON%" -B "%DIAGNOSTIC_ROOT%claude_call_diagnostic.py"', raw)
        self.assertIn(b'--runtime "%DIAGNOSTIC_RUNTIME%"', raw)
        self.assertIn(b"--test --open-report", raw)


if __name__ == "__main__":
    unittest.main()
