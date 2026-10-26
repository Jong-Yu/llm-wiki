"""주장에 쓰이는 작은 값과 한정어·관점·출처를 검증한다.

문자열의 인용 포함 여부만 확인하며 조건의 논리나 의미 정확도를 판정하지 않는다."""

from . import constants
from .errors import OntologyValidationError


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
    if not isinstance(value, str) or constants._ID_PATTERN.fullmatch(value) is None:
        raise OntologyValidationError(f"{name} must match [a-z][a-z0-9_-]{{0,63}}")
    return value


def _revision(value) -> str:
    if not isinstance(value, str) or constants._REVISION_PATTERN.fullmatch(value) is None:
        raise OntologyValidationError("expected_revision must be a 64-character lowercase SHA-256")
    return value


def _qualifiers(value, quote) -> dict:
    """Keep source restrictions as text; do not evaluate their logic."""
    _optional_fields(value, set(), set(constants._QUALIFIER_DEFAULTS), "qualifiers")
    normalized = {**constants._QUALIFIER_DEFAULTS, **value}
    for key, allowed in (("polarity", constants.POLARITIES), ("modality", constants.MODALITIES)):
        if not isinstance(normalized[key], str) or normalized[key] not in allowed:
            raise OntologyValidationError(f"qualifier {key} is not supported")
    for key in ("condition", "scope", "time"):
        if normalized[key] is not None:
            text = _text(normalized[key], constants.MAX_EVIDENCE_CHARACTERS, f"qualifier {key}")
            if quote is None or text not in quote:
                raise OntologyValidationError(f"qualifier {key} must occur verbatim in its relation evidence")
    return normalized


def _context(value, quote) -> dict:
    """Keep a literal domain and normalized viewpoint tags on one assertion."""
    _optional_fields(value, set(), constants._CONTEXT_FIELDS, "context")
    domain = value.get("domain")
    if domain is not None:
        domain = _text(domain, constants.MAX_EVIDENCE_CHARACTERS, "context domain")
        if quote is None or domain not in quote:
            raise OntologyValidationError("context domain must occur verbatim in its evidence")
    viewpoints = value.get("viewpoints", [])
    if (not isinstance(viewpoints, list) or len(viewpoints) > len(constants.VIEWPOINTS)
            or any(not isinstance(item, str) or item not in constants.VIEWPOINTS for item in viewpoints)
            or len(set(viewpoints)) != len(viewpoints)):
        raise OntologyValidationError("context viewpoints must be distinct supported tags")
    if quote is None and (domain is not None or viewpoints):
        raise OntologyValidationError("context requires evidence")
    return {"domain": domain, "viewpoints": list(viewpoints)}


def _context_key(value) -> tuple:
    return value["domain"], tuple(sorted(value["viewpoints"]))


def _provenance(value, quote, entity_types) -> dict:
    _optional_fields(value, set(), constants._PROVENANCE_FIELDS, "provenance")
    normalized = {key: value.get(key) for key in ("source_entity", "attributed_to", "basis")}
    for field, allowed in (("source_entity", {"document"}),
                           ("attributed_to", {"person", "organization", "system"})):
        identifier = normalized[field]
        if identifier is not None:
            _identifier(identifier, f"provenance {field}")
            if quote is None or entity_types.get(identifier) not in allowed:
                raise OntologyValidationError(f"provenance {field} requires evidence and an entity of the documented type")
    if normalized["basis"] is not None:
        basis = _text(normalized["basis"], constants.MAX_EVIDENCE_CHARACTERS, "provenance basis")
        if quote is None or basis not in quote:
            raise OntologyValidationError("provenance basis must occur verbatim in its evidence")
    return normalized


def _provenance_key(value) -> tuple:
    return tuple(value[field] for field in ("source_entity", "attributed_to", "basis"))
