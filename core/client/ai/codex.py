"""새 Codex 세션 하나를 실행하고 구조화 결과와 로컬 실행 근거를 보존한다.

읽는 순서: CodexAdapter.run → _execute → _events.
이 파일은 서버 토큰을 받지 않고 위키/그래프를 저장하지도 않는다. 부모 흐름이
검증한 입력을 prompt로 주고, 반환한 value를 기존 서버 저장 도구에 제출한다.
"""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import time
from uuid import UUID

from jsonschema import Draft202012Validator

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import (private_directory, write_new, read_private, is_windows,
    ClientPlatformError, platform_error_code)
from core.runtime.client_process import cli_command, stop_windows, start_owned_process
from .contracts import (
    AIAdapterError, MAX_EVENTS, MAX_PROMPT_BYTES, MAX_RESULT_BYTES, MAX_SCHEMA_BYTES, MAX_TRACE_BYTES,
)


# 로그인에 필요한 기존 HOME/CODEX_HOME은 전달하지만 서버 토큰/API 키/디버그 환경은 넘기지 않는다.
_ENVIRONMENT = ("SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
                "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "HOME", "CODEX_HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE")
_DISABLED = ("apps", "plugins", "shell_tool", "multi_agent", "memories", "hooks", "computer_use",
             "browser_use", "image_generation", "goals", "sleep_tool", "skill_search", "view_image")
_REQUIRED_FLAGS = ("--ephemeral", "--ignore-user-config", "--output-schema", "--output-last-message", "--json",
                   "--sandbox", "--skip-git-repo-check", "--disable", "--enable")


def _write_new(path, raw):
    write_new(path, raw)


# 제공자 한 그림 한도(5 MB)보다 작게 둔다. 그림 수 한도는 호출하는 쪽(page_images)이 정한다.
MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_FILES = 100


def read_images(paths):
    """첨부할 그림(PNG·JPEG)을 비공개 파일에서 읽어 형식·hash를 확인한다. 없으면 빈 목록이다."""
    if paths is None:
        return []
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_IMAGE_FILES:
        raise AIAdapterError("ai_invalid_input")
    items = []
    for value in paths:
        path = Path(value).absolute()
        try:
            raw = read_private(path, MAX_IMAGE_FILE_BYTES)
        except ClientPlatformError as error:
            raise AIAdapterError("ai_input_limit" if str(error) == "file_limit" else "ai_invalid_input") from None
        except OSError as error:
            raise AIAdapterError("ai_invalid_input") from error
        media = ("image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else
                 "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else None)
        if media is None:
            raise AIAdapterError("ai_invalid_input")
        items.append({"path": path, "raw": raw, "media_type": media, "sha256": sha256(raw).hexdigest(),
                      "bytes": len(raw)})
    return items


def _strict_schema(schema):
    # Codex의 구조화 출력은 객체의 모든 키가 명시된 형태를 사용한다.
    # 원본 규약은 수정하지 않고 CLI에 전달할 복사본만 더 엄격하게 만든다.
    value = deepcopy(schema)

    def object_branch(item, seen=()):
        if not isinstance(item, dict):
            return False
        if item.get("type") == "object":
            return True
        reference = item.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/") and reference not in seen:
            target = value
            try:
                for part in reference[2:].split("/"):
                    target = target[part.replace("~1", "/").replace("~0", "~")]
            except (KeyError, TypeError):
                return False
            return object_branch(target, (*seen, reference))
        return False

    def visit(item):
        if isinstance(item, dict):
            item.pop("default", None)
            # Published v1/v2 diagnostics is type=object + anyOf object refs.
            # The provider requires properties on every explicit object node.
            # Drop only this redundant type; adding empty properties would forbid
            # all report keys. Unknown/non-object branches retain the restriction.
            branches = item.get("anyOf")
            if (item.get("type") == "object" and "properties" not in item
                    and isinstance(branches, list) and branches
                    and all(object_branch(branch) for branch in branches)):
                del item["type"]
            if item.get("type") == "object" and isinstance(item.get("properties"), dict):
                item["required"] = list(item["properties"])
                item["additionalProperties"] = False
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return value


async def _stop(process):
    if is_windows():
        await stop_windows(process)
        return
    # 새 프로세스 그룹으로 시작했으므로 이번 실행의 자식만 종료한다. 다른 Codex는 건드리지 않는다.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), 2)
    except TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()
    # 부모 CLI가 먼저 종료돼도 같은 그룹의 도구 프로세스가 남지 않게 마지막으로 회수한다.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def _cleanup(process, tasks):
    await _stop(process)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def _execute(arguments, *, directory, environment, prompt=b"", timeout=15, result_path=None,
                   on_event=None, event_parser=None):
    # create_subprocess_exec는 인자 목록을 그대로 실행한다. 셸 문자열을 조합하지 않는다.
    process = await start_owned_process(arguments, cwd=directory, env=environment,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    job = getattr(process, "_wiki_job", None)
    remaining = [MAX_TRACE_BYTES]

    async def read(stream, *, events=False):
        value, pending = bytearray(), bytearray()
        count = 0
        while block := await stream.read(65536):
            remaining[0] -= len(block)
            if remaining[0] < 0:
                raise AIAdapterError("ai_output_limit")
            value.extend(block)
            if events and on_event is not None:
                pending.extend(block)
                while b"\n" in pending:
                    line, _, pending = pending.partition(b"\n")
                    count += 1
                    if count > MAX_EVENTS:
                        raise AIAdapterError("ai_output_limit")
                    (event_parser or _preview_event)(line, on_event)
        if events and pending and on_event is not None:
            count += 1
            if count > MAX_EVENTS:
                raise AIAdapterError("ai_output_limit")
            (event_parser or _preview_event)(pending, on_event)
        return bytes(value)

    async def feed():
        try:
            process.stdin.write((b"\0" if is_windows() else b"") + prompt)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()

    async def watch_result():
        while process.returncode is None:
            if result_path is not None and result_path.exists():
                info = result_path.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RESULT_BYTES:
                    raise AIAdapterError("ai_output_limit")
            await asyncio.sleep(0.05)

    tasks = [asyncio.create_task(read(process.stdout, events=True)), asyncio.create_task(read(process.stderr)),
             asyncio.create_task(feed()), asyncio.create_task(process.wait()), asyncio.create_task(watch_result())]
    try:
        results = await asyncio.wait_for(asyncio.gather(*tasks), timeout)
        return process.returncode, results[0], results[1]
    except BaseException:
        # asyncio 취소도 예외다. 종료/회수를 마치기 전에 호출자에게 제어를 돌려주지 않는다.
        cleanup = asyncio.create_task(_cleanup(process, tasks))
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        cleanup.result()
        raise
    finally:
        if job is not None:
            job.close()


def _preview_event(line, callback):
    """생성 중 공개 답변만 전달한다. reasoning/error/원시 이벤트는 내보내지 않는다."""
    if not line.strip():
        return
    try:
        event = json.loads(line)
        item = event.get("item")
        if (event.get("type") in {"item.updated", "item.completed"} and isinstance(item, dict)
                and item.get("type") == "agent_message" and isinstance(item.get("text"), str)):
            callback({"type": "agent_message", "kind": "public_text", "text": item["text"], "event": event["type"],
                      "item_id": item.get("id") if isinstance(item.get("id"), str) else None})
    except (ValueError, UnicodeError, AttributeError):
        raise AIAdapterError("ai_invalid_events") from None


def _web_search_queries(value):
    """실제 도구 입력의 단일·복수 검색어를 자르지 않고 모으며 미관측 입력을 구분한다."""
    if not isinstance(value, dict):
        return [], False
    queries, complete = [], True
    for key in ("query", "queries"):
        entry = value.get(key)
        if entry is None:
            continue
        entries = [entry] if key == "query" else entry
        if not isinstance(entries, list) or not entries:
            complete = False
            continue
        for query in entries:
            if not isinstance(query, str) or not query.strip():
                complete = False
            elif query.strip() not in queries:
                queries.append(query.strip())
    return queries, complete and bool(queries)


def _events(raw, trace, *, web_search=False):
    completed, reported_model = False, None
    try:
        lines = raw.decode("utf-8").splitlines()
        if len(lines) > MAX_EVENTS:
            raise AIAdapterError("ai_output_limit")
        for line in lines:
            if not line.strip():
                continue
            event = json.loads(line)
            kind = event["type"]
            if kind not in {"thread.started", "turn.started", "turn.completed", "turn.failed", "error",
                            "item.started", "item.updated", "item.completed"}:
                raise AIAdapterError("ai_invalid_events")
            item = event.get("item")
            item_type = item.get("type") if isinstance(item, dict) else None
            # 오류 본문은 남기지 않지만 짧은 ASCII 타입 이름은 남겨 실패와 도구 호출을 구분한다.
            safe_type = item_type if isinstance(item_type, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", item_type) else None
            trace.append({"type": kind, "item_type": safe_type})
            if kind == "thread.started" and event.get("thread_id") is not None:
                trace[-1]["session_id"] = str(UUID(event["thread_id"]))
            if kind == "turn.completed":
                from .observations import reported_usage
                usage = reported_usage(event.get("usage"))
                if usage is not None:
                    trace[-1]["token_usage"] = usage
            if kind in {"error", "turn.failed"} or (kind.startswith("item.") and item_type == "error"):
                raise AIAdapterError("ai_execution_failed")
            allowed_items = {"reasoning", "agent_message"} | ({"web_search"} if web_search else set())
            if kind.startswith("item.") and item_type not in allowed_items:
                raise AIAdapterError("ai_unexpected_tool_activity")
            if kind == "item.completed" and item_type == "web_search":
                if item.get("status") in {"failed", "cancelled"}:
                    raise AIAdapterError("ai_web_search_failed")
                trace[-1]["web_search_completed"] = True
                action = item.get("action", item)
                queries, known = _web_search_queries(action if not isinstance(action, dict)
                    or action.get("type") in {None, "search", "web_search"} else None)
                trace[-1].update(web_search_queries=queries, web_search_queries_complete=known)
            if kind == "turn.started":
                completed = False
            if kind == "turn.completed":
                completed = True
            if isinstance(event.get("model"), str):
                reported_model = event["model"][:200]
        if not completed:
            raise AIAdapterError("ai_incomplete_turn")
        return trace, reported_model
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError) as error:
        raise AIAdapterError("ai_invalid_events") from error


def _object(pairs):
    # JSON의 같은 키가 두 번 나오면 뒤 값으로 덮어 해석하지 않고 원래 결과를 거부한다.
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate result key")
        value[key] = item
    return value


class CodexAdapter:
    """로그인된 개인 Codex CLI를 단계마다 새 세션으로 호출한다."""

    def __init__(self, cli="codex", model=None, timeout_seconds=900, on_event=None):
        # self는 이번 어댑터 객체다. 모델 이름은 사용자가 지정할 때만 전달한다.
        if (not isinstance(cli, str) or not cli or model is not None and (not isinstance(model, str) or not model)
                or type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds) or timeout_seconds <= 0):
            raise AIAdapterError("ai_invalid_configuration")
        self.cli, self.model, self.timeout_seconds = cli, model, timeout_seconds
        self._capabilities = None
        self.on_event = on_event
        self.persist_session = False
        self.session_id = None
        self._session_usage = {}
        self._question_profile_checked = False

    async def _check(self, environment):
        return await self._check_cli_capabilities(environment, command=cli_command, execute=_execute,
            help_arguments=("exec", "--help"), required_flags=_REQUIRED_FLAGS)

    async def _check_cli_capabilities(self, environment, *, command, execute, help_arguments, required_flags):
        """제공자별 실행 경계를 유지하며 경로를 재확인하고 성공한 지원 옵션 검사만 보관한다."""
        try:
            executable = command(self.cli)
        except ClientPlatformError as error:
            raise AIAdapterError(str(error)) from None
        if self._capabilities is None:
            for arguments in (("--version",), help_arguments):
                code, output, _ = await execute([*executable, *arguments], directory=None, environment=environment)
                if code != 0:
                    raise AIAdapterError("ai_cli_unavailable")
                if arguments[0] == "--version":
                    version = output.decode("utf-8").strip()[:200]
                elif not all(flag in output.decode("utf-8") for flag in required_flags):
                    raise AIAdapterError("ai_cli_incompatible")
            self._capabilities = executable, version
        return self._capabilities

    async def preflight(self):
        """작업 claim 전에 실행 파일·지원 옵션만 확인한다. AI 호출이나 자동 로그인은 하지 않는다."""
        environment = {name: os.environ[name] for name in _ENVIRONMENT if name in os.environ}
        try:
            _, version = await self._check(environment)
        except ImportError as error:
            raise AIAdapterError("ai_windows_dependency_missing") from error
        except (OSError, TimeoutError) as error:
            # 앱의 실행 준비 실패는 CLI 설치 문제로 바꾸지 않고 고정 코드를 유지한다.
            raise AIAdapterError(platform_error_code(error) or "ai_cli_unavailable") from error
        return {"provider": "codex", "cli_version": version, "requested_model": self.model,
                "capabilities_checked": True, "login_checked": False}

    async def _check_question_profile(self, executable, environment):
        """축소 질문의 필수 기능만 읽기 전용으로 확인하고 성공한 확인만 재사용한다."""
        if self._question_profile_checked:
            return
        from .question_profile import FEATURE
        try:
            code, output, _ = await _execute([*executable, "features", "list"],
                                            directory=None, environment=environment)
        except (OSError, TimeoutError) as error:
            # 앱의 실행 준비 실패는 CLI 설치 문제로 바꾸지 않고 고정 코드를 유지한다.
            raise AIAdapterError(platform_error_code(error) or "ai_cli_unavailable") from error
        try:
            supported = any(len(parts := line.split()) >= 3 and parts[0] == FEATURE
                            and parts[-1] in {"true", "false"}
                            for line in output.decode("utf-8").splitlines())
        except UnicodeError as error:
            raise AIAdapterError("ai_cli_incompatible") from error
        if code != 0 or not supported:
            raise AIAdapterError("ai_cli_incompatible")
        self._question_profile_checked = True

    supports_images = True
    _image_help = ("exec", "--help")
    _image_flag = b"--image"

    async def _image_help_output(self, arguments):
        return await _execute(arguments, directory=None,
                              environment={name: os.environ[name] for name in _ENVIRONMENT if name in os.environ})

    async def image_input_available(self):
        """설치된 CLI가 그림 첨부를 받는지 도움말로만 확인한다. 확인하지 못하면 예외 대신 False다(D-169)."""
        if getattr(self, "_image_input", None) is None:
            try:
                await self.preflight()
                executable, _ = self._capabilities
                code, output, _ = await self._image_help_output([*executable, *self._image_help])
                self._image_input = code == 0 and self._image_flag in output
            except (AIAdapterError, OSError, TimeoutError):
                self._image_input = False
        return self._image_input

    async def run(self, *, prompt, schema, directory, output_schema=None, on_event=None, session_id=None,
                  web_search=False, question_profile=False, template_profile=False, stream_answer=False, images=None):
        """전체 prompt/schema로 한 번 실행해 {'value': 결과 dict, 'execution': 관측 기록}을 반환한다."""
        if (not isinstance(prompt, str) or not isinstance(schema, dict)
                or output_schema is not None and not isinstance(output_schema, dict)
                or type(web_search) is not bool or web_search and (session_id is not None or self.persist_session)
                or type(question_profile) is not bool
                or type(template_profile) is not bool or template_profile and not question_profile
                or type(stream_answer) is not bool or stream_answer and (not question_profile or template_profile)
                or question_profile and (self.persist_session or session_id is not None or web_search)
                or images is not None and (session_id is not None or web_search or question_profile)):
            raise AIAdapterError("ai_invalid_input")
        attached = read_images(images)
        if any("," in str(item["path"]) for item in attached):
            # --image 값은 쉼표로 나뉜다. 경로를 잘못 나눠 다른 파일을 붙이지 않도록 거부한다.
            raise AIAdapterError("ai_unsafe_directory")
        prompt_bytes = prompt.encode("utf-8")
        original_schema = canonical_json_bytes(schema)
        # schema는 원본 규약, output_schema는 CLI가 출력할 수 있게 조립한 별도 형식이다.
        # 실제 결과는 양쪽을 모두 만족해야 하므로 원본을 CLI 형식으로 덮어쓰지 않는다.
        effective_schema = _strict_schema(schema if output_schema is None else output_schema)
        schema_bytes = canonical_json_bytes(effective_schema)
        if len(prompt_bytes) > MAX_PROMPT_BYTES or max(len(schema_bytes), len(original_schema)) > MAX_SCHEMA_BYTES:
            raise AIAdapterError("ai_input_limit")
        environment = {name: os.environ[name] for name in _ENVIRONMENT if name in os.environ}
        await self.preflight()
        executable, version = self._capabilities
        if session_id is not None:
            try:
                session_id = str(UUID(session_id))
            except (ValueError, TypeError, AttributeError) as error:
                raise AIAdapterError("ai_invalid_session") from error
        directory = Path(directory).absolute()
        if any(path.is_symlink() for path in (directory, *directory.parents)):
            raise AIAdapterError("ai_unsafe_directory")
        private_directory(directory, exist_ok=False)
        _write_new(directory / "prompt.txt", prompt_bytes)
        _write_new(directory / "source-schema.json", original_schema)
        _write_new(directory / "schema.json", schema_bytes)
        result_path = directory / "result.json"
        arguments = [*executable, "exec"]
        for item in attached:
            # 그림은 CLI가 첫 메시지에 붙인다. 모델의 그림 보기 도구(view_image)는 계속 끈다(D-169).
            arguments.extend(["--image", str(item["path"])])
        arguments.extend(["--sandbox", "read-only", "-C", str(directory)])
        if session_id is not None:
            arguments.extend(["resume", session_id])
        if not self.persist_session and session_id is None:
            arguments.append("--ephemeral")
        arguments.extend(["--ignore-user-config", "--skip-git-repo-check", "--json",
            "--output-schema", str(directory / "schema.json"),
            "--output-last-message", str(result_path)])
        # 설치된 CLI는 개발 중 기능의 안내도 error 항목으로 보낼 수 있다. 설정 파일을
        # 바꾸지 않고 이번 실행의 안내만 숨기며, 실제 error 이벤트는 계속 실패로 처리한다.
        for setting in ("project_doc_max_bytes=0", 'web_search="live"' if web_search else 'web_search="disabled"', "agents.enabled=false",
                        "suppress_unstable_features_warning=true"):
            arguments.extend(["-c", setting])
        for feature in _DISABLED:
            arguments.extend(["--disable", feature])
        arguments.extend(["--enable", "skip_host_skill_discovery"])
        profile_metadata = None
        if question_profile:
            from .question_profile import VERSION, FEATURE, FILENAME, INSTRUCTIONS, SETTINGS
            instructions = INSTRUCTIONS.encode("utf-8")
            instructions_path = directory / FILENAME
            _write_new(instructions_path, instructions)
            settings = {"model_instructions_file": str(instructions_path), **dict.fromkeys(SETTINGS, False)}
            arguments.extend(["-c", "model_instructions_file=" + json.dumps(str(instructions_path)),
                              "--enable", FEATURE])
            for setting in SETTINGS:
                arguments.extend(["-c", setting + "=false"])
            profile_metadata = {"version": VERSION, "instructions_file": FILENAME,
                "instructions_sha256": sha256(instructions).hexdigest(), "settings": settings,
                "enabled_features": [FEATURE], "feature_support_checked": False}
        if self.model is not None:
            arguments.extend(["--model", self.model])
        if template_profile:
            from .question_profile import TEMPLATE_VERSION, TEMPLATE_SETTINGS
            for key, value in TEMPLATE_SETTINGS.items():
                arguments.extend(["-c", key + "=" + json.dumps(value)])
        arguments.append("-")
        metadata = {"provider": "codex", "cli_version": version, "requested_model": self.model,
            "model_selection": "explicit" if self.model is not None else "provider_default",
            "reported_model": None, "evidence_kind": "client_observed", "semantic_validation": "not_run",
            "prompt_sha256": sha256(prompt_bytes).hexdigest(), "schema_sha256": sha256(schema_bytes).hexdigest(),
            "input_schema_sha256": sha256(original_schema).hexdigest(), "status": "failed"}
        if profile_metadata is not None:
            metadata["question_profile"] = profile_metadata
        if template_profile:
            metadata["template_profile"] = {"version": TEMPLATE_VERSION, "settings": dict(TEMPLATE_SETTINGS),
                                             "provider_effective_settings": "not_reported"}
        if stream_answer:
            metadata["answer_stream"] = {"transport": "app-server", "config_verified": False}
        if attached:
            metadata["input_images"] = [{key: item[key] for key in ("media_type", "sha256", "bytes")} for item in attached]
        started = time.monotonic()
        output = stderr = None
        try:
            if question_profile:
                await self._check_question_profile(executable, environment)
                profile_metadata["feature_support_checked"] = True
            if attached and not await self.image_input_available():
                raise AIAdapterError("ai_cli_incompatible")
            if stream_answer:
                from .codex_app_server import execute
                output, stream_metadata = await execute(executable, directory=directory, environment=environment,
                    prompt=prompt, schema=effective_schema, model=self.model, timeout=self.timeout_seconds,
                    on_event=on_event if on_event is not None else self.on_event)
                metadata["answer_stream"] = stream_metadata
                code, stderr = 0, b""
            else:
                code, output, stderr = await _execute(arguments, directory=directory, environment=environment,
                    prompt=prompt_bytes, timeout=self.timeout_seconds, result_path=result_path,
                    on_event=on_event if on_event is not None else self.on_event)
            metadata.update(returncode=code, stdout_sha256=sha256(output).hexdigest(), stderr_sha256=sha256(stderr).hexdigest())
            if stream_answer:
                metadata["normalized_events_sha256"] = metadata["stdout_sha256"]
                metadata["stdout_sha256"] = stream_metadata.get("raw_stdout_sha256")
                metadata["stderr_sha256"] = stream_metadata.get("raw_stderr_sha256")
            if code != 0:
                # 로그인은 사용자가 별도로 수행한다. 여기서 자격 증명을 읽거나 자동 로그인하지 않는다.
                raise AIAdapterError("ai_login_or_execution_failed")
            trace = []
            try:
                _, metadata["reported_model"] = _events(output, trace, web_search=web_search)
                if web_search:
                    searches = [event for event in trace if event.get("web_search_completed")]
                    metadata["web_search_completed"] = len(searches)
                    metadata["web_search_queries"] = list(dict.fromkeys(
                        query for event in searches for query in event["web_search_queries"]))
                    metadata["web_search_queries_complete"] = bool(searches) and all(
                        event["web_search_queries_complete"] for event in searches)
                    if not metadata["web_search_completed"]:
                        raise AIAdapterError("ai_web_search_not_used")
                observed_ids = {event["session_id"] for event in trace if "session_id" in event}
                if self.persist_session or session_id is not None:
                    if len(observed_ids) != 1 or session_id is not None and session_id not in observed_ids:
                        raise AIAdapterError("ai_session_mismatch")
                    self.session_id = next(iter(observed_ids))
                    metadata["session_id"] = self.session_id
                    metadata["session_persisted"] = True
                metadata["token_usage"] = {"origin": "provider_reported", "reports": [
                    event["token_usage"] for event in trace if "token_usage" in event]} if any(
                        "token_usage" in event for event in trace) else None
                if self.persist_session or session_id is not None:
                    # exec는 대화 누적 사용량을 보고하므로 재개 호출을 합산할 때 앞 턴을 중복 계산하지 않는다.
                    reports = [event["token_usage"]["tokens"] for event in trace if "token_usage" in event]
                    current = reports[-1] if reports else None
                    previous = self._session_usage.get(self.session_id)
                    metadata["provider_session_usage"] = current
                    incremental = current if session_id is None else None
                    if current is not None and previous is not None and all(
                            key in previous and count >= previous[key] for key, count in current.items()):
                        incremental = {key: count - previous[key] for key, count in current.items()}
                    metadata["token_usage"] = ({"origin": "provider_reported", "tokens": incremental,
                        "calculation": "session_total_difference" if session_id else "initial_session_total"}
                        if incremental is not None else None)
                    if current is not None:
                        self._session_usage[self.session_id] = current
            finally:
                _write_new(directory / "trace.jsonl", b"".join(canonical_json_bytes(event) for event in trace))
            if is_windows():
                raw = read_private(result_path, MAX_RESULT_BYTES)
            else:
                descriptor = os.open(result_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise AIAdapterError("ai_invalid_result")
                    raw = stream.read(MAX_RESULT_BYTES + 1)
            if len(raw) > MAX_RESULT_BYTES:
                raise AIAdapterError("ai_output_limit")
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(value, dict) or any(
                next(Draft202012Validator(contract).iter_errors(value), None) is not None
                for contract in (schema, effective_schema)
            ):
                raise AIAdapterError("ai_invalid_result")
            metadata.update(status="completed", output_sha256=sha256(raw).hexdigest())
            return {"value": value, "execution": metadata}
        except TimeoutError as error:
            metadata["error_code"] = "ai_timeout"
            raise AIAdapterError("ai_timeout") from error
        except asyncio.CancelledError:
            metadata.update(status="cancelled", error_code="ai_cancelled")
            raise
        except AIAdapterError as error:
            metadata["error_code"] = error.code
            raise
        except (OSError, ValueError, TypeError, UnicodeError) as error:
            # 실행 준비(Job·비공개 파일) 실패를 결과 형식 오류로 바꿔 보고하지 않는다.
            code = platform_error_code(error) or "ai_invalid_result"
            metadata["error_code"] = code
            raise AIAdapterError(code) from error
        finally:
            if output is not None and metadata["status"] != "completed":
                from .codex_diagnostics import failure_observation
                observation = failure_observation(output, stderr or b"")
                metadata["failure_observation"] = observation
                # Resumed CLI usage is cumulative; do not present it as this
                # failed invocation's incremental consumption.
                if not self.persist_session and session_id is None and observation["usage_reports"]:
                    metadata["token_usage"] = {"origin": "provider_reported", "reports": [
                        {"origin": "provider_reported", "tokens": row["tokens"]}
                        for row in observation["usage_reports"]]}
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            _write_new(directory / "execution.json", canonical_json_bytes(metadata))
