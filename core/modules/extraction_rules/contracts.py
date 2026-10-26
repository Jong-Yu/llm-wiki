"""규약 저장의 공개 오류와 제한."""

# 규약 이름/버전, 한 묶음의 파일 목록, 읽을 수 있는 크기를 한곳에서 정한다.
# COMPONENTS는 배포할 파일의 고정 목록이다. 임의 파일을 규약에 끼워 넣지 않는다.

import re

MAX_POLICY_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 65536
MAX_COMPONENT_BYTES = 512 * 1024
MAX_RELEASE_BYTES = 2 * 1024 * 1024
MAX_POLICY_TENANTS = 1000
MAX_POLICY_RELEASES = 1000
COMPONENTS = frozenset({"ontology.md", "read_source.md", "prepare_wiki.md", "submission.schema.json",
                        "diagnostics.schema.json", "definitions.json", "examples.json"})
ID = re.compile(r"[a-z][a-z0-9_-]{0,63}")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
HEX = re.compile(r"[0-9a-f]{64}")


class RulesetError(ValueError):
    # 아래 오류들의 공통 부모다. 전송 계층은 code 값으로 사용자에게 보여 줄 오류를 구분한다.
    code = "ruleset_error"


class RulesetConfigurationError(RulesetError):
    code = "ruleset_unconfigured"


class RulesetUnavailableError(RulesetError):
    code = "ruleset_unavailable"


class RulesetCorruptError(RulesetError):
    code = "ruleset_corrupt"


class RulesetCompatibilityError(RulesetError):
    code = "ruleset_incompatible"


class RulesetConflictError(RulesetError):
    code = "ruleset_conflict"


class RulesetBusyError(RulesetError):
    code = "ruleset_busy"


def release_key(value):
    # 규약 ID와 표시 버전을 엄격히 확인하고 (ID, 버전) 튜플로 반환한다.
    # 내용 지문(ruleset_revision)은 별도 값이므로 같은 버전 이름만으로 내용 일치를 판단하지 않는다.
    if (type(value) is not dict or set(value) != {"ruleset_id", "ruleset_version"}
            or type(value["ruleset_id"]) is not str or not ID.fullmatch(value["ruleset_id"])
            or type(value["ruleset_version"]) is not str or not VERSION.fullmatch(value["ruleset_version"])):
        raise RulesetConfigurationError("A complete ruleset ID/version is required.")
    return value["ruleset_id"], value["ruleset_version"]
