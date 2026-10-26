"""명시 대상과 직접 확장의 선택 순서·같은 잠금 범위를 유지한다."""

# query는 find에서 고른 target과 사용자가 명시한 문서/대응을 같은 관측 안에서 읽는다.
# direct_confirmed 확장은 허용한 직접 연결만 대상으로 하며 이름 일치 후보를 자동 확장하지 않는다.

from core.modules.knowledge.schema import ConceptValidationError
from . import contracts
from copy import deepcopy
from . import schema


def query(self, target, *, documents=None, correspondence_ids=None, expansion="none", application_context=None,
          as_of=None, limit=20, policy_revision=None, profile=None, tenant=None):
    """선택한 대상과 허용한 직접 확장만 조회하며 이름 일치로 개체나 판단을 자동 병합하지 않는다."""
    # 선택한 target과 허용된 직접 확장만 읽어 상세 결과를 반환한다. 사용자 조건의 충족 여부는 not_evaluated로 구분한다.
    target = schema.validate_target(target, self.store)
    paths = self._arguments(documents, limit)
    if expansion not in {"none", "direct_confirmed"}:
        raise ConceptValidationError("unsupported expansion")
    if correspondence_ids is not None and (not isinstance(correspondence_ids, list) or len(correspondence_ids) > 8 or any(not isinstance(cid, str) for cid in correspondence_ids) or len(set(correspondence_ids)) != len(correspondence_ids)):
        raise ConceptValidationError("correspondence_ids must contain at most eight unique IDs")
    ids = list(correspondence_ids or [])
    for cid in ids:
        schema.identifier(cid, "correspondence_id")
    root_document = target["anchor"]["document"] if target["kind"] == "anchor" else target.get("document")
    root_cid = target.get("correspondence_id")
    if root_document is not None and root_document not in paths:
        paths.insert(0, root_document)
    if root_cid is not None and root_cid not in ids:
        ids.insert(0, root_cid)
    if len(paths) > 8 or len(ids) > 8:
        raise ConceptValidationError("target plus explicit selection exceeds eight roots")
    with self.store._write_lock():
        capture = self._capture("query", application_context, as_of, profile)
        # The 32-ledger total is eight explicit roots plus at most 24
        # additional ledgers, rather than 32 free discovery slots.
        capture.limits["correspondences"] = min(capture.limits["correspondences"], len(ids) + 24)
        docs, corrs = {}, {}
        for document in paths:
            docs[document] = capture.document(document, purpose="content", required_by=["target" if document == root_document else "explicit_selection"], root=document == root_document, full=True)
        # Reserve and validate every explicit root before any root's
        # dependency closure can consume the additional-ledger budget.
        for cid in ids:
            capture.correspondence(cid, purpose="content", required_by=["target" if cid == root_cid else "selected_precedent"], root=cid == root_cid, evaluate=False)
        for cid in ids:
            corrs[cid] = capture.correspondence(cid, purpose="content", required_by=["target" if cid == root_cid else "selected_precedent"], root=cid == root_cid, evaluate=True)
        if root_cid is not None:
            for document in sorted(set(corrs[root_cid].get("documents", {}).values())):
                if document not in docs:
                    docs[document] = capture.document(document, purpose="content", required_by=[f"target:{root_cid}"], full=True)
        resolution = self._resolve(target, docs, corrs)
        expanded, unexpanded, discovered = [], [], {}
        expansion_limited = False
        scan_ids = [*ids, *[cid for cid in capture.scan_correspondences() if cid not in ids]]
        for cid in scan_ids:
            detail = corrs.get(cid)
            if detail is None:
                detail = capture.correspondence(cid, purpose="discovery", required_by=["direct_connections"], evaluate=True)
            if not detail.get("correspondence_revision"):
                continue
            judgments = [*detail.get("reviews", []), *detail.get("policies", [])]
            for judgment in judgments:
                value = judgment.get("value")
                if value is None:
                    continue
                endpoints = [endpoint for endpoint in ("condition", "concept") if self._endpoint_matches(target, value[endpoint], docs, resolution)]
                if not endpoints:
                    continue
                discovered[cid] = detail
                accepted = judgment.get("decision") in {"accepted", "active"} and judgment.get("applicability") == "applicable"
                connection = {"correspondence_id": cid, "correspondence_revision": detail["correspondence_revision"], "lane": judgment["lane"], "judgment_id": judgment["judgment_id"], "event_id": judgment["event_id"], "origin_event_id": judgment.get("origin_event_id"), "matched_endpoints": endpoints, "direction": value["direction"], "decision": judgment["decision"], "applicability": judgment["applicability"], "reasons": deepcopy(judgment.get("reasons", [])), "questions": deepcopy(value.get("questions", [])), "conflict_refs": deepcopy(judgment.get("conflict_refs", [])), "conflict_assessment": "needs_semantic_review" if judgment.get("conflict_refs") else "reported"}
                if expansion != "direct_confirmed" or not accepted or not resolution.get("selectable_as_current"):
                    connection["expansion_reason"] = "expansion_disabled" if expansion == "none" else "not_current_applicable"
                    if len(unexpanded) <= limit:
                        unexpanded.append(connection)
                    continue
                new_documents = sorted({value["condition"]["document"], value["concept"]["document"], *[anchor["document"] for anchor in value["basis"]["link_evidence"]]})
                if len(set(docs) | set(new_documents)) > contracts.MAX_CONTENT_DOCUMENTS or len(expanded) >= limit:
                    connection["expansion_reason"] = "content_document_limit" if len(expanded) < limit else "result_limit"
                    if len(unexpanded) <= limit:
                        unexpanded.append(connection)
                    expansion_limited = True
                    continue
                corrs[cid] = capture.correspondence(cid, purpose="content", required_by=[judgment["event_id"]], evaluate=True)
                for document in new_documents:
                    docs[document] = capture.document(document, purpose="content", required_by=[judgment["event_id"]], full=True)
                expanded.append({**connection, "documents": new_documents, "hops": 1})
        extra_skipped = []
        truncated = expansion_limited
        if expansion_limited:
            extra_skipped.append({"component": "expanded_via", "phase": "selection", "reason": "expansion_limit", "required_by": ["query"]})
        if len(unexpanded) > limit:
            unexpanded = unexpanded[:limit]
            extra_skipped.append({"component": "unexpanded_connections", "phase": "output", "reason": "result_limit", "required_by": ["query"]})
            truncated = True
        content_documents = list(docs)
        content_correspondences = list(corrs)
        manifests = capture.manifest
        dependency_only = [deepcopy(item) for item in manifests if item.get("key") not in content_documents + content_correspondences and "content" not in item.get("purpose", [])]
        refs = self._contexts(docs, capture.actor)
        result = {"target": resolution, "scope": {"requested_target": target, "explicit_documents": paths, "explicit_correspondences": ids,
                  "content_documents": content_documents, "content_correspondences": content_correspondences, "expanded_via": expanded,
                  "dependency_only_resources": dependency_only, "unexpanded_connections": unexpanded, "discovery_scope": "bounded_tenant_scan",
                  "auto_expanded": bool(expanded), "max_hops": 1, "expansion": expansion, "not_guaranteed": ["semantic_coverage"],
                  "selected_precedent": [cid for cid in ids if cid != root_cid]},
                  "documents": [self._document_projection(entry, selected_event_ids=[target["origin_ref"]["selected_event_id"]] if target.get("origin_ref", {}).get("document") == entry["document"] else []) for entry in docs.values()],
                  "correspondences": [self._correspondence_projection(detail, selected_event_ids=[target.get("selected_event_id", target.get("latest_event_id")), target.get("origin_event_id")] if target.get("correspondence_id") == detail["correspondence_id"] else []) for detail in corrs.values()],
                  "unexpanded_connections": unexpanded, "possible_matches": [], **refs,
                  "condition_evaluation": "not_evaluated", "instance_satisfaction": "not_evaluated"}
        return self._finish(result, capture, policy_revision, profile, tenant, as_of, extra_skipped, truncated, output_limit=contracts.MAX_DETAIL_BYTES)
