"""대화·답변·비교를 개인 기록 Store에 연결한다. AI 실행과 위키 수정은 포함하지 않는다.

모든 쓰기는 새 권한과 요청 ID를 요구한다. 본문·지식 snapshot은 서버가 읽어
보관하고, 클라이언트가 제출한 답변·비교 판단은 client_reported로 표시한다.
"""

from typing import Annotated, Literal
from hashlib import sha256
from fastapi import APIRouter, Depends, Path, Query, Request
from core.api.dependencies import authorized, credential, access_value, envelope, scope_key
from core.api.operations import json_operation, body_schema, commit_guard as _guard
from core.api.schemas import Envelope
from core.common.json_codec import canonical_json_hash
from pydantic import JsonValue
from core.modules.access.policy import AccessDenied
from core.modules.personal.store import PersonalStore, PersonalConflictError
from core.modules.personal.question_basis import is_basis_reference
from core.modules.personal.workflow_io import materialize_basis
from core.modules.knowledge.aggregation import prepare_question
from core.modules.reviews.store import ReviewStore
from .schemas import (PersonalProfile, PersonalList, PersonalReceipt, CreateConversation, AppendTurn,
    CreateSavedResult, CreateComparison, CompleteComparison)
from .comparison_router import router as comparison_router

router = APIRouter(tags=["personal-records"])
RecordId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
Response = Envelope[dict[str, JsonValue]]


def _basis(scope, value, *, question=None):
    """현재 허용 관점으로 전체 근거를 읽으며 누락/부분 준비를 저장하지 않는다."""
    if value.profile is not None and value.profile != scope.profile_id:
        raise AccessDenied()
    arguments = value.model_dump(exclude={"profile", "mode"})
    if value.retrieval_scope is not None and question is not None:
        # 형식 안내/첨부와 분리한 질문은 실제 발언의 정확한 prefix인 경우에만 사용한다.
        hint = value.lookup_question
        arguments["lookup_question"] = hint if hint and question.startswith(hint) else question
    basis = prepare_question(scope.store, access_value(scope), **arguments)
    if value.retrieval_scope is not None and question is not None:
        basis["retrieval"]["question_sha256"] = sha256(question.encode()).hexdigest()
        basis["snapshot_revision"] = canonical_json_hash({k: v for k, v in basis.items() if k != "snapshot_revision"})
    if not basis["can_prepare"]:
        raise ValueError("Question context is incomplete; inspect its preparation first")
    if value.mode == "on_demand":
        from core.modules.personal.question_basis import QuestionBasisStore
        return QuestionBasisStore(scope).freeze(basis)
    return basis


def _replayed(store, kind, body, record_id=None):
    """이전에 기록된 요청이면 현재 자료를 다시 읽거나 답변을 다시 저장하지 않는다."""
    try:
        return store.receipt(kind, body.request_id, record_id=record_id, payload=body.model_dump())
    except FileNotFoundError:
        return None


def _turn(record, turn_id, *, role=None):
    """같은 사용자의 대화에 실제 남은 turn만 참조하며 임의 답변 ID를 받지 않는다."""
    turn = next((event for event in record["events"] if event["id"] == turn_id), None)
    if turn is None or (role is not None and turn["role"] != role):
        raise ValueError("The referenced conversation turn does not exist")
    return turn


def _claims(basis):
    """문서와 안정된 claim_id의 짝으로 비교 범위를 확인한다."""
    return {(item["document"], claim["claim_id"]) for item in basis["documents"]
            for claim in item["knowledge"]["claims"]}


def _list(kind, scope, query):
    """사용자 소유 자료만 목록으로 읽어 공통 응답에 넣는다."""
    return envelope({**PersonalStore(scope).list(kind, scope_key=scope_key(scope),
        limit=query.limit, cursor=query.cursor), "access": access_value(scope)})


def _read(kind, scope, record_id):
    """개인 기록의 당시 근거는 현재 값으로 바꾸지 않고 그대로 반환한다."""
    return envelope({**PersonalStore(scope).read(kind, record_id), "access": access_value(scope),
        "snapshot_currentness": "not_checked", "historical_snapshot_preserved": True})


@router.get("/conversations", response_model=Response)
def conversations(query: Annotated[PersonalList, Query()], scope=Depends(authorized)):
    """자기 대화 목록을 페이지로 조회한다."""
    return _list("conversations", scope, query)


