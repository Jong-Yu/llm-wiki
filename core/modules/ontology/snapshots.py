"""저장된 그래프 바이트의 구조와 원문 판본을 검사한다.

stale 그래프도 손상 검사는 수행하지만 옛 주장을 현재 사실로 반환하지 않는다.
원시 JSON의 중복 키·비유한 수를 거부하는 검사는 입력 정규화와 별개다."""

# _stored_graph는 저장 형식을, _query_snapshot은 그 그래프가 현재 원문에 맞는지 확인한다.
# missing은 그래프 없음, stale은 원문이 바뀌어 재추출 필요, ready는 현재 원문에 맞는 기계 그래프라는 뜻이다.
# ready는 구조·인용 검사 결과이며 주장 의미의 정확성이나 사람 승인을 뜻하지 않는다.

import json
import re

from core.modules.documents.metadata import parse_document
from .storage import validate_document_id, source_fields
from . import constants
from .errors import OntologyValidationError, OntologyCorruptError
from .validation import _items, _graph
from .values import _fields, _optional_fields, _revision


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OntologyValidationError("duplicate JSON keys are not allowed")
        result[key] = value
    return result


def _reject_constant(_value):
    raise OntologyValidationError("non-finite JSON numbers are not allowed")


def _stored_graph(raw: bytes, document: str) -> tuple:
    """Check disk schema even for stale data, without exposing stale items."""
    # JSON 필드와 모든 컬렉션을 검증해 (그래프, 개체, 관계, 후보, 속성)을 돌려준다. 오래된 그래프도 손상 검사는 생략하지 않는다.
    try:
        graph = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        if not isinstance(graph, dict):
            raise OntologyValidationError("stored graph must be an object")
        version = graph.get("schema_version")
        if type(version) is not int or version not in (1, 2, 3, 4, 5, 6):
            raise OntologyValidationError("unsupported schema_version")
        fields = {1: constants._V1_GRAPH_FIELDS, 2: constants._GRAPH_FIELDS, 3: constants._V3_GRAPH_FIELDS, 4: constants._V3_GRAPH_FIELDS, 5: constants._V3_GRAPH_FIELDS, 6: constants._V3_GRAPH_FIELDS}[version]
        _optional_fields(graph, fields, fields | {"generation_id", "document_id", "body_revision", "body_start_line", "evidence_coordinates"}, "graph")
        envelope_fields = {"document_id", "body_revision", "body_start_line", "evidence_coordinates"}
        if set(graph) & envelope_fields:
            if not envelope_fields <= set(graph):
                raise OntologyValidationError("incomplete body evidence envelope")
            if graph["document_id"] is not None:
                validate_document_id(graph["document_id"])
            _revision(graph["body_revision"])
            if (type(graph["body_start_line"]) is not int or graph["body_start_line"] < 1
                    or graph["evidence_coordinates"] != "full_file"):
                raise OntologyValidationError("invalid body evidence coordinates")
        if "generation_id" in graph and (
            not isinstance(graph["generation_id"], str)
            or re.fullmatch(r"[0-9a-f]{32}", graph["generation_id"]) is None
        ):
            raise OntologyValidationError("invalid graph generation_id")
        if graph["document"] != document:
            raise OntologyValidationError("graph document does not match its storage key")
        _revision(graph["source_revision"])

        def quote(value, *, optional=False):
            if optional and value is None:
                return None
            _fields(value, {"quote", "start_line", "end_line"}, "stored evidence")
            start, end = value["start_line"], value["end_line"]
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= constants.MAX_ONTOLOGY_BYTES:
                raise OntologyValidationError("stored evidence line numbers are invalid")
            return value["quote"]

        def metadata(item):
            _fields(item["context"], constants._CONTEXT_FIELDS, "stored context")
            _fields(item["provenance"], constants._PROVENANCE_FIELDS, "stored provenance")

        def collection(name, limit):
            items = graph[name]
            if not isinstance(items, list) or len(items) > limit:
                raise OntologyValidationError("stored collection exceeds its item limit")
            return items

        entities = []
        entity_fields = constants._ENTITY_FIELDS | ({"context", "identifiers"} if version >= 3 else set())
        for item in collection("entities", constants.MAX_ENTITIES):
            _fields(item, entity_fields, "stored entity")
            converted = {**item, "evidence": quote(item["evidence"])}
            if version >= 3:
                _fields(item["context"], constants._CONTEXT_FIELDS, "stored entity context")
                identities = item["identifiers"]
                if not isinstance(identities, list) or len(identities) > constants.MAX_IDENTIFIERS:
                    raise OntologyValidationError("stored identifiers exceed their item limit")
                converted["identifiers"] = []
                for identity in identities:
                    _fields(identity, {"namespace", "value", "evidence"}, "stored identifier")
                    converted["identifiers"].append({**identity, "evidence": quote(identity["evidence"])})
            entities.append(converted)

        relations = []
        relation_fields = constants._RELATION_FIELDS | ({"qualifiers"} if version >= 2 else set())
        if version >= 3:
            relation_fields |= constants._METADATA_FIELDS
        for item in collection("relations", constants.MAX_RELATIONS):
            _optional_fields(item, relation_fields, relation_fields | ({"mapping"} if version >= 5 else set()), "stored relation")
            if version >= 2:
                _fields(item["qualifiers"], set(constants._QUALIFIER_DEFAULTS), "stored qualifiers")
            if version >= 3:
                metadata(item)
            relations.append({**item, "evidence": quote(item["evidence"])})

        candidates = []
        if version >= 2:
            candidate_fields = constants._CANDIDATE_FIELDS | {"status"}
            if version >= 3:
                candidate_fields |= constants._METADATA_FIELDS
            for item in collection("relation_candidates", constants.MAX_RELATION_CANDIDATES):
                _fields(item, candidate_fields, "stored candidate")
                if item["status"] != "needs_review":
                    raise OntologyValidationError("stored candidate status must be needs_review")
                _fields(item["qualifiers"], set(constants._QUALIFIER_DEFAULTS), "stored qualifiers")
                if version >= 3:
                    metadata(item)
                candidates.append({
                    **{key: value for key, value in item.items() if key != "status"},
                    "evidence": quote(item["evidence"], optional=True),
                })
        attributes = []
        if version >= 3:
            for item in collection("attributes", constants.MAX_ATTRIBUTES):
                _fields(item, constants._ATTRIBUTE_FIELDS | {"qualifiers"} | constants._METADATA_FIELDS, "stored attribute")
                _fields(item["qualifiers"], set(constants._QUALIFIER_DEFAULTS), "stored qualifiers")
                metadata(item)
                attributes.append({**item, "evidence": quote(item["evidence"])})
        _items(entities, relations, relation_candidates=candidates, attributes=attributes, schema_version=version,
               document=document, source_revision=graph["source_revision"])
        return graph, entities, relations, candidates, attributes
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise OntologyCorruptError("Stored ontology is malformed; regenerate it from the latest source") from error


