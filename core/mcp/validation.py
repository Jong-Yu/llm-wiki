"""SDK의 JSON 문자열 전처리 전에 원래 입력 타입과 revision 계약을 검사한다."""

# AI가 보낸 인자를 SDK가 자동 보정하기 전에 확인한다. JSON null과 문자열 "null"은 다르다.
# 저장 기준 버전이 의도치 않게 신규 생성으로 바뀌지 않게 하며, 실제 인용/저장 검사는 업무 모듈에 맡긴다.
import json
import re

from mcp.types import CallToolResult
from pydantic import ValidationError

from core.mcp.results import _result
from core.mcp.schemas import CONCEPT_TOOLS, CORRESPONDENCE_TOOLS, REVISION_PATTERN


_CORRESPONDENCE_MUTATIONS = CORRESPONDENCE_TOOLS - {
    "ontology_correspondence_query", "ontology_correspondence_find", "ontology_correspondence_prepare",
}


def validate_model_arguments(name, arguments, models, *, maximum):
    """도구별 모델을 적용하고 SDK 처리 전 원래 JSON의 UTF-8 크기를 검사한다."""
    model = models.get(name)
    if model is None:
        return True
    try:
        model.model_validate(arguments)
        return len(json.dumps(arguments, ensure_ascii=False, allow_nan=False).encode("utf-8")) <= maximum
    except (ValidationError, ValueError, TypeError, UnicodeError, RecursionError):
        return False


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


def _is_revision(value):
    return isinstance(value, str) and re.fullmatch(REVISION_PATTERN, value) is not None


def _is_string(value):
    return isinstance(value, str)


def _is_object(value):
    return isinstance(value, dict)


def _objects(value):
    return isinstance(value, list) and all(isinstance(item, dict) for item in value)


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _schema_version(value):
    return type(value) is int and value in (3, 4, 5, 6)


def _response_mode(value):
    return type(value) is str and value in {"full", "compact"}


def _impact_baseline(value):
    fields = {"source_revision", "graph_revision", "review_revision", "history_revision"}
    return (isinstance(value, dict) and value.keys() == fields
            and all((item is None and key in {"graph_revision", "review_revision"}) or _is_revision(item)
                    for key, item in value.items()))


_STATE_MESSAGE = "expected_state_revision must be the SHA-256 from ontology_review_query."
_WIKI_REVISION_MESSAGE = "expected_revision must be JSON null or the 64-character SHA-256 from wiki_read."
_SOURCE_REVISION_MESSAGE = "expected_revision must be the 64-character SHA-256 from wiki_read."
_SCHEMA_MESSAGE = "schema_version must be the JSON integer 3, 4, 5 or 6."
_COLLECTION_MESSAGE = "Ontology collections must be JSON arrays of objects."
_QUALIFIER_MESSAGE = "qualifiers must be a JSON object, not encoded JSON text or null."
_FILTER_MESSAGE = "Ontology filters must be strings; omit a filter to leave it unset."
_REPLACEMENT_MESSAGE = "replacement must be a complete JSON claim object, not encoded JSON text."

# 순서는 기존 첫 오류의 우선순위다. required는 누락도 검사하며 optional은 명시 null을
# 검사한다. nullable만 누락과 JSON null을 함께 허용한다. 문자열 "null"은 여기에 포함되지 않는다.
_FILTER_RULES = (("domain", "optional", _is_string, _FILTER_MESSAGE),
                 ("viewpoint", "optional", _is_string, _FILTER_MESSAGE))
