"""전체 선택 맥락·이력 투영·완전성 축과 응답 hash를 보존한다."""

# 내부 캡처에서 응답에 필요한 문서/대응/이력 참조를 복사해 보여 줄 모양으로 바꾼다.
# 전체 raw 원장을 그대로 노출하지 않되 선택한 판단을 이해하는 데 필요한 연결 이력과 누락 범위를 유지한다.

from core.modules.knowledge.schema import ConceptLimitError
from core.modules.knowledge.schema import ConceptValidationError
from .values import _audit_refs
from core.modules.ontology.context import _context_selection
from .values import _display_collection
from core.common.json_codec import canonical_json_bytes as _encode
from core.common.json_codec import canonical_json_hash as _hash
from . import contracts
from copy import deepcopy


def _document_projection(self, entry, selected_event_ids=()):
    # deepcopy는 내부 dict/list와 별개 사본을 만든다. 응답 모양을 바꾸면서 원래 캡처를 수정하지 않는다.
    result = {name: deepcopy(value) for name, value in entry.items() if name not in {"ledger", "snapshot", "content", "tokens", "history"}}
    result.setdefault("document", entry["document"])
    for claim in result.get("claims", []):
        claim["original_collection"] = claim.get("original_collection", claim["collection"])
        claim["display_collection"] = _display_collection(claim)
        claim["provenance"] = self._claim_provenance(entry, claim)
    for policy in result.get("policies", []):
        policy["condition_evaluation"] = "not_evaluated"
    history = entry.get("history", [])
    event_ids = set(selected_event_ids) | set(entry.get("pending_history", []))
    for claim in entry.get("claims", []):
        event_ids.update(claim.get(name) for name in ("review_event_id", "latest_policy_event_id", "policy_event_id"))
    for policy in entry.get("policies", []):
        event_ids.update((policy["event_id"], policy.get("decision_event_id")))
    event_ids = _audit_refs(history, event_ids)
    result["events"] = [deepcopy(event) for event in history if event["id"] in event_ids]
    result["history_projection"] = {"validated_event_count": len(history), "returned_refs": [event["id"] for event in result["events"]], "omitted": "unselected_history_events", "omitted_event_count": len(history) - len(result["events"])}
    result["pending_events"] = [deepcopy(event) for event in history if event["id"] in entry.get("pending_history", [])]
    return result

def _correspondence_projection(detail, selected_event_ids=()):
    result = {name: deepcopy(value) for name, value in detail.items() if name not in {"ledger", "history"}}
    history = detail.get("history", [])
    refs = set(selected_event_ids) | {item["event_id"] for item in [*detail.get("reviews", []), *detail.get("policies", [])]}
    refs.update(item.get("origin_event_id") for item in [*detail.get("reviews", []), *detail.get("policies", [])])
    refs = _audit_refs(history, refs)
    result["events"] = [deepcopy(event) for event in history if event["id"] in refs]
    result["history_projection"] = {"validated_event_count": len(history), "returned_refs": [event["id"] for event in result["events"]], "omitted": "unselected_history_events"}
    result["condition_evaluation"] = "not_evaluated"
    result["instance_satisfaction"] = "not_evaluated"
    return result

def _contexts(self, docs, actor):
    groups = {"focus_refs": [], "other_context": [], "unclassified": []}
    all_refs = []
    for entry in docs.values():
        for claim in entry.get("claims", []):
            ref = self._claim_provenance(entry, claim)
            all_refs.append(ref)
            # The existing selector groups indices; keep every claim and
            # conservatively retain unclassified when no group is known.
            value = claim.get("reviewed_value") or claim["value"]
            partition = _context_selection({"relations": [value], "attributes": [], "relation_candidates": []}, actor.get("domain"), actor.get("viewpoint"))["relations"]
            group = next(name for name, indices in partition.items() if indices)
            if group == "focus":
                group = "focus_refs"
            groups[group].append(ref)
    return {**groups, "explanation_context": {"claim_refs": deepcopy(all_refs), "source_documents": list(docs), "condition_evaluation": "not_evaluated"},
            "map_context": {"nodes": [{"document": entry["document"], "source_revision": entry.get("source_revision"), "graph_revision": entry.get("graph_revision"), "entities": deepcopy((entry.get("effective_graph") or {}).get("entities", []))} for entry in docs.values()], "claim_refs": deepcopy(all_refs), "direction_preserved": True}}

