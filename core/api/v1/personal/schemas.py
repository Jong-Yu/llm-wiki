"""개인 기록의 입력 계약이다. 인증 사용자와 승인 여부를 입력으로 받지 않는다."""

from typing import Literal
from pydantic import Field, model_validator, field_validator
from core.api.schemas import Model
from core.api.v1.knowledge.schemas import QuestionContextRequest, ClaimSelection, SearchQuery


class PersonalProfile(Model):
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class PersonalList(PersonalProfile):
    limit: int = Field(20, ge=1, le=50, strict=False)
    cursor: str | None = Field(None, min_length=1, max_length=16384)
    integer_query = field_validator("limit", mode="before")(SearchQuery.integer_query.__func__)


class PersonalReceipt(PersonalProfile):
    record_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")


class CreateConversation(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    title: str = Field(min_length=1, max_length=200)


class AppendTurn(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    role: Literal["user", "assistant"]
    content: str = Field(max_length=65536)
    status: Literal["complete", "failed"] = "complete"
    context_request: QuestionContextRequest | None = None
    reply_to: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")

    @model_validator(mode="after")
    def role_basis(self):
        """새 질문은 근거를 준비하고 답변은 실제 저장된 질문 하나를 참조한다."""
        if self.role == "user":
            if self.context_request is None or self.reply_to is not None or self.status != "complete" or not self.content:
                raise ValueError("A question needs explicit context")
        elif self.reply_to is None or self.context_request is not None or (not self.content and self.status != "failed"):
            raise ValueError("An answer needs a stored question reference")
        return self


class CreateSavedResult(CreateConversation):
    content: str | None = Field(None, max_length=65536)
    context_request: QuestionContextRequest | None = None
    conversation_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")
    turn_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")

    @model_validator(mode="after")
    def input_source(self):
        """직접 작성 결과와 저장된 답변 중 하나만 명시한다."""
        direct = self.content is not None and self.context_request is not None
        stored = self.conversation_id is not None and self.turn_id is not None
        if direct == stored or (direct and (self.conversation_id or self.turn_id)) or (stored and (self.content is not None or self.context_request is not None)):
            raise ValueError("Select exactly one result source")
        return self


class ClaimMapping(Model):
    document: str = Field(min_length=1, max_length=4096)
    old_claim_id: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    new_claim_id: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    disposition: Literal["same", "changed", "missing", "new"]
    reason: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def endpoints(self):
        """미발견과 신규 주장을 비교 완료나 삭제로 자동 바꾸지 않는다."""
        both = self.old_claim_id is not None and self.new_claim_id is not None
        if ((self.disposition in {"same", "changed"} and not both)
                or (self.disposition == "missing" and (self.old_claim_id is None or self.new_claim_id is not None))
                or (self.disposition == "new" and (self.new_claim_id is None or self.old_claim_id is not None))):
            raise ValueError("Mapping endpoints do not match its disposition")
        return self


class CreateComparison(CreateConversation):
    baseline_result_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    context_request: QuestionContextRequest
    mappings: list[ClaimMapping] = Field(default_factory=list, max_length=100)


class CompleteComparison(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    outcome: Literal["reviewed", "deferred"]
    reason: str = Field(min_length=1, max_length=1000)
    reviewed_claims: list[ClaimSelection] = Field(default_factory=list, max_length=100)
