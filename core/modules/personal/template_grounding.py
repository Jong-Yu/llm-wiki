"""등록 템플릿의 전체 원문 선조회가 판단을 가리지 않는 범위만 고정한다."""

TEMPLATE_MAX_EVIDENCE_READS = 16
SOURCE_PREFETCH_MODE = "all_source_passages_v1"


def source_prefetch_contract(basis):
    """원문으로 대체할 수 없는 검토 상태가 있으면 명시적으로 불완전 차단한다."""
    reasons = []
    if not basis.get("complete") or basis.get("truncated") or basis.get("skipped"):
        reasons.append("incomplete_basis")
    for document in basis["documents"]:
        knowledge = document["knowledge"]
        if (any(claim.get("decision") != "unreviewed" or claim.get("authored_event_id")
                for claim in knowledge.get("claims", []))
                or any(knowledge.get(key) for key in (
                    "policies", "history", "relation_history", "authored_relations",
                    "pending_history", "current_pending_history"))):
            reasons.append("review_judgments_require_full_read")
            break
    return {"mode": SOURCE_PREFETCH_MODE, "status": "blocked" if reasons else "ready",
            "reasons": reasons, "scope": "all_selected_source_passages_not_full_graph"}
