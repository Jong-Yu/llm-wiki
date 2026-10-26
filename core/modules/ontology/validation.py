"""추출 입력을 검증하고 원문에 대응하는 정규 그래프를 만든다.

검증은 파일을 읽거나 저장하지 않으며 원문이 주어졌을 때만 인용 위치를 붙인다."""

from bisect import bisect_right
import re

from . import constants
from .anchors import normalize_anchor, endpoint_key
from .errors import OntologyValidationError
from .values import (
    _fields, _optional_fields, _text, _identifier, _qualifiers, _context,
    _context_key, _provenance, _provenance_key,
)


class _ExtractionValidation:
    """한 번의 추출 검증에서만 개체 참조표와 정확한 원문 위치를 공유한다."""

    def __init__(self, schema_version, source, document, source_revision):
        self.schema_version = schema_version
        self.source = source
        self.document = document
        self.source_revision = source_revision
        self.entity_ids = {}
        self.entity_types = constants.V1_ENTITY_TYPES if self.schema_version == 1 else constants.ENTITY_TYPES
        self.predicates = {
            1: constants.V1_RELATION_PREDICATES, 2: constants.V2_RELATION_PREDICATES,
            3: constants.RELATION_PREDICATES, 4: constants.RELATION_PREDICATES,
            5: constants.V5_RELATION_PREDICATES, 6: constants.V6_RELATION_PREDICATES,
        }[self.schema_version]
        self.line_starts = None if self.source is None else [0] + [
            match.end() for match in re.finditer(r"\r\n|\r|\n", self.source)
        ]

    def evidence(self, value):
        """원문이 있을 때만 실제 인용을 확인하고 기존 줄 번호 계산을 적용한다."""
        quote = _text(value, constants.MAX_EVIDENCE_CHARACTERS, "evidence")
        if self.source is None:
            return quote
        offset = self.source.find(quote)
        if offset < 0:
            raise OntologyValidationError("evidence must occur verbatim in the source document")
        return {
            "quote": quote,
            "start_line": bisect_right(self.line_starts, offset),
            "end_line": bisect_right(self.line_starts, offset + len(quote) - 1),
        }

    def metadata(self, item, quote):
        context = _context(item.get("context", {}), quote)
        provenance = _provenance(item.get("provenance", {}), quote, self.entity_ids)
        return {"context": context, "provenance": provenance}, (_context_key(context), _provenance_key(provenance))

    def endpoint(self, value, label, *, quote, candidate):
        """문서 안의 개체 참조와 판본에 고정된 원문 앵커를 구분한다."""
        if isinstance(value, dict):
            if self.schema_version < 4 or candidate:
                raise OntologyValidationError("source anchors require an explicit v4/v5/v6 relation")
            try:
                return normalize_anchor(value, document=self.document, source_revision=self.source_revision,
                                        source=self.source, evidence=quote)
            except (ValueError, UnicodeError) as error:
                raise OntologyValidationError(str(error)) from error
        identifier = _identifier(value, label)
        if identifier not in self.entity_ids:
            raise OntologyValidationError("relation endpoints must reference entities in this document")
        return identifier

    def claim(self, item, *, candidate=False):
        """관계와 후보의 정규값 및 모든 한정어를 포함하는 중복 키를 만든다."""
        quote = item.get("evidence")
        subject = self.endpoint(item["subject"], "relation subject", quote=quote, candidate=candidate)
        object_id = self.endpoint(item["object"], "relation object", quote=quote, candidate=candidate)
        predicate = item["predicate"]
        allowed_predicates = constants.RELATION_PREDICATES if candidate and self.schema_version >= 5 else self.predicates
        if not isinstance(predicate, str) or predicate not in allowed_predicates:
            raise OntologyValidationError("relation predicate is not supported")

        attached = None if candidate and quote is None else self.evidence(quote)
        normalized = {"subject": subject, "predicate": predicate, "object": object_id, "evidence": attached}
        key = (endpoint_key(subject), predicate, endpoint_key(object_id))
        if predicate == "maps_to":
            if self.schema_version < 5 or candidate:
                raise OntologyValidationError("maps_to requires an explicit v5/v6 relation")
            mapping = item.get("mapping")
            _fields(mapping, {"within", "subject_cardinality", "object_cardinality"}, "mapping")
            within = _identifier(mapping["within"], "mapping within")
            if within not in self.entity_ids:
                raise OntologyValidationError("mapping within must reference an entity in this document")
            if mapping["subject_cardinality"] != "many" or mapping["object_cardinality"] != "many":
                raise OntologyValidationError("mapping cardinalities must be literal many")
            normalized["mapping"] = {"within": within, "subject_cardinality": "many", "object_cardinality": "many"}
            key += (within, "many", "many")
        elif "mapping" in item:
            raise OntologyValidationError("mapping is only allowed on v5/v6 maps_to relations")
        if self.schema_version >= 2:
            qualifiers = _qualifiers(item.get("qualifiers", {}), quote)
            normalized["qualifiers"] = qualifiers
            if predicate in constants.V6_SOURCE_RECORD_PREDICATES:
                if (candidate or not isinstance(subject, str) or not isinstance(object_id, dict)
                        or qualifiers != constants._QUALIFIER_DEFAULTS):
                    raise OntologyValidationError(
                        "source record links require an existing entity subject, source_anchor object, "
                        "and positive/asserted qualifiers with null condition/scope/time")
            key += tuple(qualifiers[name] for name in constants._QUALIFIER_DEFAULTS)
        if self.schema_version >= 3:
            extra, extra_key = self.metadata(item, quote)
            normalized.update(extra)
            key += extra_key
        return normalized, key


