"""서버가 확인한 actor와 제출 값, 위치 독립적인 주장 식별자를 검증한다.

의미 ID 계산은 원문 개체의 전체 정의를 사용한다. 배열 위치나 로컬 ID만으로
판단을 재사용하지 않도록 하며 같은 함수가 원장 검증과 조회에서 쓰인다.
"""

# actor/reason/revision 같은 입력과 claim_id를 계산하는 작은 검사 함수들이다.
# claim_id는 배열 몇 번째인지가 아니라 주장의 의미와 참조 개체의 정의에서 계산해 판단 대상을 식별한다.
from copy import deepcopy
from core.common.json_codec import canonical_json_bytes as _encode, canonical_json_hash as _hash
from core.modules.ontology.constants import VIEWPOINTS
from . import contracts
from .contracts import ReviewValidationError


def _token(value, name, *, optional=False):
    if optional and value is None:
        return
    if not isinstance(value, str) or not contracts._HEX.fullmatch(value):
        raise ReviewValidationError(f"{name} must be a lowercase SHA-256 token")


def _reason(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 1000:
        raise ReviewValidationError("reason must be nonblank text of at most 1000 characters")
    value.encode("utf-8")


def _actor(value):
    # 서버가 확인한 실행 주체의 필드/관점을 검사한다. 클라이언트의 자유로운 본문을 인증 주체로 바꾸지 않는다.
    if not isinstance(value, dict) or set(value) != contracts._ACTOR_FIELDS:
        raise ReviewValidationError("actor must contain the server-authorized scope")
    for name in ("user_id", "tenant", "profile_id"):
        if not isinstance(value[name], str) or not contracts._ID.fullmatch(value[name]):
            raise ReviewValidationError("actor identifiers are invalid")
    _token(value["policy_revision"], "policy_revision")
    if value["domain"] is not None:
        if not isinstance(value["domain"], str) or not value["domain"].strip() or len(value["domain"]) > 4000:
            raise ReviewValidationError("actor domain is invalid")
        value["domain"].encode("utf-8")
    if value["viewpoint"] is not None and (not isinstance(value["viewpoint"], str) or value["viewpoint"] not in VIEWPOINTS):
        raise ReviewValidationError("actor viewpoint is invalid")


def _input(value):
    """Convert a validated stored assertion/entity back to extraction input."""
    if isinstance(value, list):
        return [_input(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: (item["quote"] if key == "evidence" and isinstance(item, dict)
                  else _input(item)) for key, item in value.items() if key != "status"}


def _identity(value):
    result = _input(value)
    result.pop("id", None)
    if "context" in result:
        result["context"]["viewpoints"] = sorted(result["context"]["viewpoints"])
    if "identifiers" in result:
        result["identifiers"] = sorted(result["identifiers"], key=_encode)
    return result


def _claim_id(collection, value, entities):
    """Exact semantic identity, independent of array position and local IDs."""
    # 해당 주장과 끝점 개체의 전체 의미를 함께 지문으로 만든다. 로컬 개체 ID 문자열만 같아도 같은 주장은 아닐 수 있다.
    identities = {entity["id"]: _identity(entity) for entity in entities}
    result = _identity(value)
    for name in ("reason", "question"):
        result.pop(name, None)
    for name in ("subject", "object"):
        if name in result and isinstance(result[name], str):
            result[name] = identities[result[name]]
    if isinstance(result.get("mapping"), dict):
        result["mapping"]["within"] = identities[result["mapping"]["within"]]
    provenance = result.get("provenance", {})
    for name in ("source_entity", "attributed_to"):
        if provenance.get(name) is not None:
            provenance[name] = identities[provenance[name]]
    return _hash({"collection": collection, "value": result})


def _target_entities(value, entities):
    # Source anchors refer to exact source text, never to entity identities.
    ids = {value[name] for name in ("subject", "object") if isinstance(value.get(name), str)}
    if isinstance(value.get("mapping"), dict):
        ids.add(value["mapping"]["within"])
    ids.update(value.get("provenance", {}).get(name)
               for name in ("source_entity", "attributed_to"))
    return [deepcopy(entity) for entity in entities if entity["id"] in ids]

