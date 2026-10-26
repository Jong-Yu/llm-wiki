"""조회는 고정 입력 존재만 안내하고 현재 입력 검증 성공을 추측하지 않는다."""

# 준비한 묶음이 있다는 사실과, 지금 저장에 써도 된다는 판정은 다르다.
# 여기서는 안내 상태만 만들고 실제 저장 직전의 전체 입력 대조는 저장 경계에서 수행한다.


def project(jobs, job):
    # reversed로 최근 이벤트부터 살펴 현재 run에서 마지막으로 준비한 입력 참조를 찾는다.
    active = None
    from .basis import active as job_basis
    basis = job_basis(job)
    for event in reversed(job["events"]):
        details = event["details"]
        if details.get("operation") == "input_prepared" and details.get("run_id") == job["run_id"]:
            active = {key: details[key] for key in ("bundle_id", "bundle_revision", "stage")}
            break
    if jobs.rulesets is None:
        status, blockers = "unconfigured", ["common_ruleset_required", "fixed_input_bundle_required"]
    else:
        try:
            if basis is None:
                jobs.rulesets.read(job["tenant"])
            else:
                jobs.rulesets.validate_reference(job["tenant"], basis["ruleset_ref"])
        except (OSError, ValueError):
            status, blockers = "unconfigured", ["ruleset_unavailable"]
        else:
            # 묶음이 있어도 이후 원문/규약이 바뀔 수 있어 validation_required로 표시한다.
            status = "not_prepared" if active is None else "validation_required"
            blockers = ["fixed_input_bundle_required"] if active is None else ["input_revalidation_required"]
    legacy = basis is None and any(event["details"].get("operation") == "input_prepared" for event in job["events"])
    if legacy:
        blockers.append("analysis_basis_rebase_required")
    return {"input_readiness": status, "active_input_ref": active,
            "analysis_basis_ref": None if basis is None else {
                "revision": basis["revision"], "ruleset_ref": basis["ruleset_ref"],
                "profile": basis["profile"], "context_documents": basis["context_documents"]},
            "legacy_rebase_required": legacy,
            "blockers": [*blockers, "personal_ai_execution_required"] if jobs.rulesets is not None else blockers}
