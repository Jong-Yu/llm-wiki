"""결과물 초안과 개인 질문 실행의 엄격한 입력 모델이다.

revision은 '읽었던 내용이 아직 같은가'를 확인하는 지문이다. 사용자/tenant,
실제 저장 성공·사람 승인 여부는 입력으로 받지 않고 서버가 판단한다.
"""

from typing import Literal
from pydantic import Field, model_validator
from core.api.schemas import Model
from .schemas import PersonalProfile


class DraftCreate(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    saved_result_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class DraftEdit(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=1024 * 1024)


class DraftApply(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    document: str = Field(min_length=1, max_length=4096)
    expected_document_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    expected_basis_observation: str = Field(pattern=r"^[0-9a-f]{64}$")
    acknowledge_changed_basis: bool = False


class RunCreate(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    conversation_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    question_turn_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_conversation_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class RunCommand(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class RunClaim(RunCommand):
    reclaim: bool = False


class RunHeartbeat(PersonalProfile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_lease_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class RunProgress(RunCommand):
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    progress: Literal["input_ready", "answering", "blocked", "failed"]
    message: str = Field("", max_length=1000)


class InputRead(PersonalProfile):
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class AnswerCitation(Model):
    kind: Literal["document", "source", "claim", "policy"] | None = None
    document: str | None = Field(None, min_length=1, max_length=4096)
    source_revision: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    source_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")
    source_version: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")
    source_sha256: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    quote: str | None = Field(None, min_length=1, max_length=10000)
    claim_id: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    graph_revision: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    state_revision: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")
    event_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")

    @model_validator(mode="after")
    def exact_source(self):
        """원문 인용·기계 주장·전문가 Action log 근거를 다른 종류로 검사한다."""
        if self.kind == "policy":
            if (self.document is None or self.state_revision is None or self.event_id is None
                    or any(value is not None for value in (self.quote, self.claim_id, self.source_id, self.source_version, self.source_sha256))):
                raise ValueError("A policy cites its actual Action log without a fabricated source quote")
        elif self.kind == "claim":
            if (any(value is None for value in (self.document, self.source_revision, self.graph_revision, self.state_revision, self.claim_id, self.quote))
                    or any(value is not None for value in (self.event_id, self.source_id, self.source_version, self.source_sha256))):
                raise ValueError("A machine claim needs its full frozen document/graph/state reference and quote")
        elif self.document is not None:
            if (self.kind not in {None, "document"} or self.source_revision is None or self.quote is None
                    or any(value is not None for value in (self.source_id, self.source_version, self.source_sha256, self.claim_id, self.graph_revision, self.state_revision, self.event_id))):
                raise ValueError("Select one exact document citation")
        elif (self.kind not in {None, "source"} or self.quote is None or self.source_revision is not None
                or any(value is not None for value in (self.claim_id, self.graph_revision, self.state_revision, self.event_id))
                or any(value is None for value in (self.source_id, self.source_version, self.source_sha256))):
            raise ValueError("Select one exact original citation")
        return self


class AnswerExecution(Model):
    provider: str = Field(min_length=1, max_length=100)
    cli_version: str = Field(min_length=1, max_length=256)
    requested_model: str | None = Field(None, max_length=256)
    reported_model: str | None = Field(None, max_length=256)
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    output_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class RunAnswer(RunCommand):
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_conversation_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    content: str = Field(min_length=1, max_length=65536)
    citations: list[AnswerCitation] = Field(default_factory=list, max_length=100)
    execution: AnswerExecution
