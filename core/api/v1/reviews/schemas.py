"""검토 대상·현재 기준·이유만 입력받고 작성자·시각은 서버에서 기록한다."""

from typing import Literal
from pydantic import Field, JsonValue
from core.api.schemas import Model
from core.api.v1.documents.schemas import VersionsQuery, ContentQuery


class DocumentReview(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    claim_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_state_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: str = Field(min_length=1, max_length=1000)
    action: Literal["accept", "edit", "reject", "defer"]
    replacement: dict[str, JsonValue] | None = None


class DocumentReviewUndo(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    event_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_state_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: str = Field(min_length=1, max_length=1000)


class DocumentPolicy(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    claim_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_state_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: str = Field(min_length=1, max_length=1000)
    replacement: dict[str, JsonValue]
    entities: list[dict[str, JsonValue]] | None = Field(None, max_length=500)


# 같은 문서·관점·페이지 계약을 이벤트 조회에서도 사용한다.
EventListQuery = VersionsQuery
EventQuery = ContentQuery