def _query_snapshot(document: str, source, raw) -> dict:
    """Validate an already captured pair without taking another storage lock."""
    # 같이 캡처한 source/raw를 비교한다. 원문 버전이 달라졌다면 예전 주장을 비우고 stale 상태를 반환한다.
    empty = {"document": document, "source_revision": source.revision,
             "entities": [], "relations": [], "relation_candidates": [], "attributes": [],
             **source_fields(source.content)}
    if raw is None:
        return {**empty, "status": "missing"}
    graph, entities, relations, candidates, attributes = _stored_graph(raw, document)
    if graph["source_revision"] != source.revision:
        return {**empty, "status": "stale", "indexed_revision": graph["source_revision"],
                "needs_reextraction": True, "indexed_body_revision": graph.get("body_revision")}
    try:
        normalized = _graph(
            document, source.revision, entities, relations, source.content, candidates,
            attributes=attributes, schema_version=graph["schema_version"], body_only="body_revision" in graph,
        )
    except OntologyValidationError as error:
        raise OntologyCorruptError("Stored ontology evidence does not match its source") from error
    if "body_revision" in graph:
        parsed = parse_document(source.content)
        normalized.update(document_id=parsed.document_id, body_revision=parsed.body_revision,
                          body_start_line=parsed.body_start_line, evidence_coordinates="full_file")
    if {k: v for k, v in graph.items() if k != "generation_id"} != normalized:
        raise OntologyCorruptError("Stored ontology evidence locations do not match its source")
    return {"relation_candidates": [], "attributes": [], **graph, **source_fields(source.content), "status": "ready",
            "evidence_scope": "body" if "body_revision" in graph else "full_file",
            "needs_reextraction": graph["schema_version"] < 3}
