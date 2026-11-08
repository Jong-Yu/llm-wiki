"""고정된 질문 근거에서 필요한 연속 구절·현재 주장·검토 사건만 읽는다.

전체 basis는 호출자가 보존한다. 여기의 짧은 ID는 그 basis 안에서만 유효하며
새 개체 동일성·승인·부재를 확정하거나 원문·검토 원장을 변경하지 않는다.
"""

from copy import deepcopy
import re
import unicodedata

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.personal.web_evidence import WEB_SOURCE_FIELDS


MAX_RESPONSE_BYTES = 24 * 1024
MAX_QUOTE_CHARACTERS = 10000
MAX_PASSAGE_CHARACTERS = 3000
MAX_RESULTS = 20
MAX_READ_LINES = 100
RANKED_SEARCH_POLICY = "coverage-tiers-v1"
_MATERIAL = re.compile(r"([dow])([1-9][0-9]{0,2})\Z")
_SPAN = re.compile(r"([sow])([1-9][0-9]{0,2}):([1-9][0-9]{0,6}):([1-9][0-9]{0,6})\Z")
_RECORD = re.compile(r"([chp])([1-9][0-9]{0,2}):([1-9][0-9]{0,6})\Z")
_QUERY_KEYS = {"action", "query", "material_id", "start_line", "line_count", "offset", "limit"}


def _integer(value, name, default, minimum, maximum):
    """bool·실수를 위치나 개수로 조용히 변환하지 않는다."""
    value = default if value is None else value
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} is outside its allowed integer range")
    return value


def _fold(value):
    return unicodedata.normalize("NFKC", value).casefold()


def _terms(query):
    return list(dict.fromkeys(re.findall(r"[\w-]+", _fold(query))))


