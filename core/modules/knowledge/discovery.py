"""원문·기계 주장·판단·대응의 문자열 발견을 제한된 범위에서 조립한다."""

# find는 문자열이 원문/개체/주장/대응의 어느 필드에 있었는지 출처와 함께 찾는다.
# 검색에 걸렸다는 사실과 현재 사실로 선택할 수 있는지는 별도로 표시한다. 과거 판단도 현재 판단으로 둔갑시키지 않는다.

from core.common.json_codec import canonical_json_hash as _hash
from core.modules.reviews.state import _is_policy
from .values import _latest
from .values import _normalized
from core.modules.reviews.state import _policy_key
from .values import _strings
from .values import _value_selector
from . import contracts
from copy import deepcopy
from . import schema


def _document_matches(self, entry, needle, include_history, omissions=None):
    document = entry["document"]
    source = entry.get("source")
    if source:
        for index, line in enumerate(source.get("body", source["content"]).splitlines(), source.get("body_start_line", 1)):
            if needle not in _normalized(line) and needle not in _normalized(document):
                continue
            if not line:
                continue
            # Whole short lines retain all qualifiers. For a long line,
            # keep a bounded real substring around the normalized match.
            quote = line
            if len(quote) > 1000:
                found = _normalized(line).find(needle)
                # Normalize whole prefixes: per-character normalization
                # loses combining sequences (A + ring -> Å) and Hangul
                # composition. Locate the containing source character by
                # normalized-prefix length, retaining surrounding text.
                low, high = 0, len(line)
                while low < high:
                    middle = (low + high) // 2
                    if len(_normalized(line[:middle])) > found:
                        high = middle
                    else:
                        low = middle + 1
                start = max(0, low - 1) if found >= 0 else 0
                quote = line[max(0, start - 100):max(0, start - 100) + 1000]
                if found >= 0 and needle not in _normalized(quote):
                    if omissions is not None:
                        omissions.append({"document": document, "component": "source", "phase": "output", "reason": "match_exceeds_anchor_limit", "required_by": ["find"]})
                    continue
            anchor = {"document": document, "source_revision": entry["source_revision"], "quote": quote, "start_line": index, "end_line": index, "occurrence": 0}
            ref = {"kind": "anchor", "anchor": anchor, "observation": {"source_revision": entry["source_revision"], "history_revision": entry.get("history_revision")}}
            yield self._match(entry, ref, "source", "document" if needle in _normalized(document) else "source.content", line,
                              current=entry.get("history_revision") is not None,
                              currentness="current" if entry.get("history_revision") is not None else "unavailable",
                              provenance={"kind": "source", "document": document, "source_revision": entry["source_revision"], "quote": quote, "start_line": index, "end_line": index})
    if entry.get("state_revision") is None:
        return
    machine = entry.get("machine_graph") or {}
    if machine.get("status") == "ready":
        for layer, graph in (("machine", machine), ("reviewed", entry.get("effective_graph") or {})):
            for entity in graph.get("entities", []):
                # Expert entities are emitted with their real policy origin.
                if entity not in machine.get("entities", []):
                    continue
                ref = {**self._base_ref(entry, "entity", layer, entity), "entity_id": entity["id"]}
                for field in ("label", "id"):
                    if needle in _normalized(entity.get(field, "")):
                        yield self._match(entry, ref, layer, f"entities.{field}", entity[field], provenance={"kind": "source_extraction", **self._tokens(entry)})
            for claim in entry.get("claims", []):
                if layer == "reviewed" and claim.get("decision") in {"reject", "defer", "policy"}:
                    continue
                value = claim["value"] if layer == "machine" else claim.get("reviewed_value")
                if value is None:
                    continue
                for field, string in _strings(value):
                    if needle not in _normalized(string):
                        continue
                    selector = _value_selector(claim["collection"], value, field)
                    ref = self._claim_ref(entry, claim, layer, value, selector=selector)
                    yield self._match(entry, ref, layer, f"{claim['collection']}.{field}", string,
                                      review_status=claim.get("decision", "unreviewed"), provenance=self._claim_provenance(entry, claim))
    events = [event for event in entry.get("history", []) if _is_policy(event)]
    current = _latest(events, _policy_key)
    for event in events:
        latest = current[_policy_key(event)]
        historical = event["id"] != latest["id"]
        if historical and not include_history:
            continue
        value = event["after"].get("value")
        if value is None:
            continue
        origin = self._origin(entry, event, latest)
        status = self._policy_status(entry, event, latest)
        claim = {"claim_id": event["claim_id"], "collection": event["collection"]}
        for field, string in _strings(value):
            if needle in _normalized(string):
                selector = _value_selector(event["collection"], value, field)
                ref = self._claim_ref(entry, claim, "reviewed", value, selector=selector, origin=origin, historical=historical)
                yield self._match(entry, ref, "document_policy", f"policy.value.{field}", string, historical=historical,
                                  current=not historical and status == "active", policy_status=status, provenance=origin)
        for entity in event["after"].get("entities", []):
            if needle in _normalized(entity.get("label", "")):
                ref = {**self._base_ref(entry, "entity", "reviewed", entity), "entity_id": entity["id"], "origin_ref": origin}
                if historical:
                    ref["historical"] = True
                yield self._match(entry, ref, "document_policy", "policy.entities.label", entity["label"], historical=historical,
                                  current=not historical and status == "active", policy_status=status, provenance=origin)

