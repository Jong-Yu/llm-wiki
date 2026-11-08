# 업무 모듈에서 발생한 파이썬 예외를 HTTP 상태 코드와 일정한 JSON 오류 형태로 바꾼다.
# 권한 거부·버전 충돌·저장 실패를 구별해야 클라이언트가 잘못된 재시도나 정보 노출을 피할 수 있다.

"""실패를 빈 성공으로 바꾸지 않고 경로·자격 증명을 숨긴 HTTP 오류로 변환한다."""

from uuid import uuid4
from pathlib import PurePosixPath
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from core.modules.access.policy import AccessDenied, PolicyError
from core.common.read_index import CanonicalIndexUnavailable
from core.modules.documents.store import DocumentTooLargeError, StorageBusyError, RevisionConflictError
from core.modules.documents.changes import AuthorshipCorruptError
from core.api.ingress import RequestInputError
from core.modules.correspondences.contracts import CorrespondenceCorruptError, CorrespondenceLimitError
from core.modules.personal.store import PersonalConflictError, PersonalCorruptError, PersonalLimitError
from core.modules.ontology.errors import OntologyCorruptError
from core.modules.reviews.contracts import ReviewCorruptError, ReviewLimitError
from core.modules.sources.contracts import (
    SourceConflictError, SourceCorruptError, SourceLimitError, SourceTooLargeError,
    SourceValidationError, UnsupportedSourceError,
)
from core.api.schemas import Error, ErrorEnvelope, Meta
from core.modules.analysis_jobs.contracts import JobConflictError, JobCorruptError, JobLimitError, JobValidationError
from core.modules.extraction_rules.contracts import RulesetError
from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_inputs.contracts import InputConflictError, InputCorruptError, InputLimitError, InputValidationError


# 오류 내용을 공통 모델로 확인한 뒤 HTTP JSONResponse를 만든다. 이 함수는 예외를 발생시키지 않는다.
def error_response(status_code, code, message, headers=None, *, retry="none", details=None):
    value = ErrorEnvelope(error=Error(code=code, message=message, retry=retry,
                                     details=details or {}), meta=Meta(trace_id=uuid4().hex))
    return JSONResponse(value.model_dump(), status_code=status_code,
                        headers={**(headers or {}), "Cache-Control": "no-store"})


def cleanup_failure_details(error):
    """실패 뒤 남은 임시 파일 경고도 원래 오류와 구분하고 절대 경로는 숨긴다."""
    warnings = []
    for value in getattr(error, "cleanup_failures", ()):
        if not isinstance(value, dict):
            warnings.append({"path": None, "error_type": "CleanupError", "errno": None})
            continue
        path = value.get("path")
        safe = (isinstance(path, str) and path and not PurePosixPath(path).is_absolute()
                and ".." not in PurePosixPath(path).parts and "\\" not in path and ":" not in path)
        kind, number = value.get("error_type"), value.get("errno")
        warnings.append({"path": path if safe else None,
                         "error_type": kind if isinstance(kind, str) and kind.isidentifier() else "CleanupError",
                         "errno": number if type(number) is int else None})
    return warnings


