# JSON 입력과 multipart 파일 입력을 같은 (메타데이터, 열린 파일, 종류) 형태로 맞춘다.
# multipart는 폼의 각 필드/파일을 나누어 전송하는 형식이며, 파일 이름은 표시용으로만 다룬다.

"""실제 수신 바이트·중복 필드·multipart 경계를 검사한 뒤 저장 모듈에 넘긴다."""

from contextlib import asynccontextmanager
from io import BytesIO
import json
import re

from anyio import to_thread
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.requests import ClientDisconnect

from core.api.concurrency import wait_owned
from core.api.ingress import bounded_stream as bounded_body, content_type
from core.modules.sources.contracts import SOURCE_MEDIA_TYPES
from .schemas import TextRegistration, TextVersion


MAX_UPLOAD_REQUEST_BYTES = 24 * 1024 * 1024
MAX_MULTIPART_HEADER_BYTES = 16384


class SourceHttpError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def invalid(message="The upload fields do not match the source contract."):
    return SourceHttpError(422, "invalid_argument", message)


# 원본 전용 바이트 한도를 공통 수신 함수에 넘긴다. Content-Length가 없거나 틀려도 실제 수신량을 제한한다.
async def bounded_stream(request):
    async for chunk in bounded_body(request, maximum=MAX_UPLOAD_REQUEST_BYTES,
            error=SourceHttpError(413, "request_too_large", "The source request exceeds the 24 MiB transport limit.")):
        yield chunk


class SourceMultipartParser(MultiPartParser):
    """파일은 디스크 spool을 사용하고 필드·헤더·완결 경계를 별도로 제한한다."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ended = False
        self.header_bytes = 0

    def on_part_begin(self):
        self.header_bytes = 0
        super().on_part_begin()

    def _count_header(self, start, end):
        self.header_bytes += end - start
        if self.header_bytes > MAX_MULTIPART_HEADER_BYTES:
            raise MultiPartException("Multipart headers exceed the input limit.")

    def on_header_field(self, data, start, end):
        self._count_header(start, end)
        super().on_header_field(data, start, end)

    def on_header_value(self, data, start, end):
        self._count_header(start, end)
        super().on_header_value(data, start, end)

    # 파일명에서 경로를 먼저 거부한다. 클라이언트 파일명이 서버 저장 위치를 정하게 하지 않는다.
    def on_headers_finished(self):
        raw = self._current_part.content_disposition
        names = list(re.finditer(rb'(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))', raw, re.I))
        if len(names) > 1:
            raise MultiPartException("Duplicate filename parameters are not allowed.")
        for match in names:
            value = match.group(1) if match.group(1) is not None else match.group(2).strip()
            # parser의 오래된 IE 경로 제거 동작보다 먼저 원래 filename 경로를 거부한다.
            if any(c in value for c in (b"/", b"\\", b":")):
                raise MultiPartException("A display filename cannot contain a client path.")
        super().on_headers_finished()

    def on_part_end(self):
        if self._current_part.file is None:
            try:
                self._current_part.data.decode("utf-8")
            except UnicodeError:
                raise MultiPartException("Metadata fields must be UTF-8.") from None
        super().on_part_end()

    # 마지막 multipart 경계까지 받았음을 표시한다. 부분 입력을 정상 업로드로 처리하지 않기 위해서다.
    def on_end(self):
        self.ended = True
        super().on_end()


def json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise invalid("Duplicate JSON fields are not allowed.")
        value[key] = item
    return value


# version=True면 새 판본용 모델을 선택해 기준 revision까지 요구한다. 텍스트 내용 자체를 실행하지 않는다.
def parse_text(raw, version):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=json_object)
        return (TextVersion if version else TextRegistration).model_validate(value)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValidationError):
        raise invalid() from None


@asynccontextmanager
async def upload_input(request, *, version):
    """수신용 파일을 반드시 닫고 입력 본문을 서버 경로나 셸 인자로 해석하지 않는다."""
    media_type = content_type(request,
        error=SourceHttpError(415, "unsupported_media_type", "Use one JSON or multipart Content-Type header."))
    if media_type == "application/json":
        raw = bytearray()
        async for chunk in bounded_stream(request):
            raw.extend(chunk)
        value = await to_thread.run_sync(parse_text, raw, version)
        try:
            encoded = value.content.encode("utf-8")
        except UnicodeError:
            raise invalid("Source content must be valid UTF-8 text.") from None
        with BytesIO(encoded) as stream:
            yield value.model_dump(exclude={"content"}), stream, {"kind": "text", "format": value.format}
        return
    if media_type != "multipart/form-data":
        raise SourceHttpError(415, "unsupported_media_type", "Use application/json or multipart/form-data.")
    parser = SourceMultipartParser(request.headers, bounded_stream(request),
                                    max_files=1, max_fields=3, max_part_size=4096)
    form = None
    try:
        form = await parser.parse()
        if not parser.ended:
            raise invalid("The multipart request is incomplete.")
        items = form.multi_items()
        fields = {name for name, _ in items}
        expected = {"request_id", "title", "file"} | ({"expected_registration_revision"} if version else set())
        if fields != expected or len(items) != len(expected):
            raise invalid()
        upload = form["file"]
        if not isinstance(upload, UploadFile):
            raise invalid()
        metadata = {name: form[name] for name in expected - {"file"}}
        if any(not isinstance(value, str) for value in metadata.values()):
            raise invalid()
        # 본문 모델의 필드 제약을 그대로 적용하되 파일 내용은 문자열로 읽지 않는다.
        model = TextVersion if version else TextRegistration
        try:
            validated = model.model_validate({**metadata, "format": "txt", "content": ""})
        except ValidationError:
            raise invalid() from None
        filename = upload.filename or ""
        if (not filename or len(filename) > 255 or any(c in filename for c in ("/", "\\", ":"))
                or any(ord(c) < 32 for c in filename)):
            raise invalid("The upload filename must be a display basename without a path.")
        suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if suffix not in SOURCE_MEDIA_TYPES:
            raise SourceHttpError(415, "unsupported_source", "Use .md, .txt, .pdf, .xlsx, .docx, .png, .jpg, .jpeg, .gif, .webp, .bmp, .tif or .tiff originals.")
        yield validated.model_dump(exclude={"content", "format"}), upload.file, {
            "kind": "file", "format": suffix, "filename": filename}
    except MultiPartException:
        raise invalid("The multipart request is malformed or exceeds field limits.") from None
    except ClientDisconnect:
        raise SourceHttpError(400, "upload_disconnected", "The source upload was interrupted.") from None
    finally:
        if form is not None:
            await wait_owned(form.close())
