"""추출물·산출물의 소유 작업과 고정 판본을 명시하는 요청 모델이다."""

from typing import Annotated
from pydantic import Field, field_validator
from core.api.schemas import Model

Identifier = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class ExtractionRead(Model):
    """먼저 본인 job을 확인하기 위해 추출 ID와 함께 소유 작업 ID를 요구한다."""
    job_id: Identifier
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class ArtifactReceiptRead(Model):
    """영수증 조회는 현재 관점의 read만 요구하고 실행·쓰기 권한을 요구하지 않는다."""
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class ExtractionContent(ExtractionRead):
    extraction_revision: Revision
    offset: int = Field(0, ge=0, le=4 * 1024 * 1024, strict=False)
    limit: int = Field(65536, ge=1, le=65536, strict=False)

    @field_validator("offset", "limit", mode="before")
    @classmethod
    def integer_query(cls, value):
        """URL 숫자도 소수나 부호를 조용히 정수로 바꾸지 않는다."""
        if isinstance(value, str) and (not value.isascii() or not value.isdecimal()):
            raise ValueError("Use decimal integer positions.")
        return value


class ArtifactMetadata(Model):
    """파일 바이트는 multipart file로 받고 여기에는 실행·입력·해시 참조만 둔다."""
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    request_id: Identifier
    run_id: Identifier
    expected_job_revision: Revision
    bundle_id: Identifier
    bundle_revision: Revision
    extraction_id: Identifier
    extraction_revision: Revision
    content_sha256: Revision
