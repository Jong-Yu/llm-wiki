"""대응 값·범위·인용 참조의 형태를 검사한다. 실제 근거/판단은 evidence와 applicability가 맡는다."""

# 전달된 dict의 필드/유형/시간/근거 참조 형태를 확인하는 파일이다.
# 문서 근거가 현재도 맞는지는 evidence.py, 업무 관점과 기간에 적용되는지는 applicability.py가 추가로 확인한다.

from copy import deepcopy
from datetime import datetime
from decimal import Decimal, InvalidOperation
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.modules.reviews.values import _actor
from .contracts import (
    MAX_CORRESPONDENCE_BYTES,
    MAX_CORRESPONDENCE_EVENTS,
    MAX_DEPENDENCY_DOCUMENTS,
    MAX_DEPENDENCY_CORRESPONDENCES,
    MAX_REFERENCE_DEPTH,
    MAX_CAPTURE_BYTES,
    MAX_DETAIL_BYTES,
    MAX_RECEIPT_BYTES,
    MAX_FIND_FILES,
    MAX_FIND_ENTRIES,
    MAX_FIND_BYTES,
    MAX_FIND_OUTPUT_BYTES,
    HEX,
    UUID,
    CorrespondenceValidationError,
    CorrespondenceCorruptError,
    CorrespondenceLimitError,
    CorrespondenceConflictError,
)

def fields(value, required, optional=(), name="value"):
    if not isinstance(value, dict) or not set(required) <= set(value) <= set(required) | set(optional):
        raise CorrespondenceValidationError(f"{name} must contain exactly its documented fields")

