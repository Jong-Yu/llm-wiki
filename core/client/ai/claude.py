"""구독 로그인을 유지한 새 Claude Code 세션의 구조화 답변만 수신한다.

safe-mode는 사용자 확장을 끄며 조직의 관리 정책은 계속 적용된다. 서버 토큰과
API 키를 전달하지 않고, bare 모드처럼 OAuth/keychain 로그인을 무효화하지 않는다.
"""

import asyncio
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from uuid import UUID

from jsonschema import Draft202012Validator

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import private_directory, is_windows, platform_error_code
from core.runtime.client_process import cli_command
from .codex import (CodexAdapter, _ENVIRONMENT as _CODEX_ENVIRONMENT, _execute, _object, _web_search_queries,
                    _write_new, read_images)
from .contracts import AIAdapterError, MAX_PROMPT_BYTES, MAX_RESULT_BYTES, MAX_SCHEMA_BYTES


# 회사 프록시·보안 인증서·Git Bash 위치는 터미널의 claude와 같은 연결 조건이다(D-143). 인증 정보는 넣지 않는다.
NETWORK_ENVIRONMENT = ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
                       "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_GIT_BASH_PATH")
_ENVIRONMENT = (tuple(name for name in _CODEX_ENVIRONMENT if name != "CODEX_HOME") + ("CLAUDE_CONFIG_DIR",)
                + NETWORK_ENVIRONMENT)
# Claude Code의 system 메시지 중 격리가 깨졌음을 뜻하는 종류만 거부한다(D-143). 진행·상태·안내 메시지는
# 답이나 도구 실행이 아니며, 도구 금지는 tool_use·tool_result·permission_denials 검사가 지킨다.
REJECTED_SYSTEM_SUBTYPES = frozenset((
    "hook_started", "hook_progress", "hook_response", "stop_hook_summary",
    "task_started", "task_progress", "task_notification", "task_updated", "background_tasks_changed",
    "local_command_output", "permission_denied", "elicitation_complete", "plugin_install",
    "files_persisted", "memory_recall"))
_REJECTED_PREFIXES = ("hook_", "task_")
_EVENT_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
# Claude's documented stdin limit is 10 MB. Never truncate a larger fixed input.
_MAX_STDIN_BYTES = 10_000_000
_REQUIRED_FLAGS = ("--print", "--output-format", "--json-schema", "--safe-mode", "--tools",
    "--setting-sources", "--settings", "--strict-mcp-config", "--mcp-config", "--disable-slash-commands",
    "--no-session-persistence", "--no-chrome", "--permission-mode", "--permission-prompts", "--verbose",
    "--disallowedTools")
_ISOLATION = ("--safe-mode", "--setting-sources", "", "--settings", '{"disableAllHooks":true}')


