"""선택한 개인 CLI만 만든다. 생략한 제공자는 기존 Codex를 유지한다."""

from .codex import CodexAdapter
from .contracts import AIAdapterError


def create_adapter(provider="codex", *, cli=None, model=None, timeout_seconds=900, on_event=None):
    if provider == "codex":
        adapter = CodexAdapter
    elif provider == "claude":
        from .claude import ClaudeAdapter
        adapter = ClaudeAdapter
    else:
        raise AIAdapterError("ai_invalid_configuration")
    return adapter(cli=provider if cli is None else cli, model=model,
                   timeout_seconds=timeout_seconds, on_event=on_event)
