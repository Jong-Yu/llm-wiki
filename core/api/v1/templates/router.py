"""템플릿 관리·고정판 다운로드·렌더를 기존 tenant 권한에 연결한다."""

from hashlib import sha256
from io import BytesIO
from pathlib import PurePosixPath
import re
from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import JSONResponse

from core.api.concurrency import run_owned_thread
from core.api.dependencies import access_value, authorized, credential, envelope
from core.api.ingress import RequestInputError, read_json_model
from core.api.operations import body_schema, commit_guard, json_operation, reauthorize
from core.api.v1.sources.download import OriginalResponse
from core.modules.templates.store import MAX_FILE_BYTES, TemplateError, TemplateStore
from .ingress import template_input
from .schemas import Identifier, Revision, TemplateArchive, TemplateProfile, TemplateRender

router = APIRouter(tags=["templates"])


def _inspection(metadata, content):
    """실제 파일의 편집 가능한 영역과 지원 여부만 반환한다."""
    from core.modules.templates.render import inspect_template
    return {"template": metadata, "generation": inspect_template(metadata["filename"], content)}


def _detail(scope, template_id, revision=None):
    metadata, content = TemplateStore(scope).read(template_id, revision)
    return _inspection(metadata, content)


def _binary(metadata, content, *, generated=False):
    """파일명·크기·지문을 붙이며 열린 바이트 스트림은 응답이 소유한다."""
    filename = metadata["filename"]
    suffix = PurePosixPath(filename).suffix
    if generated:
        filename = filename[:-len(suffix)] + "-결과" + suffix if suffix else filename + "-결과"
    digest = sha256(content).hexdigest()
    extension = suffix.lstrip(".").lower()
    # 임의 등록 확장자를 Content-Disposition의 ASCII fallback 문법으로 사용하지 않는다.
    safe_extension = extension if re.fullmatch(r"[a-z0-9]{1,12}", extension) else "bin"
    response = OriginalResponse(BytesIO(content), {"filename": filename,
        "format": safe_extension, "size_bytes": len(content), "source_sha256": digest})
    response.headers["X-Content-SHA256"] = digest
    response.headers["X-Template-Revision"] = metadata["revision"]
    return response


@router.get("/templates")
def list_templates(query: Annotated[TemplateProfile, Query()], scope=Depends(authorized)):
    """현재 작업 공간의 보관하지 않은 템플릿을 조회한다."""
    return envelope({**TemplateStore(scope).list(), "access": access_value(scope)})


@router.get("/templates/{template_id}")
def read_template(template_id: Identifier, query: Annotated[TemplateProfile, Query()], scope=Depends(authorized)):
    """현재 이름·지침·파일 판본과 실제 생성 지원 범위를 함께 읽는다."""
    return envelope({**_detail(scope, template_id), "access": access_value(scope)})


@router.get("/templates/{template_id}/versions/{revision}")
def read_version(template_id: Identifier, revision: Revision, query: Annotated[TemplateProfile, Query()], scope=Depends(authorized)):
    """이전 요청이 선택한 불변 파일과 지침을 읽는다."""
    return envelope({**_detail(scope, template_id, revision), "access": access_value(scope)})


@router.get("/templates/{template_id}/versions/{revision}/file", status_code=200, response_class=OriginalResponse)
def download_version(template_id: Identifier, revision: Revision, query: Annotated[TemplateProfile, Query()], scope=Depends(authorized)):
    """무결성을 확인한 원본 전체를 첨부 파일로 내려준다."""
    return _binary(*TemplateStore(scope).read(template_id, revision))


async def _save(request, tenant, token, template_id=None):
    """인가 후 제한 수신하고 실제 공개 직전에 같은 주체의 쓰기 권한을 재확인한다."""
    request.app.state.policy.authorize(token, tenant, "source_write")
    if request.query_params:
        raise RequestInputError(422, "invalid_argument", "프로필은 업로드 필드로 지정해 주세요.")
    async with template_input(request, updating=template_id is not None) as (value, stream, filename):
        def execute():
            scope = reauthorize(request, tenant, token, "source_write", value.profile)
            content = stream.read(MAX_FILE_BYTES + 1) if stream is not None else None
            result = TemplateStore(scope).save(request_id=value.request_id, name=value.name,
                instructions=value.instructions, filename=filename, content=content, template_id=template_id,
                expected_revision=getattr(value, "expected_revision", None),
                before_commit=commit_guard(request, tenant, token, "source_write", scope))
            metadata, content = TemplateStore(scope).read(result["template"]["id"], result["template"]["revision"])
            return envelope({**result, **_inspection(metadata, content), "access": access_value(scope)})
        result = await run_owned_thread(execute)
    return JSONResponse(result, status_code=200 if template_id or result["data"]["replayed"] else 201,
                        headers={"Cache-Control": "no-store"})


@router.post("/templates")
async def create_template(request: Request, tenant: str, token: Annotated[str, Depends(credential)]):
    """확장자 제한 없이 양식 파일과 지침을 새 템플릿으로 등록한다."""
    return await _save(request, tenant, token)


@router.put("/templates/{template_id}")
async def update_template(request: Request, tenant: str, template_id: Identifier, token: Annotated[str, Depends(credential)]):
    """현재 기준 판본에서 파일 또는 지침을 갱신하고 이전 판본은 보존한다."""
    return await _save(request, tenant, token, template_id)


@router.post("/templates/{template_id}/archive", openapi_extra=body_schema(TemplateArchive))
async def archive_template(request: Request, tenant: str, template_id: Identifier, token: Annotated[str, Depends(credential)]):
    """새 요청 목록에서 제외하고 과거 대화가 참조한 판본은 계속 보존한다."""
    def execute(scope, value):
        result = TemplateStore(scope).archive(template_id, request_id=value.request_id,
            expected_revision=value.expected_revision,
            before_commit=commit_guard(request, tenant, token, "source_write", scope))
        return {**result, **_detail(scope, template_id, result["template"]["revision"])}
    return await json_operation(request, tenant, token, TemplateArchive, "source_write", execute)


@router.post("/templates/{template_id}/versions/{revision}/render", status_code=200, response_class=OriginalResponse,
             openapi_extra=body_schema(TemplateRender))
async def render_version(request: Request, tenant: str, template_id: Identifier, revision: Revision,
                         token: Annotated[str, Depends(credential)]):
    """모델의 텍스트 변경안만 고정 원본에 적용하며 셸·외부 참조는 실행하지 않는다."""
    request.app.state.policy.authorize(token, tenant, "read")
    if request.query_params:
        raise RequestInputError(422, "invalid_argument", "프로필은 JSON 본문으로 지정해 주세요.")
    value = await read_json_model(request, TemplateRender)
    def execute():
        from core.modules.templates.render import TemplateRenderError, render_template
        scope = reauthorize(request, tenant, token, "read", value.profile)
        metadata, original = TemplateStore(scope).read(template_id, revision)
        try:
            content = render_template(metadata["filename"], original, value.content)
        except TemplateRenderError as error:
            raise TemplateError(error.code, error.message) from error
        if not 0 < len(content) <= MAX_FILE_BYTES:
            raise TemplateError("template_file_limit", "생성한 파일이 20 MiB 한도를 넘었습니다.", 413)
        reauthorize(request, tenant, token, "read", value.profile, expected=scope)
        return _binary(metadata, content, generated=True)
    return await run_owned_thread(execute)
