"""Standalone, opt-in observation of the app's Claude connection call.

Place this file beside LLM Wiki.exe. No runtime/configuration files are changed.
Reports contain fixed labels and code locations, never model output or paths.
"""

import argparse
import asyncio
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from hashlib import sha256
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace


# 앱이 Claude에 넘기는 프록시·인증서·Git Bash 설정(D-143). 값은 보고서에 넣지 않고 이름만 적는다.
_NETWORK = (
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_GIT_BASH_PATH",
)
_APP_ENV = (
    "PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", *_NETWORK,
)
_PROTOCOL = "claude-call-diagnostic-v3"
_SOURCES = ("core/runtime/client_platform.py", "core/runtime/client_process.py",
            "core/client/ai/claude.py", "tools/search_terms_cli.py")
_TYPES = frozenset(("system", "assistant", "user", "result", "rate_limit_event", "auth_status",
                    "tool_progress", "tool_use_summary", "stream_event"))
_SUBTYPES = frozenset((
    "init", "status", "api_retry", "compact_boundary", "thinking_tokens", "success",
    "error_max_turns", "error_during_execution", "error_max_budget_usd",
    "error_max_structured_output_retries", "hook_started", "hook_progress", "hook_response",
    "task_started", "task_progress", "task_notification", "local_command_output",
    "stop_hook_summary", "bridge_status",
    "informational", "notification", "model_refusal_fallback", "model_refusal_no_fallback",
    "background_tasks_changed", "commands_changed", "control_request_progress",
    "elicitation_complete", "files_persisted", "memory_recall", "mirror_error",
    "permission_denied", "plugin_install", "session_state_changed", "session_writes_lost",
    "task_updated", "worker_shutting_down",
))
# SDK 0.3.328의 타입과 CLI 2.1.327에서 확인한 분류만 기록한다. 앱의 허용 목록은 바꾸지 않는다.
_SYSTEM_FIELDS = frozenset(("message", "level", "hook_id", "hook_name", "hook_event",
                            "systemMessage", "system_message", "stdout", "stderr", "output",
                            "error", "status", "model", "replacement_model", "text", "key",
                            "priority", "color", "timeout_ms", "content", "tag", "tool_use_id",
                            "prevent_continuation"))
_NOTICE_KEYS = frozenset(("config-two-files", "error-compacting-conversation", "fast-mode-overage-rejected"))
_NOTICE_TAGS = frozenset(("account_skills_refused_in_sandbox", "connector_files", "hook_no_verdict",
                         "no_bash_shell", "permission_rule_not_saved"))
_CODES = frozenset((
    "search_terms_failed", "ai_cli_unavailable", "ai_cli_incompatible",
    "ai_windows_dependency_missing", "ai_cli_native_executable_required", "ai_process_job_failed",
    "ai_invalid_events", "ai_unexpected_tool_activity", "ai_cli_event_rejected", "ai_execution_failed", "ai_rate_limited",
    "ai_login_or_execution_failed", "ai_incomplete_turn", "ai_invalid_result", "ai_invalid_json",
    "ai_invalid_schema", "ai_invalid_input", "ai_input_limit", "ai_unsafe_directory",
    "ai_timeout", "ai_session_mismatch", "ai_windows_security_dependency_missing",
    "ai_windows_directory_unavailable", "ai_windows_file_unavailable", "ai_private_directory_required",
    "ai_private_file_required", "ai_unsupported_file_acl", "ai_unsafe_file_path", "ai_file_limit",
    "ai_file_changed",
))


def _same_path(first, second):
    return os.path.normcase(str(Path(first).resolve())) == os.path.normcase(str(Path(second).resolve()))