@router.get("/conversations/{record_id}", response_model=Response)
def conversation(record_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """대화와 질문 당시의 전체 근거를 읽는다."""
    return _read("conversations", scope, record_id)


@router.post("/conversations", status_code=201, response_model=Response,
             responses={200: {"model": Response, "description": "Existing request confirmed"}},
             openapi_extra=body_schema(CreateConversation))
async def create_conversation(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """명시적인 개인 대화를 생성하며 기존 요청은 같은 기록으로 확인한다."""
    def operation(scope, body):
        return PersonalStore(scope).create("conversations", body.request_id, body.model_dump(),
            {"title": body.title, "sharing": "personal"}, access_value(scope),
            before_commit=_guard(request, tenant, token, "conversation_write", scope))
    return await json_operation(request, tenant, token, CreateConversation, "conversation_write", operation, created=True)


@router.post("/conversations/{record_id}/turns", response_model=Response, openapi_extra=body_schema(AppendTurn))
async def append_turn(request: Request, tenant: str, record_id: RecordId, token: Annotated[str, Depends(credential)]):
    """사용자 질문 또는 그 질문에 대한 클라이언트 보고 답변을 추가한다."""
    def operation(scope, body):
        store = PersonalStore(scope)
        replay = _replayed(store, "conversations", body, record_id)
        if replay is not None:
            return replay
        record = store.read("conversations", record_id)["record"]
        basis = _basis(scope, body.context_request, question=body.content) if body.role == "user" else None
        if body.role == "assistant":
            basis = _turn(record, body.reply_to, role="user")["basis"]
        event = {"role": body.role, "content": body.content, "status": body.status, "reply_to": body.reply_to,
            "basis": basis, "origin": "client_reported", "human_approval": False, "basis_storage": "embedded_full_snapshot"}
        if is_basis_reference(basis):
            event["basis_storage"] = "immutable_snapshot_reference"
        return store.append("conversations", record_id, body.request_id, body.expected_revision,
            body.model_dump(), event, access_value(scope),
            before_commit=_guard(request, tenant, token, "conversation_write", scope))
    return await json_operation(request, tenant, token, AppendTurn, "conversation_write", operation)


@router.get("/saved-results", response_model=Response)
def results(query: Annotated[PersonalList, Query()], scope=Depends(authorized)):
    """명시적으로 저장한 자기 결과만 목록으로 읽는다."""
    return _list("saved-results", scope, query)


@router.get("/saved-results/{record_id}", response_model=Response)
def saved_result(record_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """저장 당시의 답변과 근거를 읽는다."""
    return _read("saved-results", scope, record_id)


@router.post("/saved-results", status_code=201, response_model=Response,
             responses={200: {"model": Response, "description": "Existing request confirmed"}},
             openapi_extra=body_schema(CreateSavedResult))
async def save_result(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """직접 작성 결과 또는 같은 사용자의 저장된 답변을 불변 기록으로 보관한다."""
    def operation(scope, body):
        store = PersonalStore(scope)
        replay = _replayed(store, "saved-results", body)
        if replay is not None:
            return replay
        if body.conversation_id is not None:
            conversation = store.read("conversations", body.conversation_id)["record"]
            turn = _turn(conversation, body.turn_id, role="assistant")
            if turn["status"] != "complete":
                raise ValueError("A failed answer is not a completed result")
            content, basis = turn["content"], turn["basis"]
            answer_provenance = {"conversation_id": body.conversation_id, "answer_turn_id": body.turn_id,
                "question_turn_id": turn["reply_to"], "turn_hash": turn["hash"],
                "citations": turn.get("citations", []), "execution": turn.get("execution"),
                "question_run_id": turn.get("question_run_id"), "origin": "client_reported"}
        else:
            content, basis = body.content, _basis(scope, body.context_request)
            answer_provenance = None
        data = {"title": body.title, "content": content, "basis": basis, "origin": "client_reported",
            "conversation_id": body.conversation_id, "turn_id": body.turn_id, "human_approval": False,
            "basis_storage": "embedded_full_snapshot", "answer_provenance": answer_provenance}
        if is_basis_reference(basis):
            data["basis_storage"] = "immutable_snapshot_reference"
        return store.create("saved-results", body.request_id, body.model_dump(), data, access_value(scope),
            before_commit=_guard(request, tenant, token, "result_write", scope))
    return await json_operation(request, tenant, token, CreateSavedResult, "result_write", operation, created=True)


@router.get("/comparisons", response_model=Response)
def comparisons(query: Annotated[PersonalList, Query()], scope=Depends(authorized)):
    """저장된 명시 비교 범위를 조회한다. 자동 의미 판정은 수행하지 않는다."""
    return _list("comparisons", scope, query)


@router.get("/comparisons/{record_id}", response_model=Response)
def comparison(record_id: RecordId, query: Annotated[PersonalProfile, Query()], scope=Depends(authorized)):
    """이전/새 snapshot과 대응 제안·완료 기록을 함께 읽는다."""
    return _read("comparisons", scope, record_id)


@router.post("/comparisons", status_code=201, response_model=Response,
             responses={200: {"model": Response, "description": "Existing request confirmed"}},
             openapi_extra=body_schema(CreateComparison))
async def create_comparison(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """기존 저장 결과의 근거와 새 근거를 고정하고 명시 주장 대응만 보관한다."""
    def operation(scope, body):
        store = PersonalStore(scope)
        replay = _replayed(store, "comparisons", body)
        if replay is not None:
            return replay
        baseline = store.read("saved-results", body.baseline_result_id)["record"]["data"]["basis"]
        current = _basis(scope, body.context_request)
        actor = access_value(scope)
        old_claims = _claims(materialize_basis(scope.store, baseline, actor))
        new_claims = _claims(materialize_basis(scope.store, current, actor))
        old_documents = {item["document"] for item in baseline["documents"]}
        new_documents = {item["document"] for item in current["documents"]}
        if old_documents != new_documents:
            raise ValueError("Compare the same explicitly selected document scope")
        for mapping in body.mappings:
            if ((mapping.old_claim_id and (mapping.document, mapping.old_claim_id) not in old_claims)
                    or (mapping.new_claim_id and (mapping.document, mapping.new_claim_id) not in new_claims)):
                raise ValueError("Claim mapping endpoints must exist in their exact snapshots")
        data = {"title": body.title, "baseline_result_id": body.baseline_result_id, "baseline": baseline,
            "current": current, "mappings": [item.model_dump() for item in body.mappings],
            "origin": "client_reported", "semantic_judgment": "not_automated", "human_approval": False,
            "coverage": "explicit_selection_only"}
        return store.create("comparisons", body.request_id, body.model_dump(), data, access_value(scope),
            before_commit=_guard(request, tenant, token, "comparison_write", scope))
    return await json_operation(request, tenant, token, CreateComparison, "comparison_write", operation, created=True)


@router.post("/comparisons/{record_id}/completions", response_model=Response, openapi_extra=body_schema(CompleteComparison))
async def complete_comparison(request: Request, tenant: str, record_id: RecordId, token: Annotated[str, Depends(credential)]):
    """실제 새 주장 검토를 대조하고 명시 범위의 완료/보류 이벤트를 추가한다."""
    def operation(scope, body):
        store = PersonalStore(scope)
        replay = _replayed(store, "comparisons", body, record_id)
        if replay is not None:
            return replay
        record = store.read("comparisons", record_id)["record"]
        full_current = materialize_basis(scope.store, record["data"]["current"], access_value(scope))
        captured = {item["document"]: item["knowledge"] for item in full_current["documents"]}
        if len({(item.document, item.claim_id) for item in body.reviewed_claims}) != len(body.reviewed_claims):
            raise ValueError("Select unique reviewed claims")
        evidence = []
        for reference in body.reviewed_claims:
            expected = captured.get(reference.document)
            if expected is None or (reference.document, reference.claim_id) not in _claims(full_current):
                raise ValueError("Claim is outside the explicit comparison")
            current = ReviewStore(scope.store).query(reference.document, domain=scope.domain, viewpoint=scope.viewpoint)
            if current["state_revision"] != reference.state_revision or current["source_revision"] != expected["source_revision"] or current["graph_revision"] != expected["graph_revision"]:
                raise PersonalConflictError()
            claim = next((item for item in current["claims"] if item["claim_id"] == reference.claim_id), None)
            if claim is None or claim["decision"] not in {"accept", "edit", "reject"}:
                raise ValueError("Completion needs an actual current review decision")
            evidence.append({**reference.model_dump(), "decision": claim["decision"], "observed_state_revision": current["state_revision"]})
        required = {(item["document"], item["new_claim_id"]) for item in record["data"]["mappings"] if item["new_claim_id"]}
        if body.outcome == "reviewed" and (not required or not required <= {(item["document"], item["claim_id"]) for item in evidence}):
            raise ValueError("Review every mapped new claim before completing this explicit comparison")
        event = {"outcome": body.outcome, "reason": body.reason, "verified_reviews": evidence,
            "coverage": "explicit_mapped_claims_only", "does_not_approve_other_claims": True}
        return store.append("comparisons", record_id, body.request_id, body.expected_revision, body.model_dump(),
            event, access_value(scope), before_commit=_guard(request, tenant, token, "comparison_write", scope))
    return await json_operation(request, tenant, token, CompleteComparison, "comparison_write", operation)


@router.get("/personal-requests/{kind}/{request_id}", response_model=Response)
def receipt(kind: Literal["conversations", "saved-results", "comparisons", "result-drafts", "question-runs", "knowledge-comparisons"], request_id: RecordId,
            query: Annotated[PersonalReceipt, Query()], scope=Depends(authorized)):
    """생성/추가 응답이 유실됐을 때 자기 요청의 저장 여부만 확인한다."""
    return envelope({**PersonalStore(scope).receipt(kind, request_id, record_id=query.record_id), "access": access_value(scope)})


router.include_router(comparison_router)
