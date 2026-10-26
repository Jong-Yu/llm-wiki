"""화면 변경 없이 원본 변환 보고·분석 범위와 실행 인계 API를 제공한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import JsonValue
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import json_operation, body_schema, reauthorize
from core.api.schemas import Envelope
from core.modules.analysis_plans.store import PlanStore
from .schemas import Profile, CreateConversion, CreatePlan, ValidatePlan, HandoffPlan

router = APIRouter(tags=["analysis-plans"])
Identifier = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
Response = Envelope[dict[str, JsonValue]]


def service(scope, request):
    """인증된 저장소와 관점으로만 계획 서비스 객체를 만든다."""
    return PlanStore(scope.store, access_value(scope), rulesets=request.app.state.rulesets)


def guard(scope, request, token, permission="source_write"):
    """최종 불변 공개/원본 접수 직전에 현재 권한을 다시 확인할 함수를 만든다."""
    def current():
        return access_value(reauthorize(request, scope.tenant, token, permission, scope.profile_id, expected=scope))
    return current


@router.post("/analysis-conversions", status_code=201, response_model=Response,
             responses={200: {"model": Response}}, openapi_extra=body_schema(CreateConversion))
async def conversion(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """개인 PC가 보고한 PDF/OCR/셀 단위 문자를 원본 hash와 연결해 보관한다."""
    return await json_operation(request, tenant, token, CreateConversion, "source_write",
        lambda scope, value: service(scope, request).conversion(value, guard(scope, request, token)), created=True)


@router.get("/analysis-conversions/{conversion_id}", response_model=Response)
def read_conversion(conversion_id: Identifier, request: Request, query: Annotated[Profile, Query()], scope=Depends(authorized)):
    """원래 단위 위치·실제 문자/hash를 읽으며 OCR 의미 승인을 추측하지 않는다."""
    return envelope({**service(scope, request).read("conversions", conversion_id), "access": access_value(scope)})


@router.post("/analysis-plans", status_code=201, response_model=Response,
             responses={200: {"model": Response}}, openapi_extra=body_schema(CreatePlan))
async def create_plan(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """문서별 목적·선택 구간·필수 맥락을 서버가 확인한 불변 계획으로 만든다."""
    return await json_operation(request, tenant, token, CreatePlan, "source_write",
        lambda scope, value: service(scope, request).create(value, guard(scope, request, token)), created=True)


@router.get("/analysis-plans/{plan_id}", response_model=Response)
def read_plan(plan_id: Identifier, request: Request, query: Annotated[Profile, Query()], scope=Depends(authorized)):
    """현재 값으로 과거 계획을 바꾸지 않고 당시 입력과 선택 문자를 읽는다."""
    return envelope({**service(scope, request).read("plans", plan_id), "access": access_value(scope)})


@router.post("/analysis-plans/{plan_id}/validate", response_model=Response, openapi_extra=body_schema(ValidatePlan))
async def validate_plan(plan_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """실행 없이 원본·필수 맥락·관점·계획 지문을 다시 대조한다."""
    return await json_operation(request, tenant, token, ValidatePlan, "read",
        lambda scope, value: service(scope, request).validate(plan_id, value.expected_plan_revision))


@router.post("/analysis-plans/{plan_id}/handoffs", response_model=Response, openapi_extra=body_schema(HandoffPlan))
async def handoff(plan_id: Identifier, request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """선택한 문자를 별도 원본으로 접수하고 문서별 기존 분석 job에 인계한다."""
    return await json_operation(request, tenant, token, HandoffPlan, "source_write",
        lambda scope, value: service(scope, request).handoff(plan_id, value.expected_plan_revision,
            value.request_id, guard(scope, request, token)))


@router.get("/analysis-plans/{plan_id}/handoffs/{request_id}", response_model=Response)
def handoff_receipt(plan_id: Identifier, request_id: Identifier, request: Request,
                    query: Annotated[Profile, Query()], scope=Depends(authorized)):
    """인계 결과는 현재 read와 소유권으로 조회하며 새 작업을 만들지 않는다."""
    return envelope({**service(scope, request).handoff_receipt(plan_id, request_id), "access": access_value(scope)})
