# 인증과 현재 read 권한을 확인한 저장소에서 문서 목록 또는 본문을 읽어 응답한다.
# 이 입구는 파일을 직접 열거나 고치지 않고 기존 목록 서비스와 WikiStore를 재사용한다.

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from pydantic import JsonValue
from core.api.dependencies import authorized, access_value, envelope, scope_key, credential
from core.api.operations import json_operation, body_schema, reauthorize
from core.api.schemas import Envelope
from core.modules.access.policy import AccessScope
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.documents.history import list_versions, read_version, save_content, restore_version
from .schemas import ContentQuery, DocumentContent, DocumentPage, ListQuery, VersionsQuery, SaveContent, RestoreContent

router = APIRouter(tags=["documents"])


@router.get("/documents", response_model=Envelope[DocumentPage])
def documents(query: Annotated[ListQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """허용된 위키 문서를 목록 기준에 묶인 페이지로 읽는다."""
    value = list_catalogue(scope.store, tenant=scope.tenant, scope_key=scope_key(scope),
                           limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/content", response_model=Envelope[DocumentContent])
def content(query: Annotated[ContentQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """상대 .md 경로의 최신 전체 본문과 같은 바이트의 revision을 읽는다."""
    snapshot = scope.store.read(query.document)
    return envelope({"document": query.document, "content": snapshot.content,
                     "revision": snapshot.revision, "access": access_value(scope)})


@router.put("/documents/content", response_model=Envelope[dict[str, JsonValue]],
            openapi_extra=body_schema(SaveContent))
async def save(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """본문 편집을 공통 저장기에 넘겨 수정 전 전체 이력과 기준 판본을 지킨다."""
    def operation(scope, body):
        return save_content(scope.store, body.document, body.content, body.expected_revision,
            before_commit=lambda: reauthorize(request, tenant, token, "write", body.profile, expected=scope))
    return await json_operation(request, tenant, token, SaveContent, "write", operation)


@router.get("/documents/versions", response_model=Envelope[dict[str, JsonValue]])
def versions(query: Annotated[VersionsQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """현재 본문 참조와 과거 전체 파일 목록을 별도로 반환한다."""
    value = list_versions(scope.store, query.document, tenant=scope.tenant,
                          scope_key=scope_key(scope), limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/versions/{history_id}", response_model=Envelope[dict[str, JsonValue]])
def version(history_id: str, query: Annotated[ContentQuery, Query()],
            scope: Annotated[AccessScope, Depends(authorized)]):
    """보관 파일 한 개의 전체 본문을 읽으며 과거 작성자·이유를 추정하지 않는다."""
    return envelope({**read_version(scope.store, query.document, history_id), "access": access_value(scope)})


@router.post("/documents/restorations", response_model=Envelope[dict[str, JsonValue]],
             openapi_extra=body_schema(RestoreContent))
async def restore(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """과거 본문을 새 저장으로 적용하되 그래프나 승인 상태를 자동 복원하지 않는다."""
    def operation(scope, body):
        return restore_version(scope.store, body.document, body.history_id, body.expected_revision,
            before_commit=lambda: reauthorize(request, tenant, token, "write", body.profile, expected=scope))
    return await json_operation(request, tenant, token, RestoreContent, "write", operation)