def _correspondence_matches(self, result, needle, include_history):
    events = result.get("history", [])
    states = _latest(events, lambda event: (event["lane"], event["judgment_id"]))
    summaries = {item["event_id"]: item for item in [*result.get("reviews", []), *result.get("policies", [])]}
    for event in events:
        latest = states[(event["lane"], event["judgment_id"])]
        historical = latest["id"] != event["id"]
        if historical and not include_history:
            continue
        value = event["after"].get("value")
        if value is None:
            continue
        summary = summaries.get(latest["id"], {})
        for endpoint in ("condition", "concept"):
            # Statement/qualifiers are linked to the selected real endpoint,
            # never represented as an invented source quote.
            searchable = {"anchor": {"document": value[endpoint]["document"], "quote": value[endpoint]["quote"]}, "statement": value["statement"], "qualifiers": value["qualifiers"]}
            for field, string in _strings(searchable):
                if needle not in _normalized(string):
                    continue
                ref = {"kind": "correspondence_endpoint", "correspondence_id": result["correspondence_id"],
                       "correspondence_revision": result["correspondence_revision"], "lane": event["lane"],
                       "judgment_id": event["judgment_id"], "latest_event_id": latest["id"], "origin_event_id": event["after"].get("origin_event_id"),
                       "endpoint": endpoint, "snapshot": deepcopy(value[endpoint])}
                if historical:
                    ref.update(historical=True, selected_event_id=event["id"])
                yield self._match({}, ref, "correspondence", f"{endpoint}.{field}", string, historical=historical,
                                  current=not historical and summary.get("applicability") == "applicable", applicability=summary.get("applicability", "unavailable"),
                                  decision=event["after"]["decision"], provenance={"correspondence_id": result["correspondence_id"], "correspondence_revision": result["correspondence_revision"], "latest_event_id": latest["id"], "selected_event_id": event["id"], "origin_event_id": event["after"].get("origin_event_id")})

def find(self, text, *, documents=None, include_history=False, application_context=None, as_of=None,
         limit=20, policy_revision=None, profile=None, tenant=None):
    """원문·주장·정책 용어의 문자열 일치를 찾고 근거와 버전 있는 대상 참조를 함께 돌려준다."""
    # query 문자열을 받아 일치 위치와 target_ref를 반환한다. 사용할 참조를 명시 선택해 query로 현재 자료를 다시 확인한다.
    schema.text(text)
    paths = self._arguments(documents, limit, include_history)
    needle = _normalized(text)
    with self.store._write_lock():
        capture = self._capture("find", application_context, as_of, profile)
        selected = paths or capture.scan_documents()
        matches, identities = [], set()
        skipped = []
        for document in selected:
            entry = capture.document(document, purpose="discovery", required_by=["find"], full=True)
            for match in self._document_matches(entry, needle, include_history, skipped):
                key = _hash({"ref": match["target_ref"], "field": match["matched_field"], "text": match["original_text"]})
                if key not in identities and len(matches) <= limit:
                    matches.append(match)
                    identities.add(key)
        for cid in capture.scan_correspondences():
            detail = capture.correspondence(cid, purpose="discovery", required_by=["find"], evaluate=True)
            if paths and not set(paths).intersection(detail.get("documents", {}).values()):
                continue
            for match in self._correspondence_matches(detail, needle, include_history):
                key = _hash({"ref": match["target_ref"], "field": match["matched_field"], "text": match["original_text"]})
                if key not in identities and len(matches) <= limit:
                    matches.append(match)
                    identities.add(key)
        truncated = len(matches) > limit or bool(skipped)
        if truncated:
            skipped.append({"component": "matches", "phase": "output", "reason": "result_limit", "required_by": ["find"]})
        result = {"scope": {"text": text, "explicit_documents": paths, "discovery_scope": "explicit_documents" if paths else "bounded_tenant_scan", "include_history": include_history,
                            "not_guaranteed": ["semantic_coverage"], "limit": limit}, "matches": matches[:limit]}
        return self._finish(result, capture, policy_revision, profile, tenant, as_of, skipped, truncated,
                            output_limit=contracts.MAX_FIND_OUTPUT_BYTES)
