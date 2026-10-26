"""정리 경고를 기존 응답 형식으로 옮기며 저장 결과나 파일을 변경하지 않는다.

정리 경고는 이미 성공한 저장에도 붙을 수 있다. 이 변환은 저장 실패 판정이나
재쓰기·삭제의 근거가 아니며 원래 경고 객체와 예외를 그대로 둔다.
"""

from pathlib import Path


def cleanup_details(data_dir: Path, failures) -> list[dict]:
    """경고의 상대 POSIX 경로·오류 종류·errno만 반환한다.

    서버 절대 경로를 내보내지 않는다. 범위 밖 경로의 ValueError도 기존처럼
    전파하여 잘못된 경고를 숨기지 않으며 파일 접근이나 재시도를 하지 않는다.
    """
    # failures의 경고를 하나씩 돌며 화면/응답에 넣을 dict로 바꾸는 목록 표현식이다.
    # relative_to는 자료 폴더 안의 상대 경로만 남기고, as_posix는 구분자를 /로 맞춘다.
    # errno는 운영체제가 알려 준 오류 번호다. 이 함수는 경고를 보여 줄 뿐 파일을 지우지 않는다.
    return [
        {
            "path": failure.path.relative_to(data_dir).as_posix(),
            "error_type": type(failure.error).__name__,
            "errno": failure.error.errno,
        }
        for failure in failures
    ]