# 예외 종류에 맞춰 상태 코드와 재시도 방법을 결정한다. 원래 예외의 민감한 메시지는 그대로 내보내지 않는다.
async def domain_error(request, error):
    from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
    status, code, message, retry = 500, "internal_error", "The request could not be completed.", "none"
    details = {}
    if isinstance(error, RequestInputError):
        status, code, message = error.status, error.code, error.message
    elif isinstance(error, (RevisionConflictError, PersonalConflictError)):
        status, code, message, retry = 409, "conflict", "The editing basis changed; read and reconcile the current record.", "reconcile"
    elif isinstance(error, (CorrespondenceCorruptError, PersonalCorruptError)):
        code, message = "record_corrupt", "Preserved records are inconsistent; existing data is unchanged."
    elif isinstance(error, CorrespondenceLimitError):
        status, code, message = 413, "correspondence_limit", "The complete correspondence exceeds its bound."
    elif isinstance(error, PersonalLimitError):
        status, code, message = 413, "personal_limit", "The complete personal record exceeds its bound; existing data is preserved."
    elif isinstance(error, ResultError):
        status = 500 if error.code == "result_corrupt" else 413 if error.code == "result_limit" else 422
        code, message = error.code, "Inspect the retained analysis result and its storage receipt."
        details = error.details
    elif isinstance(error, RulesetError):
        status, code, message = 503, error.code, "The published ruleset is unavailable or incompatible."
    elif isinstance(error, InputConflictError):
        status, code, message, retry = 409, error.code, "The fixed input basis changed; reconcile it before proceeding.", "reconcile"
        details = error.details
    elif isinstance(error, InputCorruptError):
        code, message = "input_corrupt", "The fixed input record is inconsistent; existing records are preserved."
    elif isinstance(error, InputLimitError):
        status, code, message = 413, "input_limit", "A fixed input or extraction limit was reached; existing records are preserved."
    elif isinstance(error, InputValidationError):
        status, code, message = 422, "invalid_input", "Check the fixed input references, stage and scope."
    elif isinstance(error, JobConflictError):
        status, code, message, retry = 409, error.code, "Reconcile the current source, job, run or lease basis.", "reconcile"
        details = error.details
    elif isinstance(error, JobCorruptError):
        code, message = "job_corrupt", "Job records are inconsistent; existing records are preserved."
    elif isinstance(error, JobLimitError):
        status, code, message = 413, "job_limit", "A job or metadata limit was reached; existing records are preserved."
    elif isinstance(error, JobValidationError):
        status, code, message = 422, "invalid_job", "Job inputs or client-reported state do not match the contract."
    elif isinstance(error, SourceConflictError):
        status, code, message, retry = 409, error.code, "Reconcile the registration basis or request payload before proceeding.", "reconcile"
        details = error.details
    elif isinstance(error, UnsupportedSourceError):
        status, code, message = 415, "unsupported_source", "Use a supported source format with valid encoding or binary signature."
    elif isinstance(error, SourceTooLargeError):
        status, code, message = 413, "source_too_large", "The original exceeds its byte limit; existing originals are preserved."
        details = {"limit_bytes": error.limit_bytes, "observed_bytes": error.observed_bytes}
    elif isinstance(error, SourceLimitError):
        status, code, message = 413, "source_limit", "A source storage or scan limit was reached; existing records are preserved."
    elif isinstance(error, SourceCorruptError):
        code, message = "source_corrupt", "Source records are inconsistent; preserve them and inspect before retrying."
    elif isinstance(error, SourceValidationError):
        status, code, message = 422, "invalid_source", "Source metadata, identifiers or UTF-8 content do not match the contract."
    elif isinstance(error, AccessDenied):
        status, code, message = 403, "access_denied", "Access denied."
    elif isinstance(error, PolicyError):
        status, code, message = 503, "access_unavailable", "Access policy is unavailable."
    elif isinstance(error, CanonicalIndexUnavailable):
        status, code, message, retry = 503, "index_unavailable", "The exploration index is unavailable; existing records are preserved.", "read_again"
    elif isinstance(error, CatalogChangedError):
        status, code, message, retry = 409, "catalog_changed", "The listing basis changed; restart from the first page.", "read_again"
        details = {"requires_refresh": True}
    elif isinstance(error, InvalidCursorError):
        status, code, message = 422, "invalid_cursor", "The cursor does not match this listing scope."
    elif isinstance(error, StorageBusyError):
        status, code, message, retry = 503, "storage_busy", "Storage is busy; retry later with the same basis.", "same_basis"
        details = {"timeout_seconds": error.timeout_seconds}
    elif isinstance(error, DocumentTooLargeError):
        status, code, message = 413, "document_too_large", "The document exceeds the UTF-8 byte limit."
        details = {"limit_bytes": error.limit_bytes, "observed_bytes": error.observed_bytes}
    elif isinstance(error, ReviewCorruptError):
        code, message = "review_corrupt", "Review history is invalid; existing records are preserved."
    elif isinstance(error, ReviewLimitError):
        code, message = "review_limit", "The complete review exceeds a read limit."
    elif isinstance(error, OntologyCorruptError):
        code, message = "ontology_corrupt", "The stored ontology is invalid."
    elif isinstance(error, UnicodeError):
        code, message = "invalid_encoding", "The document is not valid UTF-8."
    elif isinstance(error, FileNotFoundError):
        status, code, message = 404, "not_found", "The requested document does not exist."
    elif isinstance(error, AuthorshipCorruptError):
        code, message = "authorship_corrupt", "The preserved authorship journal is inconsistent; inspect it before writing."
    elif isinstance(error, (ValueError, TypeError)):
        status, code, message = 422, "invalid_argument", "Check the relative .md document path and query arguments."
    elif isinstance(error, OSError):
        code, message = "storage_error", "Storage could not be read."
    warnings = cleanup_failure_details(error)
    if warnings:
        details = {**details, "cleanup_failures": warnings}
    return error_response(status, code, message, retry=retry, details=details)


# Pydantic 입력 오류에는 본문이나 토큰이 포함될 수 있어 고정 안내만 반환한다.
async def validation_error(request, error):
    # Pydantic의 input/ctx에는 원문·토큰·경로가 있을 수 있어 응답에 반사하지 않는다.
    return error_response(422, "invalid_argument", "Query fields or types do not match the API contract.")


# 프레임워크의 404/405 오류도 같은 응답 모양으로 맞춘다.
async def http_error(request, error):
    return error_response(error.status_code, "method_not_allowed" if error.status_code == 405 else "not_found",
                          "Method not allowed." if error.status_code == 405 else "Endpoint not found.", error.headers)


# 앱에 오류 처리 함수를 등록한다. 실제 요청 중 예외가 나면 그때 해당 함수가 호출된다.
def register_errors(app):
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(ResponseValidationError, lambda request, error: error_response(
        500, "response_invalid", "The service result does not match the response contract."))
    app.add_exception_handler(HTTPException, http_error)
    from core.modules.documents.listing import CatalogChangedError
    for kind in (CanonicalIndexUnavailable, AccessDenied, PolicyError, CatalogChangedError, SourceConflictError, JobConflictError, InputConflictError, RevisionConflictError, PersonalConflictError, RequestInputError, ValueError, TypeError, OSError, StorageBusyError):
        app.add_exception_handler(kind, domain_error)
    app.add_exception_handler(Exception, domain_error)
