"""변경 영향의 공용 진입. 인자 검증과 tenant 잠금을 소유하며 요청 상태에 계산을 맡긴다."""

# ImpactStore.query는 문서 변경의 재검토 대상을 안내한다. baseline은 이전에 관측한 버전 묶음이다.
# baseline이 없으면 무엇이 바뀌었다고 추정하지 않는다. 안내가 원문/그래프 저장을 실행하거나 취소하지는 않는다.

from .impact_snapshot import ImpactSnapshot
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.ontology.constants import VIEWPOINTS
from core.modules.ontology.values import _text
from core.modules.reviews.values import _token
from . import contracts


def _baseline(value):
    if value is None:
        return
    if not isinstance(value, dict) or set(value) != contracts._BASELINE_FIELDS:
        raise ValueError("baseline must contain exactly source_revision, graph_revision, review_revision and history_revision")
    for name in contracts._BASELINE_FIELDS:
        _token(value[name], name, optional=name in {"graph_revision", "review_revision"})

class ImpactStore:
    """인가가 끝난 tenant 저장소에서 한 잠금의 영향 조회를 조립한다."""

    def __init__(self, store):
        self.store = store
        self.ontology = OntologyStore(store)
        self.reviews = ReviewStore(store)

    def query(self, document, limit=20, *, baseline=None, domain=None, viewpoint=None):
        """baseline과 현재 직접 연결을 비교해 권고를 반환한다. 빈 결과를 전체 영향 없음으로 해석하지 않는다."""
        # 문서·선택 baseline과 관점에서 읽기 전용 영향 안내를 만든다. 권한 확인을 마친 tenant 저장소만 전달받아야 한다.
        _baseline(baseline)
        if type(limit) is not int or not 1 <= limit <= contracts.MAX_CONNECTION_LIMIT:
            raise ValueError(f"limit must be an integer from 1 to {contracts.MAX_CONNECTION_LIMIT}")
        if domain is not None:
            _text(domain, 4000, "domain")
        if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in VIEWPOINTS):
            raise ValueError("viewpoint must be a supported tag")
        self.store._document_path(self.store.wiki_dir, document)
        with self.store._write_lock():
            return self._query_locked(document, limit, baseline, domain, viewpoint)

    def _query_locked(self, document, limit, baseline, domain, viewpoint):
        return ImpactSnapshot(self, document, limit, baseline, domain, viewpoint).run()
