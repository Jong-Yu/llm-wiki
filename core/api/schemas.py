# HTTP 요청·응답의 공통 자료형이다. 아래 클래스의 필드는 JSON의 항목 이름과 자료형을 뜻한다.
# Model을 상속한 모델은 선언되지 않은 항목과 임의의 자동 형 변환을 허용하지 않는다.

"""일반 HTTP API가 함께 사용하는 응답·오류 모델."""

from typing import Generic, Literal, TypeVar
from pydantic import BaseModel, ConfigDict, Field, JsonValue


# Pydantic의 공통 기반이다. extra=forbid는 모르는 필드를 거부하고 strict=True는 자동 형 변환을 막는다.
class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Meta(Model):
    trace_id: str


T = TypeVar("T")


# Generic[T]의 T에는 실제 업무 응답 모델이 들어간다. 예: Envelope[Job]이면 data가 Job 형태다.
class Envelope(Model, Generic[T]):
    data: T
    meta: Meta


# retry는 지금 다시 보내기/다시 읽기/입력 대조 같은 다음 행동을 구별하는 값이다.
class Error(Model):
    code: str
    message: str
    retry: Literal["none", "read_again", "same_basis", "reconcile"] = "none"
    details: dict[str, JsonValue] = Field(default_factory=dict)


class ErrorEnvelope(Model):
    error: Error
    meta: Meta


# 서버가 적용한 사용자·tenant·관점·정책 버전이다. 사용자 입력으로 권한을 선언하는 모델은 아니다.
class Access(Model):
    user_id: str
    tenant: str
    profile_id: str
    domain: str | None
    viewpoint: str | None
    policy_revision: str
    # 과거 불변 actor에는 없을 수 있다. 신규 요청은 실제 AccessScope의 값을 사용한다.
    access_revision: str | None = Field(default=None, exclude_if=lambda value: value is None)
