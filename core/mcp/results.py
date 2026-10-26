"""업무 결과·오류를 MCP의 텍스트와 구조화 응답으로 동일하게 포장한다."""

# 여러 도구가 이 파일을 함께 써서 성공/오류 형식을 맞춘다.
# 업무 함수가 저장을 마쳤는지와 임시 파일 정리 경고는 별개이며, 이 계층은 저장을 재실행하지 않는다.
import json
import logging
from pathlib import Path
from typing import Callable

from mcp.types import CallToolResult, TextContent

from core.common.cleanup import cleanup_details
from core.modules.knowledge.schema import ConceptLimitError, ConceptValidationError
from core.modules.correspondences.contracts import (
    CorrespondenceConflictError, CorrespondenceCorruptError, CorrespondenceLimitError,
    CorrespondenceValidationError,
)
from core.mcp.schemas import CONCEPT_TOOLS, CORRESPONDENCE_TOOLS
from core.modules.ontology.errors import OntologyCorruptError, OntologyValidationError
from core.modules.reviews.contracts import (
    ReviewConflictError, ReviewCorruptError, ReviewLimitError, ReviewValidationError,
)
from core.modules.documents.store import DocumentTooLargeError, RevisionConflictError, StorageBusyError, WikiStore
from core.modules.analysis_jobs.contracts import JobConflictError, JobCorruptError, JobLimitError, JobValidationError
from core.modules.sources.validation import cleanup_failures as validate_serialized_cleanup
from core.modules.extraction_rules.contracts import RulesetError
from core.modules.analysis_inputs.contracts import InputConflictError, InputCorruptError, InputLimitError, InputValidationError
from core.modules.analysis_results.contracts import ResultError


logger = logging.getLogger(__name__)


def _relative_path(store: WikiStore, path: Path) -> str:
    # 사용자에게 서버의 절대 경로 대신 자료 루트 안의 상대 경로만 돌려준다.
    return path.relative_to(store.data_dir).as_posix()


def _cleanup_details(store: WikiStore, failures) -> list[dict]:
    # 이미 dict로 바뀐 경고와 저장 함수가 준 경고 객체를 같은 응답 형태로 맞춘다.
    # 업무 저장과 MCP 오류 응답이 같은 경고 형식을 사용하도록 한 곳에서 변환한다.
    if failures and all(isinstance(item, dict) for item in failures):
        value = list(failures)
        validate_serialized_cleanup(value)
        return value
    return cleanup_details(store.data_dir, failures)


def _result(payload: dict) -> CallToolResult:
    # 텍스트 응답만 읽는 클라이언트와 JSON 객체를 읽는 클라이언트에 같은 내용을 제공한다.
    # Text-only and structured-output clients see the same result.
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
        structured_content=payload,
        is_error=not payload["ok"],
    )