def select_settings(runtime, environment):
    """Read only the two known app profiles; never guess between existing profiles."""
    appdata = environment.get("APPDATA")
    profiles = [Path(appdata) / name / "runtime-settings" / "runtime.json"
                for name in ("llm-wiki-app", "LLM Wiki")] if appdata else []
    try:
        profiles = [path for path in profiles if os.path.lexists(path)]
    except OSError:
        return None, "invalid", 1
    if len(profiles) > 1:
        return None, "ambiguous", len(profiles)
    if profiles:
        try:
            info = profiles[0].lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 32768:
                raise ValueError()
            with profiles[0].open("rb") as stream:
                raw = stream.read(32769)
            if len(raw) > 32768:
                raise ValueError()
            value = json.loads(raw)
            if set(value) != {"version", "settings"} or value.get("version") not in (1, 2):
                raise ValueError()
            settings = value["settings"]
            required = {"root", "python", "codex", "tesseract", "tessdata"}
            if value["version"] == 2:
                required |= {"provider", "claude"}
            if not required <= set(settings) or set(settings) - required - {"models"}:
                raise ValueError()
            if value["version"] == 2 and settings["provider"] not in ("codex", "claude"):
                raise ValueError()
            for key in required - {"provider"}:
                if not isinstance(settings[key], str) or len(settings[key]) > 4096 or "\x00" in settings[key]:
                    raise ValueError()
            for key in ("root", "python", "claude"):
                item = settings.get(key, "claude" if key == "claude" else None)
                if not isinstance(item, str) or not item or len(item) > 4096 or "\x00" in item:
                    raise ValueError()
                settings[key] = item
            models = settings.get("models", {})
            if not isinstance(models, dict) or set(models) - {"claude", "codex"}:
                raise ValueError()
            for model in models.values():
                if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}", model):
                    raise ValueError()
            model = models.get("claude", "default")
            settings = {key: settings[key] for key in ("root", "python", "claude")} | {
                "model": None if model == "default" else model}
            # These two optional settings affect the app's child environment only.
            stored = value["settings"]
            for key in ("tesseract", "tessdata"):
                item = stored.get(key, "")
                if not isinstance(item, str) or len(item) > 4096 or "\x00" in item:
                    raise ValueError()
                settings[key] = item
            return settings, "selected", 1
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return None, "invalid", 1
    native = Path(environment.get("USERPROFILE", "")) / ".local" / "bin" / "claude.exe"
    return {"root": str(runtime), "python": sys.executable,
            "claude": str(native) if native.is_file() else "claude", "model": None,
            "tesseract": "", "tessdata": ""}, "bundled_default", 0


def app_environment(settings, source):
    """Match RuntimeSettingsService.environment without forwarding server/API secrets."""
    result = {key: source[key] for key in _APP_ENV if source.get(key)}
    result["PYTHONNOUSERSITE"] = "1"
    if sys.platform == "darwin":
        parts = [value for value in result.get("PATH", "").split(os.pathsep) if value]
        parts.extend(path for path in ("/opt/homebrew/bin", "/usr/local/bin") if path not in parts)
        result["PATH"] = os.pathsep.join(parts)
    if settings.get("tesseract"):
        result["PATH"] = str(Path(settings["tesseract"]).parent) + os.pathsep + result.get("PATH", "")
    if settings.get("tessdata"):
        result["TESSDATA_PREFIX"] = settings["tessdata"]
    return result


def cli_version(raw):
    """버전 출력은 숫자 세 부분만 남기고 다른 문자열은 보고서에 넣지 않는다."""
    if not isinstance(raw, bytes) or len(raw) > 256:
        return None
    match = re.fullmatch(r"(\d{1,5}\.\d{1,5}\.\d{1,5})(?: \(Claude Code\))?\s*",
                         raw.decode("ascii", errors="replace"))
    return match.group(1) if match else None


def event_summary(line):
    """알려진 이벤트 이름과 필드 존재만 기록하고 미등록 이름·본문은 노출하지 않는다."""
    try:
        event = json.loads(line)
        kind, subtype = event.get("type"), event.get("subtype")
        result = {"type": kind if isinstance(kind, str) and kind in _TYPES else "other",
                  "subtype": subtype if isinstance(subtype, str) and subtype in _SUBTYPES
                  else "other" if subtype else None}
        if isinstance(subtype, str) and subtype and subtype not in _SUBTYPES:
            result["subtype_sha256"] = sha256(subtype.encode("utf-8")).hexdigest()
        if kind == "system":
            fields = sorted(_SYSTEM_FIELDS.intersection(event))
            if fields:
                result["fields_present"] = fields
            labels = ()
            if subtype == "notification":
                labels = (("key", _NOTICE_KEYS), ("priority", ("low", "medium", "high", "immediate")))
            elif subtype == "informational":
                labels = (("tag", _NOTICE_TAGS), ("level", ("info", "notice", "suggestion", "warning")))
                if type(event.get("prevent_continuation")) is bool:
                    result["prevent_continuation"] = event["prevent_continuation"]
            for field, known in labels:
                if field in event:
                    value = event[field]
                    result[field] = value if isinstance(value, str) and value in known else "other"
                    if field in ("key", "tag") and isinstance(value, str) and value not in known:
                        result[field + "_sha256"] = sha256(value.encode("utf-8")).hexdigest()
        return result
    except (ValueError, TypeError, AttributeError, UnicodeError):
        return {"type": "invalid_json", "subtype": None}


