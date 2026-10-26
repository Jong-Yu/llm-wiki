"""조회 대상의 판본·snapshot·현재성을 비교하고 출처 참조를 유지한다."""

# target_ref에 포함된 원문/그래프/검토 버전과 의미 사본을 현재 캡처와 비교한다.
# _resolve는 현재·과거·변경·사용 불가를 구분한다. 옛 배열 위치나 주장 번호만 바꿔 현재 대상으로 삼지 않는다.

from .values import _display_collection
from core.modules.reviews.state import _is_policy
from .values import _latest
from core.modules.reviews.state import _policy_key
from copy import deepcopy
from core.modules.ontology.anchors import is_source_anchor


def _tokens(entry):
    return {name: entry.get(name) for name in ("source_revision", "graph_revision", "review_revision", "history_revision", "state_revision")}

def _base_ref(self, entry, kind, layer, snapshot):
    return {"kind": kind, "document": entry["document"],
            **{name: entry.get(name) for name in ("source_revision", "graph_revision", "state_revision")},
            "layer": layer, "snapshot": deepcopy(snapshot)}

def _claim_ref(self, entry, claim, layer, snapshot, *, selector=None, origin=None, historical=False):
    ref = {**self._base_ref(entry, "document_claim", layer, snapshot), "original_collection": claim.get("original_collection", claim["collection"]), "claim_id": claim["claim_id"]}
    if selector is not None:
        ref["selector"] = selector
    if origin is not None:
        ref["origin_ref"] = deepcopy(origin)
    if historical:
        ref["historical"] = True
    return ref

def _origin(entry, event, latest):
    value = event["after"].get("value")
    return {"kind": "document_policy", "document": entry["document"], "original_collection": event["collection"],
            "claim_id": event["claim_id"], "latest_event_id": latest["id"], "selected_event_id": event["id"],
            "decision_event_id": None if value is None else value.get("provenance", {}).get("event_id"),
            "exact_scope": deepcopy(event["scope"]), "state_revision": entry.get("state_revision"),
            "snapshot": deepcopy(event["after"])}

def _policy_status(entry, event, latest):
    summary = next((item for item in entry.get("policies", []) if item["event_id"] == latest["id"]), None)
    return summary["status"] if summary else "unavailable"

def _claim_provenance(entry, claim):
    return {"document": entry["document"], **_tokens(entry), "claim_id": claim["claim_id"],
            "original_collection": claim.get("original_collection", claim["collection"]), "display_collection": _display_collection(claim),
            "review_event_id": claim.get("review_event_id"), "latest_policy_event_id": claim.get("latest_policy_event_id"),
            "decision_event_id": claim.get("policy_event_id"), "source_decision": claim.get("source_decision", claim.get("decision")),
            "source_reviewed_value": deepcopy(claim.get("source_reviewed_value", claim.get("reviewed_value")))}

def _match(entry, ref, origin, field, string, *, historical=False, current=True, currentness=None, **metadata):
    # 일치 문자열의 원래 값·필드·근거와 현재 선택 가능 여부를 함께 묶는다. 검색 일치를 의미적 동일성으로 바꾸지 않는다.
    return {"match_origin": origin, "matched_field": field, "original_text": string, "target_ref": ref,
            "currentness": currentness or ("historical" if historical else "current"),
            "historical": historical, "selectable_as_current": bool(current and not historical),
            "document": entry.get("document"), **metadata}

def _anchor_status(anchor, entry):
    source = entry.get("source")
    if source is None:
        return "missing"
    if source["revision"] != anchor["source_revision"]:
        return "version_changed"
    lines = source["content"].splitlines(keepends=True)
    start, end = anchor["start_line"], anchor["end_line"]
    if end > len(lines):
        return "missing"
    section = "".join(lines[start - 1:end])
    offsets, position = [], 0
    while True:
        position = section.find(anchor["quote"], position)
        if position < 0:
            break
        if section[:position].count("\n") == 0 and section[:position + len(anchor["quote"])].rstrip("\r\n").count("\n") == end - start:
            offsets.append(position)
        position += 1
    if not offsets or anchor.get("occurrence", 0) >= len(offsets):
        return "missing"
    return "ambiguous" if len(offsets) > 1 and "occurrence" not in anchor else "current"

