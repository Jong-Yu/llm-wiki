"""보존한 source/expert 판단의 현재 적용 범위·기간·의존 상태를 계산한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# 저장된 판단(decision)과 지금 적용 가능한지(applicability)를 나누어 계산한다.
# 관점·업무 축·기간·근거 문서가 다르면 과거 수용 판단이 있어도 현재의 적용 가능한 사실로 쓰지 않는다.

from . import schema
from .contracts import CorrespondenceValidationError
from .state import _scope
from .state import _states
from copy import deepcopy


def _structural_applicability(owner, snapshot, deps):
    if snapshot["decision"] not in {"accepted", "active"}:
        return "inactive", ["decision is not accepted/active"]
    if not owner._complete(deps):
        return "unavailable", ["a required dependency is confirmed missing"]
    if snapshot["basis_dependencies"] != deps:
        return "needs_review", ["actual dependency state changed since the judgment"]
    return "applicable", []


def _applicability(owner, snapshot, deps, ctx, stack=None):
    # 현재 관점/업무 축/기간/근거 상태에서 쓸 수 있는지와 그 이유 목록을 반환한다. 조건 문장의 실제 참/거짓을 임의 판정하지 않는다.
    if snapshot["decision"] not in {"accepted", "active"}:
        return "inactive", ["decision is not accepted/active"]
    if not owner._complete(deps):
        return "unavailable", ["a required source, graph, or event is confirmed missing"]
    if snapshot["basis_dependencies"] != deps:
        return "needs_review", ["actual dependency state changed since the judgment"]
    if snapshot["policy_scope"] is not None and snapshot["policy_scope"] != _scope(owner.actor):
        return "other_scope", ["expert policy exact domain/viewpoint differs"]
    value = snapshot["value"]
    if value["questions"] or value["qualifiers"]["quantity"]["status"] == "unknown" or any(value["qualifiers"][name]["status"] == "unknown" for name in ("conditions", "exceptions")):
        return "unknown_scope", ["meaning, conditions, exceptions, or confirmation questions remain unresolved"]
    for axis in value["business_scope"]["axes"]:
        if axis["status"] == "unknown" or (axis["status"] == "specified" and axis["name"] not in ctx.application_context):
            return "unknown_scope", ["required application axis is not known"]
        if axis["status"] == "specified" and ctx.application_context[axis["name"]] != axis["value"]:
            return "other_scope", ["application axis differs from this judgment"]
    validity = value["business_scope"]["validity"]
    if validity["status"] == "unknown":
        return "unknown_scope", ["validity is unknown"]
    if validity["status"] == "specified":
        start, end = schema.instant(validity["start"]), schema.instant(validity["end"])
        if ctx.at < start or (ctx.at == start and not validity["start_inclusive"]) or ctx.at > end or (ctx.at == end and not validity["end_inclusive"]):
            return "out_of_period", ["evaluation time is outside the specified interval"]
    for row in deps["correspondences"]:
        if any(ref["status"] != "applicable" for ref in row["references"]):
            return "needs_review", ["a referenced judgment is no longer applicable"]
    # A reviewed graph snapshot may itself be an expert policy; its
    # exact scope remains binding even without a separate policy reference.
    graph_refs = [(anchor["document"], anchor["graph_ref"]) for anchor in [value["condition"], value["concept"], *value["basis"]["link_evidence"]] if "graph_ref" in anchor]
    graph_refs.extend((ref["document"], ref["graph_ref"]) for ref in value["references"] if ref["kind"] == "graph")
    for document, graph_ref in graph_refs:
        provenance = graph_ref["snapshot"].get("provenance", {})
        if graph_ref["layer"] == "reviewed" and provenance.get("kind") == "expert_policy":
            captured = ctx.document(document, True)
            policies = [] if captured["snapshot"] is None else captured["snapshot"].get("policies", [])
            origin = next((policy for policy in policies if policy["decision_event_id"] == provenance.get("event_id")), None)
            if origin is None or origin["status"] in {"inactive", "pending"}:
                return "needs_review", ["referenced graph expert policy is no longer current"]
            if origin["scope"] != _scope(owner.actor):
                return "other_scope", ["referenced graph expert policy exact scope differs"]
    # Referenced document-policy scope remains an extra, exact restriction.
    for ref in value["references"]:
        if ref["kind"] in {"policy", "correspondence"} and ref["scope"] is not None and ref["scope"] != _scope(owner.actor):
            return "other_scope", ["referenced policy exact scope differs"]
        if ref["kind"] == "correspondence":
            child_id = ref["correspondence_id"]
            _, child = ctx.ledger(child_id)
            if child is None:
                return "unavailable", ["referenced correspondence is missing"]
            route = stack or []
            if child_id in route:
                raise CorrespondenceValidationError("Correspondence dependency cycles are forbidden")
            judgments = owner._judgments(child, ctx, child_id, [*route, child_id])
            item = next((item for item in judgments if item["event_id"] == ref["event_id"]), None)
            if item is None or item["applicability"] != "applicable":
                return ("needs_review" if item is None else item["applicability"]), ["referenced judgment is not applicable in the requested scope/time"]
    return "applicable", []


def _judgments(owner, ledger, ctx, cid, stack=None, *, structural=False):
    # 각 기록 줄기의 현재 판단을 모으고 명시적 대체/충돌을 표시한다. 여러 전문가 판단을 조용히 하나로 합치지 않는다.
    result = []
    for event in _states(ledger).values():
        snap = event["after"]
        deps = ctx.collect([snap["value"]], cid, stack)
        applicability, reasons = (owner._structural_applicability(snap, deps) if structural else owner._applicability(snap, deps, ctx, stack or [cid]))
        result.append({**deepcopy(snap), "event_id": event["id"], "judgment_id": event["judgment_id"], "lane": event["lane"], "applicability": applicability, "reasons": reasons, "conflict_refs": [], "provenance": {"kind": "action_log" if event["lane"] == "expert" else snap["value"]["basis"]["kind"], "event_id": snap["origin_event_id"], "state_revision": event["base_state_revision"]}})
    # Explicit policies suppress the matching source only in their exact selected scope.
    by_id = {event["id"]: event for event in ledger["events"]}
    for policy in result:
        target_id = policy["supersedes_event_id"]
        if policy["lane"] != "expert" or policy["decision"] != "active" or policy["applicability"] != "applicable" or target_id is None:
            continue
        target_event = by_id[target_id]
        for target in result:
            if (target["lane"], target["judgment_id"]) == (target_event["lane"], target_event["judgment_id"]) and target is not policy:
                target["applicability"] = "inactive"
                target["reasons"] = ["explicitly superseded in this exact selected scope"]
    active = [item for item in result if item["lane"] == "expert" and item["decision"] == "active" and item["applicability"] == "applicable"]
    for left in active:
        for right in active:
            if left is right or left["policy_scope"] != right["policy_scope"] or left["value"]["business_scope"] != right["value"]["business_scope"]:
                continue
            if left["value"] != right["value"]:
                left["conflict_refs"].append(right["event_id"])
                left["applicability"] = "conflicting"
                left["reasons"] = ["independent active expert judgments disagree in an identical scope"]
    return result
