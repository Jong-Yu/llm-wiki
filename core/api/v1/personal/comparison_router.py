"""대조 조회와 결과 보관을 기존 인증·개인 원장에 연결한다. 서버는 AI를 실행하지 않는다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import JsonValue
from core.api.schemas import Envelope
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import body_schema, json_operation, reauthorize
from core.modules.personal.comparisons import ComparisonStore
from .comparison_schemas import ComparisonCreate, ComparisonList, ComparisonRead, ComparisonStep, ComparisonResult

router = APIRouter(tags=["personal-knowledge-comparisons"])
RecordId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
Response = Envelope[dict[str, JsonValue]]


def _guard(request, tenant, token, scope):
    def guard():
        reauthorize(request, tenant, token, "read", scope.profile_id, expected=scope)
        reauthorize(request, tenant, token, "comparison_write", scope.profile_id, expected=scope)
    return guard


@router.get("/knowledge-comparisons", response_model=Response)
def comparison_list(query: Annotated[ComparisonList, Query()], scope=Depends(authorized)):
    """선택 문서/작업의 실행을 최신순으로 읽고 이전 결과도 보존한다."""
    return envelope({**ComparisonStore(scope).list(document=query.document, job_id=query.job_id, limit=query.limit,
                                                   cursor=query.cursor),
                     "access": access_value(scope)})


@router.get("/knowledge-comparisons/{record_id}", response_model=Response)
def comparison_read(record_id: RecordId, query: Annotated[ComparisonRead, Query()], scope=Depends(authorized)):
    """원래 실행과 후보는 그대로 읽고 근거 변경 여부를 따로 계산한다."""
    return envelope({**ComparisonStore(scope).read(record_id, step_id=query.step_id,
                        include_target=query.include_target == "true"), "access": access_value(scope)})


@router.post("/knowledge-comparisons", status_code=201, response_model=Response,
             openapi_extra=body_schema(ComparisonCreate))
async def comparison_create(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """현재 저장된 그래프에 대한 새 개인 비교 실행을 준비한다."""
    def operation(scope, body):
        guard = _guard(request, tenant, token, scope)
        guard()
        return ComparisonStore(scope).create(**body.model_dump(exclude={"profile"}), before_commit=guard)
    return await json_operation(request, tenant, token, ComparisonCreate, "comparison_write", operation, created=True)


@router.post("/knowledge-comparisons/{record_id}/steps", response_model=Response,
             openapi_extra=body_schema(ComparisonStep))
async def comparison_step(request: Request, tenant: str, record_id: RecordId, token: Annotated[str, Depends(credential)]):
    """서버가 한 조회를 수행·기록하고 실행별 5회 한도를 적용한다."""
    def operation(scope, body):
        guard = _guard(request, tenant, token, scope)
        guard()
        return ComparisonStore(scope).step(record_id, **body.model_dump(exclude={"profile"}), before_commit=guard)
    return await json_operation(request, tenant, token, ComparisonStep, "comparison_write", operation)


@router.post("/knowledge-comparisons/{record_id}/result", response_model=Response,
             openapi_extra=body_schema(ComparisonResult))
async def comparison_result(request: Request, tenant: str, record_id: RecordId, token: Annotated[str, Depends(credential)]):
    """관찰한 참조에 연결한 후보·제외 이유·실패를 미확정 결과로 보관한다."""
    def operation(scope, body):
        guard = _guard(request, tenant, token, scope)
        guard()
        return ComparisonStore(scope).finish(record_id, **body.model_dump(exclude={"profile"}), before_commit=guard)
    return await json_operation(request, tenant, token, ComparisonResult, "comparison_write", operation)