def _resolve(self, target, docs, correspondences):
    # target의 의미 사본과 정확한 버전을 현재 캡처에 맞춰 확인한다. ID가 남아 있어도 내용이 달라지면 현재 대상으로 쓰지 않는다.
    resolved = {"requested": deepcopy(target), "status": "unavailable", "selectable_as_current": False, "resolution_layer": target.get("layer", "source")}
    kind = target["kind"]
    if kind == "correspondence_endpoint":
        detail = correspondences[target["correspondence_id"]]
        events = detail.get("history", [])
        selected = next((event for event in events if event["id"] == target.get("selected_event_id", target["latest_event_id"])), None)
        states = _latest(events, lambda event: (event["lane"], event["judgment_id"]))
        latest = states.get((target["lane"], target["judgment_id"]))
        if detail.get("correspondence_revision") != target["correspondence_revision"] or latest is None or latest["id"] != target["latest_event_id"]:
            resolved["status"] = "version_changed"
        elif selected is None or selected["lane"] != target["lane"] or selected["judgment_id"] != target["judgment_id"]:
            resolved["status"] = "missing"
        elif selected["after"].get("origin_event_id") != target["origin_event_id"] or selected["after"].get("value") is None or selected["after"]["value"][target["endpoint"]] != target["snapshot"]:
            resolved["status"] = "version_changed"
        else:
            summary = next((item for item in [*detail.get("reviews", []), *detail.get("policies", [])] if item["event_id"] == latest["id"]), {})
            historical = selected["id"] != latest["id"]
            resolved.update(status="current", observed=deepcopy(selected["after"]), resolution_layer="correspondence_snapshot", historical=historical,
                            applicability=summary.get("applicability", "unavailable"), selectable_as_current=not historical and summary.get("applicability") == "applicable")
        return resolved
    document = target["anchor"]["document"] if kind == "anchor" else target["document"]
    entry = docs[document]
    resolved["observed"] = {"document": document, **self._tokens(entry)}
    if kind == "anchor":
        changes = [name for name in ("source_revision", "history_revision") if target["observation"][name] != entry.get(name)]
        if entry.get("source") is None:
            resolved["status"] = "missing"
        elif target["observation"]["source_revision"] is None or target["observation"]["history_revision"] is None or entry.get("history_revision") is None:
            resolved["status"] = "unavailable"
        elif changes:
            resolved.update(status="version_changed", changed_fields=changes)
        else:
            resolved["status"] = self._anchor_status(target["anchor"], entry)
            if resolved["status"] == "current" and "graph_ref" in target["anchor"]:
                resolved["status"] = self._graph_ref_status(target["anchor"]["graph_ref"], entry)
        resolved["selectable_as_current"] = resolved["status"] == "current"
        return resolved
    if entry.get("source") is None:
        resolved["status"] = "missing"
        return resolved
    components = entry.get("components", {})
    if any(components.get(name, {}).get("status") == "unavailable" for name in ("graph", "review", "history")):
        resolved["status"] = "unavailable"
        resolved["unavailable_components"] = [name for name in ("graph", "review", "history") if components.get(name, {}).get("status") == "unavailable"]
        return resolved
    if components.get("graph", {}).get("status") == "missing":
        resolved["status"] = "missing"
        return resolved
    if any(target[name] != entry.get(name) for name in ("source_revision", "graph_revision", "state_revision")):
        resolved["status"] = "version_changed"
        return resolved
    if "origin_ref" in target:
        origin = target["origin_ref"]
        events = [event for event in entry.get("history", []) if _is_policy(event)]
        selected = next((event for event in events if event["id"] == origin["selected_event_id"]), None)
        latest = _latest(events, _policy_key)
        if selected is None:
            resolved["status"] = "missing"
            return resolved
        current = latest[_policy_key(selected)]
        actual_origin = self._origin(entry, selected, current)
        if origin != actual_origin or target.get("original_collection", selected["collection"]) != selected["collection"] or target.get("claim_id", selected["claim_id"]) != selected["claim_id"]:
            resolved["status"] = "version_changed"
            return resolved
        values = selected["after"].get("entities", []) if kind == "entity" else [selected["after"].get("value")]
        if target["snapshot"] not in values or kind == "entity" and target["snapshot"].get("id") != target["entity_id"]:
            resolved["status"] = "missing"
            return resolved
        status = self._policy_status(entry, selected, current)
        historical = selected["id"] != current["id"]
        resolved.update(status="current", observed=deepcopy(target["snapshot"]), policy_status=status,
                        resolution_layer="policy_snapshot", historical=historical,
                        selectable_as_current=status == "active" and not historical, provenance=actual_origin)
        return resolved
    graph = entry.get("machine_graph" if target["layer"] == "machine" else "effective_graph")
    if graph is None or graph.get("status") == "unavailable":
        resolved["status"] = "unavailable"
    elif graph.get("status") != "ready":
        resolved["status"] = "stale" if graph.get("status") == "stale" else "missing"
    else:
        if kind == "entity":
            values = [item for item in graph.get("entities", []) if item["id"] == target["entity_id"]]
        else:
            values = []
            for claim in entry.get("claims", []):
                if claim["claim_id"] != target["claim_id"] or claim["collection"] != target["original_collection"]:
                    continue
                if target["layer"] == "machine":
                    values.append(claim["value"])
                elif claim.get("decision") not in {"reject", "defer"}:
                    values.append(claim.get("reviewed_value"))
        resolved["status"] = "ambiguous" if len(values) > 1 else "missing" if not values else "current" if values[0] == target["snapshot"] else "version_changed"
        resolved["selectable_as_current"] = resolved["status"] == "current"
        if values:
            resolved["observed"] = deepcopy(values[0])
    return resolved

