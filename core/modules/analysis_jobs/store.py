"""같은 원본 조정 잠금으로 분석 접수·소유권·lease를 연결하는 공용 진입점."""

# 외부 코드는 이 클래스의 create/claim/query 등을 사용한다. 실제 업무는 commands/queries에 있다.
# job은 분석 작업 하나, run은 한 번의 실행, lease는 그 실행이 유효한 기간을 뜻한다.

from datetime import datetime, timezone
from core.modules.sources.store import SourceStore
from . import commands, queries, records


class JobStore:
    """원본 기준과 작업·실행 lease를 관리하며 AI 실행이나 결과 저장을 수행하지 않는다."""

    def __init__(self, store, *, clock=None, rulesets=None):
        # self는 현재 서비스 객체다. clock을 전달하면 테스트에서도 같은 시각 기준을 사용할 수 있다.
        self.store = store
        self.sources = SourceStore(store)
        self.jobs_dir = store.data_dir / "_jobs"
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.rulesets = rulesets

    def _now(self):
        # 클라이언트가 신고한 시각 대신 서버의 시간대 있는 현재 시각을 사용한다.
        value = self.clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError("The server clock must include a timezone.")
        return value.astimezone(timezone.utc)

    def _write(self, path, value):
        return records.write(self, path, value)

    def _write_request(self, path, value):
        return self._write(path, value)

    def create(self, **kwargs):
        """고정 원본·예정 대상과 요청 영수증을 접수하고 현재 권한을 다시 확인한다."""
        return commands.create(self, **kwargs)

    def query(self, job_id, *, tenant, user_id):
        # 현재 사용자의 소유 범위를 확인한 뒤 상태를 읽는다. 다른 사람의 작업을 먼저 읽지 않는다.
        return queries.query(self, job_id, tenant=tenant, user_id=user_id)

    def list_jobs(self, *, tenant, user_id, scope_key, limit=20, cursor=None):
        # 페이지를 이어 읽을 때 권한 범위와 목록 기준까지 같은지 확인한다.
        return queries.list_jobs(self, tenant=tenant, user_id=user_id, scope_key=scope_key, limit=limit, cursor=cursor)

    def request_receipt(self, *, tenant, user_id, request_id):
        return queries.request_receipt(self, tenant=tenant, user_id=user_id, request_id=request_id)

    def claim(self, job_id, **kwargs):
        """작업 기준 버전을 대조해 실행을 확보한다. 유효한 다른 run은 인계하지 않는다."""
        return commands.claim(self, job_id, **kwargs)

    def heartbeat(self, job_id, **kwargs):
        """lease revision만 갱신해 작업 본문 CAS와 생존 보고가 충돌하지 않게 한다."""
        return commands.heartbeat(self, job_id, **kwargs)

    def update(self, job_id, **kwargs):
        """CLI 진행 상황을 기록한다. 자기보고를 분석 결과 저장 성공으로 승격하지 않는다."""
        return commands.update(self, job_id, **kwargs)

    def cancel(self, job_id, **kwargs):
        # **kwargs는 이름 있는 여러 인자를 모은 dict다. 실제 함수 호출 때 다시 펼쳐 전달한다.
        # 취소는 후속 실행을 막으며 기존 원본이나 저장 결과를 삭제하지 않는다.
        return commands.cancel(self, job_id, **kwargs)

    def source_input(self, job_id, **kwargs):
        # 이번 실행이 읽어야 할 정확한 원본 참조를 반환한다. AI를 실행하거나 원본을 새로 만들지 않는다.
        return commands.source_input(self, job_id, **kwargs)
