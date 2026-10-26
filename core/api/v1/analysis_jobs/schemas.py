# 작업을 만들거나 조회할 때 주고받는 필드다. 같은 str 자료형이어도 ID와 revision의 용도는 다르다.
# job은 분석 작업, run은 이번 실행, lease는 일정 시간만 유효한 실행 사용권을 뜻한다.

"""실제 제공하는 작업 접수 모델. AI 실행·저장 완료를 임의 생성하지 않는다."""

from typing import Literal
from pydantic import Field, JsonValue, field_validator
from core.api.schemas import Access, Model


class EmptyQuery(Model):
    pass


# 등록된 특정 원본 판본과 만들 문서/산출물을 명시한다. 서버는 이 요청으로 AI를 자동 시작하지 않는다.
class CreateJob(Model):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_version: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_registration_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    targets: list[str] = Field(min_length=1, max_length=8)
    outputs: list[Literal["wiki", "ontology"]] = Field(min_length=1, max_length=2)


# 실행 사용권의 버전만 갱신한다. 본문 작업 버전과 분리해 생존 보고가 편집 충돌을 만들지 않게 한다.
class Heartbeat(Model):
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_lease_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class Cancel(Model):
    expected_job_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str = Field("", max_length=1000)


class ListQuery(Model):
    limit: int = Field(20, ge=1, le=50, strict=False)
    cursor: str | None = Field(None, min_length=1, max_length=16384)

    @field_validator("limit", mode="before")
    @classmethod
    def integer_string(cls, value):
        if isinstance(value, str) and (not value.isascii() or not value.isdecimal()):
            raise ValueError("limit must be an integer string")
        return value


class SourceRef(Model):
    source_id: str
    source_version: str
    source_sha256: str
    size_bytes: int
    registration_revision: str


class Target(Model):
    document: str
    source_revision: str | None
    state_revision: str | None


# 서버 상태(state), CLI의 자기보고(reported_status), 사용권(lease), 실제 결과(result_summary)를 나눠 표현한다.
class Job(Model):
    schema_version: Literal[1]
    job_id: str
    tenant: str
    user_id: str
    request_id: str
    payload_hash: str
    actor: Access
    created_at: str
    source_ref: SourceRef
    targets: list[Target]
    outputs: list[Literal["wiki", "ontology"]]
    state: Literal["awaiting_cli", "claimed", "cancelled"]
    run_id: str | None
    reported_status: Literal["input_ready", "analyzing", "blocked", "failed", "stopped"] | None
    message: str
    events: list[dict[str, JsonValue]]
    job_revision: str
    lease_status: Literal["none", "active", "expired"]
    lease_revision: str | None
    lease_expires_at: str | None
    basis_status: Literal["current", "changed", "missing"]
    execution_ready: Literal[False]
    blockers: list[str]
    input_readiness: Literal["unconfigured", "not_prepared", "validation_required", "stale"] = "unconfigured"
    active_input_ref: dict[str, JsonValue] | None = None
    analysis_basis_ref: dict[str, JsonValue] | None = None
    legacy_rebase_required: bool = False
    result_summary: dict[str, JsonValue] | None = None
    access: Access


# 작업 생성 접수의 영수증이다. complete는 생성 접수가 확인됐다는 뜻이며 분석 결과 저장 완료와 다르다.
class CreatedJob(Model):
    request_id: str
    state: Literal["complete", "pending_reconcile"]
    job_id: str
    job_revision: str | None
    receipt: dict[str, JsonValue] | None
    replayed: bool
    cleanup_failures: list[dict[str, JsonValue]]
    access: Access


class JobPage(Model):
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