_STATE_RULE = ("expected_state_revision", "required", _is_revision, _STATE_MESSAGE)
_RAW_FIELD_RULES = {
    "ontology_review": (_STATE_RULE, ("replacement", "nullable", _is_object, _REPLACEMENT_MESSAGE)),
    "ontology_review_undo": (_STATE_RULE,),
    "ontology_policy": (_STATE_RULE,
        ("replacement", "optional", _is_object, _REPLACEMENT_MESSAGE),
        ("entities", "nullable", _objects, "entities must be a JSON array of new concept objects.")),
    "ontology_policy_undo": (_STATE_RULE,),
    "ontology_query": _FILTER_RULES,
    "ontology_review_query": _FILTER_RULES,
    "ontology_context": (*_FILTER_RULES,
        ("documents", "optional", _strings, "documents must be a JSON array of relative Markdown paths.")),
    "ontology_impact": (("baseline", "nullable", _impact_baseline,
        "baseline must contain exactly source_revision, graph_revision, review_revision and history_revision SHA-256 values; only graph/review revisions may be null."),
        *_FILTER_RULES),
    "wiki_write": (("expected_revision", "nullable", _is_revision, _WIKI_REVISION_MESSAGE),),
    "ontology_generate": (
        ("expected_state_revision", "nullable", _is_revision, _STATE_MESSAGE),
        ("schema_version", "optional", _schema_version, _SCHEMA_MESSAGE),
        ("expected_revision", "required", _is_revision, _SOURCE_REVISION_MESSAGE),
        ("entities", "optional", _objects, _COLLECTION_MESSAGE),
        ("relations", "optional", _objects, _COLLECTION_MESSAGE),
        ("relation_candidates", "optional", _objects, _COLLECTION_MESSAGE),
        ("attributes", "optional", _objects, _COLLECTION_MESSAGE)),
}
_RESPONSE_MODE_RULES = (("response_mode", "optional", _response_mode, "response_mode must be full or compact."),)
_MESSAGE_FIRST_ERRORS = {_WIKI_REVISION_MESSAGE, _SOURCE_REVISION_MESSAGE, _SCHEMA_MESSAGE,
                         _COLLECTION_MESSAGE, _QUALIFIER_MESSAGE}


def _field_argument_error(arguments, rules):
    for field, presence, check, message in rules:
        value = arguments.get(field)
        if presence == "optional" and field not in arguments:
            continue
        if presence == "nullable" and value is None:
            continue
        if not check(value):
            return message
    return None


def _cleanup_argument_error(name, arguments):
    from core.api.v1.reviews.schemas import CleanupApply, CleanupUndo, EventListQuery
    from core.api.v1.documents.schemas import ContentQuery
    from core.modules.reviews.cleanup_state import identifier
    try:
        if name in {"ontology_cleanup_apply", "ontology_cleanup_undo"}:
            (CleanupApply if name.endswith("apply") else CleanupUndo).model_validate(arguments)
        elif name == "ontology_cleanup_request":
            identifier(arguments.get("request_id"))
            ContentQuery.model_validate({key: value for key, value in arguments.items() if key != "request_id"})
        else:
            if "limit" in arguments and type(arguments["limit"]) is not int:
                raise ValueError("limit must be a JSON integer")
            EventListQuery.model_validate(arguments)
    except (ValidationError, ValueError, TypeError):
        return "Cleanup fields must match the strict preview/selection contract."
    return None


def _qualifier_argument_error(arguments):
    # 배열/원소 타입을 먼저 검사한 뒤 관계·후보·속성 안의 qualifiers만 검사한다.
    for field in ("relations", "relation_candidates", "attributes"):
        for item in arguments.get(field, []):
            if "qualifiers" in item and not isinstance(item["qualifiers"], dict):
                return _QUALIFIER_MESSAGE
    return None


def _invalid_argument(message):
    # JSON 객체뿐 아니라 text-only 클라이언트가 받던 키 순서도 유지한다.
    error = {"code": "invalid_argument", "retryable": False, "message": message}
    if message in _MESSAGE_FIRST_ERRORS:
        error = {"code": "invalid_argument", "message": message, "retryable": False}
    return _result({"ok": False, "error": error})


def validate_raw_arguments(name: str, arguments: dict) -> CallToolResult | None:
    """원시 타입을 순서대로 검사해 SDK의 문자열/nullable 보정 전 첫 오류를 반환한다."""
    from core.mcp.response_views import COMPACT_OPERATIONS
    if name in COMPACT_OPERATIONS:
        message = _field_argument_error(arguments, _RESPONSE_MODE_RULES)
        if message is not None:
            return _invalid_argument(message)
    if name.startswith("ontology_cleanup_"):
        message = _cleanup_argument_error(name, arguments)
        if message is not None:
            return _invalid_argument(message)
    if name in CONCEPT_TOOLS:
        message = _concept_argument_error(name, arguments)
        if message is not None:
            return _invalid_argument(message)
    if name in CORRESPONDENCE_TOOLS:
        message = _correspondence_argument_error(name, arguments)
        if message is not None:
            return _invalid_argument(message)
    message = _field_argument_error(arguments, _RAW_FIELD_RULES.get(name, ()))
    if message is not None:
        return _invalid_argument(message)
    if name == "ontology_generate":
        message = _qualifier_argument_error(arguments)
        if message is not None:
            return _invalid_argument(message)
    return None
