"""실행 감독의 동시 완료 순서와 호출자별 취소·사용권·회수 계약을 확인한다."""

import asyncio
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

from core.client.ai.lease import LeaseKeeper
from core.client.proposal import ProposalExecution
from core.client.question import _QuestionExecution, QuestionClientError
from core.client.supervision import supervise
from core.client.transport import AnalysisClientError


class SupervisionTests(IsolatedAsyncioTestCase):
    async def test_success_waits_for_observer_cleanup(self):
        cleaned = []

        async def observe():
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                cleaned.append("observer")

        async def work():
            return "answer"

        result = await supervise(work(), observe(), check=lambda: None)
        self.assertEqual((result, cleaned), ("answer", ["observer"]))

    async def test_observer_failure_wins_over_simultaneously_completed_work(self):
        async def work():
            return "answer"

        async def observe():
            raise AnalysisClientError("remote_changed")

        with self.assertRaises(AnalysisClientError) as caught:
            await supervise(work(), observe(), check=lambda: None)
        self.assertEqual(caught.exception.code, "remote_changed")

    async def test_work_failure_is_preserved_and_observer_is_reaped(self):
        stopped = asyncio.Event()

        async def work():
            raise ValueError("model failed")

        async def observe():
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        with self.assertRaisesRegex(ValueError, "model failed"):
            await supervise(work(), observe(), check=lambda: None)
        self.assertTrue(stopped.is_set())

    async def test_caller_cancellation_waits_for_owned_work_cleanup(self):
        started, release, cleaned = asyncio.Event(), asyncio.Event(), []

        async def operation(name):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await release.wait()
                cleaned.append(name)

        task = asyncio.create_task(supervise(operation("work"), operation("watch"), check=lambda: None))
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertCountEqual(cleaned, ["work", "watch"])

    async def test_lease_loss_wins_over_simultaneously_completed_model(self):
        lease = LeaseKeeper(None, tenant="sample", job_id="a" * 32, run_id="b" * 32, lease_revision="old")
        lease.failed = asyncio.Event()
        lease.failed.set()

        async def work():
            return "answer"

        with self.assertRaises(AnalysisClientError) as caught:
            await lease.guard(work())
        self.assertEqual(caught.exception.code, "analysis_lease_lost")

    def question(self, cancel_event=None):
        return _QuestionExecution(None, base="http://localhost", tenant="sample", directory=Path("unused"),
            profile=None, on_event=None, cancel_event=cancel_event, poll_seconds=.001, heartbeat_seconds=.001)

    async def test_question_cancel_precedes_monitor_failure_and_restores_callback(self):
        cancel = asyncio.Event()
        cancel.set()
        execution = self.question(cancel)
        callback = object()

        class Adapter:
            on_event = callback

            async def run(self, **options):
                return "answer"

        async def monitor():
            raise QuestionClientError("question_lease_lost")

        execution.monitor = monitor
        adapter = Adapter()
        with self.assertRaises(QuestionClientError) as caught:
            await execution.guarded_model(adapter, "prompt", {})
        self.assertEqual(caught.exception.code, "question_cancelled")
        self.assertIs(adapter.on_event, callback)

    async def test_question_completion_waits_for_inflight_heartbeat_revision(self):
        execution = self.question()
        heartbeat_started, heartbeat_release, model_done = asyncio.Event(), asyncio.Event(), asyncio.Event()
        execution.check_active = lambda current: None

        async def read():
            return {}

        async def command(operation):
            self.assertEqual(operation, "heartbeat")
            heartbeat_started.set()
            await heartbeat_release.wait()
            execution.state = {"lease_revision": "confirmed"}
            return execution.state

        class Adapter:
            async def run(self, **options):
                await model_done.wait()
                return "answer"

        execution.read, execution.command = read, command
        task = asyncio.create_task(execution.guarded_model(Adapter(), "prompt", {}))
        await asyncio.wait_for(heartbeat_started.wait(), timeout=1)
        model_done.set()
        for _ in range(4):
            await asyncio.sleep(0)
        self.assertFalse(task.done())
        heartbeat_release.set()
        self.assertEqual(await task, "answer")
        self.assertEqual(execution.state["lease_revision"], "confirmed")

    async def test_proposal_cancel_reaps_nested_lease_and_model(self):
        cancel, cleaned = asyncio.Event(), asyncio.Event()
        cancel.set()
        execution = ProposalExecution(None, base="http://localhost", tenant="sample", proposal_id="a" * 32,
            profile=None, directory=Path("unused"), on_event=None, cancel_event=cancel)
        lease = LeaseKeeper(None, tenant="sample", job_id="b" * 32, run_id="c" * 32, lease_revision="old")
        lease.failed = asyncio.Event()

        async def work():
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                cleaned.set()

        with self.assertRaises(AnalysisClientError) as caught:
            await execution.guarded(work(), lease)
        self.assertEqual(caught.exception.code, "proposal_cancelled")
        self.assertTrue(cleaned.is_set())

    async def test_proposal_remote_change_cancels_its_model(self):
        cleaned = asyncio.Event()
        execution = ProposalExecution(None, base="http://localhost", tenant="sample", proposal_id="a" * 32,
            profile=None, directory=Path("unused"), on_event=None, cancel_event=None)
        lease = LeaseKeeper(None, tenant="sample", job_id="b" * 32, run_id="c" * 32, lease_revision="old")
        lease.failed = asyncio.Event()

        async def current():
            raise AnalysisClientError("proposal_job_changed")

        async def work():
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        execution.current = current
        with self.assertRaises(AnalysisClientError) as caught:
            await execution.guarded(work(), lease)
        self.assertEqual(caught.exception.code, "proposal_job_changed")
        self.assertTrue(cleaned.is_set())