def _finish(self, result, capture, policy_revision, profile, tenant, requested_as_of, extra_skipped, truncated, *, output_limit):
    """실제 조회 범위·누락·출력 제한을 보존하고 캡처 전체와 표시 결과의 버전을 구분한다."""
    # 출력 용량과 완전성·범위를 확인하고 snapshot/view 지문을 계산한다. 일부 결과를 전체 조회 성공으로 과장하지 않는다.
    if self.budgets is not None and "output_bytes" in self.budgets:
        value = self.budgets["output_bytes"]
        if type(value) is not int or value < 0:
            raise ConceptValidationError("output_bytes must be a nonnegative integer")
        output_limit = min(output_limit, value)
    skipped = [*deepcopy(capture.skipped), *extra_skipped]
    capture_complete = bool(capture.complete)
    entries = result.get("documents", [])
    context_complete = all(entry.get("complete", False) for entry in entries)
    if "matches" in result:
        context_complete = capture_complete
    evaluation = {"profile_id": (profile or {}).get("profile_id", self.actor.get("profile_id")),
                  "profile_definition": deepcopy(profile or {"domain": self.actor.get("domain"), "viewpoint": self.actor.get("viewpoint")}),
                  "policy_revision": policy_revision or self.actor.get("policy_revision"), "application_context": deepcopy(capture.application_context),
                  "requested_as_of": requested_as_of, "evaluated_at": capture.at.isoformat(), "temporal_scope": "current_capture_evaluated_at_requested_time"}
    result.update(ok=True, resource_manifest=deepcopy(capture.manifest), evaluation=evaluation, access=deepcopy(self.actor),
                  skipped=skipped, truncated=bool(truncated or capture.truncated),
                  completeness={"selection": {"complete": not capture.truncated, "scope": "explicit_and_bounded_discovery"},
                                "capture": {"complete": capture_complete, "scope": "resource_manifest"},
                                "context": {"complete": context_complete, "scope": "full_selected_components"},
                                "output": {"complete": not truncated, "scope": "requested_projection"}})
    result["complete"] = all(axis["complete"] for axis in result["completeness"].values())
    # Output omissions preserve whole component boundaries, not clipped
    # claims/quotes/events that might lose a condition or change meaning.
    while len(_encode(result)) > max(0, output_limit - 400) and (result.get("documents") or result.get("correspondences") or result.get("matches")):
        component = "documents" if result.get("documents") else "correspondences" if result.get("correspondences") else "matches"
        omitted = result[component].pop()
        key = omitted.get("document", omitted.get("correspondence_id", omitted.get("target_ref")))
        if component == "documents":
            for group in ("focus_refs", "other_context", "unclassified"):
                result[group] = [ref for ref in result.get(group, []) if ref.get("document") != key]
            for group in ("explanation_context", "map_context"):
                context = result.get(group, {})
                context["claim_refs"] = [ref for ref in context.get("claim_refs", []) if ref.get("document") != key]
                if group == "map_context":
                    context["nodes"] = [node for node in context.get("nodes", []) if node.get("document") != key]
                else:
                    context["source_documents"] = [document for document in context.get("source_documents", []) if document != key]
        result["skipped"].append({"component": component, "key": key, "phase": "output", "reason": "output_budget", "required_by": ["response"]})
        result["complete"] = False
        result["truncated"] = True
        result["completeness"]["output"]["complete"] = False
    result["revision_scope"] = "complete_manifest" if result["complete"] else "partial_manifest"
    manifest = result["resource_manifest"]
    snapshot_scope = {"contract_version": contracts.CONTRACT_VERSION, "tenant": tenant or self.actor["tenant"], "policy_revision": evaluation["policy_revision"],
                      "scope": result["scope"], "target": result.get("target", {}).get("requested"), "manifest": manifest, "coverage": deepcopy(capture.coverage)}
    # evaluated_at and transient status decisions belong only to view hash.
    if "expanded_via" in snapshot_scope["scope"]:
        snapshot_scope = deepcopy(snapshot_scope)
        snapshot_scope["scope"].pop("unexpanded_connections", None)
        snapshot_scope["scope"]["expanded_via"] = [{key: item[key] for key in ("correspondence_id", "event_id", "documents", "hops")} for item in result["scope"]["expanded_via"]]
    result["snapshot_revision"] = _hash(snapshot_scope)
    projection_scope = {"documents": [{"document": entry["document"], "events": entry.get("history_projection", {}).get("returned_refs", [])} for entry in result.get("documents", [])],
                        "correspondences": [{"correspondence_id": entry["correspondence_id"], "events": entry.get("history_projection", {}).get("returned_refs", [])} for entry in result.get("correspondences", [])],
                        "matches": [{"target_ref": match["target_ref"], "matched_field": match["matched_field"], "original_text": match["original_text"]} for match in result.get("matches", [])],
                        "omitted": [item for item in result["skipped"] if item.get("phase") == "output"]}
    result["view_revision"] = _hash({"snapshot_revision": result["snapshot_revision"], "evaluation": evaluation,
                                   "target": result.get("target"), "completeness": result["completeness"], "scope": result["scope"], "projection_scope": projection_scope})
    if len(_encode(result)) > output_limit:
        raise ConceptLimitError("Response metadata exceeds output limit; narrow the selected scope")
    return result
