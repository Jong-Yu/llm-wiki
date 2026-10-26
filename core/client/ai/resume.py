"""재개 전에 실제 저장 영수증과 현재 산출물을 조회한다. 저장을 재전송하지 않는다."""

from core.client.transport import AnalysisClientError, tool_call


def fixed_selection(job, profile, context_documents):
    basis = job.get("analysis_basis_ref")
    if job.get("legacy_rebase_required"):
        raise AnalysisClientError("analysis_basis_rebase_required")
    if basis is None:
        # 계획 생성 당시 관점을 우선하며, 서버가 계획/권한과 다시 대조한다.
        return profile or job.get("actor", {}).get("profile_id"), context_documents, None
    selected = basis["profile"]["profile_id"]
    if (profile is not None and profile != selected or context_documents is not None
            and context_documents != basis["context_documents"]):
        raise AnalysisClientError("analysis_basis_changed")
    return selected, basis["context_documents"], basis["ruleset_ref"]


async def completed_results(client, *, tenant, job, profile):
    rows = job.get("result_summary", {}).get("results", [])
    if any(row.get("state") == "pending_reconcile" or row.get("saved") is None for row in rows):
        raise AnalysisClientError("analysis_result_unconfirmed")
    basis = job.get("analysis_basis_ref")
    completed, receipts = set(), []
    for row in rows:
        if row.get("basis_current") is not True or row.get("saved") is not True:
            continue
        if row.get("state") != "complete" or basis is None:
            raise AnalysisClientError("analysis_result_unconfirmed")
        try:
            result = await tool_call(client, "analysis_job_result_query", {
                "tenant": tenant, "job_id": job["job_id"], "request_id": row["request_id"],
                **({"profile": profile} if profile else {})})
        except Exception:
            raise AnalysisClientError("analysis_result_unconfirmed") from None
        receipt = result.get("receipt") or {}
        if (result.get("job_revision") != job["job_revision"] or result.get("state") != "complete"
                or result.get("saved") is not True or receipt.get("document") != row["document"]
                or receipt.get("analysis_basis_revision") != basis["revision"]):
            raise AnalysisClientError("analysis_result_unconfirmed")
        if result.get("current_output", {}).get("status") != "current":
            raise AnalysisClientError("analysis_saved_output_changed")
        completed.add((row["document"], row["stage"]))
        receipts.append(result)
    return completed, receipts
