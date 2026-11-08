"""Explicit response projections; stored values and default MCP responses stay intact."""

from collections import Counter
from copy import deepcopy


REVIEW_MUTATIONS = frozenset({"ontology_review", "ontology_review_undo", "ontology_policy", "ontology_policy_undo"})
RESULT_OPERATIONS = frozenset({"analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"})
COMPACT_OPERATIONS = REVIEW_MUTATIONS | RESULT_OPERATIONS


def _review(value):
    event = next((row for row in value.get("history", []) if row["id"] == value.get("event_id")), None)
    if event is None:
        # A successful save must not turn into a response error if a future store
        # changes its representation. Returning the full value is safe.
        return value
    omitted = {"machine_graph", "effective_graph", "claims", "current_claims", "history", "selection", "policies"}
    result = {key: item for key, item in value.items() if key not in omitted}
    claim_id = event["claim_id"]
    result.update(
        event=event,
        claim=next((row for row in value["claims"] if row["claim_id"] == claim_id), None),
        policies=[row for row in value.get("policies", []) if row["claim_id"] == claim_id],
        selection={key: value["selection"][key] for key in ("domain", "viewpoint")},
        summary={
            "claim_decisions": dict(Counter(row["decision"] for row in value["claims"])),
            "current_claim_count": len(value.get("current_claims", value["claims"])),
            "ambiguous_claim_count": sum(bool(row["ambiguous"]) for row in value["claims"]),
            "policy_statuses": dict(Counter(row["status"] for row in value.get("policies", []))),
        },
        response_view={
            "version": "compact-v1", "full_snapshot": False,
            "omitted": sorted(omitted),
            "detail_query": {"tool": "ontology_review_query", "arguments": {
                "document": value["document"], "tenant": event["actor"]["tenant"],
                "profile": event["actor"]["profile_id"],
            }},
            "state_revision": value["state_revision"],
        },
    )
    return result


def _report(value):
    """Remove only successful checker explanations; preserve all other statuses."""
    if not isinstance(value, dict):
        return value
    result = deepcopy(value)
    if isinstance(result.get("rule_results"), list):
        result["rule_results"] = [
            {key: item for key, item in row.items() if key not in {"checker", "reason"}}
            if row.get("status") == "pass" else row
            for row in result["rule_results"]
        ]
    if isinstance(result.get("semantic"), dict):
        result["semantic"] = _report(result["semantic"])
    return result


def _analysis_result(value):
    # Receipts, input versions, current_output, cleanup failures and diagnostic
    # findings remain complete. In particular, not_run is never replaced by pass.
    result = {**value, "validation_report": _report(value.get("validation_report"))}
    actor = (value.get("receipt") or {}).get("actor", {})
    result["response_view"] = {
        "version": "compact-v1", "full_snapshot": False,
        "omitted": ["validation_report successful rule checker/reason explanations"],
        "detail_query": {"tool": "analysis_job_result_query", "arguments": {
            "job_id": value["job_id"], "request_id": value["request_id"], "response_mode": "full",
            **({"tenant": actor["tenant"], "profile": actor["profile_id"]} if actor else {}),
        }, "access": "Use the same authorized tenant/profile as this response."},
    }
    return result


def project(operation, value, response_mode):
    """A response option is not a write option and never enters request hashes."""
    if response_mode == "full":
        return value
    try:
        if operation in REVIEW_MUTATIONS:
            return _review(value)
        if operation in RESULT_OPERATIONS:
            return _analysis_result(value)
    except (KeyError, TypeError, ValueError):
        # Projection is optional. A changed result shape must never turn a saved
        # mutation into an error that could encourage another write.
        return value
    return value
