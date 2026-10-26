# 원본 요청의 순서는 수신 용량 확보 → 입력 읽기/임시 보관 → 현재 권한 재확인 → 판본 공개 → 영수증 응답이다.
# finally의 임시 파일 정리는 성공/실패/취소와 관계없이 실행되므로 수신 자료가 불필요하게 남지 않게 한다.

"""원본 등록과 판본·영수증을 같은 현재 tenant 권한으로 제공한다."""

from functools import partial
from typing import Annotated

from anyio import fail_after
from fastapi import APIRouter, Depends, Path, Query, Request
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from core.api.dependencies import (
    access_value, authorize_source, authorized, credential, envelope, scope_key,
)
from core.api.concurrency import run_owned_thread
from core.api.errors import cleanup_failure_details, error_response
from core.api.schemas import Envelope
from core.modules.access.policy import AccessScope
from core.modules.sources.store import SourceStore

from .download import OriginalResponse
from .ingress import SourceHttpError, invalid, upload_input
from .schemas import (
    EmptyQuery, FileRegistration, FileVersion, SourceCatalog, SourceListQuery,
    SourcePage, SourceReadQuery, SourceResult, TextRegistration, TextVersion,
)
from core.api.v1.analysis_jobs.schemas import CreatedJob
from core.modules.analysis_jobs.store import JobStore
from core.modules.sources.contracts import SOURCE_MEDIA_TYPES


router = APIRouter(tags=["sources"])
Identifier = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
UPLOAD_WAIT_SECONDS = 5


def request_body(version=False):
    # 두 media type은 같은 저장 계약으로 연결하되 서버가 직접 바이트를 제한해 읽는다.
    text_model = TextVersion if version else TextRegistration
    file_model = FileVersion if version else FileRegistration
    return {"requestBody": {"required": True, "content": {
        "application/json": {"schema": text_model.model_json_schema()},
        "multipart/form-data": {"schema": file_model.model_json_schema()},
    }}}


# 동시 업로드 허용 자리를 기다리고, 처리가 끝나면 성공/실패와 관계없이 반환한다.
async def register(request, scope, token, version=False, source_id=None):
    limiter = request.app.state.upload_limiter
    try:
        with fail_after(UPLOAD_WAIT_SECONDS):
            await limiter.acquire()
    except TimeoutError:
        return error_response(503, "upload_busy", "Upload capacity is busy; retry later with the same request.",
                              retry="same_basis")
    try:
        return await _register(request, scope, token, version, source_id)
    finally:
        limiter.release()


# 임시 보관과 공개 저장을 분리한다. 공개 전 최신 권한을 확인하고 이미 성공한 저장은 다시 실행하지 않는다.
async def _register(request, scope, token, version=False, source_id=None):
    store = SourceStore(scope.store)
    staged = None
    value = None
    access = access_value(scope)
    try:
        async with upload_input(request, version=version) as (fields, stream, metadata):
            def stage_owned():
                nonlocal staged
                staged = store.stage(stream, title=fields["title"], **metadata)
            try:
                await run_owned_thread(stage_owned)
            except UnicodeError as error:
                converted = invalid("Source content must be valid UTF-8 text.")
                converted.cleanup_failures = getattr(error, "cleanup_failures", ())
                raise converted from None

        def current_authorization():
            # 업로드를 받는 동안 권한이 바뀔 수 있어 commit의 조정 잠금 안에서 재확인한다.
            nonlocal access
            access = access_value(request.app.state.policy.authorize(token, scope.tenant, "source_write"))
            return access

        def commit_owned():
            nonlocal value
            value = store.commit(staged, tenant=scope.tenant, user_id=scope.user_id,
                request_id=fields["request_id"], source_id=source_id,
                expected_registration_revision=fields.get("expected_registration_revision"),
                authorize=current_authorization)
        await run_owned_thread(commit_owned)
    except SourceHttpError as error:
        warnings = cleanup_failure_details(error)
        return error_response(error.status, error.code, error.message,
                              details={"cleanup_failures": warnings} if warnings else None)
    except ClientDisconnect:
        return error_response(400, "upload_disconnected", "The source upload was interrupted.")
    finally:
        if staged is not None:
            warnings = await run_owned_thread(partial(store.discard, staged))
            if value is not None and warnings:
                value["cleanup_failures"].extend(warnings)
    status = 202 if value["state"] == "pending_reconcile" else 200 if value["replayed"] else 201
    payload = Envelope[SourceResult].model_validate(envelope({**value, "access": access}))
    return JSONResponse(payload.model_dump(), status_code=status, headers={"Cache-Control": "no-store"})