def _graph_ref_status(self, graph_ref, entry):
    kind = "entity" if graph_ref["collection"] == "entities" else "document_claim"
    target = {**self._base_ref(entry, kind, graph_ref["layer"], graph_ref["snapshot"]), "graph_revision": graph_ref["graph_revision"], "state_revision": graph_ref["state_revision"]}
    target.update({"entity_id": graph_ref["entity_id"]} if kind == "entity" else {"original_collection": graph_ref["collection"], "claim_id": graph_ref["claim_id"]})
    return self._resolve(target, {entry["document"]: entry}, {})["status"]

def _endpoint_matches(self, target, anchor, docs, resolution):
    if resolution["status"] != "current" or not resolution.get("selectable_as_current"):
        return False
    kind = target["kind"]
    if kind == "correspondence_endpoint":
        return target["snapshot"] == anchor
    if kind == "anchor":
        keys = ("document", "source_revision", "quote", "start_line", "end_line")
        return all(target["anchor"][name] == anchor[name] for name in keys) and target["anchor"].get("occurrence", 0) == anchor.get("occurrence", 0) and target["anchor"].get("graph_ref") == anchor.get("graph_ref")
    if "graph_ref" not in anchor or anchor["document"] != target["document"] or anchor["source_revision"] != target["source_revision"]:
        return False
    selector = target.get("selector")
    if selector == "value":
        return False
    expected = {"graph_revision": target["graph_revision"], "state_revision": target["state_revision"], "layer": target["layer"], "snapshot": target["snapshot"]}
    if kind == "entity":
        expected.update(collection="entities", entity_id=target["entity_id"])
    elif selector is not None:
        entity_id = target["snapshot"].get("subject" if selector == "attribute_subject" else selector)
        if is_source_anchor(entity_id):
            # A source endpoint is a selected position in this claim. It
            # must not be coerced to or discovered as a synthetic entity.
            keys = ("document", "source_revision", "quote", "start_line", "end_line")
            if (not all(entity_id[name] == anchor[name] for name in keys)
                    or entity_id["occurrence"] != anchor.get("occurrence", 0)):
                return False
            expected.update(collection=target["original_collection"], claim_id=target["claim_id"])
            return anchor["graph_ref"] == expected
        if not isinstance(entity_id, str):
            return False
        graph = docs[target["document"]].get("machine_graph" if target["layer"] == "machine" else "effective_graph") or {}
        entities = [entity for entity in graph.get("entities", []) if entity["id"] == entity_id]
        if len(entities) != 1:
            return False
        expected.update(collection="entities", entity_id=entity_id, snapshot=entities[0])
    else:
        expected.update(collection=target["original_collection"], claim_id=target["claim_id"])
    return anchor["graph_ref"] == expected
