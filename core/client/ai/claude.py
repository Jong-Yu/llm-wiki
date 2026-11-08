"""구독 로그인을 유지한 새 Claude Code 세션의 구조화 답변만 수신한다.

safe-mode는 사용자 확장을 끄며 조직의 관리 정책은 계속 적용된다. 서버 토큰과
API 키를 전달하지 않고, bare 모드처럼 OAuth/keychain 로그인을 무효화하지 않는다.
"""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import UUID

from jsonschema import Draft202012Validator

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import private_directory, is_windows, ClientPlatformError
from core.runtime.client_process import cli_command
from .codex import CodexAdapter, _ENVIRONMENT as _CODEX_ENVIRONMENT, _execute, _object, _write_new
from .contracts import AIAdapterError, MAX_PROMPT_BYTES, MAX_RESULT_BYTES, MAX_SCHEMA_BYTES


_ENVIRONMENT = tuple(name for name in _CODEX_ENVIRONMENT if name != "CODEX_HOME") + ("CLAUDE_CONFIG_DIR",)
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

    def __init__(self, *, web_search=False):
        self.trace, self.structured_ids = [], set()
        self.result, self.model = None, None
        self.token_usage = None
        self.session_id = None
        self.web_search = web_search
        self.web_tool_ids, self.web_completed_ids = set(), set()

    def __call__(self, line, callback):
        if not line.strip():
            return
        try:
            event = _json(line)
            kind = event["type"]
            if self.result is not None or kind not in {"system", "assistant", "user", "result", "rate_limit_event"}:
                raise AIAdapterError("ai_invalid_events")
            self.trace.append({"type": kind})
            if event.get("session_id") is not None:
                observed_id = str(UUID(event["session_id"]))
                if self.session_id is not None and observed_id != self.session_id:
                    raise AIAdapterError("ai_session_mismatch")
                self.session_id = observed_id
            if kind == "system":
                # Hooks are not part of a frozen-input analysis. Do not accept their output as an answer.
                # thinking_tokens는 추론 토큰 수 추정치만 담은 진행 알림이며 답변이나 도구 출력이 아니다.
                if event.get("subtype") not in {"init", "status", "api_retry", "compact_boundary", "thinking_tokens"}:
                    raise AIAdapterError("ai_unexpected_tool_activity")
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
                        callback({"type": "agent_message", "text": block["text"],
                                  "event": "item.completed", "item_id": None})
                    elif block["type"] == "tool_use" and block.get("name") == "StructuredOutput":
                        # This provider-internal tool only carries the JSON reply, not a host tool call.
                        if not isinstance(block.get("id"), str) or not isinstance(block.get("input"), dict):
                            raise AIAdapterError("ai_invalid_events")
                        self.structured_ids.add(block["id"])
                        callback({"type": "agent_message", "text": canonical_json_bytes(block["input"]).decode(),
                                  "event": "item.completed", "item_id": block["id"]})
                    elif block["type"] == "tool_use" and block.get("name") == "WebSearch" and self.web_search:
                        if not isinstance(block.get("id"), str) or not isinstance(block.get("input"), dict):
                            raise AIAdapterError("ai_invalid_events")
                        self.web_tool_ids.add(block["id"])
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
                    elif block["type"] != "tool_result" or block.get("tool_use_id") not in self.structured_ids:
                        raise AIAdapterError("ai_unexpected_tool_activity")
            elif kind == "result":
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
        try:
            executable = cli_command(self.cli)
        except ClientPlatformError as error:
            raise AIAdapterError(str(error)) from None
        if self._capabilities is None:
            for arguments in (("--version",), ("--help",)):
                code, output, _ = await _execute([*executable, *arguments], directory=None, environment=env)
                if code != 0:
                    raise AIAdapterError("ai_cli_unavailable")
                if arguments[0] == "--version":
                    version = output.decode("utf-8").strip()[:200]
                elif not all(flag in output.decode("utf-8") for flag in _REQUIRED_FLAGS):
                    raise AIAdapterError("ai_cli_incompatible")
            self._capabilities = executable, version
        return self._capabilities

    async def preflight(self):
        try:
            _, version = await self._check(environment())
        except ImportError as error:
            raise AIAdapterError("ai_windows_dependency_missing") from error
        except (OSError, TimeoutError) as error:
            raise AIAdapterError("ai_cli_unavailable") from error
        return {"provider": "claude", "cli_version": version, "requested_model": self.model,
                "capabilities_checked": True, "login_checked": False}

    async def run(self, *, prompt, schema, directory, output_schema=None, on_event=None, session_id=None, web_search=False):
        if (not isinstance(prompt, str) or not isinstance(schema, dict)
                or output_schema is not None and not isinstance(output_schema, dict)
                or type(web_search) is not bool or web_search and (session_id is not None or self.persist_session)):
            raise AIAdapterError("ai_invalid_input")
        prompt_bytes, original_schema = prompt.encode("utf-8"), canonical_json_bytes(schema)
        effective_schema = schema if output_schema is None else output_schema
        schema_bytes = canonical_json_bytes(effective_schema)
        if len(prompt_bytes) > min(MAX_PROMPT_BYTES, _MAX_STDIN_BYTES) or max(len(schema_bytes), len(original_schema)) > MAX_SCHEMA_BYTES:
            raise AIAdapterError("ai_input_limit")
        env = environment()
        await self.preflight()
        executable, version = self._capabilities
        arguments = [*executable, "--print", "--output-format", "stream-json", "--verbose", *_ISOLATION,
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
        metadata = {"provider": "claude", "cli_version": version, "requested_model": self.model,
            "model_selection": "explicit" if self.model is not None else "provider_default",
            "reported_model": None, "evidence_kind": "client_observed", "semantic_validation": "not_run",
            "prompt_sha256": sha256(prompt_bytes).hexdigest(), "schema_sha256": sha256(schema_bytes).hexdigest(),
            "input_schema_sha256": sha256(original_schema).hexdigest(), "status": "failed"}
        events, started = _Events(web_search=web_search), time.monotonic()
        callback = on_event if on_event is not None else self.on_event
        try:
            code, output, stderr = await _execute(arguments, directory=execution_directory, environment=env,
                prompt=prompt_bytes, timeout=self.timeout_seconds, on_event=callback or (lambda _: None), event_parser=events)
            metadata.update(returncode=code, stdout_sha256=sha256(output).hexdigest(), stderr_sha256=sha256(stderr).hexdigest(),
                            reported_model=events.model, token_usage=events.token_usage)
            if code != 0:
                raise AIAdapterError("ai_login_or_execution_failed")
            if events.result is None:
                raise AIAdapterError("ai_incomplete_turn")
            if web_search:
                metadata["web_search_completed"] = len(events.web_completed_ids)
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
            raise
        except (OSError, ValueError, TypeError, UnicodeError) as error:
            metadata["error_code"] = "ai_invalid_result"
            raise AIAdapterError("ai_invalid_result") from error
        finally:
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            _write_new(directory / "trace.jsonl", b"".join(canonical_json_bytes(event) for event in events.trace))
            _write_new(directory / "execution.json", canonical_json_bytes(metadata))
