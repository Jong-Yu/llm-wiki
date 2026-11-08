"""파일 경로를 공개하지 않고 현재 허용 범위의 추출물·산출물만 전송한다."""

from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from pydantic import JsonValue, ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse
from core.common.json_codec import canonical_json_hash
from core.api.concurrency import run_owned_thread, wait_owned
from core.api.dependencies import authorized, credential, access_value, envelope
from core.api.errors import error_response
from core.api.ingress import content_type
from core.api.operations import reauthorize
from core.api.schemas import Envelope
from core.api.v1.sources.download import OriginalResponse
from core.api.v1.sources.ingress import SourceHttpError, SourceMultipartParser, bounded_stream
from core.modules.access.policy import AccessScope
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_inputs import artifacts, contracts as limits
from core.modules.analysis_inputs.store import InputStore
from . import schemas

router = APIRouter(tags=["extractions"])


def multipart_schema():
    """실제 메타데이터 모델의 필드·지문 규칙과 파일 항목을 OpenAPI에도 그대로 공개한다."""
    value = schemas.ArtifactMetadata.model_json_schema()
    value["properties"]["file"] = {"type": "string", "format": "binary"}
    value["required"] = [*value["required"], "file"]
    return {"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": value}}}}


def selected(scope, query, extraction_id):
    """자료를 읽기 전에 본인 작업을 확인하고 기존 파일·지문 검사로 추출물을 읽는다."""
    return artifacts.extraction(scope.store, JobStore(scope.store), tenant=scope.tenant,
        user_id=scope.user_id, job_id=query.job_id, extraction_id=extraction_id)


@router.get("/extractions/{extraction_id}", response_model=Envelope[dict[str, JsonValue]])
def extraction_manifest(extraction_id: schemas.Identifier, query: Annotated[schemas.ExtractionRead, Query()],
                        scope: Annotated[AccessScope, Depends(authorized)]):
    """당시 원본·입력·실행 계보와 명시 산출물 참조를 읽고 본문 전체를 대신 반환하지 않는다."""
    job, manifest, _ = selected(scope, query, extraction_id)
    return envelope({"manifest": manifest, "artifacts": artifacts.artifact_refs(job, extraction_id),
        "artifact_collection_revision": canonical_json_hash(artifacts.artifact_refs(job, extraction_id)),
        "access": access_value(scope)})


@router.get("/extractions/{extraction_id}/content", response_model=Envelope[dict[str, JsonValue]])
def extraction_content(extraction_id: schemas.Identifier, query: Annotated[schemas.ExtractionContent, Query()],
                       scope: Annotated[AccessScope, Depends(authorized)]):
    """같은 불변 추출 판본의 문자 페이지를 읽는다. 나머지 페이지가 있으면 완료로 표시하지 않는다."""
    _, manifest, text = selected(scope, query, extraction_id)
    if query.extraction_revision != manifest["extraction_revision"]:
        raise limits.InputConflictError("extraction_basis_changed")
    if query.offset > len(text):
        raise limits.InputValidationError("The character offset exceeds the extraction.")
    stop = min(len(text), query.offset + query.limit)
    return envelope({"extraction_id": extraction_id, "extraction_revision": manifest["extraction_revision"],
        "content_sha256": manifest["content_sha256"], "content_size_bytes": manifest["content_size_bytes"],
        "content": text[query.offset:stop], "offset": query.offset, "next_offset": stop if stop < len(text) else None,
        "complete": stop == len(text), "extraction_complete": manifest["complete"],
        "truncated": False, "skipped": [], "access": access_value(scope)})


class ArtifactResponse(OriginalResponse):
    """원본 응답의 열린 파일·취소 정리를 재사용하며 산출물은 첨부 바이너리로 내려준다."""
    def __init__(self, stream, manifest):
        super().__init__(stream, {"format": "bin", "filename": manifest["filename"],
            "size_bytes": manifest["size_bytes"], "source_sha256": manifest["sha256"]})
        self.headers["content-type"] = "application/octet-stream"
        del self.headers["x-source-sha256"]
        self.headers["x-artifact-sha256"] = manifest["sha256"]


