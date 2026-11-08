"""선택한 개체의 원문 문맥과 현재 주장을 저장 없이 묶는다.

등장 구절은 정의문이 아니며, effective의 미검토 주장도 판단 상태를 보존한다.
일반 질문 문맥이나 저장된 개체·주장에는 이 투영을 추가하지 않는다.
"""

from bisect import bisect_right
from collections import defaultdict
from copy import deepcopy
import re

from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import CatalogChangedError
from .ontology_exploration import _ref
from .schema import ConceptValidationError, documents, text, token
from .values import _display_collection


MAX_PASSAGE_CHARACTERS = 4000


def _source_passage(entry, entity):
    evidence = entity.get("evidence")
    if evidence is None:
        return None, "no_source_evidence"
    source = entry["source"]
    content, body = source["content"], source["body"]
    starts = [0] + [match.end() for match in re.finditer(r"\r\n|\r|\n", content)]
    body_offset = len(content) - len(body)
    body_start_line = bisect_right(starts, body_offset)
    quote = evidence["quote"]
    first, last = evidence["start_line"], evidence["end_line"]
    if not quote or first < body_start_line or not 1 <= first <= last <= len(starts):
        raise CatalogChangedError()
    offset = content.find(quote, max(starts[first - 1], body_offset))
    if (offset < 0 or bisect_right(starts, offset) != first
            or bisect_right(starts, offset + len(quote) - 1) != last):
        raise CatalogChangedError()
    # 추출기와 같은 CR/LF 경계만 사용해 Unicode 구분자를 새 행으로 오인하지 않는다.
    lines = [content[start:end] for start, end in zip(starts, [*starts[1:], len(content)])]
    left, right = first - 1, last
    lower = body_start_line - 1
    while left > lower and lines[left - 1].strip():
        left -= 1
    while right < len(lines) and lines[right].strip():
        right += 1
    # 제목만 선택된 경우 이어지는 문단도 원문 그대로 보여 준다.
    block = "".join(lines[left:right]).strip()
    if "\n" not in block and "\r" not in block and re.match(r"^#{1,6}\s+", block):
        following = right
        while following < len(lines) and not lines[following].strip():
            following += 1
        if following < len(lines):
            right = following + 1
            while right < len(lines) and lines[right].strip():
                right += 1
    passage = "".join(lines[left:right]).rstrip("\r\n")
    if len(passage) > MAX_PASSAGE_CHARACTERS:
        return {**deepcopy(evidence), "source_revision": entry["source_revision"]}, "limited"
    return {"quote": passage, "start_line": left + 1,
            "end_line": bisect_right(starts, starts[left] + len(passage) - 1),
            "source_revision": entry["source_revision"]}, "available"


def _claim(owner, entry, claim, collection, value):
    origin = ("policy" if claim.get("authored_kind") == "policy" or claim.get("policy_event_id")
              or claim.get("latest_policy_event_id") else "independent" if claim.get("authored_event_id")
              else "reviewed" if claim.get("review_event_id") else "machine")
    provenance = owner._claim_provenance(entry, claim)
    if claim.get("authored_event_id"):
        provenance["authored_event_id"] = claim["authored_event_id"]
    if origin == "policy":
        provenance["policy_scope"] = {key: owner.actor[key] for key in ("domain", "viewpoint")}
    return {"claim_id": claim["claim_id"], "collection": collection,
            "original_collection": claim.get("original_collection", claim["collection"]),
            "origin": origin, "decision": claim["decision"], "value": deepcopy(value),
            "provenance": provenance}


def glossary(owner, document, entity_id, expected_state_revision, *, limit=10):
    """문서와 현재 판본을 고정해 정확한 개체 하나의 읽기 전용 카드를 만든다."""
    documents([document], owner.store)
    text(entity_id, "entity_id", 4096)
    token(expected_state_revision, "expected_state_revision")
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ConceptValidationError("limit must be an integer from 1 to 20")
    with owner.store._write_lock():
        capture = owner._capture("query", None, None, None)
        entry = capture.document(document, purpose="glossary", required_by=["glossary"], root=True, full=True)
        if (not entry["complete"] or entry["state_revision"] != expected_state_revision
                or _ref(entry)["status"] != "ready"):
            raise CatalogChangedError()
        graph = entry["effective_graph"]
        entity = next((item for item in graph["entities"] if item["id"] == entity_id), None)
        if entity is None:
            raise ConceptValidationError("The selected ontology entity is unavailable; select a current entity")
        passage, passage_status = _source_passage(entry, entity)
        claims = defaultdict(list)
        for claim in entry["claims"]:
            value = claim.get("reviewed_value")
            if value is not None and claim["decision"] not in {"reject", "defer"}:
                claims[(_display_collection(claim), canonical_json_hash(value))].append(claim)
        selected = {"attributes": [], "relations": []}
        totals = {"attributes": 0, "relations": 0}
        for collection in ("attributes", "relations", "relation_candidates"):
            for value in graph[collection]:
                if entity_id != value.get("subject") and (collection == "attributes" or entity_id != value.get("object")):
                    continue
                matched = claims[(collection, canonical_json_hash(value))]
                if not matched:
                    # 유효값을 원래 판단과 연결할 수 없으면 승인·출처를 추측하지 않는다.
                    raise CatalogChangedError()
                bucket = "attributes" if collection == "attributes" else "relations"
                claim = matched.pop(0)
                totals[bucket] += 1
                if len(selected[bucket]) < limit:
                    selected[bucket].append(_claim(owner, entry, claim, collection, value))
        truncated = capture.truncated or passage_status == "limited" or any(total > limit for total in totals.values())
        skipped = [{"document": document, "code": item["reason"]} for item in capture.skipped]
        if passage_status == "limited":
            skipped.append({"document": document, "code": "source_context_limit"})
        return {"document": _ref(entry), "entity": deepcopy(entity), "source_passage": passage,
                "source_passage_status": passage_status,
                **selected, "totals": totals,
                "coverage": {"complete": not skipped and not truncated, "truncated": truncated, "skipped": skipped}}
