"""SDK의 JSON 문자열 전처리 전에 원래 입력 타입과 revision 계약을 검사한다."""

# AI가 보낸 인자를 SDK가 자동 보정하기 전에 확인한다. JSON null과 문자열 "null"은 다르다.
# 저장 기준 버전이 의도치 않게 신규 생성으로 바뀌지 않게 하며, 실제 인용/저장 검사는 업무 모듈에 맡긴다.
import re

from mcp.types import CallToolResult

from core.mcp.results import _result
from core.mcp.schemas import CONCEPT_TOOLS, CORRESPONDENCE_TOOLS, REVISION_PATTERN


_CORRESPONDENCE_MUTATIONS = CORRESPONDENCE_TOOLS - {
    "ontology_correspondence_query", "ontology_correspondence_find", "ontology_correspondence_prepare",
}


def _concept_argument_error(name: str, arguments: dict) -> str | None:
    """SDK 전처리 전에 리터럴 문자열과 엄격한 JSON 타입을 보존한다."""
    # 발견(find)은 검색 문자열, 조회(query)는 정확한 대상 객체를 받는다.
    # 잘못됐으면 안내 문자열을, 통과하면 None을 반환하는 보조 함수다.
    if name == "ontology_concept_find":
        text = arguments.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 200:
            return "text must contain 1 to 200 nonblank characters."
        if "include_history" in arguments and type(arguments["include_history"]) is not bool:
            return "include_history must be a JSON boolean."
    else:
        if not isinstance(arguments.get("target"), dict):
            return "target must be one typed JSON object from ontology_concept_find, not encoded JSON text."
        expansion = arguments.get("expansion", "none")
        if not isinstance(expansion, str) or expansion not in {"none", "direct_confirmed"}:
            return "expansion must be none or direct_confirmed."
    if "documents" in arguments and arguments["documents"] is not None:
        documents = arguments["documents"]
        if (not isinstance(documents, list) or not 1 <= len(documents) <= 8
                or any(not isinstance(item, str) for item in documents)):
            return "documents must be a JSON array of 1 to 8 relative Markdown paths."
    if "correspondence_ids" in arguments and arguments["correspondence_ids"] is not None:
        identifiers = arguments["correspondence_ids"]
        if (not isinstance(identifiers, list) or len(identifiers) > 8
                or any(not isinstance(item, str) or re.fullmatch(r"[0-9a-f]{32}", item) is None for item in identifiers)):
            return "correspondence_ids must be a JSON array of at most 8 server-issued identifiers."
    if "application_context" in arguments and arguments["application_context"] is not None and not isinstance(arguments["application_context"], dict):
        return "application_context must be a JSON axis-name-to-value object, not encoded JSON text."
    if "as_of" in arguments and not isinstance(arguments["as_of"], str):
        return "as_of must be an offset-aware timestamp string; omit it when unset."
    limit = arguments.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 100:
        return "limit must be an integer from 1 to 100."
    return None


