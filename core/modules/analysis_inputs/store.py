"""고정 입력·원본문자 제출을 기존 작업과 같은 잠금에 연결하는 공용 진입."""

# 이 클래스는 외부 호출 창구다. bundles는 입력 묶음, extractions는 읽은 문자 결과를 처리한다.
# 규약·원문·참고 자료를 '분석 당시의 사본'으로 남겨 이후 기준이 달라졌는지 확인할 수 있게 한다.

from core.modules.analysis_jobs.store import JobStore
from . import bundles, extractions


class InputStore:
    """현재 실행의 입력 사본을 고정한다. 기존 사본·원문·그래프는 갱신하지 않는다."""

    def __init__(self, store, rulesets, *, jobs=None):
        # 기존 작업 저장 객체가 있으면 공유한다. 준비/저장 단계가 같은 작업·잠금을 보게 한다.
        self.store, self.rulesets = store, rulesets
        self.jobs = jobs or JobStore(store, rulesets=rulesets)

    def prepare(self, job_id, **kwargs):
        """단계별 권한과 현재 기준에서 입력을 캡처하고 새 묶음을 불변 보관한다."""
        # **kwargs는 tenant=... 같은 이름 있는 인자들을 모았다가 실제 함수에 펼쳐 전달한다.
        return bundles.prepare(self, job_id, **kwargs)

    def read(self, job_id, **kwargs):
        """현재 권한·의존 버전을 재확인한 입력의 manifest 또는 문자 페이지를 반환한다."""
        return bundles.read(self, job_id, **kwargs)

    def submit_extraction(self, job_id, **kwargs):
        """원본문자 제출과 그 입력 계보를 보존한다. 위키 본문 저장은 수행하지 않는다."""
        return extractions.submit(self, job_id, **kwargs)
