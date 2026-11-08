"""추출 초안의 누락·의미 의견을 그래프/전문가 원장과 분리해 검증한다.

진단은 클라이언트의 보고다. 실제 인용·위치·제출 대상은 검사하지만 의미 지지나
사람 승인을 인증하지 않는다. 원래 제출과 함께 불변 보관하며 조회로 회수한다.
"""

import json
from copy import deepcopy
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from .contracts import ResultError

MAX_DIAGNOSTIC_BYTES = 256 * 1024
Text = Annotated[StrictStr, Field(min_length=1, max_length=2000)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SourceRange(Model):
    start_line: Annotated[StrictInt, Field(ge=1)]
    end_line: Annotated[StrictInt, Field(ge=1)]


class SourceQuote(SourceRange):
    quote: Annotated[StrictStr, Field(min_length=1, max_length=4000)]


class DraftTarget(Model):
    collection: Literal["entities", "relations", "attributes", "relation_candidates"]
    index: Annotated[StrictInt, Field(ge=0)]


class Finding(Model):
    rule_id: Annotated[StrictStr, Field(pattern=r"^R-S(0[1-9]|10)$")]
    verdict: Literal["supported", "contradicted", "unsupported", "condition_loss", "ambiguous",
                     "omission", "schema_limit", "not_run", "undetermined"]
    source: SourceQuote | None
    target: DraftTarget | None
    reason: Text
    recommendation: Text | None
    question: Text | None


class DiagnosticReport(Model):
    schema_version: Literal[1]
    reviewer_kind: Literal["ai_self_check", "separate_ai", "human_reported", "not_reported"]
    warnings: Annotated[list[Text], Field(max_length=100)]
    omissions: Annotated[list[Text], Field(max_length=100)]
    unread_ranges: Annotated[list[Text], Field(max_length=100)]
    reviewed_ranges: Annotated[list[SourceRange], Field(max_length=100)]
    findings: Annotated[list[Finding], Field(max_length=100)]


Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
Identifier = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{32}$")]
SEMANTIC_RULES = [f"R-S{number:02d}" for number in range(1, 11)]
PROBLEM_VERDICTS = {"contradicted", "unsupported", "condition_loss", "omission", "schema_limit"}
UNRESOLVED_VERDICTS = {"ambiguous", "not_run", "undetermined"}


class RuleResult(Model):
    rule_id: Annotated[StrictStr, Field(pattern=r"^R-S(0[1-9]|10)$")]
    status: Literal["pass", "fail", "not_run", "not_applicable", "error"]
    reason: Text
    finding_indices: Annotated[list[Annotated[StrictInt, Field(ge=0)]], Field(max_length=100)]


class RulesetReference(Model):
    ruleset_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    ruleset_version: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    ruleset_revision: Digest


class CheckInput(Model):
    job_id: Identifier
    run_id: Identifier
    bundle_id: Identifier
    bundle_revision: Digest
    document: Annotated[StrictStr, Field(min_length=1, max_length=4096)]
    source_revision: Digest
    submission_sha256: Digest
    schema_version: Literal[3, 4, 5, 6]
    ruleset_ref: RulesetReference


class CheckExecution(Model):
    provider: Literal["codex", "claude"]
    cli_version: Annotated[StrictStr, Field(min_length=1, max_length=100)]
    prompt_sha256: Digest
    schema_sha256: Digest
    output_sha256: Digest


class SemanticCheck(Model):
    check_id: Identifier
    input: CheckInput
    source_audit_execution: CheckExecution | None
    assessment_execution: CheckExecution | None
    source_audit_sha256: Digest | None
    source_audit: Annotated[StrictStr, Field(min_length=1, max_length=16000)] | None


class DiagnosticReportV2(DiagnosticReport):
    schema_version: Literal[2]
    rule_results: Annotated[list[RuleResult], Field(min_length=10, max_length=10)]
    semantic_check: SemanticCheck | None


def schema(version=None):
    """MCP/개인 CLI가 같은 진단 출력 계약을 사용한다."""
    if version == 1:
        return DiagnosticReport.model_json_schema()
    if version == 2:
        return DiagnosticReportV2.model_json_schema()
    # v1 릴리스를 읽는 경로는 원래 스키마 바이트도 허용한다. 새 발행은 두 버전을 명시한다.
    from pydantic import TypeAdapter
    return {"type": "object", **TypeAdapter(DiagnosticReport | DiagnosticReportV2).json_schema()}


def legacy_schema(version=None):
    """기존 Codex 전용 발행의 정확한 스키마를 재구성한다. 발행 파일은 수정하지 않는다."""
    value = schema(version)
    if "CheckExecution" in value.get("$defs", {}):
        value["$defs"]["CheckExecution"]["properties"]["provider"] = {
            "const": "codex", "title": "Provider", "type": "string"}
    return value


def validation_schema(published_schema):
    """알려진 구 스키마의 실행 제공자만 확장한 검증 사본을 반환한다.

    원래 규약/고정 입력의 바이트와 hash, 진단 내용은 그대로 보존한다. 다른 스키마는
    변경하지 않으며 v1에 v2 의미 검사 기능을 추가하거나 임의 제약을 완화하지 않는다.
    """
    raw = canonical_json_bytes(published_schema)
    for version in (None, 2):
        if raw == canonical_json_bytes(legacy_schema(version)):
            return schema(version)
    return deepcopy(published_schema)


def empty_report():
    """검토가 보고되지 않았음을 명시한다. 빈 배열을 의미 검토 통과로 해석하지 않는다."""
    return {"schema_version": 1, "reviewer_kind": "not_reported", "warnings": [],
            "omissions": [], "unread_ranges": [], "reviewed_ranges": [], "findings": []}


def _range(value, lines):
    if not 1 <= value.start_line <= value.end_line <= len(lines):
        raise ResultError("invalid_diagnostics")


def source_text(manifest, components, payload):
    """단계가 고정한 증거 원문을 반환한다. 참고 문서로 대체하지 않는다."""
    if manifest["stage"] == "prepare_wiki":
        return components.get("data/registration.md", components.get("data/extraction.txt", ""))
    context = json.loads(components["data/context.json"])
    return next(item["source"]["content"] for item in context["documents"] if item["document"] == payload["document"])


def _validate_finding(finding, source, lines, payload):
    if finding.source is not None:
        selected = finding.source
        _range(selected, lines)
        start = sum(len(line) for line in lines[:selected.start_line - 1])
        end = sum(len(line) for line in lines[:selected.end_line])
        at = source.find(selected.quote, start, end)
        # 시작/끝 줄까지 맞아야 한다. 넓은 범위 안 어딘가의 인용은 인정하지 않는다.
        first_end = start + len(lines[selected.start_line - 1])
        last_start = end - len(lines[selected.end_line - 1])
        if at < 0 or not start <= at < first_end or not last_start <= at + len(selected.quote) - 1 < end:
            raise ResultError("invalid_diagnostics")
    elif finding.verdict not in UNRESOLVED_VERDICTS:
        raise ResultError("diagnostic_evidence_required")
    if finding.target is not None:
        submission = payload.get("submission", {})
        items = submission.get(finding.target.collection) if type(submission) is dict else None
        if type(items) is not list or finding.target.index >= len(items):
            raise ResultError("invalid_diagnostics")


def validate(value, manifest, components, payload):
    """고정한 실제 위키/추출 문자에서 인용 위치와 초안 배열 대상을 확인한다."""
    if value is None:
        return
    try:
        if type(value) is not dict or type(value.get("schema_version")) is not int:
            raise ResultError("invalid_diagnostics")
        if len(canonical_json_bytes(value)) > MAX_DIAGNOSTIC_BYTES:
            raise ResultError("diagnostic_limit")
        if "rules/diagnostics.schema.json" in components:
            from jsonschema import Draft202012Validator
            published = json.loads(components["rules/diagnostics.schema.json"])
            if not Draft202012Validator(validation_schema(published)).is_valid(value):
                raise ResultError("invalid_diagnostics")
        model = DiagnosticReport if value["schema_version"] == 1 else DiagnosticReportV2
        report = model.model_validate(value)
        source = source_text(manifest, components, payload)
        lines = source.splitlines(keepends=True)
        for selected in report.reviewed_ranges:
            _range(selected, lines)
        for finding in report.findings:
            _validate_finding(finding, source, lines, payload)
        if report.reviewer_kind == "not_reported" and (report.findings or report.reviewed_ranges):
            raise ResultError("invalid_diagnostics")
        if isinstance(report, DiagnosticReportV2):
            _validate_rules(report, manifest, payload)
    except (ValidationError, KeyError, TypeError, StopIteration, ValueError) as error:
        if isinstance(error, ResultError):
            raise
        raise ResultError("invalid_diagnostics") from error


def _validate_rules(report, manifest, payload):
    """자기보고의 완전한 규칙 목록과 정확 입력만 검사한다. 의미 결론을 서버 결론으로 바꾸지 않는다."""
    if sorted(item.rule_id for item in report.rule_results) != SEMANTIC_RULES:
        raise ResultError("invalid_diagnostics")
    for result in report.rule_results:
        _validate_rule_result(report, result)
    _validate_check(report, manifest, payload)


def _validate_rule_result(report, result):
    if not result.reason.strip() or len(set(result.finding_indices)) != len(result.finding_indices):
        raise ResultError("invalid_diagnostics")
    linked = []
    for index in result.finding_indices:
        if index >= len(report.findings) or report.findings[index].rule_id != result.rule_id:
            raise ResultError("invalid_diagnostics")
        linked.append(report.findings[index])
    if result.status in {"pass", "fail"} and not report.reviewed_ranges:
        raise ResultError("diagnostic_evidence_required")
    if result.status == "fail" and not any(item.verdict in PROBLEM_VERDICTS for item in linked):
        raise ResultError("diagnostic_evidence_required")
    # schema_limit은 확인한 표현 손실이다. 미판정(not_run)이나 의미 통과로 바꾸지 않는다.
    findings = [item for item in report.findings if item.rule_id == result.rule_id]
    if result.status == "pass" and any(item.verdict != "supported" for item in findings):
        raise ResultError("invalid_diagnostics")
    if result.rule_id == "R-S10" and result.status == "pass" and (report.omissions or report.unread_ranges):
        raise ResultError("invalid_diagnostics")
    if result.status == "not_applicable" and findings:
        raise ResultError("invalid_diagnostics")
    if result.status == "not_run" and any(item.verdict not in UNRESOLVED_VERDICTS for item in findings):
        raise ResultError("invalid_diagnostics")
    if report.reviewer_kind == "not_reported" and result.status != "not_run":
        raise ResultError("invalid_diagnostics")


def _validate_check(report, manifest, payload):
    check = report.semantic_check
    if report.reviewer_kind == "separate_ai" and check is None:
        raise ResultError("diagnostic_check_input_required")
    if check is not None:
        if manifest["stage"] != "extract_ontology" or "submission" not in payload:
            raise ResultError("invalid_diagnostics")
        expected = {key: payload[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "document")}
        expected.update(source_revision=payload["expected_revision"],
                        submission_sha256=canonical_json_hash(payload["submission"]),
                        schema_version=payload["submission"].get("schema_version"), ruleset_ref=manifest["ruleset_ref"])
        if check.input.model_dump() != expected:
            raise ResultError("diagnostic_check_input_mismatch")
        from hashlib import sha256
        if (check.source_audit is None) != (check.source_audit_sha256 is None):
            raise ResultError("invalid_diagnostics")
        if check.source_audit is not None and sha256(check.source_audit.encode()).hexdigest() != check.source_audit_sha256:
            raise ResultError("invalid_diagnostics")
        if report.reviewer_kind == "separate_ai" and any(
                row.status in {"pass", "fail", "not_applicable"} for row in report.rule_results):
            if check.source_audit_execution is None or check.assessment_execution is None or check.source_audit is None:
                raise ResultError("diagnostic_execution_required")


def partial_report(value, manifest, components, payload):
    """별도 검사에서 유효한 규칙/인용만 별도 파생 보고로 보존한다. 원본은 호출자가 보존한다.

    상태를 추측 교정하지 않는다. 잘못된 규칙은 error이며 유효한 finding의 verdict는
    그대로 둔다. 전역 형식·기준·실행 기록 오류는 부분 복구하지 않고 기존 전체 실패로 보낸다.
    저장 검증기는 이 함수를 자동 호출하지 않으며 원래 잘못된 보고를 계속 거부한다.
    """
    report = DiagnosticReportV2.model_validate(value)
    if (report.reviewer_kind != "separate_ai" or len(canonical_json_bytes(value)) > MAX_DIAGNOSTIC_BYTES
            or sorted(row.rule_id for row in report.rule_results) != SEMANTIC_RULES):
        raise ResultError("invalid_diagnostics")
    _validate_check(report, manifest, payload)
    source = source_text(manifest, components, payload)
    lines = source.splitlines(keepends=True)
    for selected in report.reviewed_ranges:
        _range(selected, lines)
    accepted, invalid, issues = {}, set(), []
    for index, finding in enumerate(report.findings):
        try:
            _validate_finding(finding, source, lines, payload)
            accepted[index] = len(accepted)
        except ResultError as error:
            invalid.add(finding.rule_id)
            issues.append({"rule_id": finding.rule_id, "finding_index": index, "code": error.code})
    result = deepcopy(value)
    result["findings"] = [value["findings"][index] for index in accepted]
    for row, original in zip(result["rule_results"], report.rule_results):
        try:
            _validate_rule_result(report, original)
            if original.rule_id in invalid:
                raise ResultError("invalid_diagnostics")
            row["finding_indices"] = [accepted[index] for index in original.finding_indices]
        except ResultError as error:
            issues.append({"rule_id": original.rule_id, "original_status": original.status, "code": error.code})
            row.update(status="error", reason="semantic_check_rule_report_error; inspect preserved assessment",
                       finding_indices=[index for index, finding in enumerate(result["findings"])
                                        if finding["rule_id"] == original.rule_id])
    result["warnings"].append("semantic_check_partial_report; invalid original assessment preserved separately")
    validate(result, manifest, components, payload)
    return result, issues


def semantic_summary(value):
    """v1의 부분 의견은 규칙별 통과로 소급 해석하지 않는다."""
    results = value.get("rule_results") if value else None
    return {"status": "client_reported" if results else "not_run", "human_approval": False,
            "reviewer_kind": value.get("reviewer_kind", "not_reported") if value else "not_reported",
            "rule_results": results or [{"rule_id": rule, "status": "not_run",
                "reason": "no_per_rule_assessment_reported", "finding_indices": []} for rule in SEMANTIC_RULES]}


def observation(payload, manifest=None, *, validated=False):
    """불변 제출의 진단과 기준을 읽기용으로 묶는다. 그래프 claim/승인으로 변환하지 않는다."""
    value = payload.get("diagnostics")
    if value is None:
        return None
    basis = {key: payload[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "document", "stage")}
    basis.update(source_revision=payload["expected_revision"],
                 submission_hash=canonical_json_hash(payload.get("submission", payload.get("content"))))
    if manifest is not None:
        basis.update(ruleset_ref=manifest["ruleset_ref"], extraction_ref=manifest["dependency"]["extraction"],
                     analysis_basis_revision=manifest.get("analysis_basis_revision"))
        basis["evidence_source"] = ({"kind": "extraction", **manifest["dependency"]["extraction"]}
                                    if manifest["stage"] == "prepare_wiki" else
                                    {"kind": "wiki", "document": payload["document"],
                                     "source_revision": payload["expected_revision"]})
    return {"report_id": payload["request_id"], "report_hash": canonical_json_hash(value),
            "origin": "client_reported", "human_approval": False,
            "validation": "structure_and_source_checked" if validated else "not_validated",
            "basis": basis, "report": value,
            "semantic": semantic_summary(value) if validated else semantic_summary(None)}
