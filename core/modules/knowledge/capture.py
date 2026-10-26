"""한 요청의 공유 캡처 상태를 소유한다. 호출자가 보유한 tenant 잠금을 재획득하지 않는다."""

# ConceptCapture는 한 요청에서 읽은 바이트·실패·근거 목록·남은 예산을 공유하는 객체다.
# 여러 경로가 같은 파일을 참조해도 같은 요청 안에서는 같은 관측을 사용한다. 다음 요청에는 이 가변 상태를 넘기지 않는다.

from core.modules.correspondences.store import CorrespondenceStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _actor
from . import capture_correspondences
from . import capture_documents
from . import capture_io
from . import capture_scan
from . import contracts
from datetime import datetime
from copy import deepcopy
from core.modules.correspondences.schema import instant
from datetime import timezone


class ConceptCapture:
    """All methods require the caller's WikiStore lock to remain held.

    This class does not acquire/release locks. ``full=False`` reads only source
    and history, so unrelated graph/review errors cannot poison source anchors.
    """

    def __init__(self, wiki, reviews=None, correspondences=None, *, actor=None,
                 mode="query", application_context=None, as_of=None, budgets=None):
        # Support a positional server actor without mistaking it for ReviewStore.
        # self는 이번 요청의 캡처 객체다. 캐시·오류·남은 용량을 새로 만들고 같은 tenant의 협력 Store인지 확인한다.
        if isinstance(reviews, dict) and actor is None:
            actor, reviews = reviews, None
        if actor is None and correspondences is not None:
            actor = correspondences.actor
        if actor is None:
            actor = {"user_id": "reader", "tenant": "local", "profile_id": "default",
                     "domain": None, "viewpoint": None, "policy_revision": "0" * 64}
        _actor(actor)
        if mode not in {"query", "find"}:
            raise ValueError("capture mode must be query or find")
        self.store = wiki
        self.actor = deepcopy(actor)
        self.reviews = reviews or ReviewStore(wiki)
        self.ontology = self.reviews.ontology
        self.correspondences = correspondences or CorrespondenceStore(wiki, actor)
        if self.reviews.store.data_dir != wiki.data_dir or self.correspondences.store.data_dir != wiki.data_dir:
            raise ValueError("capture components must belong to the selected tenant store")
        if self.correspondences.actor != self.actor:
            raise ValueError("capture correspondence actor must match the authorized actor")
        self.mode = mode
        self.application_context = self.correspondences._application_context(application_context)
        self.requested_as_of = as_of
        self.at = datetime.now(timezone.utc) if as_of is None else instant(as_of, "as_of")
        self.evaluated_at = self.at.isoformat()
        self.limits = {"capture_bytes": contracts.MAX_CAPTURE_BYTES,
                       "documents": contracts.MAX_QUERY_DOCUMENTS if mode == "query" else contracts.MAX_FIND_DOCUMENTS,
                       "correspondences": contracts.MAX_QUERY_CORRESPONDENCES if mode == "query" else contracts.MAX_FIND_CORRESPONDENCES,
                       "entries": contracts.MAX_SCAN_ENTRIES, "history_entries": contracts.MAX_HISTORY_ENTRIES}
        if budgets is not None:
            if not isinstance(budgets, dict):
                raise TypeError("budgets must be a dictionary")
            for name, value in budgets.items():
                if name == "output_bytes":
                    continue  # Projection budgets belong to ConceptStore.
                if name not in self.limits or type(value) is not int or value < 0:
                    raise ValueError("capture budgets must be known nonnegative integer limits")
                self.limits[name] = value
        self.remaining = [self.limits["capture_bytes"]]
        self.raw = {}
        self.errors = {}
        self._rows = {}
        self._documents = set()
        self._unresolved_review_files = set()
        self._correspondence_ids = set()
        self._history = {}
        self._parsed_reviews = {}
        self._parsed_correspondences = {}
        self._directory_cache = {}
        self._scan_documents = None
        self._scan_correspondences = None
        self.skipped = []
        self.truncated = False
        self.scanned_entries = 0
        self.history_entries = 0

    @property
    def captured_bytes(self):
        return self.limits["capture_bytes"] - self.remaining[0]

    @property
    def manifest(self):
        return [deepcopy(self._rows[key]) for key in sorted(self._rows)]

    @property
    def complete(self):
        return not self.skipped and not self.truncated

    @property
    def coverage(self):
        # 얼마나 읽었고 어디까지 완전한지 집계한다. 문서 수가 있다는 사실만으로 내용/판단을 모두 확보한 것은 아니다.
        return {"mode": self.mode, "documents": len(self._documents) + len(self._unresolved_review_files),
                "correspondences": len(self._correspondence_ids),
                "captured_bytes": self.captured_bytes, "scanned_entries": self.scanned_entries,
                "history_entries": self.history_entries, "limits": deepcopy(self.limits),
                "complete": self.complete}

    def _touch(self, kind, key, purpose, required_by):
        return capture_io._touch(self, kind, key, purpose, required_by)

    def _skip(self, kind, key, error=None, *, reason=None, phase="capture", truncated=False):
        return capture_io._skip(self, kind, key, error, reason=reason, phase=phase, truncated=truncated)

    def _reserve(self, kind, key):
        return capture_io._reserve(self, kind, key)

    def _path(self, kind, key):
        return capture_io._path(self, kind, key)

    def _read(self, kind, key, purpose, required_by):
        return capture_io._read(self, kind, key, purpose, required_by)

    def _validated_error(self, kind, key, error, *, phase="validation"):
        return capture_io._validated_error(self, kind, key, error, phase=phase)

    def _history_capture(self, document, purpose, required_by):
        return capture_io._history_capture(self, document, purpose, required_by)

    def _component(self, kind, key):
        return capture_io._component(self, kind, key)

    def document_raw(self, document):
        return capture_documents.document_raw(self, document)

    def document_ledger(self, document):
        return capture_documents.document_ledger(self, document)

    def document(self, document, purpose="content", required_by=None, *, root=False, full=True):
        # capture_documents에 같은 객체 self를 넘겨 바이트/오류 캐시와 예산을 공유한다.
        return capture_documents.document(self, document, purpose, required_by, root=root, full=full)

    def _dependency_document(self, document, full, purpose, required_by):
        return capture_documents._dependency_document(self, document, full, purpose, required_by)

    def _ledger(self, cid, purpose, required_by):
        return capture_correspondences._ledger(self, cid, purpose, required_by)

    def correspondence(self, correspondence_id, purpose="content", required_by=None, *, root=False, evaluate=True):
        # 문서 간 대응도 같은 캡처 예산에 포함한다. root와 참조 자료의 역할을 구분해 읽는다.
        return capture_correspondences.correspondence(self, correspondence_id, purpose, required_by, root=root, evaluate=evaluate)

    def _entries(self, directory, phase):
        return capture_scan._entries(self, directory, phase)

    def scan_documents(self):
        return capture_scan.scan_documents(self)

    def scan_correspondences(self):
        return capture_scan.scan_correspondences(self)

    discover_documents = scan_documents

    discover_correspondences = scan_correspondences
