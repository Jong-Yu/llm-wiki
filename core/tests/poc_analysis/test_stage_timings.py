"""가짜 시계와 격리 저장으로 단계 경과/실패/재사용을 검증한다. 모델은 호출하지 않는다."""

import asyncio
import json
import unittest
from unittest.mock import patch

from core.client import analysis
from core.client.ai import draft_validation, workflow
from core.client.ai.timings import StageTimings
from core.client.transport import AnalysisClientError, client_error_code
from core.modules.analysis_results.diagnostics import empty_report
from core.tests.poc_analysis import test_draft_workflow as fixtures


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TimedAdapter(fixtures.DraftAdapter):
    def __init__(self, clock, outcomes=("valid",)):
        super().__init__(outcomes)
        self.clock = clock

    async def preflight(self):
        self.clock.advance(2)
        return await super().preflight()

    async def run(self, **kwargs):
        self.clock.advance(10 if self.calls == 0 else 20)
        return await super().run(**kwargs)


class TimingCollectorTests(unittest.TestCase):
    def test_nested_spans_are_not_double_counted_and_snapshot_is_detached(self):
        clock = Clock()
        timing = StageTimings(clock=clock)
        clock.advance(1)
        with timing.measure("preparation"):
            clock.advance(2)
            with timing.measure("validation"):
                clock.advance(3)
            clock.advance(4)
        timing.finish("stored")
        value = timing.summary()
        self.assertEqual(value["elapsed_seconds"], 10)
        self.assertEqual(value["measured_seconds"], 9)
        self.assertEqual(value["unmeasured_seconds"], 1)
        self.assertEqual(value["phase_seconds"], {"preparation": 6, "validation": 3})
        self.assertEqual(value["events"][0]["elapsed_seconds"], 9)
        value["events"][0]["status"] = "changed"
        self.assertEqual(timing.summary()["events"][0]["status"], "completed")


