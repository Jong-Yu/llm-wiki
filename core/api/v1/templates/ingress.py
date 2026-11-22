"""모든 템플릿 형식의 바이트를 보존하며 multipart 경계·필드·용량을 검사한다."""

from contextlib import asynccontextmanager
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.requests import ClientDisconnect

from core.api.concurrency import wait_owned
from core.api.ingress import bounded_stream, content_type
from core.api.v1.sources.ingress import SourceMultipartParser
from core.modules.templates.store import TemplateError, validate_filename
from .schemas import TemplateCreate, TemplateUpdate


@asynccontextmanager
async def template_input(request, *, updating=False):
    """파일명을 형식 allowlist로 제한하지 않고 수신 spool의 수명을 끝까지 관리한다."""
    form = None
    error = TemplateError("invalid_template", "템플릿 업로드 필드를 확인해 주세요.")
    if content_type(request, error=error) != "multipart/form-data":
        raise TemplateError("unsupported_media_type", "템플릿은 multipart/form-data로 업로드해 주세요.", 415)
    parser = SourceMultipartParser(request.headers, bounded_stream(request, maximum=24 * 1024 * 1024,
        error=TemplateError("request_too_large", "템플릿 요청은 24 MiB 이하여야 합니다.", 413)),
        max_files=1, max_fields=6, max_part_size=64 * 1024)
    try:
        form = await parser.parse()
        if not parser.ended:
            raise error
        items = form.multi_items()
        if len(items) != len({key for key, _ in items}):
            raise error
        values = dict(items)
        upload = values.pop("file", None)
        if upload is not None and not isinstance(upload, UploadFile):
            raise error
        if not updating and upload is None:
            raise error
        if any(type(value) is not str for value in values.values()):
            raise error
        model = TemplateUpdate if updating else TemplateCreate
        try:
            metadata = model.model_validate(values)
        except ValidationError:
            raise error from None
        filename = validate_filename(upload.filename or "") if upload is not None else None
        yield metadata, upload.file if upload is not None else None, filename
    except MultiPartException:
        raise TemplateError("invalid_template", "템플릿 업로드가 불완전하거나 필드 한도를 넘었습니다.") from None
    except ClientDisconnect:
        raise TemplateError("upload_disconnected", "템플릿 업로드 연결이 끊어졌습니다.", 400) from None
    finally:
        if form is not None:
            await wait_owned(form.close())
