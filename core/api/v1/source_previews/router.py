"""현재 허용 범위와 고정 원본 근거를 대조한 PDF 페이지 이미지만 제공한다."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import Field
from starlette.responses import Response

from core.api.concurrency import run_owned_thread
from core.api.dependencies import authorized, credential
from core.api.errors import error_response
from core.api.operations import reauthorize
from core.api.v1.sources.schemas import SourceReadQuery
from core.modules.access.policy import AccessScope
from core.modules.sources.contracts import SourceConflictError
from core.modules.sources.store import SourceStore
from .render import PreviewError, render_page

router = APIRouter(tags=["sources"])
Identifier = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]


class PreviewQuery(SourceReadQuery):
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    registration_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


def _check_basis(sources, source_id, source_version, query):
    """검토 화면의 판본이 변경되거나 휴지통으로 이동했으면 오래된 승인을 막는다."""
    catalog = sources.get_source(source_id)
    if (catalog["registration_revision"] != query.registration_revision
            or catalog["current_version"] != source_version):
        raise SourceConflictError("source_changed")


@router.get("/sources/{source_id}/versions/{source_version}/pages/{page}", response_class=Response,
            responses={200: {"content": {"image/png": {"schema": {"type": "string", "format": "binary"}}}}})
async def page_preview(request: Request, tenant: str, source_id: Identifier, source_version: Identifier,
                       page: Annotated[int, Path(ge=1, le=100000)],
                       query: Annotated[PreviewQuery, Query()],
                       token: Annotated[str, Depends(credential)],
                       scope: Annotated[AccessScope, Depends(authorized)]):
    """OCR 설치 없이 원본을 확인하며 조회 자체는 읽음·판단·승인을 바꾸지 않는다."""
    def operation():
        sources = SourceStore(scope.store)
        _check_basis(sources, source_id, source_version, query)
        stream, manifest = sources.open_original(source_id, source_version)
        with stream:
            if manifest["source_sha256"] != query.source_sha256:
                raise SourceConflictError("source_changed")
            if manifest["format"] != "pdf":
                raise PreviewError("source_preview_unsupported", 415)
            data = render_page(stream, page)
        reauthorize(request, tenant, token, "read", query.profile, expected=scope)
        _check_basis(sources, source_id, source_version, query)
        return data

    try:
        data = await run_owned_thread(operation)
    except PreviewError as error:
        return error_response(error.status, error.code, "The original page preview is unavailable.",
                              retry="read_again" if error.status == 503 else "none")
    return Response(data, media_type="image/png", headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "X-Source-Sha256": query.source_sha256, "X-Source-Version": source_version,
        "X-Registration-Revision": query.registration_revision, "X-Source-Page": str(page),
    })
