# 분석 작업의 HTTP 입구다. 요청 모델로 읽고 JobStore/ResultStore에 넘긴 뒤 공통 응답으로 포장한다.
# URL의 job_id만 믿지 않고 인증 주체가 그 작업의 소유자인지 업무 모듈에서 함께 확인한다.

"""현재 주체의 작업만 제공하며 현재 정책을 조정 잠금 안에서 재검사한다."""

# @router.get/post는 URL과 함수를 연결한다. Depends(...)는 서버가 사용자·권한 같은
# 공통 값을 먼저 확인해 전달하게 한다. 저장 업무는 이 파일이 아닌 각 Store가 수행한다.
from functools import partial
from typing import Annotated
from pydantic import JsonValue
from fastapi import APIRouter, Depends, Path, Query, Request
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from core.api.dependencies import access_value, authorize_source, authorized, credential, envelope, scope_key
from core.api.errors import error_response
from core.api.schemas import Envelope
from core.api.concurrency import run_owned_thread
from core.modules.access.policy import AccessScope
from core.modules.analysis_jobs.store import JobStore
from .ingress import JobInputError, input_error, read_json
from .schemas import Cancel, CreatedJob, CreateJob, CreateRegistration, EmptyQuery, Heartbeat, Job, JobPage, ListQuery


router = APIRouter(tags=["analysis-jobs"])
Identifier = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]


def body_schema(model):
    return {"requestBody": {"required": True, "content": {
        "application/json": {"schema": model.model_json_schema()}}}}


# 작업 생성/heartbeat/취소의 공통 처리다. operation 이름에 맞는 JobStore 메서드에 검증된 입력을 넘긴다.
async def mutate(request, scope, token, model, operation, *, job_id=None):
    access = access_value(scope)
    try:
        value = await read_json(request, model)
        store = JobStore(scope.store, rulesets=request.app.state.rulesets)

        def current_authorization():
            # 요청 시작의 scope를 저장 허가로 재사용하지 않고 실제 변경 직전에 확인한다.
            nonlocal access
            access = access_value(request.app.state.policy.authorize(token, scope.tenant, "source_write"))
            return access

        arguments = {**value.model_dump(), "tenant": scope.tenant, "user_id": scope.user_id,
                     "authorize": current_authorization}
        if job_id is not None:
            arguments["job_id"] = job_id
        result = await run_owned_thread(partial(getattr(store, operation), **arguments))
    except JobInputError as error:
        return input_error(error)
    except ClientDisconnect:
        return error_response(400, "request_disconnected", "The job request was interrupted.")
    if operation in {"create", "create_registration"}:
        status = 202 if result["state"] == "pending_reconcile" else 200 if result["replayed"] else 201
        payload = Envelope[CreatedJob].model_validate(envelope({**result, "access": access}))
    else:
        status = 200
        payload = Envelope[Job].model_validate(envelope({**result, "access": access}))
    return JSONResponse(payload.model_dump(), status_code=status, headers={"Cache-Control": "no-store"})


@router.post("/analysis-jobs", status_code=201, response_model=Envelope[CreatedJob],
             responses={200: {"model": Envelope[CreatedJob]}, 202: {"model": Envelope[CreatedJob]}},
             openapi_extra=body_schema(CreateJob))
async def create_job(request: Request, query: Annotated[EmptyQuery, Query()],
                     scope: Annotated[AccessScope, Depends(authorize_source)],
                     token: Annotated[str, Depends(credential)]):
    """고정 원본의 작업을 접수한다. AI 실행이나 위키 저장 완료가 아니다."""
    return await mutate(request, scope, token, CreateJob, "create")


@router.post("/analysis-jobs/registrations", status_code=201, response_model=Envelope[CreatedJob],
             responses={200: {"model": Envelope[CreatedJob]}, 202: {"model": Envelope[CreatedJob]}},
             openapi_extra=body_schema(CreateRegistration))
async def create_registration(request: Request, query: Annotated[EmptyQuery, Query()],
                              scope: Annotated[AccessScope, Depends(authorize_source)],
                              token: Annotated[str, Depends(credential)]):
    return await mutate(request, scope, token, CreateRegistration, "create_registration")


# 현재 사용자 범위의 작업 페이지를 조회한다. cursor와 scope_key로 다른 범위의 페이지를 섞지 않는다.
@router.get("/analysis-jobs", response_model=Envelope[JobPage])
def list_jobs(request: Request, query: Annotated[ListQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    value = JobStore(scope.store, rulesets=request.app.state.rulesets).list_jobs(tenant=scope.tenant, user_id=scope.user_id,
        scope_key=scope_key(scope), limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


# 작업 상태와 실제 저장 요약을 읽는다. 조회만으로 실행을 재개하거나 결과를 만들지 않는다.
@router.get("/analysis-jobs/{job_id}", response_model=Envelope[Job])
def get_job(request: Request, job_id: Identifier, query: Annotated[EmptyQuery, Query()],
            scope: Annotated[AccessScope, Depends(authorized)]):
    value = JobStore(scope.store, rulesets=request.app.state.rulesets).query(job_id, tenant=scope.tenant, user_id=scope.user_id)
    return envelope({**value, "access": access_value(scope)})


@router.get("/analysis-jobs/{job_id}/results/{request_id}", response_model=Envelope[dict[str, JsonValue]])
def get_result(request: Request, job_id: Identifier, request_id: Identifier,
               query: Annotated[EmptyQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)],
               token: Annotated[str, Depends(credential)]):
    """현재 read 권한으로 본인 제출/영수증을 확인한다. 실행을 재개하거나 저장하지 않는다."""
    from core.modules.analysis_results.store import ResultStore

    access = access_value(scope)

    def current_authorization(permission=None):
        # 결과 조회 시점의 read 권한을 다시 확인한다. URL의 ID를 안다고 소유자가 되는 것은 아니다.
        nonlocal access
        access = access_value(request.app.state.policy.authorize(token, scope.tenant, "read", scope.profile_id))
        return access

    value = ResultStore(scope.store, request.app.state.rulesets).query(
        job_id, tenant=scope.tenant, user_id=scope.user_id, request_id=request_id, authorize=current_authorization)
    return envelope({**value, "access": access})


@router.post("/analysis-jobs/{job_id}/heartbeat", response_model=Envelope[Job], openapi_extra=body_schema(Heartbeat))
async def heartbeat(request: Request, job_id: Identifier, query: Annotated[EmptyQuery, Query()],
                    scope: Annotated[AccessScope, Depends(authorize_source)],
                    token: Annotated[str, Depends(credential)]):
    """현재 run의 lease만 갱신하며 job_revision을 바꾸지 않는다."""
    return await mutate(request, scope, token, Heartbeat, "heartbeat", job_id=job_id)


@router.post("/analysis-jobs/{job_id}/cancel", response_model=Envelope[Job], openapi_extra=body_schema(Cancel))
async def cancel(request: Request, job_id: Identifier, query: Annotated[EmptyQuery, Query()],
                 scope: Annotated[AccessScope, Depends(authorize_source)],
                 token: Annotated[str, Depends(credential)]):
    """후속 실행을 취소하고 기존 원본·문서·영수증을 보존한다."""
    return await mutate(request, scope, token, Cancel, "cancel", job_id=job_id)
