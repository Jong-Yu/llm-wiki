"""스키마 1~6의 어휘와 입력·캡처·출력 예산을 한 곳에서 정의한다.

값 변경은 저장/조회 계약 변경이므로 파일 분리 중에는 기존 상한을 유지한다."""

import re


# 개별 항목, 캡처 입력, 반환 출력의 상한은 서로 다른 제한이다.
MAX_ONTOLOGY_BYTES = 1024 * 1024
MAX_ENTITIES = 100
MAX_RELATIONS = 200
MAX_RELATION_CANDIDATES = 50
MAX_ATTRIBUTES = 200
MAX_IDENTIFIERS = 8
MAX_IDENTIFIER_CHARACTERS = 120
MAX_ATTRIBUTE_VALUE_CHARACTERS = 500
MAX_LABEL_CHARACTERS = 120
MAX_EVIDENCE_CHARACTERS = 1000
MAX_CANDIDATE_REASON_CHARACTERS = 1000
MAX_CANDIDATE_QUESTION_CHARACTERS = 500
MAX_CONNECTION_DOCUMENTS = 100
MAX_CONNECTION_SCAN_ENTRIES = 1000
MAX_CONNECTION_BYTES = 16 * 1024 * 1024
MAX_CONNECTION_LIMIT = 100
MAX_CONNECTION_LINKS = 1000
MAX_CONTEXT_DOCUMENTS = 8
MAX_CONTEXT_BYTES = 4 * 1024 * 1024
MAX_CONTEXT_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_LINK_HREF_CHARACTERS = 2048

# 이전 형식의 어휘도 남겨 과거 그래프를 현재 형식으로 암묵 변환하지 않는다.
V1_ENTITY_TYPES = frozenset({"person", "organization", "system", "concept", "document"})
ENTITY_TYPES = V1_ENTITY_TYPES | {"process", "physical_object", "substance", "place"}
V1_RELATION_PREDICATES = frozenset({
    "uses", "depends_on", "part_of", "implements", "related_to", "authored_by",
})
V2_RELATION_PREDICATES = V1_RELATION_PREDICATES | {
    "subclass_of", "instance_of", "composed_of", "located_in", "has_input", "has_output",
    "participates_in", "precedes", "causes", "enables", "prevents", "predicts",
    "supports_prediction", "measures", "observes",
}
RELATION_PREDICATES = V2_RELATION_PREDICATES | {
    "view_of", "same_as", "different_from", "responsible_for", "approves",
}
V5_NEW_RELATION_PREDICATES = frozenset({
    "maps_to", "targets", "follows_reference", "requires", "includes_step", "delivered_to", "recommends",
})
V5_RELATION_PREDICATES = RELATION_PREDICATES | V5_NEW_RELATION_PREDICATES
# 원문에 적힌 메타데이터/이력이라는 주장이다. 현재 사실이나 검토 승인이 아니다.
V6_SOURCE_RECORD_PREDICATES = frozenset({"has_source_metadata", "has_source_history"})
V6_RELATION_PREDICATES = V5_RELATION_PREDICATES | V6_SOURCE_RECORD_PREDICATES

VIEWPOINTS = frozenset({"business", "developer", "architecture"})
POLARITIES = frozenset({"positive", "negative"})
MODALITIES = frozenset({"asserted", "possible", "capability", "planned", "hypothetical"})
_QUALIFIER_DEFAULTS = {
    "polarity": "positive", "modality": "asserted", "condition": None, "scope": None, "time": None,
}
_ID_PATTERN = re.compile(r"[a-z][a-z0-9_-]{0,63}")
_REVISION_PATTERN = re.compile(r"[0-9a-f]{64}")
_NUMBER_PATTERN = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)")
_V1_GRAPH_FIELDS = {"schema_version", "document", "source_revision", "entities", "relations"}
_GRAPH_FIELDS = _V1_GRAPH_FIELDS | {"relation_candidates"}
_V3_GRAPH_FIELDS = _GRAPH_FIELDS | {"attributes"}
_ENTITY_FIELDS = {"id", "type", "label", "evidence"}
_RELATION_FIELDS = {"subject", "predicate", "object", "evidence"}
_CANDIDATE_REQUIRED_FIELDS = {"id", "subject", "predicate", "object", "reason", "question"}
_CANDIDATE_FIELDS = _CANDIDATE_REQUIRED_FIELDS | {"evidence", "qualifiers"}
_ATTRIBUTE_FIELDS = {"id", "subject", "property", "datatype", "value", "unit", "evidence"}
_METADATA_FIELDS = {"context", "provenance"}
_CONTEXT_FIELDS = {"domain", "viewpoints"}
_PROVENANCE_FIELDS = {"source_entity", "attributed_to", "basis"}


def relation_schema_version(value):
    """주장의 사용 기능으로 읽기 형식을 고르되 과거 주장 바이트는 바꾸지 않는다."""
    if isinstance(value, dict):
        if value.get("predicate") in V6_SOURCE_RECORD_PREDICATES:
            return 6
        if "mapping" in value or value.get("predicate") in V5_NEW_RELATION_PREDICATES:
            return 5
        if any(isinstance(value.get(name), dict) for name in ("subject", "object")):
            return 4
    return 3