def text(value, name="text", limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise CorrespondenceValidationError(f"{name} must be nonblank text of at most {limit} characters")
    try:
        value.encode("utf-8")
    except UnicodeError as error:
        raise CorrespondenceValidationError(f"{name} must be valid UTF-8") from error
    return value

def token(value, name="revision"):
    if not isinstance(value, str) or HEX.fullmatch(value) is None:
        raise CorrespondenceValidationError(f"{name} must be a lowercase SHA-256 token")
    return value

def identifier(value, name="id"):
    if not isinstance(value, str) or UUID.fullmatch(value) is None:
        raise CorrespondenceValidationError(f"{name} must be lowercase UUID4 hex")
    # IDs passed from prepare and persisted event IDs are UUID4, not client names.
    if value[12] != "4" or value[16] not in "89ab":
        raise CorrespondenceValidationError(f"{name} must be UUID4")
    return value

def scope(value):
    fields(value, {"domain", "viewpoint"}, name="scope")
    if value["domain"] is not None:
        text(value["domain"], "domain", 4000)
    if value["viewpoint"] is not None and value["viewpoint"] not in {"business", "developer", "architecture"}:
        raise CorrespondenceValidationError("unsupported viewpoint")
    return value

def instant(value, name="timestamp"):
    text(value, name, 100)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CorrespondenceValidationError(f"invalid {name}") from error
    if result.tzinfo is None or result.utcoffset() is None:
        raise CorrespondenceValidationError(f"{name} needs a UTC offset")
    return result

def texts(value, name, limit=50):
    if not isinstance(value, list) or len(value) > limit:
        raise CorrespondenceValidationError(f"{name} must be a list of at most {limit} items")
    for item in value:
        text(item, name)

def graph_reference(value):
    fields(value, {"graph_revision", "state_revision", "collection", "snapshot", "layer"}, {"entity_id", "claim_id"}, "graph_ref")
    token(value["graph_revision"])
    token(value["state_revision"])
    if value["layer"] not in {"machine", "reviewed"}:
        raise CorrespondenceValidationError("graph_ref layer must be machine or reviewed")
    if value["collection"] == "entities":
        if set(value) != {"graph_revision", "state_revision", "collection", "snapshot", "layer", "entity_id"}:
            raise CorrespondenceValidationError("entity reference needs entity_id only")
        text(value["entity_id"], "entity_id", 100)
    elif value["collection"] in {"relations", "attributes", "relation_candidates"}:
        if set(value) != {"graph_revision", "state_revision", "collection", "snapshot", "layer", "claim_id"}:
            raise CorrespondenceValidationError("claim reference needs claim_id only")
        token(value["claim_id"], "claim_id")
    else:
        raise CorrespondenceValidationError("unsupported graph collection")
    if not isinstance(value["snapshot"], dict):
        raise CorrespondenceValidationError("graph snapshot must be an object")

def anchor(value, store):
    fields(value, {"document", "source_revision", "quote", "start_line", "end_line"}, {"occurrence", "graph_ref"}, "anchor")
    store._document_path(store.wiki_dir, value["document"])
    token(value["source_revision"], "source_revision")
    text(value["quote"], "quote", 1000)
    if type(value["start_line"]) is not int or type(value["end_line"]) is not int or not 1 <= value["start_line"] <= value["end_line"] <= 1024 * 1024:
        raise CorrespondenceValidationError("anchor line positions are invalid")
    if "occurrence" in value and (type(value["occurrence"]) is not int or value["occurrence"] < 0):
        raise CorrespondenceValidationError("occurrence must be a nonnegative integer")
    if "graph_ref" in value:
        graph_reference(value["graph_ref"])

def constraints(value, name):
    fields(value, {"status", "items"}, name=name)
    if value["status"] not in {"unknown", "none", "specified"}:
        raise CorrespondenceValidationError(f"invalid {name} status")
    texts(value["items"], name)
    if bool(value["items"]) != (value["status"] == "specified"):
        raise CorrespondenceValidationError(f"{name} specified requires items; unknown/none must be empty")

def business_scope(value):
    """unknown·unrestricted·specified를 구분해 미확인을 명시적인 제한 없음으로 바꾸지 않는다."""
    # 업무 축·기간과 적용 범위를 엄격한 dict로 검사한다. 누락된 축을 전체 업무에 적용된다는 뜻으로 채우지 않는다.
    fields(value, {"axes", "validity"}, name="business_scope")
    if not isinstance(value["axes"], list) or not 1 <= len(value["axes"]) <= 50:
        raise CorrespondenceValidationError("business_scope axes needs 1-50 explicitly identified axes")
    names = set()
    for axis in value["axes"]:
        fields(axis, {"name", "status", "value", "source"}, name="axis")
        text(axis["name"], "axis name", 100)
        if axis["name"] in names:
            raise CorrespondenceValidationError("axis names must be unique")
        names.add(axis["name"])
        if axis["status"] not in {"unknown", "unrestricted", "specified"}:
            raise CorrespondenceValidationError("invalid axis status")
        if axis["status"] == "specified":
            text(axis["value"], "axis value")
        elif axis["value"] is not None:
            raise CorrespondenceValidationError("unknown/unrestricted axis value must be null")
        if axis["status"] == "unknown":
            if axis["source"] is not None:
                text(axis["source"], "axis source")
        else:
            text(axis["source"], "axis source")
    validity = value["validity"]
    fields(validity, {"status", "source"}, {"start", "end", "start_inclusive", "end_inclusive", "timezone"}, "validity")
    if validity["status"] not in {"unknown", "unrestricted", "specified"}:
        raise CorrespondenceValidationError("invalid validity status")
    if validity["status"] == "unknown":
        if validity["source"] is not None:
            text(validity["source"], "validity source")
    else:
        text(validity["source"], "validity source")
    if validity["status"] != "specified":
        fields(validity, {"status", "source"}, name="validity")
        return
    fields(validity, {"status", "source", "start", "end", "start_inclusive", "end_inclusive", "timezone"}, name="validity")
    start, end = instant(validity["start"], "start"), instant(validity["end"], "end")
    if start >= end or any(type(validity[name]) is not bool for name in ("start_inclusive", "end_inclusive")):
        raise CorrespondenceValidationError("invalid validity boundaries")
    try:
        zone = ZoneInfo(text(validity["timezone"], "timezone", 100))
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise CorrespondenceValidationError("timezone must be an available IANA zone") from error
    if any(bound.astimezone(zone).utcoffset() != bound.utcoffset() for bound in (start, end)):
        raise CorrespondenceValidationError("period UTC offsets must agree with timezone")

def value_schema(value, store, documents=None):
    # 대응 양 끝점·조건·연결 근거·참조의 전체 구조를 확인한다. 실제 인용/현재성 검사는 이후 evidence 단계에서 한다.
    fields(value, {"condition", "concept", "statement", "direction", "qualifiers", "business_scope", "basis", "references", "questions", "related_to"}, name="correspondence")
    for name in ("condition", "concept"):
        anchor(value[name], store)
        if documents is not None and value[name]["document"] != documents[name]:
            raise CorrespondenceValidationError("condition/concept documents are fixed for a correspondence")
    text(value["statement"], "statement")
    if value["direction"] not in {"condition_to_concept", "equivalent_definition"}:
        raise CorrespondenceValidationError("unsupported correspondence direction")
    qualifiers = value["qualifiers"]
    fields(qualifiers, {"quantity", "conditions", "exceptions"}, name="qualifiers")
    quantity = qualifiers["quantity"]
    fields(quantity, {"status", "expression"}, {"subject", "unit", "lower", "upper", "lower_inclusive", "upper_inclusive"}, "quantity")
    if quantity["status"] not in {"unknown", "not_applicable", "specified"}:
        raise CorrespondenceValidationError("invalid quantity status")
    text(quantity["expression"], "quantity expression")
    if quantity["status"] == "specified":
        fields(quantity, {"status", "expression", "subject", "unit", "lower", "upper", "lower_inclusive", "upper_inclusive"}, name="quantity")
        for name in ("subject", "unit"):
            text(quantity[name], name)
        try:
            for name in ("lower", "upper"):
                if not isinstance(quantity[name], str) or re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)", quantity[name]) is None:
                    raise InvalidOperation
            if Decimal(quantity["lower"]) > Decimal(quantity["upper"]):
                raise InvalidOperation
        except InvalidOperation as error:
            raise CorrespondenceValidationError("quantity bounds must be finite ordered decimal strings") from error
        if any(type(quantity[name]) is not bool for name in ("lower_inclusive", "upper_inclusive")):
            raise CorrespondenceValidationError("quantity boundaries need explicit booleans")
    else:
        fields(quantity, {"status", "expression"}, name="quantity")
    for name in ("conditions", "exceptions"):
        constraints(qualifiers[name], name)
    business_scope(value["business_scope"])
    basis = value["basis"]
    fields(basis, {"kind", "reason", "link_evidence"}, name="basis")
    if basis["kind"] not in {"candidate", "source", "expert"}:
        raise CorrespondenceValidationError("unsupported basis kind")
    text(basis["reason"], "basis reason")
    if not isinstance(basis["link_evidence"], list) or len(basis["link_evidence"]) > 50:
        raise CorrespondenceValidationError("link_evidence must be at most 50 anchors")
    if bool(basis["link_evidence"]) != (basis["kind"] == "source"):
        raise CorrespondenceValidationError("only source basis requires nonempty linking evidence")
    for item in basis["link_evidence"]:
        anchor(item, store)
    texts(value["questions"], "questions")
    if basis["kind"] == "candidate" and not value["questions"]:
        raise CorrespondenceValidationError("candidate needs an explicit confirmation question")
    if not isinstance(value["references"], list) or len(value["references"]) > 50:
        raise CorrespondenceValidationError("references must be at most 50 entries")
    for ref in value["references"]:
        if not isinstance(ref, dict):
            raise CorrespondenceValidationError("reference must be an object")
        kind = ref.get("kind")
        if kind == "graph":
            fields(ref, {"kind", "document", "graph_ref"}, name="graph reference")
            store._document_path(store.wiki_dir, ref["document"])
            graph_reference(ref["graph_ref"])
        elif kind in {"review", "policy"}:
            fields(ref, {"kind", "document", "event_id", "state_revision", "snapshot", "scope"}, name="document action reference")
            store._document_path(store.wiki_dir, ref["document"])
            identifier(ref["event_id"], "event_id")
            token(ref["state_revision"], "state_revision")
            if kind == "policy":
                scope(ref["scope"])
            elif ref["scope"] is not None:
                raise CorrespondenceValidationError("source review scope must be null")
        elif kind == "correspondence":
            fields(ref, {"kind", "correspondence_id", "event_id", "correspondence_revision", "snapshot", "scope"}, name="correspondence reference")
            identifier(ref["correspondence_id"], "correspondence_id")
            identifier(ref["event_id"], "event_id")
            token(ref["correspondence_revision"], "correspondence_revision")
            if ref["scope"] is not None:
                scope(ref["scope"])
        else:
            raise CorrespondenceValidationError("unsupported reference kind")
        if kind != "graph" and not isinstance(ref["snapshot"], dict):
            raise CorrespondenceValidationError("reference snapshot must be an object")
    if not isinstance(value["related_to"], list) or len(value["related_to"]) > 50:
        raise CorrespondenceValidationError("related_to must be at most 50 entries")
    for related in value["related_to"]:
        fields(related, {"correspondence_id", "event_id"}, name="related_to")
        identifier(related["correspondence_id"])
        identifier(related["event_id"], "event_id")
    return deepcopy(value)
