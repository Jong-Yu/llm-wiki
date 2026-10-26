"""개념 조회의 대상·판본·snapshot 참조를 엄격하게 검사한다.

대응 스키마의 공통 값 검사를 재사용하되 이 도메인의 오류로 변환한다.
형식 통과는 대상의 현재성·업무 사실·접근 권한을 증명하지 않는다.
"""

# target_ref가 문서·개체·주장·판단에 필요한 버전과 의미 사본을 갖췄는지 확인한다.
# 형식이 맞아도 현재 자료와 같다는 뜻은 아니다. 실제 대조는 references.py가 맡는다.
from copy import deepcopy

from core.modules.correspondences import schema as correspondence


class ConceptValidationError(ValueError):
    """An unsupported or incomplete discovery/selection request."""


class ConceptLimitError(ValueError):
    """A request cannot fit a documented bounded selection."""


def fields(value, required, optional=(), name="target"):
    if not isinstance(value, dict) or not set(required) <= set(value) <= set(required) | set(optional):
        raise ConceptValidationError(f"{name} must contain exactly its documented fields")


def token(value, name="revision", *, nullable=False):
    if value is None and nullable:
        return
    try:
        correspondence.token(value, name)
    except ValueError as error:
        raise ConceptValidationError(str(error)) from error


def identifier(value, name="id"):
    try:
        correspondence.identifier(value, name)
    except ValueError as error:
        raise ConceptValidationError(str(error)) from error


def text(value, name="text", limit=200):
    try:
        return correspondence.text(value, name, limit)
    except ValueError as error:
        raise ConceptValidationError(str(error)) from error


def documents(value, store):
    if value is None:
        return []
    if not isinstance(value, list) or not 1 <= len(value) <= 8 or any(not isinstance(path, str) for path in value) or len(value) != len(set(value)):
        raise ConceptValidationError("documents must contain 1-8 unique paths")
    for path in value:
        try:
            store._document_path(store.wiki_dir, path)
        except (ValueError, TypeError) as error:
            raise ConceptValidationError("invalid document path") from error
    return list(value)


def _origin(value, store):
    fields(value, {"kind", "document", "original_collection", "claim_id", "latest_event_id", "selected_event_id", "decision_event_id", "exact_scope", "state_revision", "snapshot"}, name="origin_ref")
    if value["kind"] != "document_policy":
        raise ConceptValidationError("unsupported origin_ref kind")
    store._document_path(store.wiki_dir, value["document"])
    if value["original_collection"] not in {"relations", "attributes", "relation_candidates"}:
        raise ConceptValidationError("invalid origin collection")
    for name in ("claim_id", "state_revision"):
        token(value[name], name)
    for name in ("latest_event_id", "selected_event_id"):
        identifier(value[name], name)
    if value["decision_event_id"] is not None:
        identifier(value["decision_event_id"], "decision_event_id")
    try:
        correspondence.scope(value["exact_scope"])
    except ValueError as error:
        raise ConceptValidationError(str(error)) from error
    if not isinstance(value["snapshot"], dict):
        raise ConceptValidationError("origin snapshot must be an object")


def _validate_target(value, store):
    if not isinstance(value, dict) or "kind" not in value:
        raise ConceptValidationError("target must be a typed object")
    kind = value["kind"]
    if kind == "anchor":
        fields(value, {"kind", "anchor", "observation"})
        try:
            correspondence.anchor(value["anchor"], store)
        except (ValueError, TypeError) as error:
            raise ConceptValidationError(str(error)) from error
        fields(value["observation"], {"source_revision", "history_revision"}, name="observation")
        for name in ("source_revision", "history_revision"):
            token(value["observation"][name], name, nullable=True)
        if value["observation"]["source_revision"] is not None and value["observation"]["source_revision"] != value["anchor"]["source_revision"]:
            raise ConceptValidationError("anchor and observation source revisions differ")
    elif kind in {"entity", "document_claim"}:
        required = {"kind", "document", "source_revision", "graph_revision", "state_revision", "layer", "snapshot"}
        required |= {"entity_id"} if kind == "entity" else {"original_collection", "claim_id"}
        fields(value, required, {"origin_ref", "historical"} | ({"selector"} if kind == "document_claim" else set()))
        store._document_path(store.wiki_dir, value["document"])
        for name in ("source_revision", "graph_revision", "state_revision"):
            token(value[name], name, nullable=name == "graph_revision")
        if value["layer"] not in {"machine", "reviewed"} or not isinstance(value["snapshot"], dict):
            raise ConceptValidationError("target needs a supported layer and object snapshot")
        if kind == "entity":
            text(value["entity_id"], "entity_id", 100)
        else:
            collection = value["original_collection"]
            if collection not in {"relations", "attributes", "relation_candidates"}:
                raise ConceptValidationError("invalid original_collection")
            token(value["claim_id"], "claim_id")
            allowed = {"attribute_subject", "value"} if collection == "attributes" else {"subject", "object"}
            if "selector" in value and value["selector"] not in allowed:
                raise ConceptValidationError("selector is not supported by this collection")
        if "historical" in value and type(value["historical"]) is not bool:
            raise ConceptValidationError("historical must be boolean")
        if "origin_ref" in value:
            if value["layer"] != "reviewed":
                raise ConceptValidationError("policy origin needs the reviewed layer")
            _origin(value["origin_ref"], store)
            if value["origin_ref"]["document"] != value["document"]:
                raise ConceptValidationError("origin_ref document differs")
        elif value.get("historical"):
            raise ConceptValidationError("historical document selection needs its policy origin")
    elif kind == "correspondence_endpoint":
        fields(value, {"kind", "correspondence_id", "correspondence_revision", "lane", "judgment_id", "latest_event_id", "origin_event_id", "endpoint", "snapshot"}, {"selected_event_id", "historical"})
        for name in ("correspondence_id", "latest_event_id"):
            identifier(value[name], name)
        if value["lane"] == "source":
            if value["judgment_id"] is not None:
                raise ConceptValidationError("source lane judgment_id must be null")
        else:
            identifier(value["judgment_id"], "judgment_id")
        if value["origin_event_id"] is not None:
            identifier(value["origin_event_id"], "origin_event_id")
        if "selected_event_id" in value:
            identifier(value["selected_event_id"], "selected_event_id")
        token(value["correspondence_revision"], "correspondence_revision")
        if value["lane"] not in {"source", "expert"} or value["endpoint"] not in {"condition", "concept"}:
            raise ConceptValidationError("unsupported correspondence endpoint")
        if not isinstance(value["snapshot"], dict):
            raise ConceptValidationError("endpoint snapshot must be an object")
        if "historical" in value and type(value["historical"]) is not bool:
            raise ConceptValidationError("historical must be boolean")
    else:
        raise ConceptValidationError("unsupported target kind")
    return deepcopy(value)


def validate_target(value, store):
    """Normalize malformed JSON types into the public argument error."""
    # 잘못된 JSON 필드/형식을 이 조회의 공개 입력 오류로 바꾼다. 권한·현재 의미의 승인 함수가 아니다.
    try:
        return _validate_target(value, store)
    except ConceptValidationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise ConceptValidationError("target contains an invalid path, type, or selector") from error
