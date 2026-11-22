"""격리된 업무 시험에 필요한 소속을 가입과 별개로 준비한다. 제품에서는 사용하지 않는다."""

from core.common.json_codec import canonical_json_bytes
from core.modules.access.auth import _publish
from core.modules.access.policy import _PERMISSIONS


def grant_test_membership_for_user(policy, user_id, *, tenant="sdv-platform"):
    """비밀값 없이 임시 정책의 기존 사용자에게 업무 시험 소속을 명시 부여한다."""
    (policy.tenant_root / tenant).mkdir(exist_ok=True)
    value, _ = policy._load()
    value["tenants"].setdefault(tenant, {"display_name": "테스트 작업 공간",
        "profiles": {"default": {"domain": None, "viewpoint": None}}})
    value["users"][user_id]["memberships"][tenant] = {
        "permissions": sorted(_PERMISSIONS), "profiles": ["default"], "default_profile": "default"}
    value["users"][user_id]["default_tenant"] = tenant
    policy._validate_policy(value)
    _publish(policy.config_path, canonical_json_bytes(value), replace=True)


def grant_test_membership(policy, user, *, tenant="sdv-platform"):
    """업무 시험 소속을 명시 부여하고 토큰 소유자의 최신 인증 DTO를 반환한다."""
    grant_test_membership_for_user(policy, user["user_id"], tenant=tenant)
    return {"token": user["token"], **policy.describe(user["token"])}
