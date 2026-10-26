# 직접 텍스트 입력과 파일 업로드의 입력 항목, 등록 영수증과 원본 목록의 응답 항목이다.
# Literal은 정해진 값만 허용한다. TextVersion처럼 상속한 모델은 부모 필드를 유지하고 버전 기준을 추가한다.

"""원본 수신 입력과 등록 결과를 손실 없이 표현하는 전송 모델."""

from typing import Literal
from pydantic import Field, JsonValue, field_validator

from core.api.schemas import Access, Model


class EmptyQuery(Model):
    pass


class SourceReadQuery(Model):
    # 원본 상세/파일도 화면이 선택한 허용 관점을 현재 정책으로 확인한다.
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class SourceListQuery(Model):
    limit: int = Field(20, ge=1, le=50, strict=False)
    cursor: str | None = Field(None, min_length=1, max_length=16384)

    @field_validator("limit", mode="before")
    @classmethod
    def integer_query(cls, value):
        if isinstance(value, str) and (not value.isascii() or not value.isdecimal()):
            raise ValueError("limit must be an integer string")
        return value


class TextRegistration(Model):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    title: str = Field(min_length=1, max_length=200)
    format: Literal["md", "txt"]
    content: str


class TextVersion(TextRegistration):
    expected_registration_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class FileRegistration(Model):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    title: str = Field(min_length=1, max_length=200)
    file: str = Field(description="One original, at most 20 MiB: MD, TXT, PDF, XLSX, DOCX, PNG, JPEG, GIF, WebP, BMP or TIFF. Filename suffix and file markers must match. Upload does not perform conversion or OCR.", json_schema_extra={"format": "binary"})


class FileVersion(FileRegistration):
    expected_registration_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


# 원본 보관 결과다. cleanup_failures는 정리 경고이며 원본 저장 성공을 자동으로 실패로 바꾸지 않는다.
class SourceResult(Model):
    request_id: str
    state: Literal["complete", "pending_reconcile"]
    source_id: str
    source_version: str
    source_sha256: str
    size_bytes: int
    registration_revision: str | None
    receipt: dict[str, JsonValue] | None
    cleanup_failures: list[dict[str, JsonValue]]
    replayed: bool
    access: Access


# current_version은 최신 판본을 가리키고 versions에는 보존된 과거 판본의 정보도 남는다.
class SourceCatalog(Model):
    source_id: str
    title: str
    current_version: str
    versions: list[dict[str, JsonValue]]
    documents: list[dict[str, JsonValue]]
    registration_revision: str
    access: Access


class SourcePage(Model):
    items: list[dict[str, JsonValue]]
    scope: dict[str, JsonValue]
    catalog_revision: str
    next_cursor: str | None
    complete: bool
    truncated: bool
    skipped: list[dict[str, JsonValue]]
    scanned: int
    requires_refresh: bool
    access: Access
