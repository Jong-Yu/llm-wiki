"""Current-scope notifications, separate read flags, and explicit approval/claim."""
from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import JsonValue
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import json_operation, body_schema
from core.api.schemas import Envelope
from core.api.v1.analysis_plans.router import guard
from core.api.v1.analysis_plans.schemas import Profile
from core.modules.notifications.store import NotificationStore
from .schemas import Listing, DetailQuery, ContentQuery, CreateWorkflow, ReadFlags, PageDecisions, PageCorrection, Approve, Claim, Execution, ReportedEvent

router = APIRouter(tags=['notifications'])
Identifier = Annotated[str, Path(pattern=r'^[a-f0-9]{32}$')]
Response = Envelope[dict[str, JsonValue]]


def service(scope, request):
    return NotificationStore(scope.store, access_value(scope), rulesets=request.app.state.rulesets)


@router.get('/notifications', response_model=Response)
def listing(request: Request, query: Annotated[Listing, Query()], scope=Depends(authorized)):
    return envelope({**service(scope, request).list(**query.model_dump(exclude={'profile'})), 'access': access_value(scope)})


@router.get('/notification-workflows/{workflow_id}', response_model=Response)
def detail(workflow_id: Identifier, request: Request, query: Annotated[DetailQuery, Query()], scope=Depends(authorized)):
    return envelope({**service(scope, request).detail(workflow_id, include_content=query.include_content), 'access': access_value(scope)})


@router.get('/notification-workflows/{workflow_id}/content', response_model=Response)
def content(workflow_id: Identifier, request: Request, query: Annotated[ContentQuery, Query()], scope=Depends(authorized)):
    return envelope({**service(scope, request).content(workflow_id, query), 'access': access_value(scope)})


@router.post('/notification-workflows', response_model=Response, openapi_extra=body_schema(CreateWorkflow))
async def create(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, CreateWorkflow, 'source_write',
        lambda scope, value: service(scope, request).create(value, guard(scope, request, token)))


@router.post('/notifications/read', response_model=Response, openapi_extra=body_schema(ReadFlags))
async def read_flags(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, ReadFlags, 'read',
        lambda scope, value: service(scope, request).read_flags(value, guard(scope, request, token, 'read')))


@router.post('/notification-events', response_model=Response, openapi_extra=body_schema(ReportedEvent))
async def reported_event(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, ReportedEvent, 'source_write',
        lambda scope, value: service(scope, request).reported_event(value, guard(scope, request, token)))


@router.post('/notification-workflows/{workflow_id}/pages', response_model=Response, openapi_extra=body_schema(PageDecisions))
async def pages(workflow_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, PageDecisions, 'source_write',
        lambda scope, value: service(scope, request).mutate(workflow_id, 'pages', value, guard(scope, request, token)))


@router.post('/notification-workflows/{workflow_id}/approve', response_model=Response, openapi_extra=body_schema(Approve))
async def approve(workflow_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, Approve, 'source_write',
        lambda scope, value: service(scope, request).mutate(workflow_id, 'approve', value, guard(scope, request, token)))


@router.post('/notification-workflows/{workflow_id}/corrections', response_model=Response, openapi_extra=body_schema(PageCorrection))
async def corrections(workflow_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, PageCorrection, 'source_write',
        lambda scope, value: service(scope, request).mutate(workflow_id, 'corrections', value, guard(scope, request, token)))


@router.post('/notification-workflows/{workflow_id}/claim', response_model=Response, openapi_extra=body_schema(Claim))
async def claim(workflow_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, Claim, 'source_write',
        lambda scope, value: service(scope, request).mutate(workflow_id, 'claim', value, guard(scope, request, token)))


@router.post('/notification-workflows/{workflow_id}/execution', response_model=Response, openapi_extra=body_schema(Execution))
async def execution(workflow_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    return await json_operation(request, tenant, token, Execution, 'source_write',
        lambda scope, value: service(scope, request).mutate(workflow_id, 'execution', value, guard(scope, request, token)))