def _correspondence_argument_error(name: str, arguments: dict) -> str | None:
    # 초안/교체값/업무 조건은 JSON 객체여야 한다. 객체를 문자열로 인코딩해 우회하지 못하게 한다.
    """Reject raw types before SDK nullable/JSON-string preprocessing occurs."""
    suffix = name.removeprefix("ontology_correspondence_")
    required = {
        "query": set(), "find": {"documents"},
        "prepare": {"correspondence_id", "operation", "change"},
        "propose": {"correspondence_id", "draft", "expected_state_revision", "reason"},
        "review": {"correspondence_id", "action", "expected_state_revision", "reason"},
        "review_undo": {"correspondence_id", "event_id", "expected_state_revision", "reason"},
        "policy": {"correspondence_id", "replacement", "expected_state_revision", "reason"},
        "policy_undo": {"correspondence_id", "event_id", "expected_state_revision", "reason"},
    }[suffix]
    if not required <= arguments.keys():
        return "Required correspondence arguments are missing."
    for field in ("correspondence_id", "event_id", "judgment_id", "supersedes_event_id"):
        if field in arguments and arguments[field] is not None and (
            not isinstance(arguments[field], str) or re.fullmatch(r"[0-9a-f]{32}", arguments[field]) is None
        ):
            return f"{field} must be a server-issued lowercase 32-character identifier."
        if field in required and not isinstance(arguments[field], str):
            return f"{field} must be a string."
    for field in ("draft", "replacement", "change", "application_context"):
        if field in arguments and arguments[field] is not None and not isinstance(arguments[field], dict):
            return f"{field} must be a JSON object, not encoded JSON text."
        if field in required and not isinstance(arguments[field], dict):
            return f"{field} must be a JSON object."
    for field in ("text", "as_of"):
        if field in arguments and not isinstance(arguments[field], str):
            return f"{field} must be a string; omit it when unset."
    if "text" in arguments and len(arguments["text"]) > 2000:
        return "text must contain at most 2000 characters."
    if suffix == "query" and ((arguments.get("correspondence_id") is None) == (arguments.get("draft") is None)):
        return "Provide exactly one of correspondence_id or draft."
    if suffix == "find":
        documents = arguments["documents"]
        if (not isinstance(documents, list) or not 1 <= len(documents) <= 8
                or any(not isinstance(item, str) for item in documents)):
            return "documents must be a JSON array of 1 to 8 relative Markdown paths."
        limit = arguments.get("limit", 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            return "limit must be an integer from 1 to 100."
    if suffix == "prepare" and (not isinstance(arguments.get("operation"), str)
                               or arguments["operation"] not in {"review", "review_undo", "policy", "policy_undo"}):
        return "operation must be review, review_undo, policy or policy_undo."
    if suffix == "review":
        if not isinstance(arguments.get("action"), str) or arguments["action"] not in {"accept", "reject", "defer", "edit"}:
            return "action must be accept, reject, defer or edit."
        if arguments.get("decision") is not None and (not isinstance(arguments["decision"], str)
                                                     or arguments["decision"] not in {"accepted", "deferred"}):
            return "decision must be accepted or deferred."
    if name in _CORRESPONDENCE_MUTATIONS:
        revision = arguments.get("expected_state_revision")
        if not isinstance(revision, str) or re.fullmatch(REVISION_PATTERN, revision) is None:
            return "expected_state_revision must be the SHA-256 from correspondence query/prepare."
        reason = arguments.get("reason")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
            return "reason must contain 1 to 2000 characters."
    return None


def validate_raw_arguments(name: str, arguments: dict) -> CallToolResult | None:
    # 오류가 있으면 MCP 오류 응답을 반환한다. None은 다음 SDK 검사를 진행해도 된다는 뜻이다.
    if name in CONCEPT_TOOLS:
        message = _concept_argument_error(name, arguments)
        if message is not None:
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False, "message": message,
            }})
    if name in CORRESPONDENCE_TOOLS:
        message = _correspondence_argument_error(name, arguments)
        if message is not None:
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False, "message": message,
            }})
    if name in ("ontology_generate", "ontology_review", "ontology_review_undo", "ontology_policy", "ontology_policy_undo"):
        value = arguments.get("expected_state_revision")
        if (name != "ontology_generate" or value is not None) and (
            not isinstance(value, str) or re.fullmatch(REVISION_PATTERN, value) is None
        ):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False,
                "message": "expected_state_revision must be the SHA-256 from ontology_review_query.",
            }})
    if name in ("ontology_review", "ontology_policy") and "replacement" in arguments:
        if (name == "ontology_policy" or arguments["replacement"] is not None) and not isinstance(arguments["replacement"], dict):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False,
                "message": "replacement must be a complete JSON claim object, not encoded JSON text.",
            }})
    if name == "ontology_policy" and "entities" in arguments:
        entities = arguments["entities"]
        if entities is not None and (not isinstance(entities, list) or any(not isinstance(item, dict) for item in entities)):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False,
                "message": "entities must be a JSON array of new concept objects.",
            }})
    if name == "ontology_impact" and arguments.get("baseline") is not None:
        baseline = arguments["baseline"]
        fields = {"source_revision", "graph_revision", "review_revision", "history_revision"}
        if (not isinstance(baseline, dict) or set(baseline) != fields
                or any(not (value is None and key in {"graph_revision", "review_revision"})
                       and (not isinstance(value, str) or re.fullmatch(REVISION_PATTERN, value) is None)
                       for key, value in baseline.items())):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False,
                "message": "baseline must contain exactly source_revision, graph_revision, review_revision and history_revision SHA-256 values; only graph/review revisions may be null.",
            }})
    if name in ("ontology_query", "ontology_context", "ontology_review_query", "ontology_impact"):
        for field in ("domain", "viewpoint"):
            if field in arguments and not isinstance(arguments[field], str):
                return _result({"ok": False, "error": {
                    "code": "invalid_argument", "retryable": False,
                    "message": "Ontology filters must be strings; omit a filter to leave it unset.",
                }})
    if name == "ontology_context" and "documents" in arguments:
        documents = arguments["documents"]
        if not isinstance(documents, list) or any(not isinstance(item, str) for item in documents):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "retryable": False,
                "message": "documents must be a JSON array of relative Markdown paths.",
            }})
    # SDK 2.3은 nullable 인자의 JSON 모양 문자열을 먼저 파싱한다.
    # revision 문자열 "null"이 신규 생성용 None으로 바뀌기 전에 원본을 검사한다.
    if name == "wiki_write" and "expected_revision" in arguments:
        revision = arguments["expected_revision"]
        if revision is not None and (
            not isinstance(revision, str) or re.fullmatch(REVISION_PATTERN, revision) is None
        ):
            return _result({"ok": False, "error": {
                "code": "invalid_argument",
                "message": "expected_revision must be JSON null or the 64-character SHA-256 from wiki_read.",
                "retryable": False,
            }})
    if name == "ontology_generate":
        if "schema_version" in arguments and (
            type(arguments["schema_version"]) is not int or arguments["schema_version"] not in (3, 4, 5, 6)
        ):
            return _result({"ok": False, "error": {
                "code": "invalid_argument", "message": "schema_version must be the JSON integer 3, 4, 5 or 6.",
                "retryable": False,
            }})
        revision = arguments.get("expected_revision")
        if not isinstance(revision, str) or re.fullmatch(REVISION_PATTERN, revision) is None:
            return _result({"ok": False, "error": {
                "code": "invalid_argument",
                "message": "expected_revision must be the 64-character SHA-256 from wiki_read.",
                "retryable": False,
            }})
        for field in ("entities", "relations", "relation_candidates", "attributes"):
            if field in arguments and (
                not isinstance(arguments[field], list)
                or any(not isinstance(item, dict) for item in arguments[field])
            ):
                return _result({"ok": False, "error": {
                    "code": "invalid_argument",
                    "message": "Ontology collections must be JSON arrays of objects.",
                    "retryable": False,
                }})
        for field in ("relations", "relation_candidates", "attributes"):
            for item in arguments.get(field, []):
                if "qualifiers" in item and not isinstance(item["qualifiers"], dict):
                    return _result({"ok": False, "error": {
                        "code": "invalid_argument",
                        "message": "qualifiers must be a JSON object, not encoded JSON text or null.",
                        "retryable": False,
                    }})
    return None