def environment():
    value = {name: os.environ[name] for name in _ENVIRONMENT if name in os.environ}
    value["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    return value


def _json(raw):
    return json.loads(raw, object_pairs_hook=_object,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def _event_name(value):
    """CLI가 보낸 메시지 종류 이름을 기록용으로만 정리한다. 형식이 다르면 other로 둔다."""
    return value if isinstance(value, str) and _EVENT_NAME.fullmatch(value) else "other"


def _check_argument_size(arguments, env):
    # Native Windows includes the bootstrap's Python path; keep a small reserve for it.
    if is_windows():
        too_large = len(subprocess.list2cmdline(arguments).encode("utf-16-le")) > 63000
    else:
        sizes = [len(value.encode("utf-8")) + 1 for value in arguments]
        total = sum(sizes) + sum(len((key + "=" + value).encode("utf-8")) + 1 for key, value in env.items())
        too_large = total + 4096 > os.sysconf("SC_ARG_MAX")
        if sys.platform.startswith("linux"):
            too_large = too_large or max(sizes) > os.sysconf("SC_PAGESIZE") * 32
    if too_large:
        raise AIAdapterError("ai_input_limit")


class _Events:
    """공개 답변만 미리 보여 주고 원시 추론/오류/계정 정보는 보존하지 않는다."""

    def __init__(self, *, web_search=False, stream_answer=False):
        self.trace, self.structured_ids = [], set()
        self.result, self.model = None, None
        self.token_usage = None
        self.session_id = None
        self.web_search = web_search
        self.web_tool_ids, self.web_completed_ids = set(), set()
        self.web_inputs, self.web_queries = {}, []
        self.web_queries_complete = True
        self.stream_answer = stream_answer
        self.stream_message = None
        self.stream_blocks = {}

    def _stream_event(self, event, callback):
        """공개 텍스트·구조화 답변의 부분 값만 누적하며 추론과 다른 도구 입력은 내보내지 않는다."""
        if not self.stream_answer or event.get("parent_tool_use_id") is not None:
            raise AIAdapterError("ai_cli_event_rejected", event="type:stream_event")
        value = event["event"]
        kind = value["type"]
        if kind == "message_start":
            message = value["message"]
            if (self.stream_message is not None or message.get("role") != "assistant"
                    or not isinstance(message.get("id"), str) or not 1 <= len(message["id"]) <= 256):
                raise AIAdapterError("ai_invalid_events")
            self.stream_message = message["id"]
            self.stream_blocks = {}
            return
        if self.stream_message is None:
            raise AIAdapterError("ai_invalid_events")
        if kind == "message_stop":
            if self.stream_blocks:
                raise AIAdapterError("ai_invalid_events")
            self.stream_message = None
            return
        if kind == "message_delta":
            return
        index = value.get("index")
        if type(index) is not int or not 0 <= index < 128:
            raise AIAdapterError("ai_invalid_events")
        if kind == "content_block_start":
            if index in self.stream_blocks:
                raise AIAdapterError("ai_invalid_events")
            block = value["content_block"]
            block_type = block["type"]
            item_id = f"{self.stream_message}:{index}"
            text = ""
            if block_type == "text":
                text = block.get("text", "")
                if not isinstance(text, str):
                    raise AIAdapterError("ai_invalid_events")
                output_kind = "public_text"
            elif block_type == "tool_use" and block.get("name") == "StructuredOutput":
                item_id = block.get("id")
                if not isinstance(item_id, str) or not 1 <= len(item_id) <= 256 or block.get("input") != {}:
                    raise AIAdapterError("ai_invalid_events")
                output_kind = "structured_output"
            elif block_type in {"thinking", "redacted_thinking"}:
                output_kind = None
            else:
                raise AIAdapterError("ai_unexpected_tool_activity")
            self.stream_blocks[index] = {"kind": output_kind, "type": block_type,
                                         "text": text, "id": item_id}
            if text:
                self._emit_stream(self.stream_blocks[index], callback)
            return
        block = self.stream_blocks.get(index)
        if block is None:
            raise AIAdapterError("ai_invalid_events")
        if kind == "content_block_stop":
            del self.stream_blocks[index]
            return
        if kind != "content_block_delta":
            raise AIAdapterError("ai_invalid_events")
        delta = value["delta"]
        if block["kind"] is None:
            if delta.get("type") not in {"thinking_delta", "signature_delta"}:
                raise AIAdapterError("ai_invalid_events")
            return
        expected, field = (("text_delta", "text") if block["kind"] == "public_text"
                           else ("input_json_delta", "partial_json"))
        if delta.get("type") != expected or not isinstance(delta.get(field), str):
            raise AIAdapterError("ai_invalid_events")
        block["text"] += delta[field]
        self._emit_stream(block, callback)

    @staticmethod
    def _emit_stream(block, callback):
        """부분 이벤트도 기존 전체 교체 스냅샷 계약과 출력 크기 한도를 지킨다."""
        if len(block["text"].encode("utf-8")) > MAX_RESULT_BYTES:
            raise AIAdapterError("ai_output_limit")
        if block["text"]:
            callback({"type": "agent_message", "kind": block["kind"], "text": block["text"],
                      "event": "item.updated", "item_id": block["id"]})

    def __call__(self, line, callback):
        if not line.strip():
            return
        try:
            event = _json(line)
            kind = event["type"]
            if self.result is not None:
                raise AIAdapterError("ai_invalid_events")
            if kind not in {"system", "assistant", "user", "result", "rate_limit_event", "stream_event"}:
                raise AIAdapterError("ai_cli_event_rejected", event="type:" + _event_name(kind))
            self.trace.append({"type": kind})
            if event.get("session_id") is not None:
                observed_id = str(UUID(event["session_id"]))
                if self.session_id is not None and observed_id != self.session_id:
                    raise AIAdapterError("ai_session_mismatch")
                self.session_id = observed_id
            if kind == "stream_event":
                self._stream_event(event, callback)
            elif kind == "system":
                # 훅·하위 작업·명령 실행 등은 고정 입력 분석에 끼어든 것이므로 거부한다. 진행을 멈추라는
                # 표시가 붙은 메시지도 거부한다. 그 밖의 안내(새 종류 포함)는 이름만 기록하고 통과시킨다.
                subtype = _event_name(event.get("subtype"))
                self.trace[-1]["subtype"] = subtype
                if (subtype == "other" or subtype in REJECTED_SYSTEM_SUBTYPES
                        or subtype.startswith(_REJECTED_PREFIXES) or event.get("prevent_continuation") is True):
                    raise AIAdapterError("ai_cli_event_rejected", event="system:" + subtype)
                if isinstance(event.get("model"), str):
                    self.model = event["model"][:200]
            elif kind == "assistant":
                message = event["message"]
                if event.get("error"):
                    # 제공자의 고정 오류 종류만 기록하고 원시 계정/오류 본문은 내보내지 않는다.
                    error_type = event["error"]
                    if isinstance(error_type, str) and error_type in {"rate_limit", "authentication_failed", "billing_error", "invalid_request", "server_error"}:
                        self.trace[-1]["error_type"] = error_type
                    raise AIAdapterError("ai_rate_limited" if error_type == "rate_limit" else "ai_execution_failed")
                if isinstance(message.get("model"), str):
                    self.model = message["model"][:200]
                for block in message["content"]:
                    if block["type"] == "text":
                        if not isinstance(block.get("text"), str):
                            raise AIAdapterError("ai_invalid_events")
                        callback({"type": "agent_message", "kind": "public_text", "text": block["text"],
                                  "event": "item.completed", "item_id": None})
                    elif block["type"] == "tool_use" and block.get("name") == "StructuredOutput":
                        # This provider-internal tool only carries the JSON reply, not a host tool call.
                        if not isinstance(block.get("id"), str) or not isinstance(block.get("input"), dict):
                            raise AIAdapterError("ai_invalid_events")
                        self.structured_ids.add(block["id"])
                        callback({"type": "agent_message", "kind": "structured_output", "text": canonical_json_bytes(block["input"]).decode(),
                                  "event": "item.completed", "item_id": block["id"]})
                    elif block["type"] == "tool_use" and block.get("name") == "WebSearch" and self.web_search:
                        if not isinstance(block.get("id"), str) or not isinstance(block.get("input"), dict):
                            raise AIAdapterError("ai_invalid_events")
                        self.web_tool_ids.add(block["id"])
                        self.web_inputs[block["id"]] = _web_search_queries(block["input"])
                    elif block["type"] not in {"thinking", "redacted_thinking"}:
                        raise AIAdapterError("ai_unexpected_tool_activity")
            elif kind == "user":
                # Only the result of the output-format carrier may be emitted back by the CLI.
                for block in event["message"]["content"]:
                    if (block["type"] == "tool_result" and self.web_search
                            and block.get("tool_use_id") in self.web_tool_ids):
                        if block.get("is_error"):
                            raise AIAdapterError("ai_web_search_failed")
                        self.web_completed_ids.add(block["tool_use_id"])
                        queries, known = self.web_inputs[block["tool_use_id"]]
                        self.web_queries.extend(query for query in queries if query not in self.web_queries)
                        self.web_queries_complete = self.web_queries_complete and known
                    elif block["type"] != "tool_result" or block.get("tool_use_id") not in self.structured_ids:
                        raise AIAdapterError("ai_unexpected_tool_activity")
            elif kind == "result":
                if self.stream_answer and self.stream_message is not None:
                    raise AIAdapterError("ai_incomplete_turn")
                if event.get("subtype") != "success" or event.get("is_error") is not False:
                    raise AIAdapterError("ai_execution_failed")
                if event.get("permission_denials"):
                    raise AIAdapterError("ai_unexpected_tool_activity")
                if not isinstance(event.get("structured_output"), dict):
                    raise AIAdapterError("ai_invalid_result")
                self.result = event["structured_output"]
                from .observations import reported_usage
                self.token_usage = reported_usage(event.get("usage"))
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeError) as error:
            raise AIAdapterError("ai_invalid_events") from error


class ClaudeAdapter(CodexAdapter):
    """Codex와 동일한 입력·보존·취소 계약을 제공하는 개인 Claude CLI 어댑터."""

    def __init__(self, cli="claude", model=None, timeout_seconds=900, on_event=None):
        super().__init__(cli=cli, model=model, timeout_seconds=timeout_seconds, on_event=on_event)

    async def _check(self, env):
        return await self._check_cli_capabilities(env, command=cli_command, execute=_execute,
            help_arguments=("--help",), required_flags=_REQUIRED_FLAGS)

    async def preflight(self):
        try:
            _, version = await self._check(environment())
        except ImportError as error:
            raise AIAdapterError("ai_windows_dependency_missing") from error
        except (OSError, TimeoutError) as error:
            # 앱의 실행 준비 실패는 CLI 설치 문제로 바꾸지 않고 고정 코드를 유지한다.
            raise AIAdapterError(platform_error_code(error) or "ai_cli_unavailable") from error
        return {"provider": "claude", "cli_version": version, "requested_model": self.model,
                "capabilities_checked": True, "login_checked": False}

    async def _check_question_profile(self, executable, env):
        """공개 작업 안내를 덧붙일 수 있는지 확인하며 기존 일반 호출은 바꾸지 않는다."""
        if self._question_profile_checked:
            return
        try:
            code, output, _ = await _execute([*executable, "--help"], directory=None, environment=env)
        except (OSError, TimeoutError) as error:
            raise AIAdapterError(platform_error_code(error) or "ai_cli_unavailable") from error
        try:
            supported = "--append-system-prompt" in output.decode("utf-8").split()
        except UnicodeError as error:
            raise AIAdapterError("ai_cli_incompatible") from error
        if code != 0 or not supported:
            raise AIAdapterError("ai_cli_incompatible")
        self._question_profile_checked = True

    supports_images = True
    _image_help = ("--help",)
    _image_flag = b"--input-format"

    async def _image_help_output(self, arguments):
        return await _execute(arguments, directory=None, environment=environment())

    async def run(self, *, prompt, schema, directory, output_schema=None, on_event=None, session_id=None, web_search=False,
                  question_profile=False, stream_answer=False, images=None):
        if (not isinstance(prompt, str) or not isinstance(schema, dict)
                or output_schema is not None and not isinstance(output_schema, dict)
                or type(web_search) is not bool or web_search and (session_id is not None or self.persist_session)
                or type(question_profile) is not bool
                or type(stream_answer) is not bool
                or stream_answer and not question_profile
                or question_profile and (session_id is not None or self.persist_session or web_search)
                or images is not None and (session_id is not None or web_search or question_profile)):
            raise AIAdapterError("ai_invalid_input")
        prompt_bytes, original_schema = prompt.encode("utf-8"), canonical_json_bytes(schema)
        effective_schema = schema if output_schema is None else output_schema
        schema_bytes = canonical_json_bytes(effective_schema)
        if len(prompt_bytes) > min(MAX_PROMPT_BYTES, _MAX_STDIN_BYTES) or max(len(schema_bytes), len(original_schema)) > MAX_SCHEMA_BYTES:
            raise AIAdapterError("ai_input_limit")
        attached = read_images(images)
        stdin = prompt_bytes
        if attached:
            # 그림은 stream-json 사용자 메시지 한 개에 글과 함께 담는다(D-169). 도구 금지·격리 옵션은 그대로다.
            content = [{"type": "image", "source": {"type": "base64", "media_type": item["media_type"],
                        "data": base64.b64encode(item["raw"]).decode("ascii")}} for item in attached]
            content.append({"type": "text", "text": prompt})
            stdin = json.dumps({"type": "user", "message": {"role": "user", "content": content}},
                               ensure_ascii=False).encode("utf-8") + b"\n"
            if len(stdin) > _MAX_STDIN_BYTES:
                raise AIAdapterError("ai_input_limit")
        env = environment()
        await self.preflight()
        executable, version = self._capabilities
        arguments = [*executable, "--print", *(("--input-format", "stream-json") if attached else ()),
            "--output-format", "stream-json", "--verbose", *_ISOLATION,
            "--tools", "WebSearch" if web_search else "", "--disable-slash-commands", "--no-chrome",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "mcp__*",
            "--permission-mode", "dontAsk", "--permission-prompts", "none", "--json-schema", schema_bytes.decode()]
        if web_search:
            arguments.extend(["--allowedTools", "WebSearch", "--max-turns", "6"])
        if session_id is not None:
            try:
                session_id = str(UUID(session_id))
            except (ValueError, TypeError, AttributeError) as error:
                raise AIAdapterError("ai_invalid_session") from error
            arguments.extend(["--resume", session_id])
        elif not self.persist_session:
            arguments.append("--no-session-persistence")
        if self.model is not None:
            arguments.extend(["--model", self.model])
        if stream_answer:
            arguments.append("--include-partial-messages")
        instructions = None
        if question_profile:
            from .question_profile import VERSION, FILENAME, INSTRUCTIONS
            instructions = INSTRUCTIONS.encode("utf-8")
            arguments.extend(["--append-system-prompt", INSTRUCTIONS])
        # Unlike Codex's schema file, Claude accepts this schema in argv. Reject OS limits explicitly.
        _check_argument_size(arguments, env)
        directory = Path(directory).absolute()
        if any(path.is_symlink() for path in (directory, *directory.parents)):
            raise AIAdapterError("ai_unsafe_directory")
        private_directory(directory, exist_ok=False)
        # 같은 분석의 후속 호출은 Claude가 처음 기록한 작업 위치에서 재개한다.
        if self.persist_session and session_id is None:
            self._session_directory = directory
        execution_directory = getattr(self, "_session_directory", directory) if session_id else directory
        _write_new(directory / "prompt.txt", prompt_bytes)
        _write_new(directory / "source-schema.json", original_schema)
        _write_new(directory / "schema.json", schema_bytes)
        if instructions is not None:
            _write_new(directory / FILENAME, instructions)
        metadata = {"provider": "claude", "cli_version": version, "requested_model": self.model,
            "model_selection": "explicit" if self.model is not None else "provider_default",
            "reported_model": None, "evidence_kind": "client_observed", "semantic_validation": "not_run",
            "prompt_sha256": sha256(prompt_bytes).hexdigest(), "schema_sha256": sha256(schema_bytes).hexdigest(),
            "input_schema_sha256": sha256(original_schema).hexdigest(), "status": "failed"}
        if instructions is not None:
            metadata["question_profile"] = {"version": VERSION, "instructions_file": FILENAME,
                "instructions_sha256": sha256(instructions).hexdigest(),
                "instructions_argument": "--append-system-prompt", "feature_support_checked": False}
        if stream_answer:
            metadata["answer_stream"] = {"transport": "stream-json", "partial_messages": True}
        if attached:
            metadata["input_images"] = [{key: item[key] for key in ("media_type", "sha256", "bytes")} for item in attached]
            metadata["prompt_transport"] = "stream-json"
            metadata["stdin_sha256"] = sha256(stdin).hexdigest()
        events, started = _Events(web_search=web_search, stream_answer=stream_answer), time.monotonic()
        callback = on_event if on_event is not None else self.on_event
        try:
            if question_profile:
                await self._check_question_profile(executable, env)
                metadata["question_profile"]["feature_support_checked"] = True
            if stream_answer and not getattr(self, "_answer_stream_checked", False):
                code, help_output, _ = await _execute([*executable, "--help"], directory=None, environment=env)
                if code != 0 or b"--include-partial-messages" not in help_output:
                    raise AIAdapterError("ai_cli_incompatible")
                self._answer_stream_checked = True
            if attached and not await self.image_input_available():
                raise AIAdapterError("ai_cli_incompatible")
            code, output, stderr = await _execute(arguments, directory=execution_directory, environment=env,
                prompt=stdin, timeout=self.timeout_seconds, on_event=callback or (lambda _: None), event_parser=events)
            metadata.update(returncode=code, stdout_sha256=sha256(output).hexdigest(), stderr_sha256=sha256(stderr).hexdigest(),
                            reported_model=events.model, token_usage=events.token_usage)
            if code != 0:
                raise AIAdapterError("ai_login_or_execution_failed")
            if events.result is None:
                raise AIAdapterError("ai_incomplete_turn")
            if web_search:
                metadata["web_search_completed"] = len(events.web_completed_ids)
                metadata["web_search_queries"] = events.web_queries
                metadata["web_search_queries_complete"] = bool(events.web_completed_ids) and events.web_queries_complete
                if not metadata["web_search_completed"]:
                    raise AIAdapterError("ai_web_search_not_used")
            if self.persist_session or session_id is not None:
                if events.session_id is None or session_id is not None and session_id != events.session_id:
                    raise AIAdapterError("ai_session_mismatch")
                self.session_id = events.session_id
                metadata.update(session_id=events.session_id, session_persisted=True,
                    session_directory=str(execution_directory))
            raw = canonical_json_bytes(events.result)
            if len(raw) > MAX_RESULT_BYTES:
                raise AIAdapterError("ai_output_limit")
            # Preserve the exact structured payload even when schema validation fails.
            _write_new(directory / "result.json", raw)
            if any(next(Draft202012Validator(contract).iter_errors(events.result), None) is not None
                   for contract in (schema, effective_schema)):
                raise AIAdapterError("ai_invalid_result")
            metadata.update(status="completed", output_sha256=sha256(raw).hexdigest())
            return {"value": events.result, "execution": metadata}
        except TimeoutError as error:
            metadata["error_code"] = "ai_timeout"
            raise AIAdapterError("ai_timeout") from error
        except asyncio.CancelledError:
            metadata.update(status="cancelled", error_code="ai_cancelled")
            raise
        except AIAdapterError as error:
            metadata["error_code"] = error.code
            if error.event is not None:
                metadata["rejected_event"] = error.event
            raise
        except (OSError, ValueError, TypeError, UnicodeError) as error:
            # 실행 준비(Job·비공개 파일) 실패를 결과 형식 오류로 바꿔 보고하지 않는다.
            code = platform_error_code(error) or "ai_invalid_result"
            metadata["error_code"] = code
            raise AIAdapterError(code) from error
        finally:
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            _write_new(directory / "trace.jsonl", b"".join(canonical_json_bytes(event) for event in events.trace))
            _write_new(directory / "execution.json", canonical_json_bytes(metadata))
