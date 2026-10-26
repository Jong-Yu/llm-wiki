# 소속 조회 응답의 구조다. tenant별 Membership 안에 권한 목록과 선택 가능한 Profile이 들어간다.
# str | None은 문자열 또는 값 없음, dict[str, Profile]은 이름을 키로 하는 Profile 대응표를 뜻한다.

from pydantic import Field
from core.api.schemas import Model


class Profile(Model):
    domain: str | None
    viewpoint: str | None


# permissions는 허용 행동, profiles는 관점 정의, default_profile은 생략했을 때 선택할 관점이다.
class Membership(Model):
    permissions: list[str]
    profiles: dict[str, Profile]
    default_profile: str


class AccessContext(Model):
    user_id: str
    memberships: dict[str, Membership]
    policy_revision: str


# 필드가 없는 모델도 의미가 있다. 허용하지 않은 query 항목이 들어오는 것을 거부한다.
class AccessQuery(Model):
    pass