def stderr_category(raw):
    """Classify bytes in memory; never return the underlying CLI message."""
    text = raw[:65536].decode("utf-8", errors="replace").lower() if isinstance(raw, bytes) else ""
    for category, markers in (
        ("gitbash", ("git bash", "git-bash", "claude_code_git_bash_path")),
        ("proxy", ("proxy", "407")), ("tls", ("certificate", "tls", "ssl")),
        ("network", ("econn", "enotfound", "network", "fetch failed", "connection timed out")),
        ("auth", ("unauthorized", "authentication", "not logged", "oauth", "401")),
        ("model", ("model not", "unknown model", "invalid model")),
        ("schema", ("json schema", "json-schema", "structured output")),
        ("options", ("unknown option", "unrecognized option", "invalid option")),
    ):
        if any(marker in text for marker in markers):
            return category
    return "unknown" if raw else "none"


def safe_exception(error, runtime):
    """Keep fixed categories and our code locations, including a bounded cause chain."""
    records, seen = [], set()
    try:
        root = runtime.resolve()
    except (OSError, ValueError, RuntimeError):
        root = None
    while error is not None and id(error) not in seen and len(records) < 4:
        seen.add(id(error))
        name = type(error).__name__
        category = {"AIAdapterError": "adapter_error", "ClientPlatformError": "platform_error",
                    "AttributeError": "attribute_error", "TypeError": "type_error",
                    "PermissionError": "permission_error", "TimeoutError": "timeout_error",
                    "ImportError": "import_error", "ModuleNotFoundError": "import_error"}.get(name)
        code = getattr(error, "code", None)
        if name == "ClientPlatformError" and code is None:
            candidate = str(error)
            code = candidate if candidate in _CODES else "ai_" + candidate if "ai_" + candidate in _CODES else None
        item = {"category": category or ("os_error" if isinstance(error, OSError) else "unknown"),
                "code": code if isinstance(code, str) and code in _CODES else None,
                "winerror": getattr(error, "winerror", None) if type(getattr(error, "winerror", None)) is int else None,
                "frames": []}
        event = getattr(error, "event", None)
        if isinstance(event, str) and re.fullmatch(r"(system|type):[a-z][a-z0-9_]{0,63}", event):
            # 앱이 거부한 Claude 메시지의 종류 이름표만 남긴다(본문 없음).
            item["event"] = event
        frame = error.__traceback__
        while frame is not None and root is not None:
            try:
                relative = Path(frame.tb_frame.f_code.co_filename).resolve().relative_to(root)
                if relative.suffix == ".py" and relative.parts[0] in ("core", "tools"):
                    item["frames"].append({"module": ".".join(relative.with_suffix("").parts),
                                           "function": frame.tb_frame.f_code.co_name, "line": frame.tb_lineno})
                    item["frames"] = item["frames"][-12:]
            except (OSError, ValueError, RuntimeError):
                pass
            frame = frame.tb_next
        records.append(item)
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return records


@contextmanager
def _environment(values):
    previous = dict(os.environ)
    os.environ.clear()
    os.environ.update(values)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def _load_runtime(runtime):
    search = importlib.import_module("tools.search_terms_cli")
    claude = importlib.import_module("core.client.ai.claude")
    for module in (search, claude):
        Path(module.__file__).resolve().relative_to(runtime.resolve())
    return search, claude


async def _observe(search, claude, settings, work, report):
    original_execute, original_events = claude._execute, claude._Events

    async def execute(arguments, **kwargs):
        phase = next((flag for flag in ("--version", "--help", "--print") if flag in arguments), "other")
        if phase == "--print":
            report["model_attempts"] += 1
        item = {"phase": phase, "exit_code": None, "stderr_category": "unavailable", "status": "started"}
        report["cli_stages"].append(item)
        try:
            result = await original_execute(arguments, **kwargs)
            code, output, stderr = result
            if phase == "--version" and code == 0:
                report["cli_version"] = cli_version(output)
            item.update(exit_code=code if type(code) is int else None,
                        stderr_category=stderr_category(stderr), status="returned")
            return result
        except BaseException:
            item["status"] = "raised"
            raise

    class Events(original_events):
        def __call__(self, line, callback):
            if len(report["events"]) < 64 and line.strip():
                report["events"].append(event_summary(line))
            # The original parser still makes every acceptance/rejection decision.
            return super().__call__(line, callback)

    claude._execute, claude._Events = execute, Events
    try:
        args = SimpleNamespace(ai_provider="claude", ai_cli=settings["claude"], ai_model=settings["model"],
                               ai_timeout=45, work_dir=work)
        await search.execute(args, "연결 확인")
    finally:
        claude._execute, claude._Events = original_execute, original_events


