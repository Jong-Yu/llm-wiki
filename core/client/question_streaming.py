"""답변 단계의 공개 본문만 생성 중 표시하며 검증·저장에는 사용하지 않는다."""

import json
import re
from time import monotonic

from core.client.question_ai import _content_prefix


MAX_STREAM_CHARACTERS = 2 * 1024 * 1024
MIN_PREVIEW_INTERVAL_SECONDS = 0.2
_SURROGATES = re.compile(r"[\ud800-\udfff]")


def _answer_content_prefix(raw):
    """최상위 action이 answer로 확인된 JSON에서만 content 문자열 접두어를 읽는다."""
    if not isinstance(raw, str) or len(raw) > MAX_STREAM_CHARACTERS:
        return None
    decoder, index, seen, action, content = json.JSONDecoder(), 0, set(), None, None
    try:
        index = len(raw) - len(raw.lstrip())
        if raw[index:index + 1] != "{":
            return None
        index += 1
        while index < len(raw):
            while index < len(raw) and raw[index] in " \r\n\t":
                index += 1
            key, index = decoder.raw_decode(raw, index)
            if not isinstance(key, str) or key in seen:
                return None
            seen.add(key)
            while index < len(raw) and raw[index] in " \r\n\t":
                index += 1
            if raw[index:index + 1] != ":":
                return None
            index += 1
            while index < len(raw) and raw[index] in " \r\n\t":
                index += 1
            if key == "content" and action == "answer":
                # 기존 문자열 해독기는 완성된 escape/Unicode만 전달하며 본문 상한도 유지한다.
                return _content_prefix(raw)
            value, index = decoder.raw_decode(raw, index)
            if key == "action":
                if value != "answer":
                    return None
                action = value
                if content is not None:
                    return content
            elif key == "content":
                if not isinstance(value, str) or _SURROGATES.search(value):
                    return None
                content = value[:65536]
            while index < len(raw) and raw[index] in " \r\n\t":
                index += 1
            if raw[index:index + 1] != ",":
                return None
            index += 1
    except (ValueError, TypeError, RecursionError):
        return None
    return None


def _without_evidence_markers(content):
    """완성·미완성 근거 ID는 숨기고 검증이 끝난 최종 답변에서만 인용 번호를 붙인다."""
    pieces, index = [], 0
    while True:
        start = content.find("[[", index)
        if start < 0:
            tail = content[index:]
            # 다음 조각에서 [[가 될 수 있는 마지막 [ 한 글자도 보류한다.
            pieces.append(tail[:-1] if tail.endswith("[") else tail)
            return "".join(pieces)
        pieces.append(content[index:start])
        end = content.find("]]", start + 2)
        if end < 0:
            return "".join(pieces)
        index = end + 2


class GroundedAnswerPreview:
    """호출 하나의 누적 공개 JSON 스냅샷에서 미확정 본문만 전체 교체로 전달한다."""

    def __init__(self, emit, *, clock=None):
        self.emit, self.previous = emit, None
        self.clock, self.last_checked = clock or monotonic, None

    def __call__(self, event):
        if not isinstance(event, dict) or event.get("type") != "agent_message":
            return
        if event.get("kind") not in (None, "public_text", "structured_output"):
            return
        if any(event.get(key) not in (None, "final") for key in ("channel", "phase")):
            return
        now = self.clock()
        # 첫 본문과 완료는 즉시 전달한다. 빠른 토큰 이벤트는 최신 실제 수신 스냅샷만
        # 읽어 전체 JSON 재해독·본문 재전송을 초당 다섯 번 이하로 제한한다.
        if (self.previous is not None and event.get("event") != "item.completed"
                and self.last_checked is not None and now - self.last_checked < MIN_PREVIEW_INTERVAL_SECONDS):
            return
        self.last_checked = now
        content = _answer_content_prefix(event.get("text"))
        if content is None:
            return
        content = _without_evidence_markers(content)
        if content and content != self.previous:
            self.previous = content
            self.emit("answer_preview", content=content, saved=False, origin="client_reported")
