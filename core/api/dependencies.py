# 여러 API가 함께 쓰는 인증·현재 권한·응답 포장 함수다.
# Depends는 요청 처리 전에 이 함수를 실행하고, 서버가 확인한 값을 담당 함수에 전달하게 한다.

"""현재 정책 인가를 동기 업무 실행과 같은 작업 스레드에서 수행한다."""

from hashlib import sha256
import json
from typing import Annotated
from uuid import uuid4
from fastapi import Depends, Request, Security
from fastapi.security import HTTPBearer

from core.common.access import access_basis, access_dict
from core.common.read_metrics import span
from core.runtime.http_security import bearer


# 헤더에서 이번 요청의 토큰을 꺼낸다. 사용자 ID를 요청 본문에서 받지 않는다.
def credential(request: Request, ignored=Security(HTTPBearer(auto_error=False))) -> str:
    # 인증 오류 응답은 root middleware가 소유하며 사용자 입력에서 신원을 받지 않는다.
    return bearer(request.scope)


# 현재 tenant/profile의 read 권한을 확인해 저장소를 포함한 AccessScope를 반환한다.
def authorized(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    profile = request.query_params.get("profile")
    with span("authorization"):
        return request.app.state.policy.authorize(token, tenant, "read", profile)


def authorize_source(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """원본 등록만 허용하며 canonical 위키·그래프·검토 쓰기를 부여하지 않는다."""
    with span("authorization"):
        return request.app.state.policy.authorize(token, tenant, "source_write")


# scope 객체의 필요한 속성만 응답용 dict로 옮긴다. getattr(scope, name)은 이름으로 속성을 읽는다.
def access_value(scope):
    return access_dict(scope)


# 목록 페이지를 같은 사용자/관점/정책 범위에 묶을 지문을 만든다. 접근 권한 자체는 아니다.
def scope_key(scope):
    return sha256(json.dumps(access_basis(scope), sort_keys=True).encode()).hexdigest()


# 업무 결과를 data 아래에, 이번 응답 추적 ID를 meta 아래에 넣는다.
def envelope(value):
    return {"data": value, "meta": {"trace_id": uuid4().hex}}
