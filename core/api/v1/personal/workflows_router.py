"""개인 결과 초안/질문 실행을 기존 인증·JSON·저장 서비스에 연결한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from pydantic import JsonValue
from core.api.schemas import Envelope
from core.api.dependencies import authorized, credential, access_value, envelope, scope_key
from core.api.operations import body_schema, json_operation, reauthorize, commit_guard as guard
from core.modules.personal.drafts import DraftStore
from core.modules.personal.question_runs import QuestionRunStore
from core.modules.personal.store import PersonalStore
from .router import RecordId
from .schemas import PersonalProfile, PersonalList
from . import workflows_schemas as models

router = APIRouter(tags=["personal-workflows"])
Response = Envelope[dict[str, JsonValue]]


@router.get("/result-drafts", response_model=Response)
def list_drafts(query: Annotated[PersonalList, Query()], scope=Depends(authorized)):
    """닫은 초안도 다시 찾을 수 있도록 자기 초안 목록을 페이지로 읽는다."""
    return envelope({**PersonalStore(scope).list("result-drafts", scope_key=scope_key(scope),
        limit=query.limit, cursor=query.cursor), "access": access_value(scope)})


@router.get("/question-runs", response_model=Response)
def list_question_runs(query: Annotated[PersonalList, Query()], scope=Depends(authorized)):
    """재연결 후 자기 질문 실행을 찾는다. 목록 조회는 AI를 다시 실행하지 않는다."""
    return envelope({**PersonalStore(scope).list("question-runs", scope_key=scope_key(scope),
        limit=query.limit, cursor=query.cursor), "access": access_value(scope)})


@router.post("/result-drafts", status_code=201, response_model=Response, openapi_extra=body_schema(models.DraftCreate))
async def create_draft(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """저장 결과를 편집 가능한 개인 초안으로 복사하되 고정 근거는 보존한다."""
    return await json_operation(request, tenant, token, models.DraftCreate, "result_write",
        lambda scope, value: DraftStore(scope).create(value.request_id, value.saved_result_id,
            before_commit=guard(request, tenant, token, "result_write", scope)), created=True)


@router.get("/result-drafts/{draft_id}", response_model=Response)
def read_draft(draft_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """초안·원래 생성문·당시 근거와 현재 변경 관측을 읽는다."""
    return envelope({**DraftStore(scope).read(draft_id), "access": access_value(scope)})


@router.put("/result-drafts/{draft_id}", response_model=Response, openapi_extra=body_schema(models.DraftEdit))
async def edit_draft(request: Request, tenant: str, draft_id: RecordId, token: Annotated[str, Depends(credential)]):
    """현재 읽은 초안 revision으로만 새 편집 이벤트를 추가한다."""
    return await json_operation(request, tenant, token, models.DraftEdit, "result_write",
        lambda scope, value: DraftStore(scope).edit(draft_id, **value.model_dump(exclude={"profile"}),
            before_commit=guard(request, tenant, token, "result_write", scope)))


@router.post("/result-drafts/{draft_id}/applications", response_model=Response, openapi_extra=body_schema(models.DraftApply))
async def apply_draft(request: Request, tenant: str, draft_id: RecordId, token: Annotated[str, Depends(credential)]):
    """result_write와 실제 위키 write를 모두 확인하고 명시 반영한다."""
    def operation(scope, value):
        def authorize():
            reauthorize(request, tenant, token, "result_write", scope.profile_id, expected=scope)
            reauthorize(request, tenant, token, "write", scope.profile_id, expected=scope)
        return DraftStore(scope).apply(draft_id, **value.model_dump(exclude={"profile"}), authorize=authorize)
    return await json_operation(request, tenant, token, models.DraftApply, "result_write", operation)


@router.get("/result-drafts/{draft_id}/applications/{request_id}", response_model=Response)
def application_receipt(draft_id: RecordId, request_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """쓰기 권한 회수 뒤에도 자기 반영 요청의 저장 결과를 확인한다."""
    return envelope({**DraftStore(scope).apply_receipt(draft_id, request_id), "access": access_value(scope)})


@router.post("/question-runs", status_code=201, response_model=Response, openapi_extra=body_schema(models.RunCreate))
async def create_question_run(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """저장된 사용자 질문에 대한 실행 대기 자원을 만들며 서버 AI는 시작하지 않는다."""
    return await json_operation(request, tenant, token, models.RunCreate, "conversation_write",
        lambda scope, value: QuestionRunStore(scope, user_dialogue=True).create(**value.model_dump(exclude={"profile"}),
            before_commit=guard(request, tenant, token, "conversation_write", scope)), created=True)


@router.get("/question-runs/{question_run_id}", response_model=Response)
def read_question_run(question_run_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """실행 상태·lease·실제 답변 영수증을 구분해 읽는다."""
    return envelope({**QuestionRunStore(scope).read(question_run_id), "access": access_value(scope)})


@router.get("/question-runs/{question_run_id}/input", response_model=Response)
def question_input(question_run_id: RecordId, query: Annotated[models.InputRead, Query()],
                   request: Request, token: Annotated[str, Depends(credential)], scope=Depends(authorized)):
    """활성 run에만 현재 근거와 일치하는 고정 입력을 인계한다."""
    return envelope({**QuestionRunStore(scope).input(question_run_id, query.run_id,
        authorize=guard(request, scope.tenant, token, "conversation_write", scope)), "access": access_value(scope)})


async def command(request, tenant, token, question_run_id, model, operation):
    """같은 인가·검증·원장 코드를 사용하고 동작별 입력만 분리한다."""
    return await json_operation(request, tenant, token, model, "conversation_write",
        lambda scope, value: QuestionRunStore(scope).command(question_run_id, operation,
            value.model_dump(exclude={"profile"}), authorize=guard(request, tenant, token, "conversation_write", scope)))


@router.post("/question-runs/{question_run_id}/claim", response_model=Response, openapi_extra=body_schema(models.RunClaim))
async def claim(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """현재 기준에서만 사용권을 발급하며 만료 실행 재접수는 명시 reclaim을 요구한다."""
    return await command(request, tenant, token, question_run_id, models.RunClaim, "claim")


@router.post("/question-runs/{question_run_id}/heartbeat", response_model=Response, openapi_extra=body_schema(models.RunHeartbeat))
async def heartbeat(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """실행 상태 revision과 별도의 lease revision으로 생존만 갱신한다."""
    return await command(request, tenant, token, question_run_id, models.RunHeartbeat, "heartbeat")


@router.post("/question-runs/{question_run_id}/progress", response_model=Response, openapi_extra=body_schema(models.RunProgress))
async def progress(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """개인 CLI 자기보고를 실제 답변 저장 완료와 구분해 기록한다."""
    return await command(request, tenant, token, question_run_id, models.RunProgress, "progress")


@router.post("/question-runs/{question_run_id}/cancel", response_model=Response, openapi_extra=body_schema(models.RunCommand))
async def cancel(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """후속 실행/제출을 막고 이미 보관한 질문·답변은 유지한다."""
    return await command(request, tenant, token, question_run_id, models.RunCommand, "cancel")


@router.post("/question-runs/{question_run_id}/answers", response_model=Response, openapi_extra=body_schema(models.RunAnswer))
async def answer(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """개인 AI가 작성한 답변을 입력 지문/현재 근거/실제 인용과 대조해 저장한다."""
    return await json_operation(request, tenant, token, models.RunAnswer, "conversation_write",
        lambda scope, value: QuestionRunStore(scope).submit(question_run_id, value.model_dump(exclude={"profile"}),
            authorize=guard(request, tenant, token, "conversation_write", scope)))


@router.post("/question-runs/{question_run_id}/evidence", response_model=Response, openapi_extra=body_schema(models.RunEvidence))
async def question_evidence(request: Request, tenant: str, question_run_id: RecordId, token: Annotated[str, Depends(credential)]):
    """실행이 요청한 고정 자료만 읽고 작은 조회 결과를 같은 원장에 보존한다."""
    return await json_operation(request, tenant, token, models.RunEvidence, "conversation_write",
        lambda scope, value: QuestionRunStore(scope).evidence(question_run_id, value.model_dump(exclude={"profile"}),
            authorize=guard(request, tenant, token, "conversation_write", scope)))


@router.get("/question-runs/{question_run_id}/evidence/{request_id}", response_model=Response)
def question_evidence_receipt(question_run_id: RecordId, request_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """조회 응답 유실은 기존 영수증으로 확인하며 AI나 조회 요청을 재실행하지 않는다."""
    return envelope({**QuestionRunStore(scope).evidence_receipt(question_run_id, request_id), "access": access_value(scope)})


@router.get("/question-runs/{question_run_id}/answers/{request_id}", response_model=Response)
def answer_receipt(question_run_id: RecordId, request_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """만료/취소/쓰기 회수 뒤에도 정확한 답변 요청의 저장 증거를 읽는다."""
    return envelope({**QuestionRunStore(scope).answer_receipt(question_run_id, request_id), "access": access_value(scope)})
