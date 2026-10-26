"""개인 AI 실행에서 함께 사용하는 크기 한도와 안전한 오류 코드."""

from core.client.transport import AnalysisClientError

# 글자 수가 아니라 UTF-8 바이트 수다. 큰 입력을 자르지 않고 실행 전에 거부한다.
MAX_PROMPT_BYTES = 32 * 1024 * 1024
MAX_SCHEMA_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 8 * 1024 * 1024
MAX_TRACE_BYTES = 8 * 1024 * 1024
MAX_EVENTS = 10000
# 서버의 현재 불변 문자 추출물 한도와 맞춘다. 원본이 더 커도 자동으로 자르지 않는다.
MAX_LITERAL_SOURCE_BYTES = 4 * 1024 * 1024


class AIAdapterError(AnalysisClientError):
    """CLI의 원문 오류 대신 고정 코드만 호출자에게 전달한다."""

    # 부모의 code 필드를 재사용한다. SDK/CLI 오류 원문에는 인증정보가 섞일 수 있다.
    pass
