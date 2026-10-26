"""제한된 영향 권고와 전체 근거 단위의 출력 한도·완전성을 조립한다."""

# 관련 문서와 명시 링크/후보를 우선순위·응답 크기 한도에 맞춰 조립한다.
# 제한으로 빠진 근거는 skipped/truncated로 알려 빈 결과를 전체 영향 없음으로 읽지 않게 한다.

from core.common.json_codec import canonical_json_bytes as _encode
from . import contracts
from copy import deepcopy


def result(ctx):
    """읽을 수 없는 문서를 missing으로 바꾸지 않고 전체 근거 단위로만 생략한다."""
    # 관련 문서·명시 링크·공통 이름 후보와 누락 정보를 합쳐 반환한다. 출력 한도로 빠지는 근거도 따로 표시한다.
    related = {}
    for link in ctx.explicit:
        name = link["target_document"] if link["direction"] == "outgoing" else link["source_document"]
        related.setdefault(name, set()).add("explicit_link_removed" if link["change"] == "removed" else "explicit_link")
    for candidate in ctx.candidates:
        related.setdefault(candidate["target_entity"]["document"], set()).add("shared_concept_candidate")
    chosen = sorted(related, key=lambda name: ("explicit_link" not in related[name] and "explicit_link_removed" not in related[name], name))[:ctx.limit]
    if len(chosen) != len(related):
        ctx.skip(ctx.document, "document_limit", "output")
    documents = []
    for name in chosen:
        # A link to a known nonregular/inaccessible/unscanned source is not
        # a missing file. Keep that distinction when no source was captured.
        target_statuses = {link["target_status"] for link in ctx.explicit if link["target_document"] == name}
        source_error = ctx.captured["source_errors"].get(name)
        if source_error == "byte_budget" or "unscanned" in target_statuses:
            source_status = "unscanned"
        elif source_error is not None or "unavailable" in target_statuses or ctx.known_states.get(name, {}).get("status") == "unavailable":
            source_status = "unavailable"
        else:
            source_status = "missing" if "missing" in target_statuses or ctx.captured["scan_complete"] else "unscanned"
        state = deepcopy(ctx.states.get(name, {"document": name, "source_revision": None, "graph_revision": None,
                                          "source_status": source_status,
                                          "review_revision": None, "history_revision": None, "state_revision": None,
                                          "ontology_status": "missing" if source_status == "missing" else "unavailable",
                                          "review_status": "unavailable", "state_available": False,
                                          "needs_review": True, "policy_pending": False, "reasons": []}))
        state["reasons"] = sorted(set(state["reasons"]) | related[name])
        state["recommendation"] = "consider_review"
        state["content_error_confirmed"] = False
        documents.append(state)
        if not state["state_available"]:
            ctx.skip(name, "state_unavailable", "related_document", omitted=False)
    selected = set(chosen)
    links = [link for link in ctx.explicit if (link["target_document"] if link["direction"] == "outgoing" else link["source_document"]) in selected]
    selected_candidates = [item for item in ctx.candidates if item["target_entity"]["document"] in selected]
    if len(links) > ctx.limit or len(selected_candidates) > ctx.limit:
        ctx.skip(ctx.document, "reference_limit", "output")
    links, selected_candidates = links[:ctx.limit], selected_candidates[:ctx.limit]
    returned_names = {link["target_document"] if link["direction"] == "outgoing" else link["source_document"] for link in links}
    returned_names.update(item["target_entity"]["document"] for item in selected_candidates)
    documents = [item for item in documents if item["document"] in returned_names]
    result = {"document": ctx.document, **ctx.current, "state_revision": ctx.root["state_revision"], "root": ctx.root,
              "baseline_status": "not_compared" if ctx.baseline is None else "compared",
              "baseline": deepcopy(ctx.baseline), "changes": ctx.changes,
              "change_status": "current_only" if ctx.baseline is None else "changed" if any(value is True for value in ctx.changes.values()) else "unknown" if any(value is None for value in ctx.changes.values()) else "unchanged",
              "selection": {"domain": ctx.domain, "viewpoint": ctx.viewpoint},
              "scope": {"kind": "bounded_one_hop", "automatic_reextraction": False,
                        "semantic_impact_complete": False, "historical_scan": "not_requested" if ctx.baseline is None else "baseline_root_and_review_events",
                        "baseline_is_authority": False},
              "explicit_links": links, "candidates": selected_candidates, "documents": documents,
              "restoration": ctx.restoration, "skipped": ctx.skipped, "truncated": ctx.truncated,
              "complete": not ctx.incomplete, "scanned": ctx.connections["scanned"],
              "captured_bytes": contracts.MAX_CONNECTION_BYTES - ctx.remaining[0],
              "scanned_entries": contracts.MAX_CONNECTION_SCAN_ENTRIES - ctx.entry_budget[0],
              "limits": {"max_documents": contracts.MAX_CONNECTION_DOCUMENTS, "max_scan_entries": contracts.MAX_CONNECTION_SCAN_ENTRIES,
                         "max_capture_bytes": contracts.MAX_CONNECTION_BYTES, "max_output_bytes": contracts.MAX_IMPACT_OUTPUT_BYTES,
                         "returned_documents": ctx.limit, "references_per_kind": ctx.limit}}
    # No partial evidence strings: remove whole references and their orphan
    # recommendation rows until the bounded JSON response fits.
    def output_size():
        result.setdefault("output_bytes", 0)
        while True:
            size = len(_encode(result))
            if result["output_bytes"] == size:
                return size
            result["output_bytes"] = size

    while output_size() > contracts.MAX_IMPACT_OUTPUT_BYTES and (result["candidates"] or result["explicit_links"] or result["documents"]):
        result["truncated"] = True
        result["complete"] = False
        if not any(item["code"] == "output_budget" for item in result["skipped"]):
            result["skipped"].append({"document": ctx.document, "component": "output", "code": "output_budget"})
        if result["candidates"]:
            result["candidates"].pop()
        elif result["explicit_links"]:
            result["explicit_links"].pop()
        else:
            result["documents"].pop()
        present = {link["target_document"] if link["direction"] == "outgoing" else link["source_document"] for link in result["explicit_links"]}
        present.update(item["target_entity"]["document"] for item in result["candidates"])
        result["documents"] = [item for item in result["documents"] if item["document"] in present]
    if output_size() > contracts.MAX_IMPACT_OUTPUT_BYTES:
        raise ValueError("Impact response metadata exceeds its output budget")
    return result
