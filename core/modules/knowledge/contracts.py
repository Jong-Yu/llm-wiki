"""개념/영향 조회의 요청 한도와 캡처 오류를 한 곳에서 소유한다."""

# 개념 찾기·상세 조회·영향 안내에서 읽거나 반환할 최대 자료량을 정한다.
# ConceptCaptureLimitError는 필요한 구성 전체가 읽기 예산에 들어가지 않는 경우다. 구성 일부를 잘라 정상 자료로 반환하지 않는다.

from core.modules.ontology.constants import MAX_CONNECTION_BYTES
from core.modules.ontology.constants import MAX_CONNECTION_DOCUMENTS
from core.modules.ontology.constants import MAX_CONNECTION_LIMIT
from core.modules.ontology.constants import MAX_CONNECTION_LINKS
from core.modules.ontology.constants import MAX_CONNECTION_SCAN_ENTRIES
from core.modules.correspondences.contracts import MAX_CORRESPONDENCE_BYTES
from core.modules.correspondences.contracts import MAX_DEPENDENCY_DOCUMENTS
from core.modules.documents.store import MAX_DOCUMENT_BYTES
from core.modules.ontology.constants import MAX_LINK_HREF_CHARACTERS
from core.modules.ontology.constants import MAX_ONTOLOGY_BYTES
from core.modules.reviews.contracts import MAX_REVIEW_BYTES
from core.modules.correspondences.contracts import CorrespondenceLimitError

CONTRACT_VERSION = 1
MAX_DETAIL_BYTES = 8 * 1024 * 1024
MAX_FIND_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_CONTENT_DOCUMENTS = 16
MAX_CAPTURE_BYTES = 32 * 1024 * 1024
MAX_QUERY_DOCUMENTS = 32
MAX_QUERY_CORRESPONDENCES = 32
MAX_FIND_DOCUMENTS = 100
MAX_FIND_CORRESPONDENCES = 100
MAX_SCAN_ENTRIES = 1000
MAX_HISTORY_ENTRIES = 10000
MAX_IMPACT_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_IMPACT_ENTITY_REFERENCES = 1000
_BASELINE_FIELDS = {"source_revision", "graph_revision", "review_revision", "history_revision"}

class ConceptCaptureLimitError(CorrespondenceLimitError):
    """A whole required component does not fit this request's capture budget."""
