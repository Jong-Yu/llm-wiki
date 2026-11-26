"""오류 보고 접수만 제공하며 목록·조회·피드백 경로는 제공하지 않는다."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from core.api.concurrency import run_owned_thread
from core.api.dependencies import credential, envelope
from core.api.ingress import RequestInputError, read_json_model
from core.api.operations import body_schema
from core.api.schemas import Envelope
from core.modules.access.policy import AccessDenied
from core.modules.voc.store import save_report
from .schemas import ReportReceipt, ReportRequest


router = APIRouter(tags=["voc"])


@router.post("/voc", status_code=201, response_model=Envelope[ReportReceipt],
             openapi_extra=body_schema(ReportRequest))
async def submit_report(request: Request, token: Annotated[str, Depends(credential)]):
    """현재 로그인으로만 작성자를 정하며 소속 배정 전에도 오류를 보고할 수 있다."""
    if request.query_params:
        raise RequestInputError(422, "invalid_argument", "Error reports do not accept query fields.")
    value = await read_json_model(request, ReportRequest)

    def execute():
        policy = request.app.state.policy
        user_id = policy.authenticate(token)

        def before_commit():
            # 수신 이후 토큰이 회수되거나 다른 사용자에 연결되면 저장하지 않는다.
            if policy.authenticate(token) != user_id:
                raise AccessDenied()

        return save_report(policy.tenant_root, user_id=user_id, content=value.content,
            before_commit=before_commit)

    result = await run_owned_thread(execute)
    return JSONResponse(envelope(result), status_code=201, headers={"Cache-Control": "no-store"})
