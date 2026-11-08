"""독립 관계 추가·역이벤트·저장 영수증의 인증된 HTTP 경계."""
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import Field, JsonValue
from core.api.schemas import Model, Envelope
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import json_operation, body_schema, reauthorize
from core.modules.access.policy import AccessScope
from core.modules.reviews.relations import RelationStore
from .schemas import EventQuery

router = APIRouter(tags=['reviews'])


class RelationCreate(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_state_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    kind: Literal['source', 'policy']
    replacement: dict[str, JsonValue]
    reason: str = Field(min_length=1, max_length=1000)


class RelationUndo(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    event_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_state_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    kind: Literal['source', 'policy']
    reason: str = Field(min_length=1, max_length=1000)


def mutate(request, tenant, token, scope, body, method):
    # read 허용 후 kind의 별도 변경 권한을 확인하며 공개 직전에도 같은 범위를 재검사한다.
    permission = 'ontology_policy' if body.kind == 'policy' else 'ontology_review'
    check = lambda: reauthorize(request, tenant, token, permission, body.profile, expected=scope)
    check()
    return getattr(RelationStore(scope.store, access_value(scope)), method)(body.document,
        **body.model_dump(exclude={'document', 'profile'}), before_commit=check)


@router.post('/documents/relations', response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(RelationCreate))
async def create(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, RelationCreate, 'read',
        lambda scope, body: mutate(request, tenant, token, scope, body, 'create'))


@router.post('/documents/relation-undos', response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(RelationUndo))
async def undo(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, RelationUndo, 'read',
        lambda scope, body: mutate(request, tenant, token, scope, body, 'undo'))


@router.get('/documents/relation-requests/{request_id}', response_model=Envelope[dict[str, JsonValue]])
def receipt(request_id: Annotated[str, Path(pattern=r'^[a-f0-9]{32}$')], query: Annotated[EventQuery, Query()],
            scope: Annotated[AccessScope, Depends(authorized)]):
    result = RelationStore(scope.store, access_value(scope)).request(query.document, request_id=request_id)
    return envelope({**result, 'access': access_value(scope)})
