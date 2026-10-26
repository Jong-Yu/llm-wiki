"""대응의 HTTP 요청을 현재 권한·관점에서 기존 CorrespondenceStore에 연결한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Request
from pydantic import JsonValue
from core.api.dependencies import credential, access_value
from core.api.operations import json_operation, body_schema, reauthorize
from core.api.schemas import Envelope
from core.modules.correspondences.store import CorrespondenceStore
from . import schemas

router = APIRouter(tags=["correspondences"])


class AuthorizedStore(CorrespondenceStore):
    """기존 저장 과정의 마지막 공개 직전에 현재 권한을 다시 확인하는 HTTP 어댑터다."""

    def __init__(self, scope, before_commit):
        super().__init__(scope.store, access_value(scope))
        self.before_commit = before_commit

    def _publish(self, cid, encoded, existing, cleanup):
        # 오래 걸린 근거 확인 중 권한이 회수되었으면 기존 원장 교체 전에 멈춘다.
        if self.before_commit is not None:
            self.before_commit()
        return super()._publish(cid, encoded, existing, cleanup)


def invoke(scope, body, method, before_commit=None, **extra):
    """서버가 확인한 작성자와 저장소를 쓰며, 클라이언트의 actor 필드는 받지 않는다."""
    arguments = body.model_dump(exclude={"profile"})
    result = getattr(AuthorizedStore(scope, before_commit), method)(**arguments, **extra)
    return {**result, "access": access_value(scope)}


async def mutate(request, tenant, token, model, permission, method, **extra):
    """접수 때와 원장 공개 직전의 사용자·관점·권한이 같은 경우만 한 번 저장한다."""
    def operation(scope, body):
        return invoke(scope, body, method, before_commit=lambda: reauthorize(
            request, tenant, token, permission, body.profile, expected=scope), **extra)
    return await json_operation(request, tenant, token, model, permission, operation)


@router.post("/correspondences/find", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Find))
async def find(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """선택 문서의 기존 대응만 찾는다. 조회 자체가 제안이나 승인을 만들지는 않는다."""
    return await json_operation(request, tenant, token, schemas.Find, "read",
        lambda scope, body: invoke(scope, body, "find"))


@router.post("/correspondences/drafts/prepare", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Draft))
async def draft(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """새 제안의 전체 초안과 부재 판본을 준비하며 파일은 저장하지 않는다."""
    return await json_operation(request, tenant, token, schemas.Draft, "read",
        lambda scope, body: invoke(scope, body, "query"))


@router.post("/correspondences", status_code=201, response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Propose))
async def propose(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """준비에서 받은 같은 ID·초안·판본으로 미검토 제안 하나를 보존한다."""
    return await mutate(request, tenant, token, schemas.Propose, "ontology_write", "propose")


@router.post("/correspondences/{correspondence_id}/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Query))
async def query(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                token: Annotated[str, Depends(credential)]):
    """현재 판단과 실제 적용 조건·이력을 함께 읽고 오래된 근거를 그대로 구분한다."""
    return await json_operation(request, tenant, token, schemas.Query, "read",
        lambda scope, body: invoke(scope, body, "query", correspondence_id=correspondence_id))


@router.post("/correspondences/{correspondence_id}/changes/prepare", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Prepare))
async def prepare(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                  token: Annotated[str, Depends(credential)]):
    """정확한 수정 내용과 의존 판본에 묶인 확인 토큰을 준비한다. 쓰기 권한은 별도다."""
    return await json_operation(request, tenant, token, schemas.Prepare, "read",
        lambda scope, body: invoke(scope, body, "prepare", correspondence_id=correspondence_id))


@router.post("/correspondences/{correspondence_id}/reviews", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Review))
async def review(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                 token: Annotated[str, Depends(credential)]):
    """원문 근거 검토를 새 이벤트로 기록한다. 전문가 업무 판단을 덮어쓰지 않는다."""
    return await mutate(request, tenant, token, schemas.Review, "ontology_review", "review",
                        correspondence_id=correspondence_id)


@router.post("/correspondences/{correspondence_id}/review-undos", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Undo))
async def review_undo(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                     token: Annotated[str, Depends(credential)]):
    """지정한 검토의 역이벤트를 추가한다. 이전 원장 파일이나 이벤트를 삭제하지 않는다."""
    return await mutate(request, tenant, token, schemas.Undo, "ontology_review", "review_undo",
                        correspondence_id=correspondence_id)


@router.post("/correspondences/{correspondence_id}/policies", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Policy))
async def policy(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                 token: Annotated[str, Depends(credential)]):
    """원문 인용 없는 전문가 판단을 별도 권한과 실제 서버 작성자로 보존한다."""
    return await mutate(request, tenant, token, schemas.Policy, "ontology_policy", "policy",
                        correspondence_id=correspondence_id)


@router.post("/correspondences/{correspondence_id}/policy-undos", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(schemas.Undo))
async def policy_undo(correspondence_id: schemas.Identifier, request: Request, tenant: str,
                     token: Annotated[str, Depends(credential)]):
    """같은 관점의 정확한 전문가 판단만 새 역이벤트로 되돌린다."""
    return await mutate(request, tenant, token, schemas.Undo, "ontology_policy", "policy_undo",
                        correspondence_id=correspondence_id)
