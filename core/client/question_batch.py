"""현재 문맥으로 선택한 여러 조회의 형식·예산·자료 범위를 미리 검사한다.

검색어와 후속 선택의 의미적 독립성은 이 검사로 증명하지 않는다. 실제 조회의
권한·판본·취소 검사는 기존 owner가 각 요청을 실행할 때 다시 수행한다.
"""

from copy import deepcopy

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

from core.client.ai.contracts import AIAdapterError


_MAX_QUERIES = 6
_QUERY_ACTIONS = ("search", "read", "claims", "history", "dialogue")
_QUERY_FIELDS = ("action", "query", "material_id", "start_line", "line_count", "offset", "limit",
                 "start_character", "character_count")
_STEP_FIELDS = (*_QUERY_FIELDS, "content", "evidence_ids")
_BATCH_GUIDE = (
    "Batch planning: put multiple evidence queries in queries only when each can be selected "
    "from the currently provided context. If a later choice needs an earlier query's result, "
    "use another planning round. Each physical query uses one of the same six-query budget; "
    "preserve every returned result, source condition and limitation. For action=batch, set "
    "all root query fields other than action to null, content to null and evidence_ids to []; "
    "put 1..remaining queries in queries. Query actions are search/read/claims/history/dialogue. "
    "For a single query or action=answer, queries must be []. Existing answer and citation "
    "rules still apply.\n"
)


def _invalid():
    raise AIAdapterError("ai_invalid_result")


def _remaining(value):
    if type(value) is not int or not 0 <= value <= _MAX_QUERIES:
        _invalid()


def batch_step_schema(base_schema, remaining):
    """기존 strict object에 필수 queries 배열만 더하며 입력 스키마는 보존한다."""
    _remaining(remaining)
    if (not isinstance(base_schema, dict) or base_schema.get("type") != "object"
            or base_schema.get("additionalProperties") is not False
            or not isinstance(base_schema.get("properties"), dict)
            or set(base_schema["properties"]) != set(_STEP_FIELDS)
            or not isinstance(base_schema.get("required"), list)
            or set(base_schema["required"]) != set(_STEP_FIELDS)):
        _invalid()
    try:
        Draft202012Validator.check_schema(base_schema)
    except SchemaError:
        _invalid()
    result = deepcopy(base_schema)
    query_properties = {name: deepcopy(result["properties"][name]) for name in _QUERY_FIELDS}
    query_properties["action"] = {"type": "string", "enum": list(_QUERY_ACTIONS)}
    result["properties"]["action"] = {"type": "string", "enum": (
        [*_QUERY_ACTIONS, "answer", "batch"] if remaining else ["answer"])}
    result["properties"]["queries"] = {"type": "array", "minItems": 0, "maxItems": remaining,
        "items": {"type": "object", "additionalProperties": False,
            "properties": query_properties, "required": list(_QUERY_FIELDS)}}
    result["required"].append("queries")
    return result


def batch_grounding_prompt(base_prompt, maximum_bytes):
    """신뢰된 계획 안내를 앞에 붙이고 원래 JSON·근거를 자르지 않는다."""
    if not isinstance(base_prompt, str) or type(maximum_bytes) is not int or maximum_bytes < 1:
        _invalid()
    prompt = _BATCH_GUIDE + base_prompt
    if len(prompt.encode("utf-8")) > maximum_bytes:
        raise AIAdapterError("ai_input_limit")
    return prompt


def _validate_binding(query, catalog):
    web = catalog.get("web", {})
    if not isinstance(web, dict):
        _invalid()
    documents, originals, sources = catalog.get("documents", []), catalog.get("originals", []), web.get("sources", [])
    if any(not isinstance(group, list) for group in (documents, originals, sources)):
        _invalid()
    material_id, action = query["material_id"], query["action"]
    matches = [item for group in (documents, originals, sources) for item in group
               if isinstance(item, dict) and item.get("id") == material_id]
    if action == "dialogue":
        if material_id is not None:
            _invalid()
    elif action == "read":
        if material_id is None or len(matches) != 1:
            _invalid()
        total, start = matches[0].get("line_count"), query["start_line"] or 1
        if type(total) is not int or not 1 <= start <= total:
            _invalid()
    elif action in ("claims", "history"):
        document_matches = [item for item in documents
                            if isinstance(item, dict) and item.get("id") == material_id]
        if (material_id is None or not material_id.startswith("d")
                or len(document_matches) != 1 or len(matches) != 1):
            _invalid()
    elif action == "search" and material_id is not None and len(matches) != 1:
        _invalid()


def batch_query_steps(step, remaining, catalog, schema):
    """전체 계획을 검사한 뒤 실행할 원시 조회들을 순서대로 반환한다."""
    _remaining(remaining)
    if not isinstance(schema, dict) or not isinstance(catalog, dict):
        _invalid()
    try:
        Draft202012Validator(schema).validate(step)
    except (SchemaError, ValidationError):
        _invalid()
    action = step["action"]
    if action == "batch":
        queries = step["queries"]
        if (not 1 <= len(queries) <= remaining
                or any(step[name] is not None for name in _QUERY_FIELDS if name != "action")
                or step["content"] is not None or step["evidence_ids"] != []):
            _invalid()
    else:
        if step["queries"] != []:
            _invalid()
        if action == "answer":
            return []
        if action not in _QUERY_ACTIONS or not remaining or step["content"] is not None or step["evidence_ids"] != []:
            _invalid()
        queries = [step]
    for query in queries:
        _validate_binding(query, catalog)
    return list(queries)