@router.post("/sources", status_code=201, response_model=Envelope[SourceResult],
             responses={200: {"model": Envelope[SourceResult]}, 202: {"model": Envelope[SourceResult]}},
             openapi_extra=request_body())
async def create_source(request: Request, query: Annotated[EmptyQuery, Query()],
                        scope: Annotated[AccessScope, Depends(authorize_source)],
                        token: Annotated[str, Depends(credential)]):
    """텍스트·PDF·XLSX·DOCX·이미지 원본을 보관한다. 등록은 변환이나 AI 실행이 아니다."""
    return await register(request, scope, token)


@router.post("/sources/{source_id}/versions", status_code=201, response_model=Envelope[SourceResult],
             responses={200: {"model": Envelope[SourceResult]}, 202: {"model": Envelope[SourceResult]}},
             openapi_extra=request_body(True))
async def create_version(request: Request, source_id: Identifier,
                         query: Annotated[EmptyQuery, Query()],
                         scope: Annotated[AccessScope, Depends(authorize_source)],
                         token: Annotated[str, Depends(credential)]):
    """현재 등록 revision에서 새 불변 판본을 추가하고 옛 원본과 문서는 보존한다."""
    return await register(request, scope, token, True, source_id)


@router.get("/sources", response_model=Envelope[SourcePage])
def list_sources(query: Annotated[SourceListQuery, Query()],
                 scope: Annotated[AccessScope, Depends(authorized)]):
    store = SourceStore(scope.store)
    value = store.list_sources(tenant=scope.tenant, scope_key=scope_key(scope),
                               limit=query.limit, cursor=query.cursor)
    return envelope({**value, "access": access_value(scope)})


@router.get("/sources/{source_id}", response_model=Envelope[SourceCatalog])
def get_source(source_id: Identifier, query: Annotated[SourceReadQuery, Query()],
               scope: Annotated[AccessScope, Depends(authorized)]):
    value = SourceStore(scope.store).get_source(source_id)
    return envelope({**value, "access": access_value(scope)})


# 원본 등록 또는 작업 생성의 본인 영수증을 읽는다. 다른 사용자 요청을 먼저 읽고 나중에 숨기는 방식은 쓰지 않는다.
@router.get("/requests/{request_id}", response_model=Envelope[SourceResult | CreatedJob])
def request_receipt(request_id: Identifier, query: Annotated[EmptyQuery, Query()],
                    scope: Annotated[AccessScope, Depends(authorized)]):
    try:
        value = SourceStore(scope.store).request_receipt(
            tenant=scope.tenant, user_id=scope.user_id, request_id=request_id)
    except FileNotFoundError:
        value = JobStore(scope.store).request_receipt(
            tenant=scope.tenant, user_id=scope.user_id, request_id=request_id)
    return envelope({**value, "access": access_value(scope)})


@router.get("/sources/{source_id}/versions/{source_version}/file", status_code=200, response_class=OriginalResponse,
            responses={200: {"content": {media: {"schema": {"type": "string", "format": "binary"}}
                                         for media in dict.fromkeys(SOURCE_MEDIA_TYPES.values())}}})
def original(source_id: Identifier, source_version: Identifier,
             query: Annotated[SourceReadQuery, Query()], scope: Annotated[AccessScope, Depends(authorized)]):
    """허용 tenant의 정확한 판본을 전체 바이트와 hash로 내려받는다."""
    stream, manifest = SourceStore(scope.store).open_original(source_id, source_version)
    return OriginalResponse(stream, manifest)
