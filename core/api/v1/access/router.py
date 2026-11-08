# 로그인된 사용자가 자신에게 허용된 tenant와 행동을 찾는 첫 조회 API다.
# @router.get은 URL을 함수에 연결하고 Depends(credential)은 요청에서 인증 토큰을 읽어 전달한다.

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from core.api.dependencies import credential, envelope
from core.api.schemas import Envelope
from core.api.errors import error_response
from core.api.ingress import read_json_model, RequestInputError
from core.modules.access.auth import AuthError
from core.modules.access.policy import PolicyError
from anyio import to_thread
from starlette.responses import JSONResponse
from .schemas import AccessContext, AccessQuery, AuthRequest, AuthResult

router = APIRouter(tags=["access"])


@router.get("/access-context", response_model=Envelope[AccessContext])
def access_context(request: Request, query: Annotated[AccessQuery, Query()],
                   token: Annotated[str, Depends(credential)]):
    """현재 인증 주체의 허용 tenant·행동·관점을 조회한다."""
    return envelope(request.app.state.policy.describe(token))


async def _authenticate_name(request, operation):
    if request.query_params:
        raise RequestInputError(422, "invalid_argument", "Authentication endpoints do not accept query fields.")
    body = await read_json_model(request, AuthRequest, maximum=4096)
    auth = getattr(request.app.state, "auth", None)
    if auth is None:
        raise PolicyError()
    try:
        value = await to_thread.run_sync(getattr(auth, operation), body.name)
    except AuthError as error:
        return error_response(error.status, error.code, error.message)
    # 토큰은 이 두 응답에서만 반환하며 프록시/브라우저에 캐시하지 않는다.
    value = AuthResult.model_validate(value).model_dump()
    return JSONResponse(envelope(value), headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@router.post("/auth/signup", response_model=Envelope[AuthResult], openapi_extra={
    "requestBody": {"required": True, "content": {"application/json": {"schema": AuthRequest.model_json_schema()}}}})
async def signup(request: Request):
    return await _authenticate_name(request, "signup")


@router.post("/auth/login", response_model=Envelope[AuthResult], openapi_extra={
    "requestBody": {"required": True, "content": {"application/json": {"schema": AuthRequest.model_json_schema()}}}})
async def login(request: Request):
    return await _authenticate_name(request, "login")
