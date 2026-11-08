# 문서 목록/본문 API의 query와 JSON 응답 형태다. Field의 ge/le는 숫자의 최소/최대 허용값이다.
# cursor는 다음 목록 페이지를 이어 읽는 표식이고 revision은 읽은 내용의 버전 지문이다.

from typing import Literal
from pydantic import Field, JsonValue, field_validator
from core.api.schemas import Access, Model


class ListQuery(Model):
    # HTTP query의 숫자는 문자열이므로 제한된 정수 파싱만 허용한다.
    limit: int = Field(20, ge=1, le=50, strict=False)
    cursor: str | None = Field(None, min_length=1, max_length=16384)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")

    @field_validator("limit", mode="before")
    @classmethod
    def integer_query(cls, value):
        if isinstance(value, str) and (not value.isascii() or not value.isdecimal()):
            raise ValueError("limit must be an integer string")
        return value


class ContentQuery(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class VersionsQuery(ListQuery):
    """기존 목록의 페이지/관점 규칙을 문서 버전 조회에도 재사용한다."""
    document: str = Field(min_length=1, max_length=4096)


class SaveContent(Model):
    """None 기준은 신규 생성만 뜻한다. 기존 수정에는 읽었던 revision이 필요하다."""
    document: str = Field(min_length=1, max_length=4096)
    content: str = Field(max_length=1024 * 1024)
    expected_revision: str | None = Field(pattern=r"^[a-f0-9]{64}$")
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    reason: str | None = Field(None, max_length=2000)


class RestoreContent(Model):
    """과거 본문을 현재 편집 기준에서 새 저장으로 복원한다."""
    document: str = Field(min_length=1, max_length=4096)
    history_id: str = Field(min_length=1, max_length=255)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    reason: str | None = Field(None, max_length=2000)


class DocumentContent(Model):
    document: str
    content: str
    revision: str
    metadata: dict[str, JsonValue]
    body: str
    body_start_line: int
    body_revision: str
    document_id: str | None
    authorship: dict[str, JsonValue]
    access: Access


class DocumentItem(Model):
    document: str
    revision: str
    source_status: Literal["unlinked", "linked"]
    metadata: dict[str, JsonValue] = Field(default_factory=dict)
    document_id: str | None = None
    body_revision: str | None = None
    authorship: dict[str, JsonValue] = Field(default_factory=lambda: {"status": "unknown", "created": None, "updated": None})


class RegisteredSourceItem(Model):
    kind: Literal["source"]
    source_id: str
    title: str
    source_version: str
    source_sha256: str
    size_bytes: int
    format: Literal["md", "txt", "pdf", "xlsx", "docx", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]
    registration_revision: str
    documents: list[dict[str, JsonValue]]
    analysis_status: Literal["not_started"]


# complete/truncated/skipped를 함께 봐야 목록이 전부인지 판단할 수 있다. 빈 items만으로 자료가 없다고 단정하지 않는다.
class DocumentPage(Model):
    items: list[DocumentItem | RegisteredSourceItem]
    scope: dict[str, JsonValue]
    catalog_revision: str
    next_cursor: str | None
    complete: bool
    truncated: bool
    skipped: list[dict[str, JsonValue]]
    scanned: int
    requires_refresh: bool
    access: Access
