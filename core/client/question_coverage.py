"""질문에서 만든 항목을 고정하고 각 항목의 답변과 근거를 함께 보존한다.

계획 항목이 출력에서 빠지지 않는 구조를 검사한다. 계획이 질문의 모든 의미를
포함하는지, 인용이 답변의 의미를 뒷받침하는지는 별도의 의미 검증 대상이다.
선택된 원문 맥락은 그대로 보존하지만 모델이 추출하지 않은 조건을 만들어 내지 않는다.
"""

from copy import deepcopy
import re

from core.client.ai.contracts import AIAdapterError
from core.client.question_citations import (
    MAX_CITATIONS,
    MAX_CONTENT_CHARACTERS,
    MAX_IDENTIFIER_CHARACTERS,
    _MARKER,
    _code_ranges,
    render_evidence_citations,
)


MAX_PARTS = 8
MAX_PART_CHARACTERS = 200
MAX_ANSWER_CHARACTERS = 7000
MAX_SOURCE_CONTEXTS = 8
MAX_SOURCE_CONTEXT_CHARACTERS = 1000
_QUERIES = {"search", "read", "claims", "history", "dialogue"}
_ANSWER_FIELDS = {"part", "status", "text", "evidence_ids"}
_SOURCE_CONTEXT_FIELDS = {"kind", "text", "evidence_ids"}
_SOURCE_CONTEXT_LABELS = {"definition": "관련 정의", "requirement": "원문의 요구", "condition": "조건",
    "exception": "예외", "direction": "방향", "source_claim": "자료의 주장", "scope": "적용 범위"}
_HEADING_CHARACTER = re.compile(r"([\\`*_{}\[\]<>()#+.!|~\-])")
_PURPOSE = "question_derived_plan_only_not_factual_evidence"


def _invalid():
    raise AIAdapterError("ai_invalid_result")


def _number(value, maximum):
    return type(value) is int and 1 <= value <= maximum


