"""기존 JSON 저장 바이트와 그 바이트에 연결된 hash 계약을 보존한다.

키 정렬·UTF-8·구분자·마지막 LF는 원장 hash와 CAS의 입력이다. 보기 좋은
출력으로 바꾸거나 줄바꿈을 제거하면 같은 값도 다른 저장 버전이 된다.

JSON은 dict/list 같은 값을 파일에 쓸 문자열로 표현하는 형식이다. UTF-8은
그 문자열을 바이트로 바꾸는 방식이고, LF는 줄바꿈 문자 하나를 뜻한다.
CAS는 '처음 읽은 버전과 아직 같을 때만 수정한다'는 충돌 방지 방식이다.
"""

from hashlib import sha256
import json


def canonical_json_bytes(value, *, allow_nan=False) -> bytes:
    """정렬된 JSON 뒤에 LF 하나를 붙인 기존 UTF-8 저장 형식을 반환한다.

    기본값은 원장처럼 비유한수를 거부한다. allow_nan=True는 기존 그래프
    인코더의 옵션을 그대로 유지할 때만 명시하며, 입력 검증을 대신하지 않는다.
    """
    # dumps로 JSON 문자열을 만든 뒤 encode로 저장할 바이트로 바꾼다.
    # sort_keys는 키 순서를 일정하게 하고 separators는 구분자의 불필요한 공백을 없앤다.
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=allow_nan) + "\n").encode("utf-8")


def canonical_json_hash(value) -> str:
    """마지막 LF를 포함한 엄격한 정규 JSON 바이트의 SHA-256을 반환한다.

    원문 파일의 raw 바이트 hash와 구분하며 기존 원장·상태 CAS 계산을 유지한다.
    """
    # hash는 내용에서 계산한 지문이다. hexdigest는 그 지문을 16진수 문자열로 돌려준다.
    # 암호화된 내용이 아니며, 권한 확인이나 실제 의미 검사를 대신하지 않는다.
    return sha256(canonical_json_bytes(value)).hexdigest()
