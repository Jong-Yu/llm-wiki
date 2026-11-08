"""AI가 응답을 기다리는 동안 서버 작업의 실행 사용권을 유지한다.

서버의 lease는 잠시 동안 이번 run이 작업을 맡고 있다는 기록이다. AI가 오래
응답하지 않아도 30초마다 갱신하고, 갱신 실패 시 AI 작업도 끝내도록 부모에게 알린다.
"""

import asyncio
from contextlib import suppress

from core.client.transport import AnalysisClientError, api_call
from core.client.supervision import supervise


HEARTBEAT_SECONDS = 30


class LeaseKeeper:
    # self는 이번 실행의 사용권 갱신 객체다. run_id와 마지막 lease 버전을 보관한다.
    def __init__(self, http, *, tenant, job_id, run_id, lease_revision):
        self.http, self.run_id, self.revision = http, run_id, lease_revision
        self.path = f"/api/v1/tenants/{tenant}/analysis-jobs/{job_id}/heartbeat"

    async def __aenter__(self):
        # Event는 한 작업에서 발생한 실패를 다른 비동기 작업에도 알려 주는 신호다.
        self.failed = asyncio.Event()
        self.task = asyncio.create_task(self._keep())
        return self

    async def __aexit__(self, kind, value, traceback):
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task

    async def _keep(self):
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                result = await api_call(self.http, "POST", self.path, {
                    "run_id": self.run_id, "expected_lease_revision": self.revision})
                self.revision = result["lease_revision"]
        except asyncio.CancelledError:
            raise
        except Exception:
            # 오류 원문에는 연결/인증 정보가 섞일 수 있어 고정된 실패 신호만 전달한다.
            self.failed.set()

    def check(self):
        # 파일 저장 전에 호출하면 갱신 실패가 있었던 실행을 다음 단계로 진행시키지 않는다.
        if self.failed.is_set():
            raise AnalysisClientError("analysis_lease_lost")

    async def guard(self, operation):
        """AI 실행과 사용권 실패를 함께 기다린다. 먼저 실패하면 이번 실행만 취소한다."""
        return await supervise(operation, self.failed.wait(), check=self.check)
