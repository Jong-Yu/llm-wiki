# 지식 조회 결과에서 원문·기계 그래프·검토 판단·출처·버전을 함께 보존하는 응답 모델이다.
# machine_graph는 기계 추출 결과, effective_graph는 현재 검토/정책을 반영한 결과이므로 구별한다.

from typing import Literal
from pydantic import Field, JsonValue, field_validator, model_serializer
from core.api.schemas import Access, Model
from core.api.v1.analysis_plans.schemas import ConversionRef


class KnowledgeQuery(Model):
    document: str = Field(min_length=1, max_length=4096)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class SearchQuery(Model):
    """주소의 검색어와 페이지 크기를 검증한다. 문자열 검색이지 의미 검색은 아니다."""
    query: str = Field(min_length=1, max_length=200)
    limit: int = Field(20, ge=1, le=50, strict=False)
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")

    @field_validator("limit", mode="before")
    @classmethod
    def integer_query(cls, value):
        if isinstance(value, str) and (not value.isascii() or not value.isdecimal()):
            raise ValueError("limit must contain decimal digits")
        return value


class ConnectionsQuery(KnowledgeQuery):
    """문서 연결 목록의 한도는 링크와 후보에 각각 적용한다."""
    limit: int = Field(20, ge=1, le=100, strict=False)
    integer_query = field_validator("limit", mode="before")(SearchQuery.integer_query.__func__)


class ProfileRequest(Model):
    """POST 본문에서 선택 관점만 받는다. 사용자·tenant·업무 권한은 서버가 정한다."""
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class ContextRequest(ProfileRequest):
    documents: list[str] = Field(min_length=1, max_length=8)


class FindRequest(ProfileRequest):
    text: str = Field(min_length=1, max_length=200)
    documents: list[str] | None = Field(None, min_length=1, max_length=8)
    include_history: bool = False
    application_context: dict[str, JsonValue] | None = None
    as_of: str | None = Field(None, max_length=100)
    limit: int = Field(20, ge=1, le=100)


class ConceptRequest(ProfileRequest):
    target: dict[str, JsonValue]
    documents: list[str] | None = Field(None, min_length=1, max_length=8)
    correspondence_ids: list[str] | None = Field(None, max_length=8)
    expansion: Literal["none", "direct_confirmed"] = "none"
    application_context: dict[str, JsonValue] | None = None
    as_of: str | None = Field(None, max_length=100)
    limit: int = Field(20, ge=1, le=100)


class ImpactBaseline(Model):
    source_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    graph_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    review_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    history_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class ImpactRequest(ProfileRequest):
    document: str = Field(min_length=1, max_length=4096)
    baseline: ImpactBaseline | None = None
    limit: int = Field(20, ge=1, le=100)


class AggregateRequest(ProfileRequest):
    """기존 명시 범위와 현재 허용 공간 전체를 구분해 집계한다."""
    coverage: Literal["selected", "tenant"] = "selected"
    documents: list[str] = Field(default_factory=list, max_length=8)
    correspondence_ids: list[str] = Field(default_factory=list, max_length=8)
    limit: int = Field(20, ge=1, le=100)
    cursor: str | None = Field(None, min_length=1, max_length=16384)


class ReviewQueueRequest(AggregateRequest):
    states: list[Literal["unreviewed", "defer", "pending"]] = Field(
        default_factory=lambda: ["unreviewed", "defer", "pending"], min_length=1, max_length=3)


class HistoryRequest(AggregateRequest):
    job_ids: list[str] = Field(default_factory=list, max_length=8)


class ClaimSelection(Model):
    document: str = Field(min_length=1, max_length=4096)
    claim_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class QuestionSource(Model):
    source_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_version: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    # PDF/Excel은 원시 파일을 문자로 읽을 수 없다. 개인 PC에서 보고한 변환의
    # ID와 revision을 함께 지정하면 그때의 본문·페이지/셀 위치를 고정한다.
    conversion_ref: ConversionRef | None = None

    @model_serializer(mode="wrap")
    def serialize(self, handler):
        """생략한 새 필드가 기존 개인 요청의 hash·재시도 비교를 바꾸지 않게 한다."""
        value = handler(self)
        if self.conversion_ref is None:
            value.pop("conversion_ref", None)
        return value


class QuestionContextRequest(ProfileRequest):
    """정의·예외·고정 주장과 원본 판본을 조용히 제외하지 않는 질문 준비 입력이다."""
    documents: list[str] = Field(default_factory=list, max_length=8)
    required_documents: list[str] = Field(default_factory=list, max_length=8)
    claims: list[ClaimSelection] = Field(default_factory=list, max_length=100)
    source_refs: list[QuestionSource] = Field(default_factory=list, max_length=4)


# 각 revision은 서로 다른 자료의 버전이다. 원문·그래프·검토·전체 이력을 같은 값으로 취급하지 않는다.
class DocumentKnowledge(Model):
    document: str
    source_revision: str
    graph_revision: str | None
    review_revision: str | None
    history_revision: str
    state_revision: str
    status: str
    # 저장 스키마 세대별 전체 payload를 유지하며 인용·한정어를 필터링하지 않는다.
    machine_graph: dict[str, JsonValue]
    effective_graph: dict[str, JsonValue]
    claims: list[dict[str, JsonValue]]
    policies: list[dict[str, JsonValue]]
    history: list[dict[str, JsonValue]]
    pending_history: list[str]
    selection: dict[str, JsonValue]
    needs_review: bool
    access: Access
