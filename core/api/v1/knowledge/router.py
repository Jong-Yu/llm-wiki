# 원시 기계 그래프와 현재 검토 판단을 함께 읽어 사용 가능한 지식으로 반환한다.
# 선택한 profile의 관점은 조회 정렬/선택 기준이며 tenant 자료 접근 권한을 대신하지 않는다.

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from pydantic import JsonValue
from core.api.dependencies import authorized, access_value, envelope, credential
from core.api.operations import json_operation, body_schema
from core.api.schemas import Envelope
from core.modules.access.policy import AccessScope
from core.modules.documents.search import search_documents
from core.modules.documents.listing import _error_code
from core.modules.ontology.store import OntologyStore
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.impact import ImpactStore
from core.modules.knowledge.aggregation import review_queue, history_query, prepare_question
from core.modules.reviews.store import ReviewStore
from .schemas import (
    DocumentKnowledge, KnowledgeQuery, SearchQuery, ConnectionsQuery,
    ContextRequest, FindRequest, ConceptRequest, ImpactRequest,
    ReviewQueueRequest, HistoryRequest, QuestionContextRequest,
)

router = APIRouter(tags=["knowledge"])


@router.get("/documents/knowledge", response_model=Envelope[DocumentKnowledge])
def knowledge(query: Annotated[KnowledgeQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """전체 원장과 현재 관점의 유효 지식·보류 상태·출처를 함께 읽는다."""
    value = ReviewStore(scope.store).query(query.document, domain=scope.domain, viewpoint=scope.viewpoint)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/search", response_model=Envelope[dict[str, JsonValue]])
def search(query: Annotated[SearchQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """허용 저장소에서 원문 문자열을 찾고 읽지 못한 항목·탐색 한도를 그대로 알린다."""
    value = search_documents(scope.store, query.query, query.limit, read_error_code=_error_code)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/ontology", response_model=Envelope[dict[str, JsonValue]])
def ontology(query: Annotated[KnowledgeQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """현재 원문과 대조한 기계층을 읽는다. 전문가 판단은 knowledge API에서 별도로 읽는다."""
    value = OntologyStore(scope.store).query(query.document, domain=scope.domain, viewpoint=scope.viewpoint)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/connections", response_model=Envelope[dict[str, JsonValue]])
def connections(query: Annotated[ConnectionsQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """명시 링크와 이름·유형이 같은 미확정 후보를 합치지 않고 반환한다."""
    value = OntologyStore(scope.store).connections(query.document, query.limit)
    return envelope({**value, "access": access_value(scope)})


@router.post("/knowledge/context/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(ContextRequest))
async def context(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """선택 문서의 전체 원문·기계 그래프를 읽으며 다른 관점의 조건도 보존한다."""
    return await json_operation(request, tenant, token, ContextRequest, "read",
        lambda scope, body: OntologyStore(scope.store).context(body.documents, domain=scope.domain, viewpoint=scope.viewpoint))


def _concept(scope, body, method):
    """기존 개념 서비스에 서버가 확인한 관점과 엄격한 입력만 전달한다."""
    arguments = body.model_dump(exclude={"profile"})
    return getattr(ConceptStore(scope.store, actor=access_value(scope)), method)(
        **arguments, tenant=scope.tenant, policy_revision=scope.policy_revision,
        profile={"profile_id": scope.profile_id, "domain": scope.domain, "viewpoint": scope.viewpoint})


@router.post("/concepts/find", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(FindRequest))
async def find(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """문자열로 버전이 있는 개념 후보를 발견하며 동일 개체로 확정하지 않는다."""
    return await json_operation(request, tenant, token, FindRequest, "read", lambda scope, body: _concept(scope, body, "find"))


@router.post("/concepts/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(ConceptRequest))
async def concept(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """명시한 target_ref의 현재 판단·출처·범위를 기존 개념 서비스에서 함께 읽는다."""
    return await json_operation(request, tenant, token, ConceptRequest, "read", lambda scope, body: _concept(scope, body, "query"))


@router.post("/documents/impact/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(ImpactRequest))
async def impact(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """기준 네 판본과 현재 직접 영향을 비교한다. 저장·재추출은 실행하지 않는다."""
    return await json_operation(request, tenant, token, ImpactRequest, "read", lambda scope, body:
        ImpactStore(scope.store).query(body.document, body.limit,
            baseline=body.baseline.model_dump() if body.baseline is not None else None,
            domain=scope.domain, viewpoint=scope.viewpoint))


@router.post("/review-queue/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(ReviewQueueRequest))
async def queue(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """명시 문서·대응의 미검토/보류/옛 기준 항목만 페이지로 모은다."""
    return await json_operation(request, tenant, token, ReviewQueueRequest, "read", lambda scope, body:
        review_queue(scope.store, access_value(scope), **body.model_dump(exclude={"profile"})))


@router.post("/history/query", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(HistoryRequest))
async def history(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """원문 보관·검토·정책·대응·본인 작업 이력을 출처 종류를 유지해 모은다."""
    return await json_operation(request, tenant, token, HistoryRequest, "read", lambda scope, body:
        history_query(scope.store, access_value(scope), **body.model_dump(exclude={"profile"})))


@router.post("/question-context/prepare", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(QuestionContextRequest))
async def question_context(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """질문 근거의 현재 판본을 고정해 반환한다. AI 실행·영구 snapshot 저장은 하지 않는다."""
    return await json_operation(request, tenant, token, QuestionContextRequest, "read", lambda scope, body:
        prepare_question(scope.store, access_value(scope), **body.model_dump(exclude={"profile"})))
