"""Lossless initial-citation transport; offsets count Unicode code points.

Only literal quotes in a document passage in this same response can be referred
to. This representation changes neither model-visible evidence nor citation IDs.
The caller must authenticate/hash the wire response before decoding it.
"""

from copy import deepcopy
import re

from .json_codec import canonical_json_bytes


INITIAL_CITATION_ENCODING = "source-span-v1"
_SOURCE_ID = re.compile(r"s([1-9][0-9]{0,2}):([1-9][0-9]{0,6}):([1-9][0-9]{0,6})\Z")


def initial_citation_encoding(data):
    """The absent policy is legacy; present null/unknown policies are errors."""
    if "initial_citation_encoding" not in data:
        return None
    if data["initial_citation_encoding"] != INITIAL_CITATION_ENCODING:
        raise ValueError("Unknown frozen initial citation encoding")
    return INITIAL_CITATION_ENCODING


def _sources(response):
    sources = {}
    identifiers = set()
    for item in response["items"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid initial evidence item")
        identifier = item.get("item_id", item.get("evidence_id"))
        if not isinstance(identifier, str) or identifier in identifiers:
            raise ValueError("Initial evidence item IDs must be unique")
        identifiers.add(identifier)
        if item.get("kind") != "source" or "document" not in item:
            continue
        identifier = item.get("evidence_id")
        match = _SOURCE_ID.fullmatch(identifier) if isinstance(identifier, str) else None
        if (not match or item.get("material_id") != "d" + match[1]
                or type(item.get("start_line")) is not int or item["start_line"] != int(match[2])
                or type(item.get("end_line")) is not int or item["end_line"] != int(match[3])
                or item["end_line"] < item["start_line"] or not isinstance(item.get("text"), str)
                or not isinstance(item.get("document"), str) or not isinstance(item.get("source_revision"), str)
                or identifier in sources):
            raise ValueError("Invalid source passage for citation transport")
        sources[identifier] = item
    return sources


def expand_initial_citations(response, *, expected_encoding=None):
    """Decode only an explicitly negotiated format, never recursively follow refs.

    A negotiated task can retain the legacy wire form when it is smaller. The
    transport header is removed from the returned model view, not from receipts.
    """
    if expected_encoding not in (None, INITIAL_CITATION_ENCODING) or not isinstance(response, dict):
        raise ValueError("Unknown initial citation encoding")
    encoding = response.get("citation_encoding")
    citations = response.get("citations", [])
    if not isinstance(citations, list):
        raise ValueError("Invalid citation transport")
    if encoding is None:
        if "citation_encoding" in response or any(isinstance(row, dict) and isinstance(row.get("citation"), dict)
                and "quote_ref" in row["citation"] for row in citations):
            raise ValueError("Unnegotiated citation reference")
        return deepcopy(response)
    if (encoding != INITIAL_CITATION_ENCODING or expected_encoding != encoding
            or response.get("kind") != "question_evidence" or response.get("action") != "initial"
            or not isinstance(response.get("items"), list) or not isinstance(response.get("evidence_ids"), list)):
        raise ValueError("Unexpected initial citation transport")
    ids = response["evidence_ids"]
    if (any(not isinstance(value, str) for value in ids) or len(ids) != len(set(ids))
            or any(not isinstance(row, dict) or set(row) != {"evidence_id", "citation"}
                   or not isinstance(row["citation"], dict) for row in citations)
            or [row["evidence_id"] for row in citations] != ids):
        raise ValueError("Invalid transported citation IDs")
    sources = _sources(response)
    expanded = deepcopy(response)
    expanded.pop("citation_encoding")
    for row in expanded["citations"]:
        citation = row["citation"]
        if "quote_ref" not in citation:
            continue
        reference = citation.pop("quote_ref")
        if ("quote" in citation or citation.get("kind") not in {"document", "claim"}
                or not isinstance(reference, dict) or set(reference) != {"evidence_id", "start", "end"}
                or not isinstance(reference["evidence_id"], str)):
            raise ValueError("Invalid quote reference")
        source = sources.get(reference["evidence_id"])
        first, last = reference["start"], reference["end"]
        if (source is None or reference["evidence_id"] not in ids
                or source["document"] != citation.get("document")
                or source["source_revision"] != citation.get("source_revision")
                or type(first) is not int or type(last) is not int
                or not 0 <= first < last <= len(source["text"]) or last - first > 10000):
            raise ValueError("Quote reference is outside its exact source passage")
        citation["quote"] = source["text"][first:last]
    by_id = {row["evidence_id"]: row["citation"] for row in expanded["citations"]}
    for identifier, source in sources.items():
        if identifier not in by_id:
            raise ValueError("Referenced source has no retained citation")
        citation = by_id[identifier]
        if (citation.get("kind") != "document" or citation.get("document") != source["document"]
                or citation.get("source_revision") != source["source_revision"]
                or citation.get("quote") != source["text"]):
            raise ValueError("Source passage and its exact citation disagree")
    return expanded


def compact_initial_citations(response):
    """Use references only when the complete wire response becomes smaller."""
    original = expand_initial_citations(response)
    sources = _sources(original)
    candidate = deepcopy(original)
    candidate["citation_encoding"] = INITIAL_CITATION_ENCODING
    for row in candidate["citations"]:
        citation = row["citation"]
        quote = citation.get("quote")
        if citation.get("kind") not in {"document", "claim"} or not isinstance(quote, str) or not quote:
            continue
        for source in sources.values():
            if (source["document"] != citation.get("document")
                    or source["source_revision"] != citation.get("source_revision")):
                continue
            first = source["text"].find(quote)
            if first < 0:
                continue
            reference = {key: value for key, value in citation.items() if key != "quote"}
            reference["quote_ref"] = {"evidence_id": source["evidence_id"], "start": first, "end": first + len(quote)}
            if len(canonical_json_bytes(reference)) < len(canonical_json_bytes(citation)):
                row["citation"] = reference
                break
    if len(canonical_json_bytes(candidate)) >= len(canonical_json_bytes(original)):
        return original
    if expand_initial_citations(candidate, expected_encoding=INITIAL_CITATION_ENCODING) != original:
        raise ValueError("Citation transport must preserve the complete response")
    return candidate
