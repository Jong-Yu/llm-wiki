"""검증된 접근 범위의 공개 필드와 현재성 비교. 인증 판단은 AccessPolicy가 맡는다."""


def access_dict(scope):
    value = {name: getattr(scope, name) for name in (
        "user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")}
    revision = getattr(scope, "access_revision", None)
    if revision is not None:
        value["access_revision"] = revision
    return value


def access_basis(scope):
    value = access_dict(scope)
    if value.get("access_revision"):
        # 전체 정책 감사 값은 보존하지만 다른 사용자의 변경은 본인의 접근 변경이 아니다.
        value.pop("policy_revision")
    return value
