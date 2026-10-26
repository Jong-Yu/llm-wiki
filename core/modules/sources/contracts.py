"""원본 보관의 한도·엄격한 식별자·공개 오류."""

# API와 저장 코드가 같은 한도·오류 종류를 사용하도록 한곳에 모은다.
# MAX_*는 최대 허용값이다. MiB 용량은 글자 수가 아니라 UTF-8 바이트 수로 계산한다.

from dataclasses import dataclass
from pathlib import Path
import re


MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_TENANT_SOURCE_BYTES = 200 * 1024 * 1024
MAX_STAGING_BYTES = 64 * 1024 * 1024
MAX_SOURCES = 1000
MAX_VERSIONS = 100
MAX_REQUESTS = 10000
MAX_SCAN_ENTRIES = 50000
MAX_JSON_BYTES = 1024 * 1024
MAX_CATALOG_BYTES = 16 * 1024 * 1024
MAX_PAGE_SIZE = 50
CHUNK_BYTES = 65536
ID = re.compile(r"[0-9a-f]{32}")
HEX = re.compile(r"[0-9a-f]{64}")
SOURCE_MEDIA_TYPES = {
    "md": "text/markdown", "txt": "text/plain", "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
}
IMAGE_FORMATS = frozenset({"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"})


class SourceValidationError(ValueError):
    """입력 형식 또는 원본 식별자가 잘못되었다."""


class UnsupportedSourceError(SourceValidationError):
    """원본 보관이 지원하지 않는 파일 형식이나 입력 방식."""


class SourceTooLargeError(SourceValidationError):
    def __init__(self, observed_bytes):
        self.limit_bytes = MAX_SOURCE_BYTES
        self.observed_bytes = observed_bytes
        super().__init__("The original exceeds its byte limit.")


class SourceLimitError(SourceValidationError):
    """누적 보관·판본·요청·탐색 상한으로 기존 자료를 보존하고 중단했다."""


class SourceCorruptError(ValueError):
    """보관 파일이나 기록이 예상 구조·근거와 다르다."""


class SourceConflictError(Exception):
    def __init__(self, code="conflict", **details):
        self.code = code
        self.details = details
        super().__init__("Source registration basis or request payload conflicts.")


@dataclass
class StagedSource:
    # @dataclass는 아래 항목을 받는 생성자를 만들어 준다. 아직 공개하지 않은 수신 파일의 기록이다.
    # consumed=True가 되면 공개 폴더로 이동했으므로 임시 정리에서 삭제하면 안 된다.
    directory: Path
    metadata: dict
    size_bytes: int
    source_sha256: str
    consumed: bool = False


def identifier(value):
    # fullmatch는 일부가 아니라 문자열 전체가 '소문자 16진수 32자리'인지 검사한다.
    if type(value) is not str or not ID.fullmatch(value):
        raise SourceValidationError("Expected a server-format identifier.")
    return value


def metadata(*, kind, title, format, filename=None):
    # 입력의 표시 정보만 검증해 dict로 반환한다. filename은 서버 저장 경로로 사용하지 않는다.
    # * 뒤 인자는 kind=...처럼 이름을 붙여 전달해 인자 순서 실수를 줄인다.
    if kind not in ("file", "text") or type(format) is not str or format not in SOURCE_MEDIA_TYPES:
        raise UnsupportedSourceError("Use Markdown, text, PDF, XLSX, DOCX, PNG, JPEG, GIF, WebP, BMP or TIFF originals.")
    if kind == "text" and format not in {"md", "txt"}:
        raise UnsupportedSourceError("Binary originals must be uploaded as files.")
    if type(title) is not str or not title.strip() or len(title) > 200 or any(ord(c) < 32 for c in title):
        raise SourceValidationError("A title of 1 to 200 visible characters is required.")
    try:
        title.encode("utf-8")
        if filename is not None:
            filename.encode("utf-8")
    except (UnicodeError, AttributeError) as error:
        raise SourceValidationError("Source metadata must be valid UTF-8.") from error
    if kind == "file":
        if (type(filename) is not str or not filename or len(filename) > 255
                or "/" in filename or "\\" in filename or ":" in filename
                or any(ord(c) < 32 for c in filename)
                or Path(filename).suffix.lower() != "." + format):
            raise UnsupportedSourceError("The display filename must match its declared format and contain no path.")
    elif filename is not None:
        raise SourceValidationError("Direct text does not have a client filename.")
    return {"kind": kind, "title": title, "format": format, "filename": filename}
