# 로그인된 사용자가 자신에게 허용된 tenant와 행동을 찾는 첫 조회 API다.
# @router.get은 URL을 함수에 연결하고 Depends(credential)은 요청에서 인증 토큰을 읽어 전달한다.

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from core.api.dependencies import credential, envelope
from core.api.schemas import Envelope
from .schemas import AccessContext, AccessQuery

router = APIRouter(tags=["access"])


@router.get("/access-context", response_model=Envelope[AccessContext])
def access_context(request: Request, query: Annotated[AccessQuery, Query()],
                   token: Annotated[str, Depends(credential)]):
    """현재 인증 주체의 허용 tenant·행동·관점을 조회한다."""
    return envelope(request.app.state.policy.describe(token))