@router.get("/extractions/{extraction_id}/artifacts/{artifact_id}", status_code=200, response_class=ArtifactResponse)
def extraction_artifact(extraction_id: schemas.Identifier, artifact_id: schemas.Identifier,
                        query: Annotated[schemas.ExtractionRead, Query()],
                        scope: Annotated[AccessScope, Depends(authorized)]):
    """같은 공개 추출물에 명시 연결된 파일의 실제 크기·지문을 확인해 내려준다."""
    job, _, _ = selected(scope, query, extraction_id)
    manifest, stream = artifacts.artifact(scope.store, job, extraction_id, artifact_id)
    return ArtifactResponse(stream, manifest)


@router.get("/analysis-jobs/{job_id}/artifacts/requests/{request_id}",
            response_model=Envelope[dict[str, JsonValue]])
def artifact_receipt(job_id: schemas.Identifier, request_id: schemas.Identifier,
                     query: Annotated[schemas.ArtifactReceiptRead, Query()],
                     scope: Annotated[AccessScope, Depends(authorized)]):
    """응답 유실 뒤에도 본인의 요청 ID·payload 지문·공개 상태를 읽기만 한다."""
    result = artifacts.request_receipt(scope.store, JobStore(scope.store), tenant=scope.tenant,
        user_id=scope.user_id, job_id=job_id, request_id=request_id)
    return envelope({**result, "access": access_value(scope)})


@router.post("/analysis-jobs/{job_id}/artifacts", status_code=201,
             response_model=Envelope[dict[str, JsonValue]],
             responses={200: {"model": Envelope[dict[str, JsonValue]], "description": "Existing upload request confirmed"},
                        202: {"model": Envelope[dict[str, JsonValue]], "description": "Published file awaiting job reconciliation"}},
             openapi_extra=multipart_schema())
async def upload_artifact(job_id: schemas.Identifier, request: Request, tenant: str,
                          token: Annotated[str, Depends(credential)]):
    """현재 실행의 파일 하나를 보존한다. 업로드가 위키·그래프 저장이나 사람 승인은 아니다."""
    request.app.state.policy.authorize(token, tenant, "source_write")
    form = None
    parser = None
    try:
        if request.query_params:
            return error_response(422, "invalid_argument", "Use multipart metadata fields.")
        if content_type(request, error=SourceHttpError(415, "unsupported_media_type", "Use multipart/form-data.")) != "multipart/form-data":
            return error_response(415, "unsupported_media_type", "Use multipart/form-data.")
        parser = SourceMultipartParser(request.headers, bounded_stream(request),
                                       max_files=1, max_fields=10, max_part_size=4096)
        form = await parser.parse()
        items = form.multi_items()
        if not parser.ended or len({name for name, _ in items}) != len(items):
            raise SourceHttpError(422, "invalid_argument", "Incomplete or duplicate upload fields.")
        uploaded = form.get("file")
        if not isinstance(uploaded, UploadFile):
            raise SourceHttpError(422, "invalid_argument", "One artifact file is required.")
        metadata = schemas.ArtifactMetadata.model_validate({name: value for name, value in items if name != "file"})
        def operation():
            scope = reauthorize(request, tenant, token, "source_write", metadata.profile)
            def current(permission):
                checked = reauthorize(request, tenant, token, permission, metadata.profile, expected=scope)
                return access_value(checked)
            value = artifacts.submit(InputStore(scope.store, getattr(request.app.state, "rulesets", None)), job_id,
                tenant=tenant, user_id=scope.user_id, filename=uploaded.filename or "",
                media_type=uploaded.content_type or "application/octet-stream", stream=uploaded.file,
                authorize=current, **metadata.model_dump(exclude={"profile"}))
            payload = Envelope[dict[str, JsonValue]].model_validate(envelope({**value, "access": access_value(scope)}))
            status = 202 if value["state"] == "pending_reconcile" else 200 if value["replayed"] else 201
            return JSONResponse(payload.model_dump(), status_code=status, headers={"Cache-Control": "no-store"})
        return await run_owned_thread(operation)
    except SourceHttpError as error:
        return error_response(error.status, error.code, error.message)
    except (MultiPartException, ValidationError):
        return error_response(422, "invalid_argument", "Artifact metadata or multipart fields are invalid.")
    except ClientDisconnect:
        return error_response(400, "request_disconnected", "The file request was interrupted; inspect the current job before retrying.", retry="reconcile")
    finally:
        if form is not None:
            await wait_owned(form.close())
        elif parser is not None:
            for pending in parser._files_to_close_on_error:
                await run_owned_thread(pending.close)
