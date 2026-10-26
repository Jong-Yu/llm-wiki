"""규약·정책은 자료 루트 밖의 정규 파일로만 읽고 임시 공개를 정리한다."""

# 서버 관리 영역의 파일 접근이다. 업무 자료 폴더에 정책/규약을 섞어 두지 않게 경계를 확인한다.
# 링크·장치 파일·과도한 크기·잘못된 JSON은 읽기 단계에서 거부하며 옛 파일로 우회하지 않는다.

from pathlib import Path
import json
import os
import stat

from .contracts import RulesetConfigurationError, RulesetCorruptError


def disjoint(path, tenant_root):
    # 실제 경로를 구해 어느 쪽도 다른 쪽의 안에 들어가지 않는지 확인한 뒤 반환한다.
    actual = Path(path).absolute().resolve(strict=False)
    tenant = Path(tenant_root).absolute().resolve(strict=True)
    if actual.is_relative_to(tenant) or tenant.is_relative_to(actual):
        raise RulesetConfigurationError("Ruleset administration must be outside tenant storage.")
    return actual


def safe(path):
    # 지정 파일뿐 아니라 상위 폴더도 심볼릭 링크인지 검사해, 검사한 위치와 읽는 위치가 달라지지 않게 한다.
    path = Path(path)
    for entry in (path, *path.parents):
        if entry.is_symlink():
            raise RulesetCorruptError("A ruleset path is unsafe.")
    return path


def raw_file(path, limit):
    # 내용을 문자열로 바꾸기 전 원래 bytes로 읽는다. 지문은 이 원래 바이트에 묶인다.
    descriptor = os.open(safe(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RulesetCorruptError("Ruleset components must be regular files.")
        with os.fdopen(descriptor, "rb") as source:
            # 파일 객체가 descriptor를 닫도록 소유권을 넘겼으므로 finally에서 중복 close하지 않는다.
            descriptor = None
            raw = source.read(limit + 1)
        if len(raw) > limit:
            raise RulesetCorruptError("A ruleset input exceeds its byte budget.")
        return raw
    finally:
        if descriptor is not None:
            os.close(descriptor)


def object_pairs(pairs):
    # 같은 JSON 키를 두 번 적어 앞의 값을 숨기는 입력을 거부한다.
    value = {}
    for key, item in pairs:
        if key in value:
            raise RulesetCorruptError("Ruleset JSON contains duplicate fields.")
        value[key] = item
    return value


def json_bytes(raw):
    # UTF-8 JSON 객체만 허용하고 NaN/Infinity 같은 비표준 숫자도 거부한다.
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=object_pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if type(result) is not dict:
            raise ValueError()
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise RulesetCorruptError("Ruleset JSON is invalid.") from error
