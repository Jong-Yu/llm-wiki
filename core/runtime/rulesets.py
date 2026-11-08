# 실행 인자의 규약 폴더/허용 정책을 실제 제출 스키마와 함께 규약 서비스에 연결한다.
# 옵션을 모두 생략한 경우와 설정이 불완전한 경우를 구분하며, 잘못된 설정을 다른 저장소로 우회하지 않는다.

"""관리자가 지정한 규약/허용 정책을 실제 제출 스키마와 함께 조립한다."""

from pathlib import Path


def configured_ruleset_paths(config_path, root=None, policy_path=None):
    """명시 배포 설정만 읽으며 누락·손상·링크를 다른 경로나 기본값으로 대체하지 않는다."""
    if config_path is None:
        return root, policy_path
    if root is not None or policy_path is not None:
        raise ValueError("Ruleset config and individual paths cannot be combined.")
    from core.modules.extraction_rules import files
    value = files.json_bytes(files.raw_file(Path(config_path).absolute(), 32768))
    if set(value) != {"ruleset_root", "ruleset_policy"}:
        raise ValueError("Ruleset config requires exactly two paths.")
    paths = []
    for key in ("ruleset_root", "ruleset_policy"):
        item = value[key]
        if type(item) is not str or not item or "\0" in item or not Path(item).is_absolute():
            raise ValueError("Ruleset config paths must be absolute.")
        paths.append(files.safe(Path(item)))
    if not paths[0].is_dir() or not paths[1].is_file():
        raise ValueError("Ruleset config paths are unavailable.")
    return tuple(paths)


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