def _entities(entities, validation):
    """개체 ID와 이름/관점/식별자 조합의 중복을 검사한다."""
    labels = set()
    normalized_entities = []
    for item in entities:
        if validation.schema_version < 3:
            _fields(item, constants._ENTITY_FIELDS, "entity")
        else:
            _optional_fields(item, constants._ENTITY_FIELDS, constants._ENTITY_FIELDS | {"context", "identifiers"}, "entity")
        identifier = _identifier(item["id"], "entity id")
        entity_type = item["type"]
        if not isinstance(entity_type, str) or entity_type not in validation.entity_types:
            raise OntologyValidationError("entity type is not supported")
        label = _text(item["label"], constants.MAX_LABEL_CHARACTERS, "label")
        quote = _text(item["evidence"], constants.MAX_EVIDENCE_CHARACTERS, "evidence")
        if label not in quote:
            raise OntologyValidationError("entity label must occur verbatim in its evidence")
        normalized = {"id": identifier, "type": entity_type, "label": label, "evidence": validation.evidence(quote)}
        key = (entity_type, label)
        if validation.schema_version >= 3:
            context = _context(item.get("context", {}), quote)
            identifiers = item.get("identifiers", [])
            if not isinstance(identifiers, list) or len(identifiers) > constants.MAX_IDENTIFIERS:
                raise OntologyValidationError(f"identifiers must be a list of at most {constants.MAX_IDENTIFIERS} items")
            normalized_identifiers = []
            identity_keys = set()
            for identity in identifiers:
                _fields(identity, {"namespace", "value", "evidence"}, "identifier")
                namespace = _text(identity["namespace"], constants.MAX_IDENTIFIER_CHARACTERS, "identifier namespace")
                value = _text(identity["value"], constants.MAX_IDENTIFIER_CHARACTERS, "identifier value")
                identity_quote = _text(identity["evidence"], constants.MAX_EVIDENCE_CHARACTERS, "identifier evidence")
                if namespace not in identity_quote or value not in identity_quote:
                    raise OntologyValidationError("identifier namespace and value must occur verbatim in its evidence")
                if (namespace, value) in identity_keys:
                    raise OntologyValidationError("duplicate identifier namespace/value is not allowed")
                identity_keys.add((namespace, value))
                normalized_identifiers.append({"namespace": namespace, "value": value,
                                               "evidence": validation.evidence(identity_quote)})
            normalized.update(context=context, identifiers=normalized_identifiers)
            key += (_context_key(context), tuple(sorted(identity_keys)))
        if identifier in validation.entity_ids or key in labels:
            raise OntologyValidationError("duplicate entity id or type/label/context/identifiers is not allowed")
        validation.entity_ids[identifier] = entity_type
        labels.add(key)
        normalized_entities.append(normalized)
    return normalized_entities


