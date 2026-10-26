"""누락·손상·한도 오류를 기존 코드로 분류하고 빈 기계층을 만든다."""

# 읽지 못함·원문 손상·검토 원장 손상·한도 초과를 짧은 오류 코드로 구분한다.
# 빈 기계층은 실제 사실이 없다는 결론이 아니라 사용할 그래프를 확보하지 못했다는 표현일 수 있다.

from .contracts import ConceptCaptureLimitError
from core.modules.correspondences.contracts import CorrespondenceCorruptError
from core.modules.correspondences.contracts import CorrespondenceLimitError
from core.modules.documents.store import DocumentTooLargeError
from core.modules.ontology.errors import OntologyCorruptError
from core.modules.reviews.contracts import ReviewCorruptError


def _error_code(error):
    # 내부 예외를 짧은 공개 코드로 분류한다. 예외 원문을 응답에 반사해 서버 경로를 드러내지 않는다.
    if isinstance(error, ConceptCaptureLimitError):
        return "capture_limit"
    if isinstance(error, CorrespondenceLimitError):
        return "closure_limit"
    if isinstance(error, DocumentTooLargeError):
        return "document_too_large"
    if isinstance(error, ReviewCorruptError):
        return "review_corrupt"
    if isinstance(error, OntologyCorruptError):
        return "ontology_corrupt"
    if isinstance(error, CorrespondenceCorruptError):
        return "correspondence_corrupt"
    if isinstance(error, FileNotFoundError):
        return "not_found"
    if isinstance(error, UnicodeError):
        return "invalid_utf8"
    if isinstance(error, PermissionError):
        return "permission_denied"
    return "read_error" if isinstance(error, OSError) else "invalid_stored_input"

def _empty_graph(document, revision, status="unavailable"):
    return {"document": document, "source_revision": revision, "status": status,
            "entities": [], "relations": [], "attributes": [], "relation_candidates": [],
            "needs_reextraction": True}
