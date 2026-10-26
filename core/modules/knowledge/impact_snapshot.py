"""영향 계산의 단계별 협력 함수를 한 요청 상태로 연결한다."""

# ImpactSnapshot은 영향 조회 한 번의 상태를 담는다. run에서 실행 순서를 한눈에 볼 수 있다.
# 현재 관측 → 기준 비교 → 옛 원문 복원 → 링크/개념 후보 수집 → 출력 조립 순서이며 각 단계는 전문 모듈에 위임한다.

from . import impact_capture
from . import impact_history
from . import impact_links
from . import impact_references
from . import impact_result


class ImpactSnapshot:
    """한 영향 조회의 가변 상태. Store 인스턴스와 달리 요청 사이에 공유하지 않는다."""

    def __init__(self, owner, document, limit, baseline, domain, viewpoint):
        self.owner = owner
        self.document = document
        self.limit = limit
        self.baseline = baseline
        self.domain = domain
        self.viewpoint = viewpoint
        impact_capture.initialize(self)

    def skip(self, name, code, component, *, omitted=True):
        return impact_capture.skip(self, name, code, component, omitted=omitted)

    def history_entries(self, name):
        return impact_capture.history_entries(self, name)

    def run(self):
        # 관측·복원·후보·출력 순서는 기존 임계구역의 실행 순서를 유지한다.
        # 여러 계산 함수에 같은 요청 객체 self를 넘긴다. 앞 단계의 근거/예산/누락 상태를 다음 단계가 이어받는다.
        impact_capture.capture_states(self)
        impact_capture.compare(self)
        impact_history.restore_source(self)
        impact_links.collect_links(self)
        impact_references.collect_references(self)
        impact_references.collect_candidates(self)
        return impact_result.result(self)