def _relations(relations, validation, claims):
    """근거 관계를 검증하고 후보와 공유할 주장 키를 수집한다."""
    normalized_relations = []
    for item in relations:
        if validation.schema_version == 1:
            _fields(item, constants._RELATION_FIELDS, "relation")
        else:
            allowed = constants._RELATION_FIELDS | {"qualifiers"}
            if validation.schema_version >= 3:
                allowed |= constants._METADATA_FIELDS
            if validation.schema_version >= 5:
                allowed |= {"mapping"}
            _optional_fields(item, constants._RELATION_FIELDS, allowed, "relation")
        normalized, key = validation.claim(item)
        if key in claims:
            raise OntologyValidationError("duplicate relation claim is not allowed")
        claims.add(key)
        normalized_relations.append(normalized)
    return normalized_relations


def _candidates(relation_candidates, validation, claims):
    """미확정 후보의 질문과 근거를 보존하고 기존 관계와 구분한다."""
    candidate_ids = set()
    normalized_candidates = []
    for item in relation_candidates:
        allowed = constants._CANDIDATE_FIELDS | (constants._METADATA_FIELDS if validation.schema_version >= 3 else set())
        _optional_fields(item, constants._CANDIDATE_REQUIRED_FIELDS, allowed, "relation candidate")
        identifier = _identifier(item["id"], "candidate id")
        if identifier in candidate_ids:
            raise OntologyValidationError("duplicate candidate id is not allowed")
        candidate_ids.add(identifier)
        normalized, key = validation.claim(item, candidate=True)
        if key in claims:
            raise OntologyValidationError("duplicate claim across relations or candidates is not allowed")
        claims.add(key)
        normalized_candidates.append({
            "id": identifier, **normalized,
            "reason": _text(item["reason"], constants.MAX_CANDIDATE_REASON_CHARACTERS, "candidate reason"),
            "question": _text(item["question"], constants.MAX_CANDIDATE_QUESTION_CHARACTERS, "candidate question"),
            "status": "needs_review",
        })
    return normalized_candidates


