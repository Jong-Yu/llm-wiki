"""Validated, revision-bound ontology snapshots derived from wiki documents."""

from bisect import bisect_right
from hashlib import sha256
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import unicodedata
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from markdown_it import MarkdownIt

from core.anchors import normalize_anchor, endpoint_key

from core.storage import (
    MAX_DOCUMENT_BYTES, CleanupFailure, DocumentSnapshot, DocumentTooLargeError,
    RevisionConflictError, WikiStore,
)


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


def relation_schema_version(value):
    """Feature inference for source claim snapshots; legacy claim bytes stay unchanged."""
    if isinstance(value, dict):
        if "mapping" in value or value.get("predicate") in V5_NEW_RELATION_PREDICATES:
            return 5
        if any(isinstance(value.get(name), dict) for name in ("subject", "object")):
            return 4
    return 3


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


class OntologyValidationError(ValueError):
    """The submitted extraction does not satisfy the ontology contract."""


class OntologyCorruptError(ValueError):
    """The stored derived snapshot is malformed; source data is untouched."""


class _ContextBudgetError(ValueError):
    """An entire component does not fit the remaining capture budget."""


def _fields(value, expected: set, name: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise OntologyValidationError(f"{name} must contain exactly the documented fields")


def _optional_fields(value, required: set, allowed: set, name: str) -> None:
    if not isinstance(value, dict) or not required <= set(value) <= allowed:
        raise OntologyValidationError(f"{name} must contain only the documented fields")


def _text(value, limit: int, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise OntologyValidationError(f"{name} must be nonblank text of at most {limit} characters")
    try:
        value.encode("utf-8")
    except UnicodeError as error:
        raise OntologyValidationError(f"{name} must be valid UTF-8 text") from error
    return value


def _identifier(value, name: str) -> str:
    if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
        raise OntologyValidationError(f"{name} must match [a-z][a-z0-9_-]{{0,63}}")
    return value


def _revision(value) -> str:
    if not isinstance(value, str) or _REVISION_PATTERN.fullmatch(value) is None:
        raise OntologyValidationError("expected_revision must be a 64-character lowercase SHA-256")
    return value


def _qualifiers(value, quote) -> dict:
    """Keep source restrictions as text; do not evaluate their logic."""
    _optional_fields(value, set(), set(_QUALIFIER_DEFAULTS), "qualifiers")
    normalized = {**_QUALIFIER_DEFAULTS, **value}
    for key, allowed in (("polarity", POLARITIES), ("modality", MODALITIES)):
        if not isinstance(normalized[key], str) or normalized[key] not in allowed:
            raise OntologyValidationError(f"qualifier {key} is not supported")
    for key in ("condition", "scope", "time"):
        if normalized[key] is not None:
            text = _text(normalized[key], MAX_EVIDENCE_CHARACTERS, f"qualifier {key}")
            if quote is None or text not in quote:
                raise OntologyValidationError(f"qualifier {key} must occur verbatim in its relation evidence")
    return normalized


def _context(value, quote) -> dict:
    """Keep a literal domain and normalized viewpoint tags on one assertion."""
    _optional_fields(value, set(), _CONTEXT_FIELDS, "context")
    domain = value.get("domain")
    if domain is not None:
        domain = _text(domain, MAX_EVIDENCE_CHARACTERS, "context domain")
        if quote is None or domain not in quote:
            raise OntologyValidationError("context domain must occur verbatim in its evidence")
    viewpoints = value.get("viewpoints", [])
    if (not isinstance(viewpoints, list) or len(viewpoints) > len(VIEWPOINTS)
            or any(not isinstance(item, str) or item not in VIEWPOINTS for item in viewpoints)
            or len(set(viewpoints)) != len(viewpoints)):
        raise OntologyValidationError("context viewpoints must be distinct supported tags")
    if quote is None and (domain is not None or viewpoints):
        raise OntologyValidationError("context requires evidence")
    return {"domain": domain, "viewpoints": list(viewpoints)}


def _context_key(value) -> tuple:
    return value["domain"], tuple(sorted(value["viewpoints"]))


def _provenance(value, quote, entity_types) -> dict:
    _optional_fields(value, set(), _PROVENANCE_FIELDS, "provenance")
    normalized = {key: value.get(key) for key in ("source_entity", "attributed_to", "basis")}
    for field, allowed in (("source_entity", {"document"}),
                           ("attributed_to", {"person", "organization", "system"})):
        identifier = normalized[field]
        if identifier is not None:
            _identifier(identifier, f"provenance {field}")
            if quote is None or entity_types.get(identifier) not in allowed:
                raise OntologyValidationError(f"provenance {field} requires evidence and an entity of the documented type")
    if normalized["basis"] is not None:
        basis = _text(normalized["basis"], MAX_EVIDENCE_CHARACTERS, "provenance basis")
        if quote is None or basis not in quote:
            raise OntologyValidationError("provenance basis must occur verbatim in its evidence")
    return normalized


def _provenance_key(value) -> tuple:
    return tuple(value[field] for field in ("source_entity", "attributed_to", "basis"))


def _items(entities, relations, source=None, relation_candidates=None, *, attributes=None,
           schema_version=3, document=None, source_revision=None) -> tuple:
    """Validate raw extraction, optionally attaching locations in exact source."""
    if type(schema_version) is not int or schema_version not in (1, 2, 3, 4, 5):
        raise OntologyValidationError("unsupported schema_version")
    for collection, limit, name in ((entities, MAX_ENTITIES, "entities"),
                                    (relations, MAX_RELATIONS, "relations")):
        if not isinstance(collection, list) or len(collection) > limit:
            raise OntologyValidationError(f"{name} must be a list of at most {limit} items")
    if relation_candidates is None:
        relation_candidates = []
    if attributes is None:
        attributes = []
    for collection, limit, name in ((relation_candidates, MAX_RELATION_CANDIDATES, "relation_candidates"),
                                    (attributes, MAX_ATTRIBUTES, "attributes")):
        if not isinstance(collection, list) or len(collection) > limit:
            raise OntologyValidationError(f"{name} must be a list of at most {limit} items")
    if schema_version == 1 and relation_candidates:
        raise OntologyValidationError("schema version 1 does not support relation candidates")
    if schema_version < 3 and attributes:
        raise OntologyValidationError("attributes require schema version 3")
    entity_types = V1_ENTITY_TYPES if schema_version == 1 else ENTITY_TYPES
    predicates = {1: V1_RELATION_PREDICATES, 2: V2_RELATION_PREDICATES,
                  3: RELATION_PREDICATES, 4: RELATION_PREDICATES, 5: V5_RELATION_PREDICATES}[schema_version]
    line_starts = None if source is None else [0] + [
        match.end() for match in re.finditer(r"\r\n|\r|\n", source)
    ]

    def evidence(value):
        quote = _text(value, MAX_EVIDENCE_CHARACTERS, "evidence")
        if source is None:
            return quote
        offset = source.find(quote)
        if offset < 0:
            raise OntologyValidationError("evidence must occur verbatim in the source document")
        return {
            "quote": quote,
            "start_line": bisect_right(line_starts, offset),
            "end_line": bisect_right(line_starts, offset + len(quote) - 1),
        }

    entity_ids = {}
    labels = set()
    normalized_entities = []
    for item in entities:
        if schema_version < 3:
            _fields(item, _ENTITY_FIELDS, "entity")
        else:
            _optional_fields(item, _ENTITY_FIELDS, _ENTITY_FIELDS | {"context", "identifiers"}, "entity")
        identifier = _identifier(item["id"], "entity id")
        entity_type = item["type"]
        if not isinstance(entity_type, str) or entity_type not in entity_types:
            raise OntologyValidationError("entity type is not supported")
        label = _text(item["label"], MAX_LABEL_CHARACTERS, "label")
        quote = _text(item["evidence"], MAX_EVIDENCE_CHARACTERS, "evidence")
        if label not in quote:
            raise OntologyValidationError("entity label must occur verbatim in its evidence")
        normalized = {"id": identifier, "type": entity_type, "label": label, "evidence": evidence(quote)}
        key = (entity_type, label)
        if schema_version >= 3:
            context = _context(item.get("context", {}), quote)
            identifiers = item.get("identifiers", [])
            if not isinstance(identifiers, list) or len(identifiers) > MAX_IDENTIFIERS:
                raise OntologyValidationError(f"identifiers must be a list of at most {MAX_IDENTIFIERS} items")
            normalized_identifiers = []
            identity_keys = set()
            for identity in identifiers:
                _fields(identity, {"namespace", "value", "evidence"}, "identifier")
                namespace = _text(identity["namespace"], MAX_IDENTIFIER_CHARACTERS, "identifier namespace")
                value = _text(identity["value"], MAX_IDENTIFIER_CHARACTERS, "identifier value")
                identity_quote = _text(identity["evidence"], MAX_EVIDENCE_CHARACTERS, "identifier evidence")
                if namespace not in identity_quote or value not in identity_quote:
                    raise OntologyValidationError("identifier namespace and value must occur verbatim in its evidence")
                if (namespace, value) in identity_keys:
                    raise OntologyValidationError("duplicate identifier namespace/value is not allowed")
                identity_keys.add((namespace, value))
                normalized_identifiers.append({"namespace": namespace, "value": value,
                                               "evidence": evidence(identity_quote)})
            normalized.update(context=context, identifiers=normalized_identifiers)
            key += (_context_key(context), tuple(sorted(identity_keys)))
        if identifier in entity_ids or key in labels:
            raise OntologyValidationError("duplicate entity id or type/label/context/identifiers is not allowed")
        entity_ids[identifier] = entity_type
        labels.add(key)
        normalized_entities.append(normalized)

    def metadata(item, quote):
        context = _context(item.get("context", {}), quote)
        provenance = _provenance(item.get("provenance", {}), quote, entity_ids)
        return {"context": context, "provenance": provenance}, (_context_key(context), _provenance_key(provenance))

    def claim(item, *, candidate=False):
        quote = item.get("evidence")
        def endpoint(value, label):
            if isinstance(value, dict):
                if schema_version < 4 or candidate:
                    raise OntologyValidationError("source anchors require an explicit v4/v5 relation")
                try:
                    return normalize_anchor(value, document=document, source_revision=source_revision,
                                            source=source, evidence=quote)
                except (ValueError, UnicodeError) as error:
                    raise OntologyValidationError(str(error)) from error
            identifier = _identifier(value, label)
            if identifier not in entity_ids:
                raise OntologyValidationError("relation endpoints must reference entities in this document")
            return identifier
        subject = endpoint(item["subject"], "relation subject")
        object_id = endpoint(item["object"], "relation object")
        predicate = item["predicate"]
        allowed_predicates = RELATION_PREDICATES if candidate and schema_version == 5 else predicates
        if not isinstance(predicate, str) or predicate not in allowed_predicates:
            raise OntologyValidationError("relation predicate is not supported")

        attached = None if candidate and quote is None else evidence(quote)
        normalized = {"subject": subject, "predicate": predicate, "object": object_id, "evidence": attached}
        key = (endpoint_key(subject), predicate, endpoint_key(object_id))
        if predicate == "maps_to":
            if schema_version != 5 or candidate:
                raise OntologyValidationError("maps_to requires a v5 relation")
            mapping = item.get("mapping")
            _fields(mapping, {"within", "subject_cardinality", "object_cardinality"}, "mapping")
            within = _identifier(mapping["within"], "mapping within")
            if within not in entity_ids:
                raise OntologyValidationError("mapping within must reference an entity in this document")
            if mapping["subject_cardinality"] != "many" or mapping["object_cardinality"] != "many":
                raise OntologyValidationError("mapping cardinalities must be literal many")
            normalized["mapping"] = {"within": within, "subject_cardinality": "many", "object_cardinality": "many"}
            key += (within, "many", "many")
        elif "mapping" in item:
            raise OntologyValidationError("mapping is only allowed on v5 maps_to relations")
        if schema_version >= 2:
            qualifiers = _qualifiers(item.get("qualifiers", {}), quote)
            normalized["qualifiers"] = qualifiers
            key += tuple(qualifiers[name] for name in _QUALIFIER_DEFAULTS)
        if schema_version >= 3:
            extra, extra_key = metadata(item, quote)
            normalized.update(extra)
            key += extra_key
        return normalized, key

    claims = set()
    normalized_relations = []
    for item in relations:
        if schema_version == 1:
            _fields(item, _RELATION_FIELDS, "relation")
        else:
            allowed = _RELATION_FIELDS | {"qualifiers"}
            if schema_version >= 3:
                allowed |= _METADATA_FIELDS
            if schema_version == 5:
                allowed |= {"mapping"}
            _optional_fields(item, _RELATION_FIELDS, allowed, "relation")
        normalized, key = claim(item)
        if key in claims:
            raise OntologyValidationError("duplicate relation claim is not allowed")
        claims.add(key)
        normalized_relations.append(normalized)

    candidate_ids = set()
    normalized_candidates = []
    for item in relation_candidates:
        allowed = _CANDIDATE_FIELDS | (_METADATA_FIELDS if schema_version >= 3 else set())
        _optional_fields(item, _CANDIDATE_REQUIRED_FIELDS, allowed, "relation candidate")
        identifier = _identifier(item["id"], "candidate id")
        if identifier in candidate_ids:
            raise OntologyValidationError("duplicate candidate id is not allowed")
        candidate_ids.add(identifier)
        normalized, key = claim(item, candidate=True)
        if key in claims:
            raise OntologyValidationError("duplicate claim across relations or candidates is not allowed")
        claims.add(key)
        normalized_candidates.append({
            "id": identifier, **normalized,
            "reason": _text(item["reason"], MAX_CANDIDATE_REASON_CHARACTERS, "candidate reason"),
            "question": _text(item["question"], MAX_CANDIDATE_QUESTION_CHARACTERS, "candidate question"),
            "status": "needs_review",
        })

    attribute_ids, attribute_claims = set(), set()
    normalized_attributes = []
    for item in attributes:
        _optional_fields(item, _ATTRIBUTE_FIELDS, _ATTRIBUTE_FIELDS | {"qualifiers"} | _METADATA_FIELDS, "attribute")
        identifier = _identifier(item["id"], "attribute id")
        if identifier in attribute_ids:
            raise OntologyValidationError("duplicate attribute id is not allowed")
        attribute_ids.add(identifier)
        subject = _identifier(item["subject"], "attribute subject")
        if subject not in entity_ids:
            raise OntologyValidationError("attribute subject must reference an entity in this document")
        property_name = _text(item["property"], MAX_LABEL_CHARACTERS, "attribute property")
        value = _text(item["value"], MAX_ATTRIBUTE_VALUE_CHARACTERS, "attribute value")
        unit = item["unit"]
        if unit is not None:
            unit = _text(unit, MAX_LABEL_CHARACTERS, "attribute unit")
        datatype = item["datatype"]
        if not isinstance(datatype, str) or datatype not in {"text", "number"}:
            raise OntologyValidationError("attribute datatype must be text or number")
        if datatype == "number" and _NUMBER_PATTERN.fullmatch(value) is None:
            raise OntologyValidationError("numeric attribute value must be a finite decimal string")
        quote = _text(item["evidence"], MAX_EVIDENCE_CHARACTERS, "attribute evidence")
        if any(text is not None and text not in quote for text in (property_name, value, unit)):
            raise OntologyValidationError("attribute property, value and unit must occur verbatim in its evidence")
        qualifiers = _qualifiers(item.get("qualifiers", {}), quote)
        extra, extra_key = metadata(item, quote)
        key = (subject, property_name, datatype, value, unit)
        key += tuple(qualifiers[name] for name in _QUALIFIER_DEFAULTS) + extra_key
        if key in attribute_claims:
            raise OntologyValidationError("duplicate attribute claim is not allowed")
        attribute_claims.add(key)
        normalized_attributes.append({
            "id": identifier, "subject": subject, "property": property_name, "datatype": datatype,
            "value": value, "unit": unit, "evidence": evidence(quote), "qualifiers": qualifiers, **extra,
        })
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
    try:
        graph = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        if not isinstance(graph, dict):
            raise OntologyValidationError("stored graph must be an object")
        version = graph.get("schema_version")
        if type(version) is not int or version not in (1, 2, 3, 4, 5):
            raise OntologyValidationError("unsupported schema_version")
        fields = {1: _V1_GRAPH_FIELDS, 2: _GRAPH_FIELDS, 3: _V3_GRAPH_FIELDS, 4: _V3_GRAPH_FIELDS, 5: _V3_GRAPH_FIELDS}[version]
        _optional_fields(graph, fields, fields | {"generation_id"}, "graph")
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
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= MAX_ONTOLOGY_BYTES:
                raise OntologyValidationError("stored evidence line numbers are invalid")
            return value["quote"]

        def metadata(item):
            _fields(item["context"], _CONTEXT_FIELDS, "stored context")
            _fields(item["provenance"], _PROVENANCE_FIELDS, "stored provenance")

        def collection(name, limit):
            items = graph[name]
            if not isinstance(items, list) or len(items) > limit:
                raise OntologyValidationError("stored collection exceeds its item limit")
            return items

        entities = []
        entity_fields = _ENTITY_FIELDS | ({"context", "identifiers"} if version >= 3 else set())
        for item in collection("entities", MAX_ENTITIES):
            _fields(item, entity_fields, "stored entity")
            converted = {**item, "evidence": quote(item["evidence"])}
            if version >= 3:
                _fields(item["context"], _CONTEXT_FIELDS, "stored entity context")
                identities = item["identifiers"]
                if not isinstance(identities, list) or len(identities) > MAX_IDENTIFIERS:
                    raise OntologyValidationError("stored identifiers exceed their item limit")
                converted["identifiers"] = []
                for identity in identities:
                    _fields(identity, {"namespace", "value", "evidence"}, "stored identifier")
                    converted["identifiers"].append({**identity, "evidence": quote(identity["evidence"])})
            entities.append(converted)

        relations = []
        relation_fields = _RELATION_FIELDS | ({"qualifiers"} if version >= 2 else set())
        if version >= 3:
            relation_fields |= _METADATA_FIELDS
        for item in collection("relations", MAX_RELATIONS):
            _optional_fields(item, relation_fields, relation_fields | ({"mapping"} if version == 5 else set()), "stored relation")
            if version >= 2:
                _fields(item["qualifiers"], set(_QUALIFIER_DEFAULTS), "stored qualifiers")
            if version >= 3:
                metadata(item)
            relations.append({**item, "evidence": quote(item["evidence"])})

        candidates = []
        if version >= 2:
            candidate_fields = _CANDIDATE_FIELDS | {"status"}
            if version >= 3:
                candidate_fields |= _METADATA_FIELDS
            for item in collection("relation_candidates", MAX_RELATION_CANDIDATES):
                _fields(item, candidate_fields, "stored candidate")
                if item["status"] != "needs_review":
                    raise OntologyValidationError("stored candidate status must be needs_review")
                _fields(item["qualifiers"], set(_QUALIFIER_DEFAULTS), "stored qualifiers")
                if version >= 3:
                    metadata(item)
                candidates.append({
                    **{key: value for key, value in item.items() if key != "status"},
                    "evidence": quote(item["evidence"], optional=True),
                })
        attributes = []
        if version >= 3:
            for item in collection("attributes", MAX_ATTRIBUTES):
                _fields(item, _ATTRIBUTE_FIELDS | {"qualifiers"} | _METADATA_FIELDS, "stored attribute")
                _fields(item["qualifiers"], set(_QUALIFIER_DEFAULTS), "stored qualifiers")
                metadata(item)
                attributes.append({**item, "evidence": quote(item["evidence"])})
        _items(entities, relations, relation_candidates=candidates, attributes=attributes, schema_version=version,
               document=document, source_revision=graph["source_revision"])
        return graph, entities, relations, candidates, attributes
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise OntologyCorruptError("Stored ontology is malformed; regenerate it from the latest source") from error


def _query_snapshot(document: str, source, raw) -> dict:
    """Validate an already captured pair without taking another storage lock."""
    empty = {"document": document, "source_revision": source.revision,
             "entities": [], "relations": [], "relation_candidates": [], "attributes": []}
    if raw is None:
        return {**empty, "status": "missing"}
    graph, entities, relations, candidates, attributes = _stored_graph(raw, document)
    if graph["source_revision"] != source.revision:
        return {**empty, "status": "stale", "indexed_revision": graph["source_revision"]}
    try:
        normalized = _graph(
            document, source.revision, entities, relations, source.content, candidates,
            attributes=attributes, schema_version=graph["schema_version"],
        )
    except OntologyValidationError as error:
        raise OntologyCorruptError("Stored ontology evidence does not match its source") from error
    if {k: v for k, v in graph.items() if k != "generation_id"} != normalized:
        raise OntologyCorruptError("Stored ontology evidence locations do not match its source")
    return {"relation_candidates": [], "attributes": [], **graph, "status": "ready",
            "needs_reextraction": graph["schema_version"] < 3}


def _filter_snapshot(graph, domain, viewpoint) -> dict:
    """Filter claim metadata only; retain all entities for reference resolution."""
    if domain is None and viewpoint is None:
        return graph

    def matches(item):
        context = item.get("context", {})
        return ((domain is None or context.get("domain") == domain)
                and (viewpoint is None or viewpoint in context.get("viewpoints", [])))

    return {**graph, "filtered": {"domain": domain, "viewpoint": viewpoint},
            **{name: [item for item in graph[name] if matches(item)]
               for name in ("relations", "relation_candidates", "attributes")}}


def _context_selection(graph: dict, domain, viewpoint) -> dict:
    """Partition references without dropping claims or inventing shared context."""
    selected = {}
    for collection in ("relations", "attributes", "relation_candidates"):
        groups = {"focus": [], "other_context": [], "unclassified": []}
        for index, item in enumerate(graph[collection]):
            context = item.get("context", {})
            item_domain = context.get("domain")
            viewpoints = context.get("viewpoints", [])
            if ((domain is not None and item_domain is None)
                    or (viewpoint is not None and not viewpoints)
                    or (domain is None and viewpoint is None
                        and item_domain is None and not viewpoints)):
                group = "unclassified"
            elif ((domain is None or domain == item_domain)
                  and (viewpoint is None or viewpoint in viewpoints)):
                group = "focus"
            else:
                group = "other_context"
            groups[group].append(index)
        selected[collection] = groups
    return selected


def _connection_error(error: Exception) -> str:
    """Only bounded, non-sensitive codes leave a partial connection query."""
    if isinstance(error, OntologyCorruptError):
        return "ontology_corrupt"
    if isinstance(error, DocumentTooLargeError):
        return "document_too_large"
    if isinstance(error, UnicodeError):
        return "invalid_encoding"
    if isinstance(error, (ValueError, TypeError)):
        return "invalid_argument"
    if isinstance(error, FileNotFoundError):
        return "not_found"
    return "storage_error"


def _link_target(document: str, href: str):
    """Decode a relative Markdown destination once, never a URL or wiki escape."""
    if not isinstance(href, str) or len(href) > MAX_LINK_HREF_CHARACTERS:
        return None
    if any(ord(char) < 32 for char in href) or "\\" in href:
        return None
    try:
        parts = urlsplit(href)
        if parts.scheme or parts.netloc or "?" in href.split("#", 1)[0]:
            return None
        path = unquote(parts.path, encoding="utf-8", errors="strict")
        if not path or path.startswith("/") or "\\" in path or "\x00" in path:
            return None
        if urlsplit(path).scheme or not path.endswith(".md"):
            return None
        target = posixpath.normpath(posixpath.join(posixpath.dirname(document), path))
        if target == ".." or target.startswith("../") or target.startswith("/"):
            return None
        return target, parts.fragment
    except (ValueError, UnicodeError):
        return None


def _normalized_label(label: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", label).casefold().split())


def _source_links(content):
    """Yield Markdown links, excluding images, code and raw HTML/comments."""
    for block in MarkdownIt("commonmark").parse(content):
        if block.type == "inline" and block.map is not None:
            for token in block.children or ():
                if token.type == "link_open":
                    yield token.attrGet("href"), {"start_line": block.map[0] + 1,
                                                  "end_line": block.map[1], "scope": "block"}


class OntologyStore:
    """A derived cache; all snapshots use WikiStore's existing writer lock."""

    def __init__(self, store: WikiStore):
        self.store = store
        self.ontology_dir = store.data_dir / "_ontology"

    def _path(self, document: str) -> Path:
        self.store._document_path(self.store.wiki_dir, document)
        path = self.ontology_dir / (sha256(document.encode("utf-8")).hexdigest() + ".json")
        self.store._check_path(path)
        return path

    def _read_source(self, document: str):
        path = self.store._document_path(self.store.wiki_dir, document)
        if not stat.S_ISREG(path.stat().st_mode):
            raise OntologyValidationError("source document must be a regular file")
        return self.store.read(document)

    def _read_bytes(self, path: Path):
        self.store._check_path(path)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OntologyCorruptError("Stored ontology must be a regular file")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                raw = stream.read(MAX_ONTOLOGY_BYTES + 1)
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if len(raw) > MAX_ONTOLOGY_BYTES:
            raise OntologyCorruptError("Stored ontology exceeds the 1 MiB byte limit")
        return raw

    def generate(self, document: str, expected_revision: str, entities: list, relations: list,
                 relation_candidates=None, *, attributes=None, schema_version=3,
                 expected_state_revision=None) -> dict:
        """Validate caller-extracted facts against their exact source revision."""
        _revision(expected_revision)
        if expected_state_revision is not None:
            _revision(expected_state_revision)
        # Cheap structure/size checks precede acquiring the shared storage lock.
        _items(entities, relations, relation_candidates=relation_candidates,
               attributes=attributes, schema_version=schema_version,
               document=document, source_revision=expected_revision)
        self._path(document)
        cleanup_failures: list[CleanupFailure] = []
        try:
            with self.store._write_lock():
                path = self._path(document)
                source = self._read_source(document)
                if source.revision != expected_revision:
                    raise RevisionConflictError(document, expected_revision, source.revision)
                # Lazy import keeps graph validation reusable by the review ledger.
                # A reviewed document cannot be replaced by an unaware generator.
                from core.reviews import ReviewStore
                ReviewStore(self.store).guard_generation(document, expected_state_revision)
                graph = _graph(document, source.revision, entities, relations, source.content,
                               relation_candidates, attributes=attributes, schema_version=schema_version)
                encoded = (json.dumps(graph, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
                if len(encoded) > MAX_ONTOLOGY_BYTES:
                    raise OntologyValidationError("Generated ontology exceeds the 1 MiB byte limit")
                previous = self._read_bytes(path)
                changed = previous != encoded
                if changed and previous is not None:
                    try:
                        previous_graph, _, _, _, _ = _stored_graph(previous, document)
                    except OntologyCorruptError:
                        # A valid explicit generation can repair derived data.
                        pass
                    else:
                        changed = {k: v for k, v in previous_graph.items()
                                   if k != "generation_id"} != graph
                if changed:
                    # Unique publication identity prevents A -> B -> A from
                    # accidentally reactivating an older human decision.
                    graph["generation_id"] = uuid4().hex
                    encoded = (json.dumps(graph, ensure_ascii=False, sort_keys=True,
                                          separators=(",", ":")) + "\n").encode("utf-8")
                    if len(encoded) > MAX_ONTOLOGY_BYTES:
                        raise OntologyValidationError("Generated ontology exceeds the 1 MiB byte limit")
                    self.store._mkdir(self.ontology_dir)
                    with self.store._staged_file(self.ontology_dir, encoded, cleanup_failures) as staged:
                        os.replace(staged.path, path)
                        staged.consumed = True
        except Exception as error:
            if cleanup_failures:
                error.cleanup_failures = tuple(cleanup_failures)
            raise
        return {
            "document": document, "source_revision": source.revision, "status": "ready",
            "entity_count": len(graph["entities"]), "relation_count": len(graph["relations"]),
            "candidate_count": len(graph.get("relation_candidates", [])),
            "attribute_count": len(graph.get("attributes", [])),
            "changed": changed,
            "graph_revision": sha256(encoded if changed else previous).hexdigest(),
            "layer": "machine", "review_tool": "ontology_review_query",
            "cleanup_failures": [
                {"path": failure.path.relative_to(self.store.data_dir).as_posix(),
                 "error_type": type(failure.error).__name__, "errno": failure.error.errno}
                for failure in cleanup_failures
            ],
        }

    def query(self, document: str, *, domain=None, viewpoint=None) -> dict:
        """Read a consistent source/cache pair, optionally selecting claim contexts.

        Filters do not provide authorization or establish equivalence between views.
        Stale facts are never returned, and entities remain for reference resolution.
        """
        if domain is not None:
            _text(domain, MAX_EVIDENCE_CHARACTERS, "domain filter")
        if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in VIEWPOINTS):
            raise OntologyValidationError("viewpoint filter must be a supported tag")
        self._path(document)
        with self.store._write_lock():
            path = self._path(document)
            source = self._read_source(document)
            raw = self._read_bytes(path)
            result = _filter_snapshot(_query_snapshot(document, source, raw), domain, viewpoint)
            return {**result, "graph_revision": sha256(raw).hexdigest() if raw else None,
                    "layer": "machine", "review_tool": "ontology_review_query"}

    def _context_bytes(self, path: Path, remaining: list, document: str, component: str, *, max_bytes=None):
        """Capture bounded bytes; external file changes never create partial text.

        The caller holds the shared store lock. Read exactly the descriptor's
        measured size, so a growing file cannot consume another document's budget.
        The mutable budget also counts bytes of malformed inputs we later omit.
        """
        self.store._check_path(path)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if component == "ontology":
                return None
            raise
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                if component == "ontology":
                    raise OntologyCorruptError("Stored ontology must be a regular file")
                raise OSError("Context input must be a regular file")
            limit = (MAX_DOCUMENT_BYTES if component == "source" else MAX_ONTOLOGY_BYTES) if max_bytes is None else max_bytes

            def check_size(size):
                if size > limit:
                    if component == "source":
                        raise DocumentTooLargeError(document, size)
                    raise OntologyCorruptError("Captured input exceeds its byte limit")
                if size > remaining[0]:
                    raise _ContextBudgetError("Context capture byte budget exhausted")

            check_size(info.st_size)
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                raw = stream.read(info.st_size)
                after = os.fstat(stream.fileno())
            # Recheck before decrementing: comparison uses this component's
            # original allowance, while the finally below counts bytes consumed.
            try:
                check_size(after.st_size)
                if (len(raw) != info.st_size or after.st_size != info.st_size
                        or after.st_mtime_ns != info.st_mtime_ns):
                    raise OSError("Context input changed during capture")
            finally:
                remaining[0] -= len(raw)
            return raw
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def context(self, documents: list[str], *, domain=None, viewpoint=None) -> dict:
        """Return full source text and graphs from one explicitly bounded snapshot.

        View selection only groups claim-array indices; it neither establishes
        permission nor removes other views, unclassified claims, or prose. Each
        index is meaningful only with its document/source/graph revisions.
        """
        if (not isinstance(documents, list)
                or not 1 <= len(documents) <= MAX_CONTEXT_DOCUMENTS):
            raise ValueError(f"documents must contain 1 to {MAX_CONTEXT_DOCUMENTS} paths")
        if domain is not None:
            _text(domain, MAX_EVIDENCE_CHARACTERS, "domain filter")
        if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in VIEWPOINTS):
            raise OntologyValidationError("viewpoint filter must be a supported tag")
        # Validate every selector before opening any source. Reject aliases
        # instead of silently charging/returning one document under two names.
        for document in documents:
            self.store._document_path(self.store.wiki_dir, document)
        if len(set(documents)) != len(documents):
            raise ValueError("documents must not contain duplicate paths")

        skipped = []
        truncated = False
        captured = []
        remaining = [MAX_CONTEXT_BYTES]

        def skip(document, code, component, *, omitted=True):
            nonlocal truncated
            skipped.append({"document": document, "code": code, "component": component})
            truncated = truncated or omitted

        with self.store._write_lock():
            identities = set()
            for document in documents:
                path = self.store._document_path(self.store.wiki_dir, document)
                try:
                    info = path.stat()
                except OSError:
                    continue  # Report a bounded source error in the capture loop.
                identity = (info.st_dev, info.st_ino)
                if identity in identities:
                    raise ValueError("documents must not name the same file through aliases")
                identities.add(identity)
            for document in documents:
                path = self.store._document_path(self.store.wiki_dir, document)
                try:
                    raw_source = self._context_bytes(path, remaining, document, "source")
                    source = DocumentSnapshot(raw_source.decode("utf-8"), self.store._revision(raw_source))
                except (OSError, ValueError, TypeError) as error:
                    code = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                    skip(document, code, "source")
                    continue
                raw = None
                graph_error = None
                try:
                    raw = self._context_bytes(self._path(document), remaining, document, "ontology")
                except (OSError, ValueError, TypeError) as error:
                    graph_error = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                    skip(document, graph_error, "ontology")
                captured.append((document, source, raw, graph_error))

        entries = []
        # This budget covers the complete JSON document array, including its
        # brackets and commas. The small, bounded response metadata is separate.
        output_bytes = 2
        complete = len(captured) == len(documents)
        for document, source, raw, graph_error in captured:
            if graph_error is None:
                try:
                    graph = _query_snapshot(document, source, raw)
                except (OSError, ValueError, TypeError) as error:
                    graph_error = _connection_error(error)
                    skip(document, graph_error, "ontology")
            if graph_error is not None:
                graph = {"document": document, "source_revision": source.revision,
                         "status": "unavailable", "error": {"code": graph_error},
                         "entities": [], "relations": [], "relation_candidates": [], "attributes": []}
            graph["graph_revision"] = sha256(raw).hexdigest() if raw is not None else None
            graph["needs_reextraction"] = graph.get("needs_reextraction", graph["status"] != "ready")
            if graph["status"] != "ready" or graph["needs_reextraction"]:
                complete = False
                if graph_error is None:
                    code = ("needs_reextraction" if graph["status"] == "ready"
                            else "ontology_" + graph["status"])
                    skip(document, code, "ontology", omitted=False)
            entry = {"document": document,
                     "source": {"content": source.content, "revision": source.revision,
                                "line_start": 1 if source.content else 0,
                                "line_end": (len(re.findall(r"\r\n|\r|\n", source.content))
                                             + (not source.content.endswith(("\r", "\n")))) if source.content else 0},
                     "ontology": graph, "selection": _context_selection(graph, domain, viewpoint)}
            size = len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            size += bool(entries)
            if size > MAX_CONTEXT_OUTPUT_BYTES - output_bytes:
                skip(document, "output_budget", "source")
                complete = False
                continue
            entries.append(entry)
            output_bytes += size
        return {"documents": entries, "requested_documents": list(documents),
                "layer": "machine", "review_tool": "ontology_review_query",
                "scope": {"kind": "explicit_documents", "auto_expanded": False},
                "selection": {"domain": domain, "viewpoint": viewpoint},
                "skipped": skipped, "truncated": truncated, "complete": complete,
                "captured_bytes": MAX_CONTEXT_BYTES - remaining[0], "output_bytes": output_bytes,
                "limits": {"max_documents": MAX_CONTEXT_DOCUMENTS,
                           "max_capture_bytes": MAX_CONTEXT_BYTES,
                           "max_output_bytes": MAX_CONTEXT_OUTPUT_BYTES}}

    def _connection_documents(self, skipped: list) -> tuple:
        """Walk at most the entry budget, without following symlink directories."""
        pending = [self.store.wiki_dir]
        documents = set()
        entries = 0
        complete = True
        while pending:
            directory = pending.pop()
            try:
                with os.scandir(directory) as iterator:
                    for entry in iterator:
                        if entries >= MAX_CONNECTION_SCAN_ENTRIES:
                            return sorted(documents), False, entries
                        entries += 1
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False) and entry.name.endswith(".md"):
                                documents.add(Path(entry.path).relative_to(self.store.wiki_dir).as_posix())
                        except OSError as error:
                            complete = False
                            if len(skipped) < MAX_CONNECTION_DOCUMENTS:
                                skipped.append({"document": Path(entry.path).relative_to(self.store.wiki_dir).as_posix(),
                                                "code": _connection_error(error)})
            except OSError as error:
                complete = False
                if len(skipped) < MAX_CONNECTION_DOCUMENTS:
                    skipped.append({"document": directory.relative_to(self.store.wiki_dir).as_posix(),
                                    "code": _connection_error(error)})
        return sorted(documents), complete, entries

    def _connections_snapshot_locked(self, document: str, limit: int = 20) -> tuple:
        """Derive explicit links and unmerged concept candidates from one snapshot.

        The limit applies separately to links and candidates. Missing/stale
        ontology is a normal state; skipped inputs and every processing/output
        limit make truncated true. No derived files or source files are written.
        """
        if type(limit) is not int or not 1 <= limit <= MAX_CONNECTION_LIMIT:
            raise ValueError(f"limit must be an integer from 1 to {MAX_CONNECTION_LIMIT}")
        self.store._document_path(self.store.wiki_dir, document)
        skipped = []
        truncated = False

        def skip(name, code):
            nonlocal truncated
            truncated = True
            if len(skipped) < MAX_CONNECTION_DOCUMENTS:
                skipped.append({"document": name, "code": code})

        snapshots = {}
        raw_graphs = {}
        graph_errors = {}
        source_errors = {}
        identities = {}
        explicit = []
        # The requested source is mandatory and is always captured first.
        remaining = [MAX_CONNECTION_BYTES]
        focus = self._read_source(document)
        remaining[0] -= len(focus.content.encode("utf-8"))
        snapshots[document] = focus
        scanned_bytes = len(focus.content.encode("utf-8"))
        names, scan_complete, scan_entries = self._connection_documents(skipped)
        truncated = bool(skipped) or not scan_complete
        names = [document] + [name for name in names if name != document]
        scanned = 0
        for name in names:
            if scanned >= MAX_CONNECTION_DOCUMENTS:
                truncated = True
                scan_complete = False
                break
            try:
                path = self.store._document_path(self.store.wiki_dir, name)
                info = path.stat()
                identity = (info.st_dev, info.st_ino)
                # Filesystem aliases (case/Unicode on macOS) remain one
                # source identity, with the focus spelling taking priority.
                if identity in identities:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise OntologyValidationError("source must be a regular file")
                scanned += 1
                identities[identity] = name
                if name != document:
                    if info.st_size > MAX_CONNECTION_BYTES - scanned_bytes:
                        source_errors[name] = "byte_budget"
                        skip(name, "byte_budget")
                        scan_complete = False
                        continue
                    source_raw = self._context_bytes(path, remaining, name, "source")
                    source = DocumentSnapshot(source_raw.decode("utf-8"), self.store._revision(source_raw))
                    size = len(source.content.encode("utf-8"))
                    if size > MAX_CONNECTION_BYTES - scanned_bytes:
                        source_errors[name] = "byte_budget"
                        skip(name, "byte_budget")
                        scan_complete = False
                        continue
                    snapshots[name] = source
                    scanned_bytes = MAX_CONNECTION_BYTES - remaining[0]
            except (OSError, ValueError, TypeError) as error:
                if name == document:
                    raise
                # Count failed documents too, so failures cannot evade the
                # document processing budget.
                if name not in source_errors and name not in identities.values():
                    scanned += 1
                source_errors[name] = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                skip(name, source_errors[name])
                scan_complete = False
                continue
            try:
                cache = self._path(name)
                try:
                    cache_size = cache.stat().st_size
                except FileNotFoundError:
                    cache_size = 0
                if cache_size > MAX_ONTOLOGY_BYTES:
                    raise OntologyCorruptError("Stored ontology exceeds the 1 MiB byte limit")
                if cache_size > MAX_CONNECTION_BYTES - scanned_bytes:
                    graph_errors[name] = "byte_budget"
                    skip(name, "byte_budget")
                    continue
                raw = self._context_bytes(cache, remaining, name, "ontology")
                if raw is not None:
                    if len(raw) > MAX_CONNECTION_BYTES - scanned_bytes:
                        graph_errors[name] = "byte_budget"
                        skip(name, "byte_budget")
                        continue
                    scanned_bytes = MAX_CONNECTION_BYTES - remaining[0]
                raw_graphs[name] = raw
            except (OSError, ValueError, TypeError) as error:
                graph_errors[name] = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                skip(name, graph_errors[name])

        # Resolve target identity while the same writer lock is held. The
        # bounded parser also excludes images, code and raw HTML/comments.
        link_count = 0
        seen = set()
        links_done = False
        for name, source in snapshots.items():
            if links_done:
                break
            for href, evidence in _source_links(source.content):
                if link_count >= MAX_CONNECTION_LINKS:
                    truncated = True
                    links_done = True
                    break
                link_count += 1
                if isinstance(href, str) and len(href) > MAX_LINK_HREF_CHARACTERS:
                    skip(name, "link_href_too_long")
                    continue
                destination = _link_target(name, href)
                if destination is None:
                    continue
                target, fragment = destination
                try:
                    target_path = self.store._document_path(self.store.wiki_dir, target)
                except (ValueError, TypeError):
                    # Includes symlinks and paths outside the wiki.
                    continue
                try:
                    target_info = target_path.stat()
                    target = identities.get((target_info.st_dev, target_info.st_ino), target)
                    status = "unavailable" if not stat.S_ISREG(target_info.st_mode) else None
                    target_error = "invalid_argument" if status is not None else None
                except FileNotFoundError:
                    status = None
                    target_error = None
                except OSError as error:
                    status = "unavailable"
                    target_error = _connection_error(error)
                if target == name or document not in (name, target) or (name, target) in seen:
                    continue
                if target_error is not None:
                    skip(target, target_error)
                seen.add((name, target))
                target_source = snapshots.get(target)
                if target_source is not None:
                    status = "resolved"
                elif target in source_errors:
                    status = "unscanned" if source_errors[target] == "byte_budget" else "unavailable"
                elif status is None:
                    status = "missing" if scan_complete else "unscanned"
                if len(explicit) >= limit:
                    truncated = True
                    links_done = True
                    break
                explicit.append({
                    "source_document": name, "source_revision": source.revision,
                    "target_document": target,
                    "target_revision": None if target_source is None else target_source.revision,
                    "target_status": status,
                    "direction": "outgoing" if name == document else "incoming",
                    "href": href, "fragment": fragment,
                    "evidence": evidence,
                })

        states = []
        ready = {}
        for name, source in snapshots.items():
            if name in graph_errors:
                status = "corrupt" if graph_errors[name] == "ontology_corrupt" else "unavailable"
                states.append({"document": name, "source_revision": source.revision, "status": status})
                continue
            try:
                graph = _query_snapshot(name, source, raw_graphs[name])
            except OntologyCorruptError:
                skip(name, "ontology_corrupt")
                states.append({"document": name, "source_revision": source.revision, "status": "corrupt"})
                continue
            states.append({key: graph[key] for key in (
                "document", "source_revision", "status", "indexed_revision", "needs_reextraction",
            ) if key in graph})
            if graph["status"] == "ready":
                ready[name] = graph
        states.extend({"document": name, "source_revision": None, "status": "unavailable"} for name in source_errors)
        candidates = []
        focus_graph = ready.get(document)
        if focus_graph is not None:
            focus_entities = {}
            for entity in focus_graph["entities"]:
                focus_entities.setdefault((entity["type"], _normalized_label(entity["label"])), []).append(entity)
            for name, graph in ready.items():
                if name == document:
                    continue
                for other in graph["entities"]:
                    for entity in focus_entities.get((other["type"], _normalized_label(other["label"])), ()):
                        if len(candidates) >= limit:
                            truncated = True
                            break
                        candidates.append({
                            "status": "candidate", "reason": "same_type_and_normalized_label",
                            "source_entity": {"document": document, "source_revision": focus_graph["source_revision"], **entity},
                            "target_entity": {"document": name, "source_revision": graph["source_revision"], **other},
                        })
                    if len(candidates) >= limit and truncated:
                        break
                if len(candidates) >= limit and truncated:
                    break
        result = {
            "document": document, "source_revision": focus.revision,
            "layer": "machine", "review_tool": "ontology_review_query",
            "explicit_links": explicit, "candidates": candidates,
            "ontology_states": states, "skipped": skipped,
            "truncated": truncated, "scanned": scanned,
        }
        return result, {"sources": snapshots, "raw_graphs": raw_graphs, "graphs": ready,
                        "graph_errors": graph_errors, "source_errors": source_errors,
                        "identities": identities, "scan_complete": scan_complete,
                        "scan_entries": scan_entries,
                        "captured_bytes": MAX_CONNECTION_BYTES - remaining[0]}

    def connections(self, document: str, limit: int = 20) -> dict:
        """Read machine links/candidates using the shared bounded snapshot."""
        with self.store._write_lock():
            result, _ = self._connections_snapshot_locked(document, limit)
        return result
