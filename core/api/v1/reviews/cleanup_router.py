"""UI HTTP transport for the same cleanup service exposed by tenant MCP."""
from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request, Path
from pydantic import JsonValue

from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import json_operation, body_schema, reauthorize
from core.api.schemas import Envelope
from core.modules.access.policy import AccessScope
from core.modules.reviews.cleanup import CleanupStore
from .schemas import CleanupApply, CleanupUndo, EventListQuery, EventQuery

router = APIRouter(tags=["reviews"])


@router.get("/documents/cleanup-preview", response_model=Envelope[dict[str, JsonValue]])
def preview(query: Annotated[EventListQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    value = CleanupStore(scope.store, access_value(scope)).preview(query.document, limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/cleanup-events", response_model=Envelope[dict[str, JsonValue]])
def history(query: Annotated[EventListQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    value = CleanupStore(scope.store, access_value(scope)).history(query.document, limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/documents/cleanup-requests/{request_id}", response_model=Envelope[dict[str, JsonValue]])
def receipt(request_id: Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")],
            query: Annotated[EventQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    value = CleanupStore(scope.store, access_value(scope)).request(query.document, request_id=request_id)
    return envelope({**value, "access": access_value(scope)})


def mutate(request, tenant, token, scope, body, method):
    check = lambda: reauthorize(request, tenant, token, "ontology_review", body.profile, expected=scope)
    check()
    return getattr(CleanupStore(scope.store, access_value(scope)), method)(body.document,
        **body.model_dump(exclude={"document", "profile"}), before_commit=check)


@router.post("/documents/cleanup", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(CleanupApply))
async def apply(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, CleanupApply, "ontology_review",
        lambda scope, body: mutate(request, tenant, token, scope, body, "apply"))


@router.post("/documents/cleanup-undos", response_model=Envelope[dict[str, JsonValue]], openapi_extra=body_schema(CleanupUndo))
async def undo(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, CleanupUndo, "ontology_review",
        lambda scope, body: mutate(request, tenant, token, scope, body, "undo"))