def collect(runtime, test=False, *, source_environment=None, worker=False):
    source = dict(os.environ if source_environment is None else source_environment)
    report = {"protocol": _PROTOCOL, "test_requested": bool(test), "cli_version": None,
              "status": "metadata_only", "model_attempts": 0, "timeout_seconds": 45,
              "cli_stages": [], "events": [], "exception": [], "cleanup": "not_needed",
              "network_environment_names": [key for key in _NETWORK if source.get(key)]}
    settings, status, count = select_settings(runtime, source)
    report.update(profile_status=status, profile_count=count)
    if settings is None:
        report["status"] = "profile_" + status
        return report, None
    selected = Path(settings["root"]).resolve()
    report.update(runtime_matches_bundled=_same_path(selected, runtime),
                  python_matches_current=_same_path(settings["python"], sys.executable),
                  model_selection="explicit" if settings["model"] is not None else "provider_default")
    report["source_sha256"] = {}
    for name in _SOURCES:
        try:
            report["source_sha256"][name] = sha256((selected / name).read_bytes()).hexdigest()
        except OSError:
            report["source_sha256"][name] = None
    if not test:
        return report, settings
    if not report["python_matches_current"]:
        report["status"] = "python_mismatch" if worker else "relaunch_required"
        return report, settings
    if not selected.is_dir() or any(value is None for value in report["source_sha256"].values()):
        report["status"] = "runtime_unavailable"
        return report, settings
    temporary = None
    imported_path = None
    previous_directory = Path.cwd()
    try:
        # Devnull also suppresses unexpected imported-library output, without retaining it.
        with _environment(app_environment(settings, source)), open(os.devnull, "w") as sink, \
                redirect_stdout(sink), redirect_stderr(sink):
            os.chdir(selected)
            imported_path = str(selected.resolve())
            sys.path.insert(0, imported_path)
            search, claude = _load_runtime(selected)
            temporary = Path(tempfile.mkdtemp(prefix="wiki-claude-diagnostic-")).resolve()
            work = temporary / "work"
            work.mkdir(mode=0o700)
            (temporary / "question.txt").write_text("연결 확인", encoding="utf-8")
            asyncio.run(_observe(search, claude, settings, work, report))
            report["status"] = "success"
    except Exception as error:
        report["status"] = "failed"
        report["exception"] = safe_exception(error, selected)
    finally:
        os.chdir(previous_directory)
        if imported_path is not None:
            sys.path.remove(imported_path)
        if temporary is not None:
            try:
                shutil.rmtree(temporary)
                report["cleanup"] = "complete"
            except OSError:
                report["cleanup"] = "failed"
    return report, settings


def _report_candidates(output):
    for index in range(100):
        yield output if index == 0 else output.with_name(f"{output.stem}-{index}{output.suffix}")


def write_report(output, report):
    """Create a new report, preserving a pre-existing user file at the requested name."""
    for candidate in _report_candidates(output):
        try:
            with candidate.open("x", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=True, indent=2, allow_nan=False)
                stream.write("\n")
            return candidate
        except FileExistsError:
            continue
    raise FileExistsError()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Observe one app Claude call; output contains no paths or response text.")
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--test", action="store_true", help="Make one fixed connection call (45 second AI timeout).")
    parser.add_argument("--open-report", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    runtime, output = args.runtime, args.output
    try:
        runtime, output = runtime.resolve(), output.resolve()
        report, settings = collect(runtime, args.test, worker=args.worker)
    except Exception as error:
        # Even profile/path failures must produce a sanitized report, not a traceback.
        report = {"protocol": _PROTOCOL, "test_requested": args.test, "cli_version": None,
                  "status": "diagnostic_failed", "model_attempts": 0, "timeout_seconds": 45,
                  "cli_stages": [], "events": [], "cleanup": "not_needed",
                  "network_environment_names": [], "exception": safe_exception(error, runtime)}
        settings = None
    if report["status"] == "relaunch_required":
        arguments = [settings["python"], "-B", str(Path(__file__).resolve()), "--runtime", str(runtime),
                     "--output", str(output), "--test", "--worker"]
        if args.open_report:
            arguments.append("--open-report")
        existing = {candidate for candidate in _report_candidates(output) if candidate.exists()}
        try:
            child = subprocess.run(arguments, cwd=settings["root"], env=app_environment(settings, os.environ),
                                   timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if child.returncode in (0, 1) and any(candidate.exists() for candidate in _report_candidates(output)
                                                  if candidate not in existing):
                return child.returncode
            report["status"] = "relaunch_failed"
        except (OSError, subprocess.TimeoutExpired) as error:
            report["status"] = "relaunch_failed"
            report["exception"] = safe_exception(error, runtime)
    try:
        destination = write_report(output, report)
    except (OSError, ValueError):
        print("The diagnostic report could not be created.")
        return 2
    if args.open_report and os.name == "nt":
        try:
            subprocess.Popen(["notepad.exe", str(destination)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            print("The report was saved, but Notepad could not be opened.")
    return 0 if report["status"] in ("metadata_only", "success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
