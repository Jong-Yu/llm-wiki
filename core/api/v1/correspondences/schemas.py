"""HTTP 입력의 항목과 크기만 검사하고 실제 의미·근거 검사는 기존 Store에 맡긴다."""

from typing import Annotated, Literal
from pydantic import Field, JsonValue
from core.api.schemas import Model

# Annotated는 같은 문자열이라도 ID·판본·이유의 검사 규칙을 붙이는 표기다.
Identifier = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Reason = Annotated[str, Field(min_length=1, max_length=1000)]


class Scoped(Model):
    """관점 이름은 입력으로 선택하지만 실제 허용 여부는 서버 정책이 확인한다."""
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class Find(Scoped):
    documents: list[str] = Field(min_length=1, max_length=8)
    text: str | None = Field(None, max_length=2000)
    application_context: dict[str, JsonValue] | None = None
    as_of: str | None = Field(None, max_length=100)
    limit: int = Field(20, ge=1, le=100)


class Query(Scoped):
    application_context: dict[str, JsonValue] | None = None
    as_of: str | None = Field(None, max_length=100)


class Draft(Scoped):
    draft: dict[str, JsonValue]


class Propose(Draft):
    correspondence_id: Identifier
    expected_state_revision: Revision
    reason: Reason


class Prepare(Scoped):
    operation: Literal["review", "review_undo", "policy", "policy_undo"]
    change: dict[str, JsonValue]


class Review(Scoped):
    action: Literal["accept", "reject", "defer", "edit"]
    expected_state_revision: Revision
    reason: Reason
    replacement: dict[str, JsonValue] | None = None
    decision: Literal["accepted", "deferred"] | None = None


class Undo(Scoped):
    event_id: Identifier
    expected_state_revision: Revision
    reason: Reason


class Policy(Scoped):
    replacement: dict[str, JsonValue]
    expected_state_revision: Revision
    reason: Reason
    judgment_id: Identifier | None = None
    supersedes_event_id: Identifier | None = None
