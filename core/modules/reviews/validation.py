"""원문 근거·정규화·현재 유효 그래프의 모든 층을 검증한다.

전문가 정책이 가린 원문 검토나 다른 관점도 검사한다. 한 관점의 변경으로
다른 유효 층이 손상되는 저장을 허용하지 않는다.
"""

# 검토 교체값도 원문의 실제 인용과 개체 참조를 만족해야 한다.
# 지금 선택한 관점뿐 아니라 현재 유효한 다른 관점/정책 아래의 층도 검증해 하나의 수정이 다른 판단을 손상시키지 않게 한다.
from core.common.json_codec import canonical_json_bytes as _encode
from core.modules.ontology.constants import relation_schema_version
from core.modules.ontology.validation import _graph
from core.modules.ontology.snapshots import _stored_graph
from .contracts import ReviewValidationError, ReviewCorruptError
from .values import _input
from .state import _is_policy, _policy_key, _epoch


def _check_saved_value(document, value, collection, entities, source_revision):
    # Historical events retain their own source epoch. A synthetic zero
    # revision would incorrectly reject a valid source anchor after the
    # source changes. Actual source locations are rechecked only for active
    # events; old raw events and their hashes remain untouched.
    graph = {"schema_version": relation_schema_version(value) if collection == "relations" else 3, "document": document, "source_revision": source_revision,
             "entities": entities, "relations": [], "attributes": [], "relation_candidates": []}
    target = collection
    if collection == "relation_candidates" and "question" not in value:
        target = "relations"
    graph[target] = [value]
    _stored_graph(_encode(graph), document)


def _validate_active_event(self, source, machine, event):
    """Recheck current review evidence just as the machine cache is checked.

    Hashes detect accidental alteration; they are not authentication against
    an administrator who can rewrite the ledger and recompute its chain.
    """
    try:
        actual_entities = {entity["id"]: entity for entity in machine["entities"]}
        for entity in event["target"]["entities"]:
            if actual_entities.get(entity["id"]) != entity:
                raise ReviewValidationError("Active review entity differs from its generation")
        target = next((value for value in machine[event["collection"]]
                       if value == event["target"]["claim"]), None)
        if target is None:
            raise ReviewValidationError("Active review target differs from its generation")
        target_bytes = _encode(target)
        for state in (event["before"], event["after"]):
            value = state["value"]
            # 현재 원문에서 검증된 기계 주장과 같은 값은 위의 세대·대상 대조로 충분합니다.
            # 편집된 값은 계속 원문 인용과 위치를 다시 검증합니다.
            if _encode(value) == target_bytes:
                continue
            collection = event["collection"]
            if collection == "relation_candidates" and "question" not in value:
                collection = "relations"
            graph = _graph(machine["document"], source.revision, _input(machine["entities"]),
                           [_input(value)] if collection == "relations" else [], source.content,
                           [_input(value)] if collection == "relation_candidates" else [],
                           attributes=[_input(value)] if collection == "attributes" else [],
                           schema_version=machine["schema_version"], body_only=machine.get("evidence_scope") == "body")
            if graph[collection][0] != value:
                raise ReviewValidationError("Active review evidence locations differ from source")
    except (ValueError, TypeError, KeyError) as error:
        raise ReviewCorruptError("Current review assertions do not match their source/generation") from error


def _normalize(self, source, graph, collection, value):
    # 교체값의 인용/개체/한정어를 현재 전체 원문에 맞춰 검사한다. 옛 배열 위치만 바꾸어 정정을 받아들이지 않는다.
    if not isinstance(value, dict):
        raise ReviewValidationError("replacement must be a complete assertion object")
    if (collection == "relation_candidates"
            and any(isinstance(value.get(name), dict) for name in ("subject", "object"))):
        raise ReviewValidationError("Candidate review endpoints must remain entity identifiers")
    fields = ({"id", "subject", "property", "datatype", "value", "unit", "evidence"}
              if collection == "attributes" else {"subject", "predicate", "object", "evidence"})
    fields |= {"qualifiers", "context", "provenance"}
    if collection == "relations" and graph["schema_version"] >= 5 and (value.get("predicate") == "maps_to" or "mapping" in value):
        fields |= {"mapping"}
    if collection == "relation_candidates" and relation_schema_version(value) >= 5:
        raise ReviewValidationError("Candidate review retains the existing predicate contract")
    if set(value) != fields:
        raise ReviewValidationError("replacement must explicitly include all assertion fields")
    for key, expected in (("qualifiers", {"polarity", "modality", "condition", "scope", "time"}),
                          ("context", {"domain", "viewpoints"}),
                          ("provenance", {"source_entity", "attributed_to", "basis"})):
        if not isinstance(value[key], dict) or set(value[key]) != expected:
            raise ReviewValidationError("replacement metadata must be explicit and complete")
    target = "attributes" if collection == "attributes" else "relations"
    normalized = _graph(graph["document"], source.revision, _input(graph["entities"]),
                        [value] if target == "relations" else [], source.content,
                        attributes=[value] if target == "attributes" else [], schema_version=graph["schema_version"], body_only=graph.get("evidence_scope") == "body")
    return normalized[target][0]


def _validate_effective(self, source, snapshot):
    graph = snapshot["effective_graph"]
    def expert(value):
        return value.get("provenance", {}).get("kind") == "expert_policy"
    _graph(graph["document"], source.revision, _input([item for item in graph["entities"] if not expert(item)]),
           _input([item for item in graph["relations"] if not expert(item)]),
           source.content, _input(graph["relation_candidates"]),
           attributes=_input([item for item in graph["attributes"] if not expert(item)]),
           schema_version=graph["schema_version"], body_only=graph.get("evidence_scope") == "body")
    entity_ids = {item["id"] for item in graph["entities"]}
    if len(entity_ids) != len(graph["entities"]):
        raise ReviewValidationError("Effective entities must have unique identities")
    attributes = [item["id"] for item in graph["attributes"]]
    if len(set(attributes)) != len(attributes):
        raise ReviewValidationError("Effective attribute IDs must remain unique")
    for collection in ("relations", "attributes"):
        for value in graph[collection]:
            if expert(value):
                self._policy_value(value, collection, entity_ids,
                                   {"domain": snapshot["selection"]["domain"], "viewpoint": snapshot["selection"]["viewpoint"]}, stored=True)


def _validate_all_layers(self, source, graph_raw, ledger, tokens):
    """A local edit must not corrupt a source layer or another profile.

    Expert overrides can mask a source claim in one view. Validate that
    underlying layer too, then every currently applicable policy scope.
    """
    # 현재 선택 관점에서 보이는 주장만 검사하지 않는다. 정책에 가려진 원문 검토와 다른 관점도 손상되지 않아야 저장한다.
    self._validate_effective(source, self._render(source, graph_raw, ledger, tokens, policies=False))
    latest = {}
    for event in ledger["events"]:
        if _is_policy(event):
            latest[_policy_key(event)] = event
    scopes = {(event["scope"]["domain"], event["scope"]["viewpoint"])
              for event in latest.values()
              if _epoch(event) == _epoch(tokens) and event["after"]["decision"] == "active"}
    scopes.update((event['scope']['domain'], event['scope']['viewpoint'])
                  for event in ledger.get('relation_events', [])
                  if event['kind'] == 'policy' and _epoch(event) == _epoch(tokens))
    for domain, viewpoint in scopes:
        self._validate_effective(source, self._render(source, graph_raw, ledger, tokens, domain, viewpoint))

