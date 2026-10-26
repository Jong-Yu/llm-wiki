"""원문 준비와 전체 추출안 저장·적용·미발견 검토를 기존 업무 저장기에 연결한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import JsonValue
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.operations import body_schema, json_operation, reauthorize
from core.api.schemas import Envelope
from core.modules.analysis_proposals.store import ProposalStore
from core.modules.analysis_proposals.executions import ProposalExecutionStore
from . import schemas

router = APIRouter(tags=["analysis-proposals"])
Identifier = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
Response = Envelope[dict[str, JsonValue]]


def service(request, scope):
    """현재 서버가 확인한 사용자·관점과 게시 규약만 Store에 넘긴다."""
    return ProposalStore(scope.store, access_value(scope), rulesets=request.app.state.rulesets)


def guard(request, tenant, token, permission, scope):
    """실제 공개 직전 호출할 권한 재확인 함수다. 파일 잠금을 다시 잡지 않는다."""
    return lambda: reauthorize(request, tenant, token, permission, scope.profile_id, expected=scope)


def execution_service(request, scope):
    return ProposalExecutionStore(scope.store, access_value(scope), rulesets=request.app.state.rulesets)


@router.post("/analysis-proposals/{proposal_id}/executions", response_model=Response,
             openapi_extra=body_schema(schemas.StartExecution))
async def start_execution(request: Request, tenant: str, proposal_id: Identifier,
                          token: Annotated[str, Depends(credential)]):
    """고정 전체 원문을 계획/job으로 인계한다. 모델 실행과 canonical 적용은 하지 않는다."""
    def operation(scope, body):
        def authorize():
            reauthorize(request, tenant, token, "ontology_write", scope.profile_id, expected=scope)
            return access_value(reauthorize(request, tenant, token, "source_write", scope.profile_id, expected=scope))
        authorize()
        return execution_service(request, scope).start(proposal_id, body.request_id, body.expected_state_revision,
            body.candidate_revision, body.reason, authorize=authorize)
    return await json_operation(request, tenant, token, schemas.StartExecution, "ontology_write", operation)


@router.get("/analysis-proposals/{proposal_id}/executions/{execution_id}", response_model=Response)
def read_execution(request: Request, proposal_id: Identifier, execution_id: Identifier,
                   query: Annotated[schemas.Profile, Query()], scope=Depends(authorized)):
    return envelope({**execution_service(request, scope).read(proposal_id, execution_id), "access": access_value(scope)})


@router.post("/analysis-proposals/{proposal_id}/result-links", response_model=Response,
             openapi_extra=body_schema(schemas.LinkResult))
async def link_result(request: Request, tenant: str, proposal_id: Identifier,
                      token: Annotated[str, Depends(credential)]):
    """정확한 불변 결과의 원문·입력·규약·제출 지문을 검사해 후보/진단에 연결한다."""
    def operation(scope, body):
        return execution_service(request, scope).link(proposal_id, body.request_id, body.expected_state_revision,
            body.candidate_revision, body.execution_id, body.mode, body.result_ref.model_dump(),
            body.resolves_decision_ids, [item.model_dump() for item in body.resolution_bindings],
            authorize=guard(request, tenant, token, "ontology_write", scope))
    return await json_operation(request, tenant, token, schemas.LinkResult, "ontology_write", operation)


@router.post("/analysis-proposals", status_code=201, response_model=Response,
             responses={200: {"model": Response}}, openapi_extra=body_schema(schemas.Prepare))
async def prepare(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """기존 Wiki 자체를 고정 입력으로 준비한다. 별도 원본 등록은 필요하지 않다."""
    def operation(scope, body):
        return service(request, scope).prepare(body.request_id, body.document, body.expected_source_revision,
            body.expected_state_revision, [item.model_dump() for item in body.context_documents],
            submission=body.submission, before_commit=guard(request, tenant, token, "ontology_write", scope))
    return await json_operation(request, tenant, token, schemas.Prepare, "ontology_write", operation, created=True)


@router.get("/analysis-proposals/{proposal_id}", response_model=Response)
def read(request: Request, proposal_id: Identifier, query: Annotated[schemas.Profile, Query()], scope=Depends(authorized)):
    """전체 고정 원문·이전 주장·새 제안·미발견·별도 판단 이력을 조회한다."""
    return envelope({**service(request, scope).read(proposal_id), "access": access_value(scope)})


@router.post("/analysis-proposals/{proposal_id}/submissions", response_model=Response,
             openapi_extra=body_schema(schemas.Submit))
async def submit(request: Request, tenant: str, proposal_id: Identifier, token: Annotated[str, Depends(credential)]):
    """모델의 새 전체 결과를 canonical 적용 전의 불변 초안으로 제출한다."""
    def operation(scope, body):
        return service(request, scope).submit(proposal_id, body.request_id, body.expected_state_revision,
            body.submission, body.resolves_decision_ids,
            resolution_bindings=[item.model_dump() for item in body.resolution_bindings],
            before_commit=guard(request, tenant, token, "ontology_write", scope))
    return await json_operation(request, tenant, token, schemas.Submit, "ontology_write", operation)


@router.post("/analysis-proposals/{proposal_id}/validation", response_model=Response,
             openapi_extra=body_schema(schemas.Profile))
async def validate(request: Request, tenant: str, proposal_id: Identifier, token: Annotated[str, Depends(credential)]):
    """현재 기준과 전체 그래프 구조·실제 인용만 검사하고 의미 검토는 미실행으로 남긴다."""
    return await json_operation(request, tenant, token, schemas.Profile, "read",
        lambda scope, body: service(request, scope).validate(proposal_id))


@router.post("/analysis-proposals/{proposal_id}/apply", response_model=Response,
             openapi_extra=body_schema(schemas.Apply))
async def apply(request: Request, tenant: str, proposal_id: Identifier, token: Annotated[str, Depends(credential)]):
    """확인한 전체 제안을 명시 적용하고 저장 함수의 영수증을 반환한다."""
    def operation(scope, body):
        return service(request, scope).apply(proposal_id, body.request_id, body.expected_state_revision,
            body.candidate_revision, before_commit=guard(request, tenant, token, "ontology_write", scope))
    return await json_operation(request, tenant, token, schemas.Apply, "ontology_write", operation)


@router.get("/analysis-proposals/{proposal_id}/requests/{request_id}", response_model=Response)
def receipt(request: Request, proposal_id: Identifier, request_id: Identifier,
            query: Annotated[schemas.Profile, Query()], scope=Depends(authorized)):
    """응답 유실이나 권한 회수 뒤에도 read·소유권만으로 실제 적용 요청을 확인한다."""
    return envelope({**service(request, scope).receipt(proposal_id, request_id), "access": access_value(scope)})


@router.post("/analysis-proposals/{proposal_id}/missing-decisions", response_model=Response,
             openapi_extra=body_schema(schemas.MissingDecision))
async def decide(request: Request, tenant: str, proposal_id: Identifier, token: Annotated[str, Depends(credential)]):
    """이번 판본의 미발견 관계에 대한 명시 판단과 복구 초안을 보존한다."""
    def operation(scope, body):
        if body.action == "keep":
            reauthorize(request, tenant, token, "ontology_write", scope.profile_id, expected=scope)
        return service(request, scope).decide(proposal_id, body.request_id, body.expected_state_revision,
            body.candidate_revision, body.old_claim_id, body.action, body.reason, body.checked_whole,
            body.evidence, body.replacement, before_commit=guard(request, tenant, token, "ontology_review", scope))
    return await json_operation(request, tenant, token, schemas.MissingDecision, "ontology_review", operation)


@router.post("/analysis-proposals/{proposal_id}/completions", response_model=Response,
             openapi_extra=body_schema(schemas.Complete))
async def complete(request: Request, tenant: str, proposal_id: Identifier, token: Annotated[str, Depends(credential)]):
    """적용된 새 주장에 실제 검토가 있는지 확인하고 명시 비교 범위만 완료한다."""
    def operation(scope, body):
        return service(request, scope).complete(proposal_id, body.request_id, body.expected_state_revision,
            body.expected_review_state_revision, body.reviewed_claim_ids, body.reason,
            before_commit=guard(request, tenant, token, "ontology_review", scope))
    return await json_operation(request, tenant, token, schemas.Complete, "ontology_review", operation)