def _attributes(attributes, validation):
    """속성 값·단위·출처와 모든 한정어를 하나의 주장으로 검사한다."""
    attribute_ids, attribute_claims = set(), set()
    normalized_attributes = []
    for item in attributes:
        _optional_fields(item, constants._ATTRIBUTE_FIELDS, constants._ATTRIBUTE_FIELDS | {"qualifiers"} | constants._METADATA_FIELDS, "attribute")
        identifier = _identifier(item["id"], "attribute id")
        if identifier in attribute_ids:
            raise OntologyValidationError("duplicate attribute id is not allowed")
        attribute_ids.add(identifier)
        subject = _identifier(item["subject"], "attribute subject")
        if subject not in validation.entity_ids:
            raise OntologyValidationError("attribute subject must reference an entity in this document")
        property_name = _text(item["property"], constants.MAX_LABEL_CHARACTERS, "attribute property")
        value = _text(item["value"], constants.MAX_ATTRIBUTE_VALUE_CHARACTERS, "attribute value")
        unit = item["unit"]
        if unit is not None:
            unit = _text(unit, constants.MAX_LABEL_CHARACTERS, "attribute unit")
        datatype = item["datatype"]
        if not isinstance(datatype, str) or datatype not in {"text", "number"}:
            raise OntologyValidationError("attribute datatype must be text or number")
        if datatype == "number" and constants._NUMBER_PATTERN.fullmatch(value) is None:
            raise OntologyValidationError("numeric attribute value must be a finite decimal string")
        quote = _text(item["evidence"], constants.MAX_EVIDENCE_CHARACTERS, "attribute evidence")
        if any(text is not None and text not in quote for text in (property_name, value, unit)):
            raise OntologyValidationError("attribute property, value and unit must occur verbatim in its evidence")
        qualifiers = _qualifiers(item.get("qualifiers", {}), quote)
        extra, extra_key = validation.metadata(item, quote)
        key = (subject, property_name, datatype, value, unit)
        key += tuple(qualifiers[name] for name in constants._QUALIFIER_DEFAULTS) + extra_key
        if key in attribute_claims:
            raise OntologyValidationError("duplicate attribute claim is not allowed")
        attribute_claims.add(key)
        normalized_attributes.append({
            "id": identifier, "subject": subject, "property": property_name, "datatype": datatype,
            "value": value, "unit": unit, "evidence": validation.evidence(quote), "qualifiers": qualifiers, **extra,
        })
    return normalized_attributes


def _items(entities, relations, source=None, relation_candidates=None, *, attributes=None,
           schema_version=3, document=None, source_revision=None) -> tuple:
    """배열/형식 한도를 먼저 확인하고 개체 → 주장 순서로 참조를 검증한다.

    순서는 기존 오류 계약의 일부다. 후보는 관계와 중복 검사를 공유하지만
    승인된 주장으로 승격하지 않으며 속성은 별도 중복 집합을 사용한다.
    """
    if type(schema_version) is not int or schema_version not in (1, 2, 3, 4, 5, 6):
        raise OntologyValidationError("unsupported schema_version")
    for collection, limit, name in ((entities, constants.MAX_ENTITIES, "entities"),
                                    (relations, constants.MAX_RELATIONS, "relations")):
        if not isinstance(collection, list) or len(collection) > limit:
            raise OntologyValidationError(f"{name} must be a list of at most {limit} items")
    if relation_candidates is None:
        relation_candidates = []
    if attributes is None:
        attributes = []
    for collection, limit, name in ((relation_candidates, constants.MAX_RELATION_CANDIDATES, "relation_candidates"),
                                    (attributes, constants.MAX_ATTRIBUTES, "attributes")):
        if not isinstance(collection, list) or len(collection) > limit:
            raise OntologyValidationError(f"{name} must be a list of at most {limit} items")
    if schema_version == 1 and relation_candidates:
        raise OntologyValidationError("schema version 1 does not support relation candidates")
    if schema_version < 3 and attributes:
        raise OntologyValidationError("attributes require schema version 3")
    validation = _ExtractionValidation(schema_version, source, document, source_revision)
    normalized_entities = _entities(entities, validation)
    claims = set()
    normalized_relations = _relations(relations, validation, claims)
    normalized_candidates = _candidates(relation_candidates, validation, claims)
    normalized_attributes = _attributes(attributes, validation)
    return normalized_entities, normalized_relations, normalized_candidates, normalized_attributes


def _graph(document: str, revision: str, entities: list, relations: list, source: str,
           relation_candidates=None, *, attributes=None, schema_version=3) -> dict:
    entities, relations, candidates, attributes = _items(
        entities, relations, source, relation_candidates, attributes=attributes, schema_version=schema_version,
        document=document, source_revision=revision,
    )
    graph = {"schema_version": schema_version, "document": document, "source_revision": revision,
             "entities": entities, "relations": relations}
    if schema_version >= 2:
        graph["relation_candidates"] = candidates
    if schema_version >= 3:
        graph["attributes"] = attributes
    return graph
