"""저장된 추출을 대조하는 개인 실행의 제한된 입력 계약이다."""

from typing import Annotated, Literal
from pydantic import Field, model_validator
from core.api.schemas import Model
from .schemas import PersonalProfile, PersonalList

Identifier = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Note = Annotated[str, Field(min_length=1, max_length=2000)]


class ComparisonList(PersonalList):
    document: str | None = Field(None, min_length=1, max_length=4096)
    job_id: Identifier | None = None


class ComparisonRead(PersonalProfile):
    step_id: Identifier | None = None
    include_target: Literal["true", "false"] = "false"


class ComparisonCreate(PersonalProfile):
    request_id: Identifier
    document: str = Field(min_length=1, max_length=4096)
    source_revision: Revision
    graph_revision: Revision
    session_id: str = Field(min_length=1, max_length=200)
    job_id: Identifier | None = None
    provider: Literal["codex", "claude"] | None = None


class ComparisonStep(PersonalProfile):
    request_id: Identifier
    expected_revision: Revision
    operation: Literal["search", "read", "document"]
    terms: list[Annotated[str, Field(min_length=1, max_length=200)]] | None = Field(None, min_length=1, max_length=12)
    reference_id: Revision | None = None

    @model_validator(mode="after")
    def selected_operation(self):
        if self.operation == "search":
            if self.terms is None or self.reference_id is not None:
                raise ValueError("Search needs terms only")
        elif self.terms is not None or self.reference_id is None:
            raise ValueError("Reading needs an observed reference only")
        return self


class ComparisonCandidate(Model):
    reference_id: Revision
    reason: Note
    unconfirmed: list[Note] = Field(max_length=20)


class ComparisonResult(PersonalProfile):
    request_id: Identifier
    expected_revision: Revision
    status: Literal["complete", "incomplete"]
    candidates: list[ComparisonCandidate] = Field(max_length=100)
    excluded: list[ComparisonCandidate] = Field(max_length=100)
    unconfirmed: list[Note] = Field(max_length=100)
    failure: str | None = Field(None, min_length=1, max_length=1000)