def _labels(value):
    """한 줄 항목의 원래 표현은 유지하고 빈 값·중복·표시 제어문자는 거부한다."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PARTS:
        _invalid()
    if any(not isinstance(label, str) or not 1 <= len(label) <= MAX_PART_CHARACTERS
           or not label.strip() or any(ord(character) < 32 or ord(character) == 127 for character in label)
           for label in value):
        _invalid()
    if len({label.strip() for label in value}) != len(value):
        _invalid()
    return tuple(value)


def _heading(label):
    """모델이 만든 항목명을 링크·인용·코드가 아닌 heading 텍스트로 표시한다."""
    return _HEADING_CHARACTER.sub(r"\\\1", label)


class CoverageState:
    """한 질문 실행 안에서만 계획과 성공한 조회의 대상 항목을 보관한다."""

    def __init__(self, *, dialogue_available=False, preserve_source_scope=False):
        if type(dialogue_available) is not bool or type(preserve_source_scope) is not bool:
            _invalid()
        self._initial_context = dialogue_available
        self._preserve_source_scope = preserve_source_scope
        self._parts = ()
        self._queries = []
        self._factual_queries = []
        self._contexts = []

    def schema(self, base_schema, *, allow_not_checked=False):
        """모델 호출을 추가하지 않고 기존 step에 계획·대상·항목별 답변을 붙인다."""
        if type(allow_not_checked) is not bool or not isinstance(base_schema, dict):
            _invalid()
        result = deepcopy(base_schema)
        if not isinstance(result.get("properties"), dict) or not isinstance(result.get("required"), list):
            _invalid()
        maximum = len(self._parts) or MAX_PARTS
        statuses = ["supported", "not_found"] + (["not_checked"] if allow_not_checked else [])
        if self._initial_context or any(self._contexts):
            statuses.append("context_only")
        result["properties"].update({
            "content": {"type": "null"},
            "evidence_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 0},
            "parts": {"type": "array", "items": {"type": "string", "minLength": 1,
                "maxLength": MAX_PART_CHARACTERS, "pattern": r"^[^\r\n]+$"},
                "minItems": 0 if self._parts else 1, "maxItems": MAX_PARTS},
            "covers": {"type": "array", "items": {"type": "integer", "minimum": 1,
                "maximum": maximum}, "maxItems": maximum},
            "answers": {"type": "array", "maxItems": maximum, "items": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "part": {"type": "integer", "minimum": 1, "maximum": maximum},
                    "status": {"type": "string", "enum": statuses},
                    "text": {"type": "string", "minLength": 1, "maxLength": MAX_ANSWER_CHARACTERS},
                    "evidence_ids": {"type": "array", "items": {"type": "string", "minLength": 1,
                        "maxLength": MAX_IDENTIFIER_CHARACTERS}, "maxItems": MAX_CITATIONS}},
                "required": ["part", "status", "text", "evidence_ids"]}},
        })
        if self._preserve_source_scope:
            answer_schema = result["properties"]["answers"]["items"]
            answer_schema["properties"]["source_context"] = {"type": "array", "maxItems": MAX_SOURCE_CONTEXTS,
                "items": {"type": "object", "additionalProperties": False,
                    "properties": {
                        "kind": {"type": "string", "enum": list(_SOURCE_CONTEXT_LABELS)},
                        "text": {"type": "string", "minLength": 1, "maxLength": MAX_SOURCE_CONTEXT_CHARACTERS},
                        "evidence_ids": {"type": "array", "items": {"type": "string", "minLength": 1,
                            "maxLength": MAX_IDENTIFIER_CHARACTERS}, "minItems": 1, "maxItems": MAX_CITATIONS}},
                    "required": ["kind", "text", "evidence_ids"]}}
            answer_schema["required"].append("source_context")
        for name in ("parts", "covers", "answers"):
            if name not in result["required"]:
                result["required"].append(name)
        return result

    def _plan(self, step):
        if (not isinstance(step, dict) or not {"content", "evidence_ids", "parts"} <= step.keys()
                or step["content"] is not None or step["evidence_ids"] != []):
            _invalid()
        supplied = step.get("parts")
        if self._parts:
            if supplied == []:
                return self._parts
            if _labels(supplied) != self._parts:
                _invalid()
            return self._parts
        return _labels(supplied)

    def _query(self, step):
        parts = self._plan(step)
        covers = step.get("covers")
        action = step.get("action")
        if (not isinstance(action, str) or action not in _QUERIES or step.get("answers") != []
                or not isinstance(covers, list) or not covers
                or any(not _number(value, len(parts)) for value in covers)
                or len(covers) != len(set(covers))):
            _invalid()
        return parts, covers

    def validate_query(self, step):
        """서버 요청 전에 계획/조회 대상만 검사하며 성공 횟수는 바꾸지 않는다."""
        self._query(step)

    def observe_query(self, step, response=None):
        """성공한 실제 조회 뒤에만 호출하여 항목별 조회 횟수를 증가시킨다."""
        parts, covers = self._query(step)
        if response is not None and not isinstance(response, dict):
            _invalid()
        counts = list(self._queries) if self._parts else [0] * len(parts)
        factual = list(self._factual_queries) if self._parts else [0] * len(parts)
        contexts = list(self._contexts) if self._parts else [self._initial_context] * len(parts)
        items = response.get("items") if isinstance(response, dict) else None
        has_dialogue = (isinstance(items, list) and any(isinstance(item, dict)
            and isinstance(item.get("content"), str) and item["content"] != "" for item in items))
        for number in covers:
            counts[number - 1] += 1
            if step["action"] == "dialogue":
                contexts[number - 1] = contexts[number - 1] or has_dialogue
            else:
                factual[number - 1] += 1
        self._parts, self._queries = parts, counts
        self._factual_queries, self._contexts = factual, contexts

    def prompt_state(self):
        """계획은 정답·사실 근거가 아님을 표시한 복사본을 반환한다."""
        result = {"parts": list(self._parts), "queries_by_part": [
            {"part": index, "successful_queries": count, "factual_queries": self._factual_queries[index - 1],
             "context_available": self._contexts[index - 1]} for index, count in enumerate(self._queries, 1)],
            "initial_context_available": self._initial_context,
            "context_only_is_not_current_factual_evidence": True,
            "frozen": bool(self._parts), "purpose": _PURPOSE}
        if self._preserve_source_scope:
            result["source_scope_preservation"] = True
        return result

    def _source_context(self, answer, registry):
        """모델이 명시한 맥락 문장과 각각의 인용을 검증하고 요약 없이 붙인다."""
        body, identifiers, label_ranges = answer["text"], list(answer["evidence_ids"]), []
        if not self._preserve_source_scope:
            return body, identifiers, label_ranges
        contexts = answer["source_context"]
        if not isinstance(contexts, list) or len(contexts) > MAX_SOURCE_CONTEXTS:
            _invalid()
        if answer["status"] != "supported" and contexts:
            _invalid()
        seen = set(identifiers)
        for context in contexts:
            if not isinstance(context, dict) or set(context) != _SOURCE_CONTEXT_FIELDS:
                _invalid()
            kind, text, declared = (context[key] for key in ("kind", "text", "evidence_ids"))
            if (not isinstance(kind, str) or kind not in _SOURCE_CONTEXT_LABELS or not isinstance(text, str)
                    or not 1 <= len(text) <= MAX_SOURCE_CONTEXT_CHARACTERS or not text.strip()
                    or not isinstance(declared, list) or not declared):
                _invalid()
            render_evidence_citations(text, declared, registry)
            label = f"**{_SOURCE_CONTEXT_LABELS[kind]}**\n\n"
            start = len(body) + 2
            label_ranges.append((start, start + len(label)))
            body += "\n\n" + label + text
            for identifier in declared:
                if identifier not in seen:
                    identifiers.append(identifier)
                    seen.add(identifier)
        if len(body) > MAX_ANSWER_CHARACTERS:
            _invalid()
        return body, identifiers, label_ranges

    def render(self, step, registry, *, allow_not_checked=False):
        """모든 계획 항목을 정확히 한 번 조립하고 실제 근거 ID를 한 번에 번호화한다."""
        if type(allow_not_checked) is not bool:
            _invalid()
        parts = self._plan(step)
        answers = step.get("answers")
        if (step.get("action") != "answer" or step.get("covers") != []
                or not isinstance(answers, list) or len(answers) != len(parts)):
            _invalid()
        counts = self._queries if self._parts else [0] * len(parts)
        factual = self._factual_queries if self._parts else [0] * len(parts)
        contexts = self._contexts if self._parts else [self._initial_context] * len(parts)
        selected, bodies = {}, {}
        for answer in answers:
            fields = _ANSWER_FIELDS | {"source_context"} if self._preserve_source_scope else _ANSWER_FIELDS
            if not isinstance(answer, dict) or set(answer) != fields:
                _invalid()
            number, status, text, identifiers = (answer[key] for key in ("part", "status", "text", "evidence_ids"))
            if (not _number(number, len(parts)) or number in selected or not isinstance(text, str)
                    or not 1 <= len(text) <= MAX_ANSWER_CHARACTERS or not text.strip()):
                _invalid()
            if status == "supported":
                if not isinstance(identifiers, list) or not identifiers:
                    _invalid()
            elif status == "not_found":
                if not factual[number - 1] or identifiers != []:
                    _invalid()
            elif status == "not_checked":
                if not allow_not_checked or factual[number - 1] or identifiers != []:
                    _invalid()
            elif status == "context_only":
                if not contexts[number - 1] or identifiers != []:
                    _invalid()
            else:
                _invalid()
            if self._preserve_source_scope:
                # 항목의 선언은 핵심 본문만 또는 같은 항목의 맥락까지 포함할 수 있다.
                # 핵심 본문과 각 맥락의 미선언 인용은 각각 거부한다.
                if (not isinstance(identifiers, list) or len(identifiers) > MAX_CITATIONS
                        or any(not isinstance(value, str) for value in identifiers)
                        or len(set(identifiers)) != len(identifiers)):
                    _invalid()
                marked = set(_MARKER.findall(text))
                core_ids = [value for value in identifiers if value in marked]
                if status == "supported" and not core_ids:
                    _invalid()
                render_evidence_citations(text, core_ids, registry)
            else:
                render_evidence_citations(text, identifiers, registry)
            body = self._source_context(answer, registry)
            # 다른 항목에서의 사용으로 이 항목의 불필요한 선언을 숨기지 못한다.
            render_evidence_citations(body[0], body[1], registry)
            bodies[number] = body
            selected[number] = answer
        if set(selected) != set(range(1, len(parts) + 1)):
            _invalid()
        fragments, identifiers, declared, headings = [], [], set(), []
        position = 0
        for number, label in enumerate(parts, 1):
            answer = selected[number]
            suffix = {"supported": "", "not_found": " (확인 불가)", "not_checked": " (미확인)",
                      "context_only": " (이전 대화)"}[answer["status"]]
            heading = f"### {number}. {_heading(label)}{suffix}\n\n"
            if fragments:
                position += 2
            headings.append((position, position + len(heading)))
            body, body_ids, context_labels = bodies[number]
            headings.extend((position + len(heading) + start, position + len(heading) + end)
                            for start, end in context_labels)
            fragment = heading + body
            fragments.append(fragment)
            position += len(fragment)
            for identifier in body_ids:
                if identifier not in declared:
                    identifiers.append(identifier)
                    declared.add(identifier)
        content = "\n\n".join(fragments)
        if len(content) > MAX_CONTENT_CHARACTERS or len(identifiers) > MAX_CITATIONS:
            _invalid()
        # 앞 항목의 열린 code span/fence가 다음 항목 heading을 삼키지 못하게 한다.
        if any(first < end and last > start for first, last in _code_ranges(content) for start, end in headings):
            _invalid()
        result = render_evidence_citations(content, identifiers, registry)
        if not self._parts:
            self._parts, self._queries = parts, list(counts)
            self._factual_queries, self._contexts = list(factual), list(contexts)
        return result
