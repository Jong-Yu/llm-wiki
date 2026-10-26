# 실행 인자의 규약 폴더/허용 정책을 실제 제출 스키마와 함께 규약 서비스에 연결한다.
# 옵션을 모두 생략한 경우와 설정이 불완전한 경우를 구분하며, 잘못된 설정을 다른 저장소로 우회하지 않는다.

"""관리자가 지정한 규약/허용 정책을 실제 제출 스키마와 함께 조립한다."""


# 규약 폴더와 허용 정책은 한 쌍이다. 둘 다 없으면 미설정(None), 한쪽만 있으면 구성 오류로 처리한다.
def configured_rulesets(root, policy_path, access):
    """규약 경로·정책을 명시한 tenant 모드에만 연결하며 기본 경로를 추측하지 않는다."""
    if root is None and policy_path is None:
        return None
    if root is None or policy_path is None or access is None:
        raise ValueError("Ruleset root and policy require authenticated tenant mode.")
    from core.modules.extraction_rules.store import RulesetRegistry
    from core.runtime.extraction_schema import build_submission_schema
    return RulesetRegistry(root, policy_path, access.tenant_root,
                           expected_schema=build_submission_schema())
