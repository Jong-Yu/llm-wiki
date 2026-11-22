"""명시적으로 표시한 사용자용 작업 설명만 중간 메시지로 전달한다."""

from hashlib import sha256
import json
import unicodedata
from uuid import uuid4


START_MARKER = "[[wiki-work-update]]"
END_MARKER = "[[/wiki-work-update]]"
MAX_COMMENTARY_CHARACTERS = 2000
MAX_COMMENTARY_MESSAGES = 3


def _content(event):
    if not isinstance(event, dict) or event.get("type") != "agent_message":
        return None
    # 어댑터가 공개 본문과 구조화 출력 도구의 메시지를 구분한다.
    # 메타데이터가 없는 기존 정규화 이벤트도 명시 마커 검사를 거친다.
    if event.get("kind") not in (None, "public_text"):
        return None
    if any(event.get(key) not in (None, "commentary") for key in ("channel", "phase")):
        return None
    raw = event.get("text")
    if (not isinstance(raw, str) or any(
            character not in "\n\r\t" and unicodedata.category(character) in {"Cc", "Cf", "Cs"}
            for character in raw)):
        return None
    raw = raw.strip()
    if (len(raw) > MAX_COMMENTARY_CHARACTERS + len(START_MARKER) + len(END_MARKER)
            or not raw.startswith(START_MARKER) or not raw.endswith(END_MARKER)):
        return None
    content = raw[len(START_MARKER):-len(END_MARKER)].strip()
    if (not content or len(content) > MAX_COMMENTARY_CHARACTERS
            or START_MARKER in content or END_MARKER in content
            or content.startswith(("{", "[", "```"))):
        return None
    try:
        json.loads(content)
    except (ValueError, TypeError):
        return content
    return None


class QuestionCommentary:
    """모델 호출 하나에서 공개 작업 설명을 최대 세 개 전달하는 콜백이다."""

    def __init__(self, emit):
        self.emit = emit
        self._prefix = "work-" + uuid4().hex
        self._messages = {}
        self._latest = {}

    def __call__(self, event):
        content = _content(event)
        if content is None:
            return
        item_id = event.get("item_id")
        if isinstance(item_id, str) and item_id:
            try:
                key = ("item", sha256(item_id.encode("utf-8")).hexdigest())
            except UnicodeEncodeError:
                return
        else:
            # 제공자 메시지 ID가 없으면 동일한 원문으로 반복 스냅샷을 식별한다.
            key = ("text", sha256(event["text"].encode("utf-8")).hexdigest())
        message_id = self._messages.get(key)
        if content in self._latest.values():
            return
        if message_id is None:
            if len(self._messages) >= MAX_COMMENTARY_MESSAGES:
                return
            message_id = f"{self._prefix}-{len(self._messages) + 1}"
            self._messages[key] = message_id
        self._latest[message_id] = content
        self.emit("commentary", message_id=message_id, content=content,
                  saved=False, origin="client_reported")
