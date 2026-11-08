"""확인된 추출 저장 뒤 같은 AI 대화로 대조하며 추출 성공과 대조 실패를 구분한다."""
import asyncio
from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import write_new


async def compare_stored_extraction(http, observed_adapter, *, tenant, profile, job_id,
                                    receipt, session, directory):
    """서버 토큰은 HTTP에만 남기고 명시 대화 ID를 이어가는 콜백만 대조기로 전달한다."""
    from core.client.comparison import run_comparison
    session_id = session.get("session_id") if isinstance(session, dict) else None
    if session_id is None:
        return {"status": "incomplete", "failure": "comparison_session_unavailable", "extraction_saved": True}

    async def continue_session(*, prompt, output_schema, directory):
        return await observed_adapter.run(prompt=prompt, schema=output_schema,
            directory=directory, session_id=session_id)

    try:
        result = await run_comparison(http, continue_session, base_url=str(http.base_url).rstrip('/'),
            tenant=tenant, profile=profile, job_id=job_id, document=receipt["document"],
            source_revision=receipt["source_revision"], graph_revision=receipt["graph_revision"],
            session_id=session_id, provider=session["provider"], directory=directory / "comparison")
        summary = {"status": result["status"], "comparison_id": result["record"]["id"],
            "lookup_count": result["lookup_count"], "extraction_saved": True}
    except asyncio.CancelledError:
        raise
    except Exception as error:
        summary = {"status": "incomplete", "failure": getattr(error, "code", "comparison_failed"),
            "extraction_saved": True}
    try:
        write_new(directory / "comparison-result.json", canonical_json_bytes(summary))
    except OSError:
        # 서버의 추출·대조 저장 결과는 로컬 요약 파일 보존 실패로 바꾸지 않는다.
        summary["local_record_error"] = "comparison_local_record_failed"
    return summary
