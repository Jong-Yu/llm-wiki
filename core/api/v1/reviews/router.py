"""원문 근거 검토와 전문가 업무 판단을 별도 권한으로 기존 원장에 연결한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request, Path
from pydantic import JsonValue
from core.api.dependencies import authorized, credential, access_value, envelope, scope_key
from core.api.operations import json_operation, body_schema, reauthorize
from core.api.schemas import Envelope
from core.modules.access.policy import AccessScope
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.projection import list_events, read_event
from .schemas import DocumentReview, DocumentReviewUndo, DocumentPolicy, EventListQuery, EventQuery

router = APIRouter(tags=["reviews"])


def _mutation(scope, body, check_access, method):
    """인증 주체는 입력 JSON 대신 현재 권한에서 만들고 업무 저장은 기존 메서드에 위임한다."""
    check_access()
    fields = body.model_dump(exclude={"document", "profile"})
    value = getattr(ReviewStore(scope.store), method)(body.document, **fields, actor=access_value(scope),
                                                   before_commit=check_access)
    return {**value, "mutation_receipt": None, "retry_policy": "read_and_reconcile"}


async def _mutate_request(request, tenant, token, model, permission, method):
    """네 검토 쓰기의 본문·선택 관점·저장 직전 권한 연결을 같은 순서로 조립한다."""
    return await json_operation(request, tenant, token, model, permission,
        lambda scope, body: _mutation(scope, body,
            lambda: reauthorize(request, tenant, token, permission, body.profile, expected=scope), method))


@router.post("/documents/reviews", response_model=Envelope[dict[str, JsonValue]],
             openapi_extra=body_schema(DocumentReview))
async def review(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """실제 원문 인용에 근거한 승인·수정·거절·보류를 기록한다."""
    return await _mutate_request(request, tenant, token, DocumentReview, "ontology_review", "review")


@router.post("/documents/review-undos", response_model=Envelope[dict[str, JsonValue]],
             openapi_extra=body_schema(DocumentReviewUndo))
async def review_undo(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """기존 검토를 삭제하지 않고 정확한 이벤트의 되돌림을 새로 기록한다."""
    return await _mutate_request(request, tenant, token, DocumentReviewUndo, "ontology_review", "undo")


@router.post("/documents/policies", response_model=Envelope[dict[str, JsonValue]],
             openapi_extra=body_schema(DocumentPolicy))
async def policy(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """전문가의 업무 판단을 원문 인용을 발명하지 않고 별도 권한으로 기록한다."""
    return await _mutate_request(request, tenant, token, DocumentPolicy, "ontology_policy", "policy")


@router.post("/documents/policy-undos", response_model=Envelope[dict[str, JsonValue]],
             openapi_extra=body_schema(DocumentReviewUndo))
async def policy_undo(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """같은 관점의 마지막 전문가 판단을 삭제 없이 새 역이벤트로 되돌린다."""
    return await _mutate_request(request, tenant, token, DocumentReviewUndo, "ontology_policy", "policy_undo")


@router.get("/documents/events", response_model=Envelope[dict[str, JsonValue]])
def events(query: Annotated[EventListQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """전체 원장을 검증한 후 현재 범위·판본에 맞는 출력 페이지만 반환한다."""
    value = list_events(scope.store, query.document, tenant=scope.tenant, scope_key=scope_key(scope),
                        domain=scope.domain, viewpoint=scope.viewpoint, limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/events/{event_id}", response_model=Envelope[dict[str, JsonValue]])
def event(event_id: Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")],
          query: Annotated[EventQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """과거 이벤트의 당시 주장·이유·주체·판본과 현재 보류 여부를 읽는다."""
    value = read_event(scope.store, query.document, event_id, domain=scope.domain, viewpoint=scope.viewpoint)
    return envelope({**value, "access": access_value(scope)})
