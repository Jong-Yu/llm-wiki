"""개인 PC에서 실행하는 AI CLI 어댑터."""

# 작업·저장 흐름은 부모 client 모듈이, 실제 CLI 프로세스 관리는 이 패키지가 맡는다.
# import만으로 AI를 호출하거나 사용자의 로그인/설정을 변경하지 않는다.

from .codex import CodexAdapter
from .claude import ClaudeAdapter
from .provider import create_adapter

__all__ = ["CodexAdapter", "ClaudeAdapter", "create_adapter"]
