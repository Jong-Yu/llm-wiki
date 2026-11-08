"""규칙별 실제 검사 진행을 기록한다. 미실행 규칙을 실패나 통과로 추정하지 않는다.

기존 저장 검증기를 그대로 호출하는 진단 단계이며 의미 판단이나 사람 승인을 만들지 않는다.
canonical 저장 직전의 권한/CAS 검사는 ResultStore가 다시 수행한다.
"""

from core.modules.ontology import validation as graph, values
from core.modules.ontology.anchors import normalize_anchor
from core.modules.ontology.errors import OntologyValidationError


STATUSES = {"pass", "fail", "not_run", "not_applicable", "error"}
CHECKERS = {
    "R-A01": "published_ruleset_reference", "R-A02": "authorized_live_job_scope",
    "R-A03": "fixed_input_and_commit_cas", "R-A04": "fixed_input_completeness",
    "R-A05": "published_schema_and_storage_limits", "R-A06": "canonical_entities_and_relations",
    "R-A07": "literal_quotes_and_source_anchors", "R-A08": "explicit_qualifiers",
    "R-A09": "canonical_metadata_and_attributes", "R-A10": "canonical_candidates",
}


def initial(stage):
    return [{"rule_id": rule, "checker": checker,
             "status": "not_applicable" if stage != "extract_ontology" and int(rule[-2:]) >= 6 else "not_run",
             "reason": "wiki_stage_has_no_graph" if stage != "extract_ontology" and int(rule[-2:]) >= 6
             else "checker_not_reached"} for rule, checker in CHECKERS.items()]


def mark(report, rule, status, reason):
    if status not in STATUSES:
        raise ValueError("Unknown rule result status")
    row = next(item for item in report["rule_results"] if item["rule_id"] == rule)
    row.update(status=status, reason=reason)


def start(report, rule):
    report["active_rule"] = rule


def run(report, rule, action, *, applicable=True):
    if not applicable:
        mark(report, rule, "not_applicable", "no_applicable_graph_items")
        return
    start(report, rule)
    result = action()
    mark(report, rule, "pass", "specified_check_completed")
    report.pop("active_rule", None)
    return result


def failure(report, code):
    """검사 실패와 운영 오류를 구분하고 이미 실행한 다른 규칙 결과를 보존한다."""
    rule = report.pop("active_rule", None)
    if code.startswith("ruleset_"):
        rule = "R-A01"
    elif code in {"access_denied", "access_unavailable", "access_basis_changed", "job_cancelled", "lease_expired", "run_changed", "run_conflict", "lease_conflict"}:
        rule = "R-A02"
    elif code in {"conflict", "input_basis_changed", "analysis_basis_changed", "source_basis_changed", "analysis_basis_required"}:
        rule = "R-A03"
    if rule:
        status = "error" if code in {"storage_error", "storage_busy", "access_unavailable"} or code.endswith("_corrupt") else "fail"
        mark(report, rule, status, code)
    report["error_code"] = code
    report["automatic"] = "failed" if any(r["status"] == "fail" for r in report["rule_results"]) else "not_completed"


def graph_checks(report, submission, source, document, revision, schema_check):
    """스키마 뒤 실제 canonical 보조 검사를 나눠 실행한다. 저장이나 그래프 정정은 하지 않는다."""
    # 형식 오류가 있으면 배열/필드에 접근하지 않는다. 나머지는 정확히 not_run으로 남는다.
    try:
        run(report, "R-A05", schema_check)
    except ValueError:
        # 스키마 거부에도 명확히 확인할 수 있는 명시 키 누락만 별도 실패로 남긴다.
        if isinstance(submission, dict):
            for name in ("relations", "relation_candidates", "attributes"):
                items = submission.get(name)
                if isinstance(items, list) and any(isinstance(item, dict) and (
                        not isinstance(item.get("qualifiers"), dict) or
                        not {"polarity", "modality", "condition", "scope", "time"} <= item["qualifiers"].keys())
                        for item in items):
                    mark(report, "R-A08", "fail", "explicit_qualifier_keys_missing")
        raise
    entities, relations = submission["entities"], submission["relations"]
    candidates, attributes = submission["relation_candidates"], submission["attributes"]
    validation = graph._ExtractionValidation(submission["schema_version"], source, document, revision)
    claims = [*relations, *candidates, *attributes]

    def quotes():
        for item in [*entities, *claims]:
            if item.get("evidence") is not None:
                validation.evidence(item["evidence"])
            for identity in item.get("identifiers", []):
                validation.evidence(identity["evidence"])
        for item in relations:
            for field in ("subject", "object"):
                if isinstance(item[field], dict):
                    try:
                        normalize_anchor(item[field], document=document, source_revision=revision,
                                         source=source, evidence=item["evidence"])
                    except (ValueError, UnicodeError) as error:
                        # canonical 검증기의 기존 invalid_ontology 오류 계약을 유지한다.
                        raise OntologyValidationError(str(error)) from error

    run(report, "R-A07", quotes, applicable=bool(entities or claims))
    run(report, "R-A08", lambda: [values._qualifiers(item["qualifiers"], item.get("evidence"))
                                  for item in claims], applicable=bool(claims))

    def metadata():
        entity_types = {item["id"]: item["type"] for item in entities}
        for item in [*entities, *claims]:
            values._context(item.get("context", {}), item.get("evidence"))
        for item in claims:
            values._provenance(item.get("provenance", {}), item.get("evidence"), entity_types)

    run(report, "R-A09", metadata, applicable=bool(entities or claims))

    def references():
        graph._entities(entities, validation)
        for item in attributes:
            if item["subject"] not in validation.entity_ids:
                raise OntologyValidationError("attribute subject must reference an entity in this document")
        return graph._relations(relations, validation, claim_keys)

    claim_keys = set()
    run(report, "R-A06", references, applicable=bool(entities or relations or attributes or candidates))
    # 속성은 앞서 확인된 개체 참조표를 사용한다. 구조 통과가 값의 의미 귀속을 증명하지 않는다.
    if attributes:
        run(report, "R-A09", lambda: graph._attributes(attributes, validation))
    run(report, "R-A10", lambda: graph._candidates(candidates, validation, claim_keys), applicable=bool(candidates))
