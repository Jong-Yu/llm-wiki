"""공식 템플릿 질문의 모든 선택 원문 단락을 모델 호출 전에 영수증으로 확보한다."""

from core.client.ai.contracts import AIAdapterError

SOURCE_PREFETCH_MODE = "all_source_passages_v1"
TEMPLATE_MAX_READS = 16
# 서버의 한 응답 상한과 다음 query/JSON wrapper/action 안내를 위한 보수적 여유다.
EVIDENCE_PAGE_BYTES = 24 * 1024
EVIDENCE_ENVELOPE_BYTES = 4 * 1024


def source_answer_budget(handoff, prompt_bytes, max_context_bytes, evidence_reads):
    """실제로 전 원문을 받은 정식 템플릿만 다음 전체 페이지의 공간을 예약한다."""
    result = handoff.get("source_prefetch_result", {})
    catalog = handoff.get("basis", {})
    materials = [*catalog.get("documents", []), *catalog.get("originals", []),
                 *catalog.get("web", {}).get("sources", [])]
    completed = result.get("materials", [])
    if ("template_ref" not in handoff or handoff.get("source_prefetch", {}).get("status") != "ready"
            or result.get("mode") != SOURCE_PREFETCH_MODE or result.get("complete") is not True
            or result.get("scope") != "all_selected_meaningful_source_passages"
            or not materials or len(completed) != len(materials)
            or any(item.get("complete") is not True or item.get("material_id") != material.get("id")
                   for item, material in zip(completed, materials))):
        return None
    remaining = max_context_bytes - prompt_bytes
    if remaining >= EVIDENCE_PAGE_BYTES + EVIDENCE_ENVELOPE_BYTES:
        return None
    return {"reason": "insufficient_room_for_full_evidence_page", "base_prompt_bytes": prompt_bytes,
            "remaining_prompt_bytes": remaining, "evidence_page_bytes": EVIDENCE_PAGE_BYTES,
            "query_envelope_bytes": EVIDENCE_ENVELOPE_BYTES, "evidence_reads": evidence_reads,
            "completed_material_ids": [item["material_id"] for item in completed],
            "graph_coverage": "initial_and_explicit_reads_only"}


def evidence_read_limit(handoff):
    """본문 표지는 무시하고 서버가 고정한 정식 템플릿 계약만 확장한다."""
    if "template_ref" not in handoff:
        if "source_prefetch" in handoff:
            raise AIAdapterError("question_input_invalid")
        return 6
    if (handoff.get("contract_version") not in {"personal-question-v5", "personal-question-v6"}
            or handoff.get("output", {}).get("max_evidence_reads") != TEMPLATE_MAX_READS
            or handoff.get("source_prefetch", {}).get("mode") != SOURCE_PREFETCH_MODE):
        raise AIAdapterError("question_input_invalid")
    return TEMPLATE_MAX_READS


def check_prefetch_eligibility(handoff):
    """보류·전문가 판단을 원문으로 덮는 실행은 첫 모델 전에 중단한다."""
    if evidence_read_limit(handoff) == 6:
        return False
    contract = handoff["source_prefetch"]
    if contract.get("status") != "ready" or contract.get("reasons") != []:
        code = ("question_source_judgments_unread" if "review_judgments_require_full_read"
                in contract.get("reasons", []) else "question_source_incomplete")
        raise AIAdapterError(code)
    return True


def _page(handoff, material, query, result, total, seen, ranges):
    """같은 고정 원문의 연속 페이지·실제 인용·누락 여부를 엄격히 확인한다."""
    items, scope = result.get("items"), result.get("scope", {})
    count, following = result.get("total_matches"), result.get("next_offset")
    if (result.get("action") != "search" or not isinstance(items, list)
            or result.get("skipped") != [] or type(count) is not int or count < 0
            or total is not None and count != total
            or scope.get("material_ids") != [material["id"]]
            or scope.get("query") != "" or scope.get("completion_scope") != "matching_passages"
            or scope.get("basis_snapshot_revision") != handoff["basis"].get("snapshot_revision")
            or scope.get("basis_complete") is not True):
        raise AIAdapterError("question_source_incomplete")
    ids = []
    for item in items:
        if (not isinstance(item, dict) or item.get("kind") != "source"
                or item.get("material_id") != material["id"]
                or item.get("material_line_count") != material["line_count"]
                or type(item.get("start_line")) is not int or type(item.get("end_line")) is not int
                or not 1 <= item["start_line"] <= item["end_line"] <= material["line_count"]
                or ranges and item["start_line"] <= ranges[-1][1]
                or not isinstance(item.get("evidence_id"), str)
                or item["evidence_id"] in seen
                or "source_revision" in material and item.get("source_revision") != material["source_revision"]
                or "source_ref" in material and item.get("source_ref") != material["source_ref"]):
            raise AIAdapterError("question_source_incomplete")
        ids.append(item["evidence_id"])
        seen.add(item["evidence_id"])
        if ranges and item["start_line"] == ranges[-1][1] + 1:
            ranges[-1][1] = item["end_line"]
        else:
            ranges.append([item["start_line"], item["end_line"]])
    if ids != result.get("evidence_ids"):
        raise AIAdapterError("question_source_incomplete")
    cursor = query["offset"] + len(items)
    if following is None:
        if cursor != count or result.get("complete") is not True or result.get("truncated") is not False:
            raise AIAdapterError("question_source_incomplete")
    elif (type(following) is not int or not items or following != cursor or following <= query["offset"]
          or following >= count or result.get("complete") is not False or result.get("truncated") is not True):
        raise AIAdapterError("question_source_incomplete")
    return count, following


async def prefetch_selected_sources(owner, handoff, registry, reads, append_evidence):
    """기존 search·영수증·registry를 통해 빈줄 제외 의미 단락의 전 페이지를 읽는다."""
    catalog = handoff["basis"]
    materials = [*catalog.get("documents", []), *catalog.get("originals", []),
                 *catalog.get("web", {}).get("sources", [])]
    completed = []
    for material in materials:
        offset, total, seen, pages, ranges = 0, None, set(), 0, []
        while True:
            owner.check_cancel()
            if len(reads) >= evidence_read_limit(handoff):
                raise AIAdapterError("question_source_incomplete")
            query = {"action": "search", "query": "", "material_id": material["id"],
                     "start_line": 1, "line_count": 60, "offset": offset, "limit": 20,
                     "start_character": 0, "character_count": 4000}
            result = await owner.query_evidence(query)
            owner.check_cancel()
            total, following = _page(handoff, material, query, result, total, seen, ranges)
            append_evidence(query, result, registry, reads)
            pages += 1
            owner.emit("phase", phase="evidence_read", saved=False, evidence_reads=len(reads))
            if following is None:
                break
            offset = following
        completed.append({"material_id": material["id"], "passages": total, "pages": pages,
                          "complete": True, "returned_ranges": ranges})
    return {"mode": SOURCE_PREFETCH_MODE, "complete": True, "materials": completed,
            "scope": "all_selected_meaningful_source_passages",
            "source_bytes_preserved": False, "graph_coverage": "initial_and_explicit_reads_only"}
