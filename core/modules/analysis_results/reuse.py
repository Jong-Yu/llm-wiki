"""과거 영수증 조회와 현재 작업 결과의 재사용 가능성을 별도로 판정한다."""

from core.modules.analysis_inputs import basis, capture
from core.modules.analysis_inputs.contracts import InputConflictError
from core.modules.analysis_jobs import commands, records
from core.modules.analysis_jobs.contracts import JobConflictError
from core.modules.documents.store import StorageBusyError
from core.modules.extraction_rules.contracts import RulesetError


def observe(service, job, actor):
    """조정 잠금 아래 호출한다. 자료를 고치거나 만료된 실행을 다시 맡지 않는다.

    최신 문서 hash만 같아도 검토·맥락·권한 또는 A→B→A 이력이 바뀌었을 수
    있다. 원래 작업 기준에서 확인된 자기 저장 연쇄만 허용하고 모두 대조한다.
    실패해도 과거의 실제 저장 영수증은 조회할 수 있게 상태로 돌려준다.
    """
    try:
        fixed = basis.active(job)
        if fixed is None:
            return {"status": "unavailable", "code": "analysis_basis_required"}
        if job["state"] == "cancelled":
            return {"status": "changed", "code": "job_cancelled"}
        records.check_access(job["actor"], actor)
        commands.check_basis(service.jobs, job["source_ref"])
        if service.rulesets is None:
            return {"status": "unavailable", "code": "ruleset_unconfigured"}
        service.rulesets.validate_reference(job["tenant"], fixed["ruleset_ref"])
        with service.store._write_lock():
            if capture.profile(actor) != fixed["profile"]:
                raise InputConflictError("analysis_basis_changed")
            _, dependencies, _ = capture.documents_locked(service.store, fixed["context_documents"], actor)
            basis.validate_captured(service.inputs, job, fixed, fixed["context_documents"],
                                    dependencies, basis.targets_locked(service.inputs, job))
        return {"status": "current", "analysis_basis_revision": fixed["revision"],
                "ruleset_ref": fixed["ruleset_ref"], "scope": "job_and_confirmed_saves"}
    except (InputConflictError, JobConflictError, RulesetError) as error:
        return {"status": "changed", "code": error.code}
    except (OSError, ValueError, TypeError, StorageBusyError):
        return {"status": "unavailable", "code": "reuse_basis_unavailable"}
