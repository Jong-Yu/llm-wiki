"""인용 없는 전문가 정책의 값·출처·서버 발급 개체를 검증한다.

원문 추출 검증을 완화하지 않고, 정책은 같은 관점/세대의 Action log를 근거로
삼는다. 저장된 과거 정책도 해당 이벤트의 범위를 기준으로 재검증한다.
"""

# 업무 판단의 replacement를 검사하고 기존 개체 또는 서버가 발급한 새 개체 참조로 맞춘다.
# 새 개체/정책 값의 출처는 expert_policy 이벤트다. 원문에서 추출한 사실로 위장하지 않는다.
from copy import deepcopy
from hashlib import sha256
from core.modules.ontology.constants import ENTITY_TYPES, RELATION_PREDICATES, POLARITIES, MODALITIES, _NUMBER_PATTERN
from core.modules.ontology.values import _identifier, _text
from . import contracts
from .contracts import ReviewValidationError
from .state import _inactive_policy, _policy_context, _epoch


def _policy_value(value, collection, entities, scope, *, stored=False):
    """Validate authored assertions without weakening extraction evidence.

    Expert statements never manufacture source quotes. Their provenance is
    a reference to a policy event, whose actor and reason are server-owned.
    """
    # 전문가가 작성한 주장 형식을 검사한다. 원문 추출용 인용 검사를 느슨하게 바꿔 정책 값을 끼워 넣는 방식이 아니다.
    fields = ({"id", "subject", "property", "datatype", "value", "unit"}
              if collection == "attributes" else {"subject", "predicate", "object"})
    fields |= {"qualifiers", "context"}
    if stored:
        fields |= {"evidence", "provenance"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ReviewValidationError("Policy replacement must contain the complete assertion, qualifiers and context")
    if value["context"] != _policy_context(scope):
        raise ReviewValidationError("Policy context must exactly match the authorized domain and viewpoint")
    qualifiers = value["qualifiers"]
    if not isinstance(qualifiers, dict) or set(qualifiers) != {"polarity", "modality", "condition", "scope", "time"}:
        raise ReviewValidationError("Policy qualifiers must be explicit and complete")
    for name, allowed in (("polarity", POLARITIES), ("modality", MODALITIES)):
        if not isinstance(qualifiers[name], str) or qualifiers[name] not in allowed:
            raise ReviewValidationError("Unsupported policy qualifier")
    for name in ("condition", "scope", "time"):
        if qualifiers[name] is not None:
            _text(qualifiers[name], 1000, "policy qualifier")
    for name in ("subject",) if collection == "attributes" else ("subject", "object"):
        _identifier(value[name], "policy endpoint")
        if value[name] not in entities:
            raise ReviewValidationError("Policy endpoint must be an existing entity or an explicitly supplied new concept")
    if collection == "attributes":
        _identifier(value["id"], "policy attribute id")
        _text(value["property"], 120, "policy property")
        _text(value["value"], 500, "policy value")
        if value["unit"] is not None:
            _text(value["unit"], 120, "policy unit")
        if value["datatype"] not in ("text", "number"):
            raise ReviewValidationError("Policy datatype must be text or number")
        if value["datatype"] == "number" and not _NUMBER_PATTERN.fullmatch(value["value"]):
            raise ReviewValidationError("Policy number must be a finite decimal string")
    elif not isinstance(value["predicate"], str) or value["predicate"] not in RELATION_PREDICATES:
        raise ReviewValidationError("Unsupported policy predicate")
    if stored:
        provenance = value["provenance"]
        if (value["evidence"] is not None or not isinstance(provenance, dict)
                or set(provenance) != {"kind", "event_id"} or provenance["kind"] != "expert_policy"
                or not isinstance(provenance["event_id"], str) or not contracts._UUID.fullmatch(provenance["event_id"])):
            raise ReviewValidationError("Expert policies require event provenance, never fabricated source evidence")


def _policy_state(cls, state, event, known):
    if not isinstance(state, dict) or set(state) != {"decision", "value", "entities"}:
        raise ReviewValidationError("Invalid policy state")
    if state == _inactive_policy():
        return
    if state["decision"] != "active" or not isinstance(state["entities"], list) or len(state["entities"]) > 2:
        raise ReviewValidationError("Invalid active policy state")
    entities = {entity["id"]: entity for entity in event["target"]["entities"]}
    for entity in state["entities"]:
        if (not isinstance(entity, dict)
                or set(entity) != {"id", "label", "type", "evidence", "context", "identifiers", "provenance"}
                or entity["evidence"] is not None or entity["identifiers"] != []
                or entity["context"] != _policy_context(event["scope"])):
            raise ReviewValidationError("Invalid expert entity snapshot")
        _text(entity["label"], 120, "expert entity label")
        if not isinstance(entity["type"], str) or entity["type"] not in ENTITY_TYPES:
            raise ReviewValidationError("Unsupported expert entity type")
        match = contracts._POLICY_PREFIX.fullmatch(entity["id"]) if isinstance(entity["id"], str) else None
        if (match is None or entity["id"] in entities
                or entity["provenance"] != {"kind": "expert_policy", "event_id": match.group(1)}):
            raise ReviewValidationError("Invalid expert entity provenance or identity")
        origin = known.get(match.group(1))
        if origin is None or origin["action"] != "policy" or origin["scope"] != event["scope"] or _epoch(origin) != _epoch(event):
            raise ReviewValidationError("Expert entity must originate in the same scope and source generation")
        if origin is not event and entity not in origin["after"]["entities"]:
            raise ReviewValidationError("Expert entity differs from its creation event")
        entities[entity["id"]] = entity
    cls._policy_value(state["value"], event["collection"], entities, event["scope"], stored=True)
    origin = known.get(state["value"]["provenance"]["event_id"])
    if (origin is None or origin["action"] != "policy" or origin["scope"] != event["scope"]
            or origin["claim_id"] != event["claim_id"] or _epoch(origin) != _epoch(event)):
        raise ReviewValidationError("Policy assertion must reference its own scope and target")
    if origin is not event and state != origin["after"]:
        raise ReviewValidationError("Policy state differs from its decision event")
    referenced = {state["value"].get("subject"), state["value"].get("object")}
    if any(entity["id"] not in referenced for entity in state["entities"]):
        raise ReviewValidationError("Unused expert entities must not be stored")


def _normalize_policy(self, replacement, entities, snapshot, collection, scope, event_id):
    # 신규 개체는 서버 식별자를 발급하고 주장에 event_id 출처를 붙인다. 근거 없는 가짜 원문 인용은 넣지 않는다.
    if entities is None:
        entities = []
    if not isinstance(entities, list) or len(entities) > 2:
        raise ReviewValidationError("Supply at most two new endpoint concepts")
    available = {item["id"]: item for item in snapshot["effective_graph"]["entities"]}
    mapping, new = {}, []
    for entity in entities:
        if not isinstance(entity, dict) or set(entity) != {"id", "label", "type"}:
            raise ReviewValidationError("New expert concepts require id, label and type")
        local_id = _identifier(entity["id"], "new expert entity id")
        if local_id in available or local_id in mapping:
            raise ReviewValidationError("New concepts cannot replace an existing entity identity")
        _text(entity["label"], 120, "new expert entity label")
        if not isinstance(entity["type"], str) or entity["type"] not in ENTITY_TYPES:
            raise ReviewValidationError("Unsupported expert entity type")
        identifier = "policy_" + event_id + "_" + sha256(local_id.encode()).hexdigest()[:16]
        mapping[local_id] = identifier
        new.append({"id": identifier, "label": entity["label"], "type": entity["type"],
                    "evidence": None, "context": _policy_context(scope), "identifiers": [],
                    "provenance": {"kind": "expert_policy", "event_id": event_id}})
    value = deepcopy(replacement)
    if not isinstance(value, dict):
        raise ReviewValidationError("Policy replacement must be a complete assertion object")
    # Validate local references before replacing them with server identities.
    self._policy_value(value, collection, set(available) | set(mapping), scope)
    referenced = {value.get("subject"), value.get("object")}
    if any(local_id not in referenced for local_id in mapping):
        raise ReviewValidationError("Every supplied concept must be an endpoint of this policy")
    for name in ("subject", "object"):
        if name in value:
            value[name] = mapping.get(value[name], value[name])
    value.update(evidence=None, provenance={"kind": "expert_policy", "event_id": event_id})
    expert_entities = [deepcopy(available[identifier]) for identifier in referenced
                       if identifier in available and available[identifier].get("provenance", {}).get("kind") == "expert_policy"]
    expert_entities.extend(new)
    return {"decision": "active", "value": value, "entities": expert_entities}