def _error_details(error: Exception, operation: str) -> dict:
    # isinstance로 예외의 종류를 구분해 고정 오류 코드로 바꾼다.
    # 구체적인 업무 오류를 먼저 검사해야, 부모 클래스인 ValueError 등에 먼저 묶이지 않는다.
    details = {"retryable": False}
    if isinstance(error, ResultError):
        details.update(error.details)
        details.update(code=error.code, retryable=error.code == "storage_busy",
            message="The analysis result could not be accepted or confirmed; inspect its retained report and receipt before retrying.")
    elif isinstance(error, RulesetError):
        details.update(code=error.code, message="The published ruleset is not usable; inspect its configuration, permission and revision.")
    elif isinstance(error, InputConflictError):
        details.update(code=error.code, message="The fixed input basis changed; reconcile it before preparing or submitting again.", **error.details)
    elif isinstance(error, InputCorruptError):
        details.update(code="input_corrupt", message="The fixed input record is inconsistent; existing records are preserved.")
    elif isinstance(error, InputLimitError):
        details.update(code="input_limit", message="A fixed input or extraction limit was reached; existing records are preserved.")
    elif isinstance(error, InputValidationError):
        details.update(code="invalid_input", message="Check the stage, fixed input references and selected scope.")
    elif isinstance(error, FileNotFoundError) and operation in {"analysis_job_input_prepare", "analysis_job_input_read", "source_extraction_submit",
            "analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"}:
        details.update(code="not_found", message="The selected job or input is not available.")
    elif isinstance(error, JobConflictError):
        details.update(code=error.code, message="Read the current job and reconcile its source, run and lease basis.", **error.details)
    elif isinstance(error, JobCorruptError):
        details.update(code="job_corrupt", message="The job record is inconsistent; existing records are preserved.")
    elif isinstance(error, JobLimitError):
        details.update(code="job_limit", message="A job or metadata limit was reached; existing records are preserved.")
    elif isinstance(error, JobValidationError):
        details.update(code="invalid_job", message="Check the analysis-job arguments and reported status.")
    elif isinstance(error, FileNotFoundError) and operation in {"source_read", "analysis_job_query", "analysis_job_claim", "analysis_job_update"}:
        details.update(code="not_found", message="The requested job is not available to this user.")
    elif isinstance(error, ConceptLimitError):
        details.update(code="concept_limit", message="A concept-query budget was exceeded; narrow the requested scope. Existing records are preserved.")
    elif isinstance(error, ConceptValidationError):
        details.update(code="invalid_argument", message=str(error))
    elif isinstance(error, CorrespondenceConflictError):
        details.update(code="conflict", message="Read correspondence query/prepare and reconcile all changed evidence and decisions; do not just replace the state revision.",
                       correspondence_id=error.document, expected_state_revision=error.expected_revision,
                       current_state_revision=error.current_revision)
        if getattr(error, "components", None):
            details["components"] = error.components
    elif isinstance(error, CorrespondenceCorruptError):
        details.update(code="correspondence_corrupt", message="Correspondence history is invalid; preserve it and inspect before retrying.")
    elif isinstance(error, CorrespondenceLimitError):
        details.update(code="correspondence_limit", message="A correspondence, dependency or response limit was reached; existing records are preserved.")
    elif isinstance(error, CorrespondenceValidationError):
        details.update(code="invalid_correspondence", message=str(error))
    elif isinstance(error, ReviewConflictError):
        details.update(code="conflict", message="Read ontology_review_query and reconcile the source, graph and review changes; do not just replace the state revision.",
                       document=error.document, expected_state_revision=error.expected_revision,
                       current_state_revision=error.current_revision)
    elif isinstance(error, ReviewCorruptError):
        details.update(code="review_corrupt", message="Review history is invalid; preserve it and inspect before retrying.")
    elif isinstance(error, ReviewLimitError):
        details.update(code="review_limit", message="A review or source-history limit was reached; existing records are preserved.")
    elif isinstance(error, ReviewValidationError):
        details.update(code="invalid_review", message=str(error))
    elif isinstance(error, OntologyCorruptError):
        details.update(code="ontology_corrupt", message="The derived ontology is invalid. Inspect it before regenerating.")
    elif isinstance(error, OntologyValidationError):
        details.update(code="invalid_ontology", message=str(error))
    elif isinstance(error, RevisionConflictError):
        details.update(
            code="conflict",
            message="Read the latest document and reconcile changes; do not just replace the revision.",
            document=error.document,
            expected_revision=error.expected_revision,
            current_revision=error.current_revision,
        )
    elif isinstance(error, StorageBusyError):
        details.update(
            code="storage_busy",
            message="The writer lock is busy. Retry later with the same submitted revision tokens.",
            retryable=True,
            timeout_seconds=error.timeout_seconds,
        )
    elif isinstance(error, DocumentTooLargeError):
        details.update(
            code="document_too_large",
            message="The document exceeds the UTF-8 byte limit; it has not been truncated.",
            limit_bytes=error.limit_bytes,
            observed_bytes=error.observed_bytes,
        )
    elif isinstance(error, UnicodeError):
        details.update(code="invalid_encoding", message="Document content must be valid UTF-8 text.")
    elif isinstance(error, (ValueError, TypeError)):
        details.update(
            code="invalid_argument",
            message="Check the arguments: use a relative .md document path without symlinks and a nonblank search query.",
        )
    elif isinstance(error, FileNotFoundError) and (operation in CONCEPT_TOOLS or operation in CORRESPONDENCE_TOOLS or operation in (
        "read", "ontology_generate", "ontology_query", "ontology_connections", "ontology_context",
        "ontology_review_query", "ontology_review", "ontology_review_undo", "ontology_policy", "ontology_policy_undo", "ontology_impact",
    )):
        details.update(code="not_found", message="The requested correspondence or document does not exist." if operation in CORRESPONDENCE_TOOLS else "The requested document does not exist.")
    else:
        details.update(
            code="storage_error",
            message="Storage operation failed. Inspect the cause before retrying.",
            error_type=type(error).__name__,
            errno=getattr(error, "errno", None),
        )
    return details


def _invoke(store: WikiStore, operation: str, action: Callable[[], dict]) -> CallToolResult:
    # action은 아직 실행하지 않은 업무 함수다. 여기서 한 번 호출하고 공통 응답으로 감싼다.
    # except에서 오류를 응답으로 바꿀 뿐, 실패한 작업을 자동으로 다시 호출하지 않는다.
    try:
        return _result({"ok": True, **action()})
    except (OSError, ValueError, TypeError, RevisionConflictError, JobConflictError, InputConflictError) as error:
        details = _error_details(error, operation)
        failures = getattr(error, "cleanup_failures", ())
        if failures:
            details["cleanup_failures"] = _cleanup_details(store, failures)
        if details["code"] == "storage_error":
            logger.exception("Wiki %s failed", operation)
        return _result({"ok": False, "error": details})


def _access_error(code: str) -> CallToolResult:
    # 없는 tenant와 접근할 수 없는 tenant에 같은 안내를 줘서 다른 소속의 존재를 노출하지 않는다.
    # Identical errors for nonexistent and forbidden tenants; no principal/path echo.
    messages = {
        "access_denied": "Access denied.",
        "access_unavailable": "Access policy is unavailable.",
        "invalid_argument": "Invalid tool arguments.",
    }
    return _result({"ok": False, "error": {
        "code": code, "message": messages[code], "retryable": False,
    }})
