"""여러 파일이 함께 사용할 저장 한도와 분석 결과 오류를 정의한다.

이 파일을 공통으로 사용해 저장 서비스와 MCP/API가 같은 제한·오류 코드를 이해한다.
"""

# 대문자 이름은 변경하지 않고 사용하는 설정값이라는 관례다. 용량의 단위는 바이트다.
MAX_RESULTS = 100
MAX_SUBMISSION_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


class ResultError(ValueError):
    """호출자에게 알릴 분석 결과 오류다. ValueError를 상속해 기존 오류 처리와 연결된다."""

    def __init__(self, code, **details):
        # **details는 request_id=... 같은 추가 인자를 하나의 딕셔너리로 모은다.
        # code는 프로그램이 구분할 오류 코드, details는 검사 보고 등 확인에 필요한 정보다.
        self.code, self.details = code, details
        # super()는 부모 예외의 초기화다. 원문·토큰 대신 고정된 안내 문구를 예외 메시지로 쓴다.
        super().__init__("Inspect the preserved analysis submission and reconcile its result.")
