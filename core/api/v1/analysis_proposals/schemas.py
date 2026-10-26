"""제안·적용·재검토 입력이다. actor와 승인 상태는 클라이언트가 선언하지 않는다."""

from typing import Literal
from pydantic import Field, JsonValue
from core.api.schemas import Model


class Profile(Model):
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class ContextDocument(Model):
    document: str = Field(min_length=1, max_length=4096)
    required: bool = True
    reason: str = Field(min_length=1, max_length=1000)


class Prepare(Profile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    document: str = Field(min_length=1, max_length=4096)
    expected_source_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    context_documents: list[ContextDocument] = Field(default_factory=list, max_length=7)
    submission: dict[str, JsonValue] | None = None


class Change(Profile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class ResolutionBinding(Model):
    decision_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    new_claim_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str = Field(min_length=1, max_length=1000)


class Submit(Change):
    submission: dict[str, JsonValue]
    resolves_decision_ids: list[str] = Field(default_factory=list, max_length=100)
    resolution_bindings: list[ResolutionBinding] = Field(default_factory=list, max_length=100)


class Apply(Change):
    candidate_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class MissingDecision(Apply):
    old_claim_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    action: Literal["exclude", "keep", "reextract"]
    reason: str = Field(min_length=1, max_length=1000)
    checked_whole: bool = False
    evidence: str = Field("", max_length=65536)
    replacement: dict[str, JsonValue] | None = None


class Complete(Change):
    expected_review_state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    reviewed_claim_ids: list[str] = Field(default_factory=list, max_length=100)
    reason: str = Field(min_length=1, max_length=1000)


class StartExecution(Change):
    candidate_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str = Field(min_length=1, max_length=1000)


class ResultReference(Model):
    job_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    bundle_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    bundle_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    submission_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class LinkResult(Change):
    candidate_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    execution_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    mode: Literal["candidate", "diagnostics"]
    result_ref: ResultReference
    resolves_decision_ids: list[str] = Field(default_factory=list, max_length=100)
    resolution_bindings: list[ResolutionBinding] = Field(default_factory=list, max_length=100)
