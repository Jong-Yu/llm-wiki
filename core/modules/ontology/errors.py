"""온톨로지 입력 오류·저장된 그래프 손상·캡처 예산 초과를 구분한다.

부분 결과에는 내부 경로나 예외 메시지 대신 기존의 제한된 오류 코드만 싣는다."""

# 제출값 오류(OntologyValidationError), 저장 그래프 손상(OntologyCorruptError), 읽기 예산 부족을 구분한다.
# 부분 조회에는 서버 내부 경로나 긴 예외 원문 대신 _connection_error가 만든 짧은 코드만 싣는다.

from core.modules.documents.store import DocumentTooLargeError


class OntologyValidationError(ValueError):
    """The submitted extraction does not satisfy the ontology contract."""


class OntologyCorruptError(ValueError):
    """The stored derived snapshot is malformed; source data is untouched."""


class _ContextBudgetError(ValueError):
    """An entire component does not fit the remaining capture budget."""


def _connection_error(error: Exception) -> str:
    """Only bounded, non-sensitive codes leave a partial connection query."""
    # 예외 종류를 고정 오류 코드로 바꾼다. error의 원문에는 서버 경로가 포함될 수 있으므로 그대로 내보내지 않는다.
    if isinstance(error, OntologyCorruptError):
        return "ontology_corrupt"
    if isinstance(error, DocumentTooLargeError):
        return "document_too_large"
    if isinstance(error, UnicodeError):
        return "invalid_encoding"
    if isinstance(error, (ValueError, TypeError)):
        return "invalid_argument"
    if isinstance(error, FileNotFoundError):
        return "not_found"
    return "storage_error"
