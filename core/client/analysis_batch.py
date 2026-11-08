"""사용자가 선택한 기존 작업만 순서대로 실행한다. 규약 변경이 자동 실행을 만들지 않는다."""
import asyncio
import re

from core.client.transport import AnalysisClientError, client_error_code


def selection(value):
    if type(value) is not list or not 1 <= len(value) <= 8:
        raise AnalysisClientError("invalid_analysis_batch")
    seen = set()
    for row in value:
        if (type(row) is not dict or set(row) != {"job_id", "expected_job_revision"}
                or type(row["job_id"]) is not str or re.fullmatch(r"[0-9a-f]{32}", row["job_id"]) is None
                or type(row["expected_job_revision"]) is not str
                or re.fullmatch(r"[0-9a-f]{64}", row["expected_job_revision"]) is None
                or row["job_id"] in seen):
            raise AnalysisClientError("invalid_analysis_batch")
        seen.add(row["job_id"])
    return [dict(row) for row in value]


async def run_selected(value, execute):
    selected = selection(value)
    results = []
    for row in selected:
        try:
            result = await execute(**row)
        except asyncio.CancelledError:
            # 이미 완료된 작업의 저장 영수증은 보존하며 나머지 작업을 시작하지 않는다.
            raise
        except Exception as error:
            results.append({**row, "ok": False, "error_code": client_error_code(error) or "analysis_execution_failed"})
        else:
            results.append({**row, "ok": True, "result": result})
    return {"status": "complete" if all(row["ok"] for row in results) else "partial_failure",
            "selection": selected, "results": results, "automatic_expansion": False, "automatic_retry": False}