def _strings(value):
    """JSON 필드 이름이 아니라 실제 값에서 검색어를 발견한다."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _score(value, query):
    """서버 안의 문자열 발견이며 동의어·의미 관계를 추정하지 않는다."""
    if not query:
        return 1
    folded = _fold(value if isinstance(value, str) else "\n".join(_strings(value)))
    terms = _terms(query)
    return sum(1 for term in terms if term in folded) + (len(terms) if _fold(query) in folded else 0)


def _search_tiers(candidates, query, selected):
    """강한 일치·검색어별 첫 근거·바로 인접한 일치를 먼저 주고 나머지도 보존한다.

    원문을 요약하거나 AND로 거르지 않는다. 두 번째 군은 같은 검색의
    next_offset으로 전부 읽을 수 있고, 군 안의 기존 정렬은 유지한다.
    """
    terms = _terms(query)
    if len(terms) < 2 or not candidates:
        return candidates, None
    folded = [_fold(item["text"]) for item in candidates]
    matches = [{term for term in terms if term in text} for text in folded]
    maximum = max(map(len, matches))
    if maximum < 2:
        return candidates, None
    primary = {index for index, found in enumerate(matches) if len(found) == maximum}
    covered = set().union(*(matches[index] for index in primary))
    for term in terms:
        if term not in covered:
            first = next((index for index, found in enumerate(matches) if term in found), None)
            if first is not None:
                primary.add(first)
                covered.update(matches[first])
    # 최초 1군에서 한 단계만 넓힌다. 연쇄 확장으로 문서 전체를 붙이지 않는다.
    anchors = frozenset(primary)
    for identifier, material in selected:
        lines = _lines(material["content"])
        indices = sorted((index for index, item in enumerate(candidates)
                          if item["material_id"] == identifier), key=lambda index: candidates[index]["start_line"])
        for before, after in zip(indices, indices[1:]):
            if before not in anchors and after not in anchors:
                continue
            gap = lines[candidates[before]["end_line"]:candidates[after]["start_line"] - 1]
            if not any(line.strip() for line in gap):
                primary.update((before, after))
    if len(primary) == len(candidates):
        return candidates, None
    return ([item for index, item in enumerate(candidates) if index in primary]
            + [item for index, item in enumerate(candidates) if index not in primary], len(primary))


def _lines(content):
    """CR/LF만 줄 경계로 사용해 원문의 Unicode 구분자를 새 줄로 만들지 않는다."""
    if not isinstance(content, str):
        raise ValueError("Frozen material content must be text")
    starts = [0] + [match.end() for match in re.finditer(r"\r\n|\r|\n", content)]
    if starts[-1] == len(content):
        starts.pop()
    return [content[start:end] for start, end in zip(starts, [*starts[1:], len(content)])]


def _materials(basis):
    if not isinstance(basis, dict):
        raise ValueError("Select one frozen question basis")
    values = []
    for prefix, collection in (("d", basis.get("documents", [])), ("o", basis.get("originals", [])),
                               ("w", basis.get("web", {}).get("sources", []))):
        if not isinstance(collection, list):
            raise ValueError("Frozen material collections must be arrays")
        for index, value in enumerate(collection, 1):
            if not isinstance(value, dict) or not isinstance(value.get("content"), str):
                raise ValueError("A frozen material needs exact text")
            values.append((f"{prefix}{index}", value))
    return values


def _material(basis, identifier):
    if not isinstance(identifier, str) or _MATERIAL.fullmatch(identifier) is None:
        raise ValueError("Select a material ID from this frozen question")
    return next((value for key, value in _materials(basis) if key == identifier), None)


def _selected_materials(basis, identifier):
    values = _materials(basis)
    if identifier is None:
        return values
    if _MATERIAL.fullmatch(identifier) is None:
        raise ValueError("Invalid material ID")
    selected = [(key, value) for key, value in values if key == identifier]
    if not selected:
        raise ValueError("Material is outside this frozen question")
    return selected


def _span_quote(material, first, last):
    lines = _lines(material["content"])
    if not 1 <= first <= last <= len(lines) or last - first + 1 > MAX_READ_LINES:
        raise ValueError("Source line span is outside the frozen material")
    quote = "".join(lines[first - 1:last]).rstrip("\r\n")
    if not 1 <= len(quote) <= MAX_QUOTE_CHARACTERS:
        raise ValueError("Source quote is empty or exceeds the citation limit")
    return quote


def _span_citation(basis, prefix, index, first, last):
    material = _material(basis, ("d" if prefix == "s" else prefix) + str(index))
    if material is None:
        raise ValueError("Citation material is outside the frozen question")
    quote = _span_quote(material, first, last)
    if prefix == "s":
        return {"kind": "document", "document": material["document"],
                "source_revision": material["source_revision"], "quote": quote}
    if prefix == "o":
        return {"kind": "source", **{key: material["source_ref"][key]
                for key in ("source_id", "source_version", "source_sha256")}, "quote": quote}
    return {"kind": "web", **{key: material[key] for key in WEB_SOURCE_FIELDS}, "quote": quote}


def _record_citation(basis, prefix, document_index, record_index):
    source = _material(basis, "d" + str(document_index))
    if source is None:
        raise ValueError("Citation document is outside the frozen question")
    knowledge = source["knowledge"]
    collection = {"c": "claims", "h": "history", "p": "policies"}[prefix]
    values = _events(knowledge) if prefix == "h" else knowledge.get(collection, [])
    if not 1 <= record_index <= len(values):
        raise ValueError("Citation record is outside the frozen question")
    record = values[record_index - 1]
    common = {"document": source["document"], "state_revision": knowledge["state_revision"]}
    if prefix == "h":
        ledger, record = record
        if not isinstance(record.get("id"), str) or not record["id"]:
            raise ValueError("Review event has no retained identifier")
        return {"kind": "review", **common, "ledger": ledger, "event_id": record["id"]}
    if prefix == "p":
        events = {event["id"] for event in knowledge.get("history", [])
                  if event.get("action") in {"policy", "policy_undo"}}
        event_id = next((event for event in (record.get("decision_event_id"), record.get("event_id"))
                         if event in events), None)
        if record.get("status") != "active" or event_id not in events:
            raise ValueError("Policy has no active frozen Action log basis")
        return {"kind": "policy", **common, "event_id": event_id}
    evidence = record.get("value", {}).get("evidence")
    quote = evidence.get("quote") if isinstance(evidence, dict) else None
    if (not isinstance(quote, str) or not 1 <= len(quote) <= MAX_QUOTE_CHARACTERS
            or quote not in source["content"]):
        raise ValueError("Claim has no exact frozen source quote")
    return {"kind": "claim", **common, "source_revision": source["source_revision"],
            "graph_revision": knowledge["graph_revision"], "claim_id": record["claim_id"], "quote": quote}


def resolve_evidence_ids(basis, identifiers):
    """실제로 제공한 ID인지의 검사는 호출자가 하고 여기서는 정확한 고정 참조를 복원한다."""
    if (not isinstance(identifiers, list) or len(identifiers) > 100
            or any(not isinstance(item, str) or len(item) > 64 for item in identifiers)
            or len(set(identifiers)) != len(identifiers)):
        raise ValueError("Select at most 100 unique evidence IDs")
    citations = []
    for identifier in identifiers:
        match = _SPAN.fullmatch(identifier)
        if match:
            prefix, index, first, last = match.groups()
            citation = _span_citation(basis, prefix, int(index), int(first), int(last))
        else:
            match = _RECORD.fullmatch(identifier)
            if match is None:
                raise ValueError("Invalid evidence ID")
            prefix, index, record = match.groups()
            citation = _record_citation(basis, prefix, int(index), int(record))
        citations.append(citation)
    return citations


def _span_item(identifier, material, first, last, *, context_limited=False, lines=None):
    lines = _lines(material["content"]) if lines is None else lines
    prefix = "s" if identifier.startswith("d") else identifier[0]
    evidence_id = f"{prefix}{identifier[1:]}:{first}:{last}"
    item = {"kind": "source", "material_id": identifier, "evidence_id": evidence_id,
            "start_line": first, "end_line": last, "text": "".join(lines[first - 1:last]).rstrip("\r\n"),
            "context_limited": context_limited, "material_line_count": len(lines)}
    if identifier.startswith("d"):
        item.update(document=material["document"], source_revision=material["source_revision"])
    elif identifier.startswith("w"):
        item.update(title=material["title"], url=material["url"], origin="client_reported",
                    retrieval_verification="not_independently_verified")
    else:
        item.update(source_ref=deepcopy(material["source_ref"]))
        if material.get("conversion"):
            conversion = material["conversion"]
            item.update(origin="client_reported", original_coverage="not_verified",
                        conversion_ref=deepcopy(conversion["conversion_ref"]),
                        conversion_method=conversion["manifest"]["method"])
    return item


def _passages(identifier, material, first, last):
    """선택 범위를 온전한 줄 단위로 나눈다. 긴 줄은 줄이지 않고 한계를 남긴다."""
    lines = _lines(material["content"])
    items, skipped = [], []
    cursor = first
    while cursor <= last:
        if not lines[cursor - 1].strip():
            cursor += 1
            continue
        if len(lines[cursor - 1].rstrip("\r\n")) > MAX_QUOTE_CHARACTERS:
            skipped.append({"material_id": identifier, "start_line": cursor, "end_line": cursor,
                            "code": "source_line_quote_limit"})
            cursor += 1
            continue
        end = cursor
        length = len(lines[cursor - 1])
        while end < last and end - cursor + 1 < MAX_READ_LINES:
            following = lines[end]
            if not following.strip() or length + len(following) > MAX_PASSAGE_CHARACTERS:
                break
            length += len(following)
            end += 1
        limited = ((cursor > 1 and bool(lines[cursor - 2].strip()))
                   or (end < len(lines) and bool(lines[end].strip())))
        items.append(_span_item(identifier, material, cursor, end, context_limited=limited, lines=lines))
        cursor = end + 1
    return items, skipped


def _source_ranges(items):
    """이미 제공되었거나 남은 단락의 실제 줄 구간만 인접할 때 합친다."""
    ranges = []
    for item in sorted(items, key=lambda value: (value["start_line"], value["end_line"])):
        first, last = item["start_line"], item["end_line"]
        if ranges and first <= ranges[-1][1] + 1:
            ranges[-1][1] = max(ranges[-1][1], last)
        else:
            ranges.append([first, last])
    return ranges


def _read_window(identifier, first, count, total_lines, candidates, cursor, items, skipped):
    """단락 offset과 원문 줄 좌표를 구분하고 미독 다음 줄을 추측하지 않게 한다.

    remaining_ranges는 이번 페이지 뒤의 후보만 뜻한다. 요청 offset 앞의
    단락을 읽었다고 추정하거나 remaining에 다시 넣지 않는다. next_offset은
    같은 요청 창의 단락 번호이고 next_start_line은 새 read에 쓸 원문 줄이다.
    """
    last = min(total_lines, first + count - 1)
    remaining = candidates[cursor:]
    unavailable = [item for item in skipped if item.get("material_id") == identifier
                   and "start_line" in item and "end_line" in item]
    return {"material_id": identifier, "requested_range": [first, first + count - 1],
            "available_range": [first, last] if first <= last else None, "total_lines": total_lines,
            "returned_ranges": _source_ranges(items), "remaining_ranges": _source_ranges(remaining),
            "unavailable_ranges": _source_ranges(unavailable),
            "next_start_line": (remaining[0]["start_line"] if remaining else
                                last + 1 if last < total_lines else None)}


def _entity_context(knowledge, value):
    wanted = {value[key] for key in ("subject", "object") if isinstance(value.get(key), str)}
    provenance = value.get("provenance") or {}
    wanted.update(v for v in provenance.values() if isinstance(v, str))
    graph = knowledge.get("effective_graph", {})
    entities = {e["id"]: e for e in knowledge.get("machine_graph", {}).get("entities", [])}
    entities.update({e["id"]: e for e in graph.get("entities", [])})
    return [{key: deepcopy(entity[key]) for key in ("id", "type", "label", "context", "identifiers") if key in entity}
            for key, entity in entities.items() if key in wanted]


def _claim_items(identifier, material):
    knowledge, items = material["knowledge"], []
    events = {event["id"]: index for index, event in enumerate(knowledge.get("history", []), 1)}
    for index, claim in enumerate(knowledge.get("claims", []), 1):
        value = claim.get("value", {})
        item = {"kind": "claim", "material_id": identifier, "item_id": f"c{identifier[1:]}:{index}",
            "claim_id": claim["claim_id"], "collection": claim.get("collection"),
            "decision": claim.get("decision", "unreviewed"), "needs_review": claim.get("needs_review", True),
            "source_value": deepcopy(value), "entities": _entity_context(knowledge, value),
            "source_revision": material["source_revision"], "state_revision": knowledge["state_revision"]}
        if claim.get("reviewed_value") != value:
            item["reviewed_value"] = deepcopy(claim.get("reviewed_value"))
        for key in ("source_decision", "source_reviewed_value"):
            if key in claim:
                item[key] = deepcopy(claim[key])
        if claim.get("review_event_id") in events:
            item["review_evidence_id"] = f"h{identifier[1:]}:{events[claim['review_event_id']]}"
        item["origin"] = ("expert_policy" if claim.get("authored_kind") == "policy" or claim.get("policy_event_id") or claim.get("latest_policy_event_id")
                          else "independent_relation" if claim.get("authored_event_id")
                          else "source_review" if claim.get("review_event_id") else "machine")
        items.append(item)
    for index, policy in enumerate(knowledge.get("policies", []), 1):
        items.append({"kind": "policy", "material_id": identifier, "item_id": f"p{identifier[1:]}:{index}",
                      "value": deepcopy(policy), "state_revision": knowledge["state_revision"],
                      "applicability_not_automatically_proven": True})
    relation_events = {event["id"]: index for index, event in enumerate(knowledge.get("relation_history", []), 1)}
    history_length = len(knowledge.get("history", []))
    for index, relation in enumerate(knowledge.get("authored_relations", []), 1):
        value = relation.get("value", {})
        item = {"kind": "authored_relation", "material_id": identifier, "item_id": f"a{identifier[1:]}:{index}",
                "value": deepcopy(relation), "entities": _entity_context(knowledge, value),
                "origin": "independent_relation", "state_revision": knowledge["state_revision"],
                "applicability_not_automatically_proven": relation.get("kind") == "policy"}
        if relation.get("event_id") in relation_events:
            item["evidence_id"] = f"h{identifier[1:]}:{history_length + relation_events[relation['event_id']]}"
        items.append(item)
    return items


def _events(knowledge):
    """이벤트 ID가 우연히 같아도 검토 원장과 독립 관계 원장을 섞지 않는다."""
    return [("review", event) for event in knowledge.get("history", [])] + [
            ("relation", event) for event in knowledge.get("relation_history", [])]


def _history_items(identifier, material):
    knowledge = material["knowledge"]
    current = {("review", claim.get("review_event_id")) for claim in knowledge.get("claims", [])}
    current.update(("review", event) for policy in knowledge.get("policies", []) if policy.get("status") == "active"
                   for event in (policy.get("event_id"), policy.get("decision_event_id")))
    current.update(("relation", relation.get("event_id")) for relation in knowledge.get("authored_relations", [])
                   if relation.get("status") == "active")
    pending = {("review", event) for event in knowledge.get("current_pending_history", knowledge.get("pending_history", []))}
    pending.update(("relation", relation.get("event_id")) for relation in knowledge.get("authored_relations", [])
                   if relation.get("status") == "pending")
    inactive = {relation.get("event_id") for relation in knowledge.get("authored_relations", [])
                if relation.get("status") == "inactive"}
    current.update(("relation", event["id"]) for event in knowledge.get("relation_history", [])
                   if event.get("action") == "relation_undo" and event.get("undo_of") in inactive)
    return [{"kind": "review", "material_id": identifier, "item_id": f"h{identifier[1:]}:{index}",
             "ledger": ledger,
             "event": {key: deepcopy(event[key]) for key in ("id", "action", "collection", "claim_id", "timestamp",
                 "reason", "actor", "before", "after", "source_revision", "graph_revision", "undo_of", "kind", "scope", "value") if key in event},
             "is_current_judgment": (ledger, event["id"]) in current, "pending": (ledger, event["id"]) in pending,
             "state_revision": knowledge["state_revision"]}
            for index, (ledger, event) in enumerate(_events(knowledge), 1)]


def read_evidence(basis, query, *, ranked_search=False):
    """검색·원문 범위·현재 주장·검토 이력을 고정 근거 안에서만 제한해 제공한다."""
    if type(ranked_search) is not bool:
        raise ValueError("ranked_search must be a boolean")
    if not isinstance(query, dict) or set(query) - _QUERY_KEYS:
        raise ValueError("Invalid evidence query fields")
    action = query.get("action")
    if not isinstance(action, str) or action not in {"search", "read", "claims", "history"}:
        raise ValueError("Unknown evidence action")
    text = "" if query.get("query") is None else query["query"]
    if not isinstance(text, str) or len(text) > 200:
        raise ValueError("Evidence query must be at most 200 characters")
    identifier = query.get("material_id")
    if identifier is not None and not isinstance(identifier, str):
        raise ValueError("Invalid material ID")
    if action != "search" and identifier is None:
        raise ValueError("This evidence action needs a material ID")
    selected = _selected_materials(basis, identifier)
    if action in {"claims", "history"} and not identifier.startswith("d"):
        raise ValueError("Claims and history belong to Wiki documents")
    offset = _integer(query.get("offset"), "offset", 0, 0, 1000000)
    limit = _integer(query.get("limit"), "limit", 5, 1, MAX_RESULTS)
    candidates, skipped, window = [], [], None
    for material_id, material in selected:
        if action in {"search", "read"}:
            lines = _lines(material["content"])
            first = _integer(query.get("start_line"), "start_line", 1, 1, max(1, len(lines))) if action == "read" else 1
            count = _integer(query.get("line_count"), "line_count", 60, 1, MAX_READ_LINES) if action == "read" else len(lines)
            if action == "read":
                window = (material_id, first, count, len(lines))
            passages, omissions = _passages(material_id, material, first, min(len(lines), first + count - 1))
            skipped.extend(omissions)
            candidates.extend(item for item in passages if action == "read" or _score(item["text"], text))
        else:
            values = _claim_items(material_id, material) if action == "claims" else _history_items(material_id, material)
            candidates.extend(item for item in values if _score(item, text))
    tier_boundary = None
    if action == "search" and text:
        candidates.sort(key=lambda item: -_score(item["text"], text))
        if ranked_search:
            candidates, tier_boundary = _search_tiers(candidates, text, selected)
    if offset > len(candidates):
        raise ValueError("Evidence page offset is outside the query result")
    result = {"kind": "question_evidence", "action": action, "items": [], "evidence_ids": [], "citations": [],
        "scope": {"coverage": "query_result_only", "material_ids": [key for key, _ in selected],
                  "completion_scope": ("matching_passages" if action == "search" else
                                       "requested_source_window" if action == "read" else "matching_records"),
                  "basis_snapshot_revision": basis.get("snapshot_revision"), "query": text,
                  "basis_complete": bool(basis.get("complete", False)), "absence_proven": False,
                  "knowledge_status": {key: value["knowledge"].get("status", "unavailable")
                                       for key, value in selected if key.startswith("d")}},
        "total_matches": len(candidates), "complete": False, "truncated": False,
        "skipped": skipped, "next_offset": None}
    cursor = offset
    if window is not None:
        result["read_window"] = _read_window(*window, candidates, cursor, result["items"], skipped)
    while cursor < len(candidates) and len(result["items"]) < limit:
        if cursor == tier_boundary and result["items"]:
            break
        item = deepcopy(candidates[cursor])
        evidence_id = item.get("evidence_id", item.get("item_id"))
        try:
            citation = resolve_evidence_ids(basis, [evidence_id])[0]
        except ValueError:
            citation = None
            item["citation_status"] = "no_exact_source_or_applicable_event"
        if citation is not None:
            item["evidence_id"] = evidence_id
        candidate = deepcopy(result)
        candidate["items"].append(item)
        if citation is not None:
            candidate["evidence_ids"].append(evidence_id)
            candidate["citations"].append({"evidence_id": evidence_id, "citation": citation})
        if window is not None:
            candidate["read_window"] = _read_window(*window, candidates, cursor + 1, candidate["items"], skipped)
        if len(canonical_json_bytes(candidate)) > MAX_RESPONSE_BYTES - 512:
            if result["items"]:
                break
            omission = {"item_id": evidence_id, "code": "evidence_item_limit"}
            if item["kind"] == "source":
                omission.update({key: item[key] for key in ("material_id", "start_line", "end_line")})
            skipped.append(omission)
            cursor += 1
            continue
        result = candidate
        cursor += 1
    result["skipped"] = skipped
    more = cursor < len(candidates)
    result.update(next_offset=cursor if more else None, truncated=more or bool(skipped),
                  complete=not more and not skipped and bool(basis.get("complete", False)))
    if window is not None:
        result["read_window"] = _read_window(*window, candidates, cursor, result["items"], skipped)
    if len(canonical_json_bytes(result)) > MAX_RESPONSE_BYTES:
        raise ValueError("Evidence result metadata exceeds its byte limit")
    return result


def initial_evidence(basis, question):
    """고정 근거의 관계·판단·원문을 묶어 첫 호출에 제공한다. 모델은 호출하지 않는다."""
    from .question_index import folded, mentions, terms, searchable, without_evidence
    from collections import defaultdict

    wanted = terms(question)
    groups = {}
    omissions = []
    scanned = 0
    # 문서8개/고정 근거 크기 외에도 초기 조립 항목 수를 제한한다.
    max_records = 10000
    for material_id, material in _materials(basis):
        if not material_id.startswith("d"):
            continue
        knowledge = material["knowledge"]
        entities = {e["id"]: e for e in knowledge.get("machine_graph", {}).get("entities", [])}
        entities.update({e["id"]: e for e in (knowledge.get("effective_graph") or {}).get("entities", [])})
        matched = {key for key, value in entities.items()
                   if mentions(value["label"], question)
                   or any(mentions(i["value"], question) for i in value.get("identifiers", []))}
        history = _history_items(material_id, material)
        histories = {h["event"]["id"]: h for h in history}
        records = _claim_items(material_id, material)
        claim_values = {i["claim_id"]: i["source_value"] for i in records if i["kind"] == "claim"}
        local = defaultdict(list)
        local_scores = defaultdict(int)
        for item in records:
            scanned += 1
            if scanned > max_records:
                break
            value = item.get("source_value", item.get("value", {}).get("value", {}))
            if value is None and item["kind"] == "policy":
                # 철회 정책에는 현재 값이 없지만 대상 주장에 연결된 inactive 상태를 보존한다.
                value = claim_values.get(item["value"]["claim_id"], {})
            reviewed = item.get("reviewed_value") or value
            if not isinstance(value, dict):
                continue
            endpoints = {v for v in (value.get("subject"), value.get("object"), reviewed.get("subject"), reviewed.get("object"))
                         if isinstance(v, str)}
            if not endpoints:
                continue
            labels = tuple(sorted(folded(entities[e]["label"]) if e in entities else e for e in endpoints))
            # 동일 표면 이름은 함께 포장하되 문서별 ID/맥락은 유지하며 동일성으로 승격하지 않는다.
            key = ("relation", labels) if "object" in value else ("attribute", labels, value.get("property"))
            local[key].append(item)
            score = 10 * len(endpoints & matched) + len(wanted & terms(searchable(item)))
            local_scores[key] = max(local_scores[key], score)
        for key, items in local.items():
            if not local_scores[key]:
                continue
            group = groups.setdefault(key, {"items": [], "score": 0})
            group["score"] = max(group["score"], local_scores[key])
            for raw in items:
                item = without_evidence(raw)
                claim_id = raw.get("claim_id", raw.get("value", {}).get("claim_id"))
                if claim_id in knowledge.get("cleanup", {}).get("archived_claim_ids", []):
                    item["archived"] = True
                item["source_evidence_ids"] = []
                values = [raw.get("source_value"), raw.get("reviewed_value"), raw.get("value", {}).get("value")]
                for value in values:
                    evidence = value.get("evidence") if isinstance(value, dict) else None
                    quote = evidence.get("quote") if isinstance(evidence, dict) else None
                    if not quote or quote not in material["content"]:
                        continue
                    offset = material["content"].find(quote)
                    first = len(_lines(material["content"][:offset])) + (0 if offset and material["content"][offset - 1] not in "\r\n" else 1)
                    last = first + len(_lines(quote)) - 1
                    try:
                        passage = _span_item(material_id, material, first, last)
                        # 같은 인용문이 여러 번 등장해도 실제 제공한 전체파일 위치만 사용한다.
                        _span_quote(material, first, last)
                    except ValueError:
                        omissions.append({"material_id": material_id, "code": "initial_quote_limit"})
                        continue
                    group["items"].append(passage)
                    item["source_evidence_ids"].append(passage["evidence_id"])
                group["items"].append(item)
                for h in history:
                    if h["event"].get("claim_id") != claim_id:
                        continue
                    event_id = h["event"]["id"]
                    relevant = (event_id == raw.get("value", {}).get("event_id")
                                or h["item_id"] == raw.get("review_evidence_id")
                                or h["is_current_judgment"] or h["pending"]
                                or h["event"].get("action") in {"policy_undo", "relation_undo"})
                    if relevant:
                        group["items"].append(without_evidence(h))
                # 적용 정책의 실제 Action log도 함께 제공한다.
                for event_id in (raw.get("value", {}).get("event_id"), raw.get("value", {}).get("decision_event_id")):
                    if event_id in histories:
                        group["items"].append(without_evidence(histories[event_id]))
        if scanned > max_records:
            omissions.append({"material_id": material_id, "code": "initial_record_limit"})
            break

    # 추출되지 않은 자료와 정의/설명도 원문 단락에서 찾는다. 이 검색은 의미상 완전성을 증명하지 않는다.
    for material_id, material in _materials(basis):
        lines = _lines(material["content"])
        passages, skipped = _passages(material_id, material, 1, len(lines))
        omissions.extend({"material_id": material_id, **s} for s in skipped[:4])
        ranked = sorted(((len(wanted & terms(p["text"])), p) for p in passages), key=lambda row: -row[0])
        for score, passage in ranked[:2]:
            if score:
                groups[("passage", material_id, passage["start_line"])] = {"items": [passage], "score": score}

    result = {"kind": "question_evidence", "action": "initial", "items": [], "evidence_ids": [], "citations": [],
        "scope": {"coverage": "matching_groups_in_frozen_basis", "absence_proven": False,
                  "basis_snapshot_revision": basis["snapshot_revision"],
                  "retrieval": {k: deepcopy(v) for k, v in basis.get("retrieval", {"coverage": "explicit_selection_only"}).items()
                                if k != "selected_documents"},
                  "identity": "document_local_no_automatic_merge", "semantic_completeness": "not_proven"},
        "total_matches": len(groups), "complete": False, "truncated": False, "skipped": [],
        "next_offset": None, "scanned_records": min(scanned, max_records)}
    seen = set()
    ordered = sorted(groups.items(), key=lambda entry: (-entry[1]["score"], str(entry[0])))
    for number, (key, group) in enumerate(ordered):
        if number >= 64:
            omissions.append({"code": "initial_group_count_limit"})
            break
        candidate = deepcopy(result)
        pending = set()
        for item in group["items"]:
            identifier = item.get("evidence_id", item.get("item_id"))
            item_key = item.get("item_id", identifier)
            if item_key in seen or item_key in pending:
                continue
            pending.add(item_key)
            item = deepcopy(item)
            try:
                citation = resolve_evidence_ids(basis, [identifier])[0]
            except ValueError:
                citation = None
                item["citation_status"] = "no_exact_source_or_applicable_event"
            if citation is not None and identifier not in candidate["evidence_ids"]:
                item["evidence_id"] = identifier
                candidate["evidence_ids"].append(identifier)
                candidate["citations"].append({"evidence_id": identifier, "citation": citation})
            candidate["items"].append(item)
        if len(canonical_json_bytes(candidate)) > MAX_RESPONSE_BYTES - 4096:
            omissions.append({"code": "initial_group_byte_limit", "group": canonical_json_hash(key),
                              "material_ids": sorted({i["material_id"] for i in group["items"]})})
            continue
        result, seen = candidate, seen | pending
    # 결과를 작게 유지하되 누락 건수와 추가 조회 경로를 숨기지 않는다.
    result["skipped"] = omissions[:12]
    result["omitted_count"] = len(omissions)
    retrieval = basis.get("retrieval", {})
    limited = bool(omissions) or not retrieval.get("complete", True)
    result.update(truncated=limited, complete=not limited and bool(basis.get("complete")))
    result["scope"]["follow_up"] = "Use claims/history/read on the frozen materials; prepare a new scope for outside documents."
    if len(canonical_json_bytes(result)) > MAX_RESPONSE_BYTES:
        raise ValueError("Initial evidence metadata exceeds its byte limit")
    return result