class StageTimingTests(unittest.IsolatedAsyncioTestCase):
    # 재사용하는 것은 격리 서버 fixture뿐이다. 기존 테스트 메서드는 다시 상속하지 않는다.
    setup_server = fixtures.DraftWorkflowTests.setup_server
    execute = fixtures.DraftWorkflowTests.execute
    graph_writes = fixtures.DraftWorkflowTests.graph_writes
    failures = fixtures.DraftWorkflowTests.failures
    assert_no_graph = fixtures.DraftWorkflowTests.assert_no_graph

    def install_clock(self):
        clock = Clock()
        self.stack.enter_context(patch("core.client.ai.timings.perf_counter", clock))
        return clock

    def assert_balanced(self, timing):
        self.assertAlmostEqual(timing["measured_seconds"], sum(timing["phase_seconds"].values()))
        self.assertAlmostEqual(timing["elapsed_seconds"], timing["measured_seconds"] + timing["unmeasured_seconds"])

    @fixtures.isolated_server
    async def test_repair_storage_reconciliation_and_zero_call_reuse(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock, ("invalid", "valid"))
        actual_tool, actual_inspect = workflow.tool_call, draft_validation.inspect
        actual_receive, actual_assemble = analysis.receive_input, workflow.assemble_input

        async def timed_tool(client, tool, arguments):
            if tool == "analysis_job_wiki_write":
                clock.advance(2)
            elif tool == "analysis_job_ontology_generate":
                clock.advance(5)
            elif tool == "analysis_job_result_query":
                clock.advance(7)
            return await actual_tool(client, tool, arguments)

        async def timed_receive(*args, **kwargs):
            clock.advance(4)
            return await actual_receive(*args, **kwargs)

        def timed_assemble(*args, **kwargs):
            clock.advance(6)
            return actual_assemble(*args, **kwargs)

        def timed_inspect(*args):
            clock.advance(3)
            return actual_inspect(*args)

        self.lose_graph_response = True
        with patch.object(workflow, "tool_call", side_effect=timed_tool), \
             patch.object(draft_validation, "inspect", side_effect=timed_inspect), \
             patch.object(analysis, "receive_input", side_effect=timed_receive), \
             patch.object(workflow, "assemble_input", side_effect=timed_assemble):
            result = (await self.execute(adapter))["ai_execution"]
        observations = result["usage_observations"]
        timing = observations["timings"]
        self.assertEqual(timing["status"], "stored")
        self.assertEqual(timing["phase_seconds"]["preparation"], 12)
        self.assertEqual(timing["phase_seconds"]["ai_initial"], 10)
        self.assertEqual(timing["phase_seconds"]["ai_repair"], 20)
        self.assertEqual(timing["phase_seconds"]["validation"], 6)
        self.assertEqual(timing["phase_seconds"]["storage"], 14)
        self.assertEqual(timing["elapsed_seconds"], 62)
        self.assertEqual([call["duration_seconds"] for call in observations["calls"]], [10, 20])
        self.assertEqual([event["passed"] for event in timing["events"] if event["phase"] == "validation"], [False, True])
        self.assert_balanced(timing)
        saved = json.loads(next((self.root / "work").rglob("ai-result.json")).read_text())
        self.assertEqual(saved["usage_observations"], observations)
        self.assertEqual(len(self.graph_writes()), 1)
        self.assertEqual(self.tool_calls.count("analysis_job_result_query"), 1)
        self.assertNotIn("timings", self.graph_writes()[0]["execution"])

        repeated = (await self.execute(adapter))["ai_execution"]
        reused = repeated["usage_observations"]
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(reused["adapter_call_count"], 0)
        self.assertEqual(reused["calls"], [])
        self.assertEqual(reused["timings"]["status"], "reused")
        self.assertEqual(reused["timings"]["elapsed_seconds"], 2)
        self.assertNotIn("ai_initial", reused["timings"]["phase_seconds"])
        self.assertEqual(repeated["execution_configuration"], result["execution_configuration"])
        self.assert_balanced(reused["timings"])

    @fixtures.isolated_server
    async def test_adapter_error_retains_failed_duration_without_retry(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock, (AnalysisClientError("ai_invalid_result"),))
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "ai_invalid_result")
        observation = self.failures()[0]["usage_observations"]
        self.assertEqual(observation["timings"]["status"], "failed")
        self.assertEqual(observation["calls"][0]["duration_seconds"], 10)
        self.assertEqual(observation["calls"][0]["outcome"], "failed")
        event = next(event for event in observation["timings"]["events"] if event["phase"] == "ai_initial")
        self.assertEqual((event["status"], event["elapsed_seconds"]), ("failed", 10))
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.graph_writes(), [])
        self.assert_balanced(observation["timings"])

    @fixtures.isolated_server
    async def test_repair_cancellation_retains_cancelled_duration_and_prior_receipt(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock, ("invalid", asyncio.CancelledError()))
        with self.assertRaises(asyncio.CancelledError):
            await self.execute(adapter)
        failure = self.failures()[0]
        observation = failure["usage_observations"]
        self.assertEqual(failure["error_code"], "ai_cancelled")
        self.assertEqual(len(failure["receipts"]), 1)
        self.assertEqual(observation["timings"]["status"], "cancelled")
        self.assertEqual(observation["calls"][-1]["outcome"], "cancelled")
        event = next(event for event in observation["timings"]["events"] if event["phase"] == "ai_repair")
        self.assertEqual((event["status"], event["elapsed_seconds"]), ("cancelled", 20))
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(self.graph_writes(), [])
        self.assert_balanced(observation["timings"])

    @fixtures.isolated_server
    async def test_preparation_failure_is_recorded_without_model_call(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock)

        async def fail_input(*args, **kwargs):
            clock.advance(4)
            raise AnalysisClientError("analysis_job_changed")

        with patch.object(analysis, "receive_input", side_effect=fail_input):
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_job_changed")
        failure = json.loads(next((self.root / "work").rglob("preparation-failure.json")).read_text())
        self.assertEqual(failure["usage_observations"]["adapter_call_count"], 0)
        timing = failure["usage_observations"]["timings"]
        self.assertEqual(timing["status"], "failed")
        self.assertEqual(timing["elapsed_seconds"], 6)
        self.assertEqual(timing["events"][-1]["operation"], "receive_initial_input")
        self.assertEqual(timing["events"][-1]["status"], "failed")
        self.assertEqual(adapter.calls, 0)
        self.assert_balanced(timing)

    @fixtures.isolated_server
    async def test_optional_semantic_and_comparison_times_remain_separate(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock)
        adapter.persist_session = True

        async def semantic(**kwargs):
            clock.advance(30)
            return empty_report()

        async def comparison(*args, **kwargs):
            clock.advance(40)
            return {"status": "incomplete", "extraction_saved": True}

        with patch("core.client.semantic_check.run_semantic_check", side_effect=semantic), \
             patch("core.client.post_extraction.compare_stored_extraction", side_effect=comparison):
            result = (await self.execute(adapter, semantic_check=True))["ai_execution"]
        timing = result["usage_observations"]["timings"]
        self.assertEqual(timing["status"], "stored")
        self.assertEqual(timing["phase_seconds"]["semantic_check"], 30)
        self.assertEqual(timing["phase_seconds"]["comparison"], 40)
        self.assertEqual(timing["phase_seconds"]["ai_initial"], 10)
        self.assertEqual(timing["elapsed_seconds"], 82)
        self.assertEqual(result["comparison"]["status"], "incomplete")
        self.assertEqual(next(event for event in timing["events"] if event["phase"] == "comparison")["result_status"], "incomplete")
        self.assertEqual(len(result["semantic_reports"]), 1)
        self.assert_balanced(timing)

    @fixtures.isolated_server
    async def test_final_local_record_failure_never_repeats_committed_storage(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock)
        actual_record = workflow._record

        def fail_result(path, value):
            if path.name == "ai-result.json":
                raise OSError("synthetic local record failure")
            return actual_record(path, value)

        with patch.object(workflow, "_record", side_effect=fail_result):
            with self.assertRaises(Exception):
                await self.execute(adapter)
        self.assertEqual(len(self.graph_writes()), 1)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.failures()[0]["usage_observations"]["timings"]["status"], "failed")
        repeated = await self.execute(adapter)
        self.assertEqual(repeated["ai_execution"]["usage_observations"]["timings"]["status"], "reused")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(len(self.graph_writes()), 1)

    @fixtures.isolated_server
    async def test_preparation_cancellation_and_failed_observation_write_preserve_cancellation(self):
        clock = self.install_clock()
        adapter = TimedAdapter(clock)
        recorded = []

        async def cancel_input(*args, **kwargs):
            clock.advance(4)
            raise asyncio.CancelledError()

        def fail_observation(path, value):
            recorded.append((path.name, value))
            raise OSError("synthetic local observation failure")

        with patch.object(analysis, "receive_input", side_effect=cancel_input), \
             patch.object(workflow, "_record", side_effect=fail_observation):
            with self.assertRaises(asyncio.CancelledError):
                await self.execute(adapter)
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(len(recorded), 1)
        name, failure = recorded[0]
        self.assertEqual(name, "preparation-failure.json")
        self.assertEqual(failure["error_code"], "ai_cancelled")
        self.assertEqual(failure["usage_observations"]["timings"]["status"], "cancelled")
        self.assertEqual(failure["usage_observations"]["timings"]["elapsed_seconds"], 6)
