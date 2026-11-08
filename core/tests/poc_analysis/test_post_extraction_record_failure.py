"""로컬 대조 요약 보존 실패가 확인된 서버 저장을 실패로 되돌리지 않는지 검사한다."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from core.client.post_extraction import compare_stored_extraction
from core.client.transport import AnalysisClientError
from core.modules.ontology.store import OntologyStore
from core.modules.personal.comparisons import ComparisonStore
from core.tests.poc_analysis import test_draft_workflow as fixture
from core.tests.poc_analysis.test_post_extraction import ContinuedFixtureAdapter


class ContinuedDraftAdapter(ContinuedFixtureAdapter):
    """기존 실제 저장 시험의 유효한 추출을 만들고 후속 대화는 합성 응답으로 잇는다."""

    def __init__(self):
        super().__init__()
        self.generator = fixture.DraftAdapter()

    async def run(self, *, prompt, schema, directory, output_schema=None, session_id=None):
        if session_id is not None:
            return await super().run(prompt=prompt, schema=schema, directory=directory,
                output_schema=output_schema, session_id=session_id)
        self.extractions += 1
        result = await self.generator.run(prompt=prompt, schema=schema,
            output_schema=output_schema or schema, directory=directory)
        result["execution"].update(session_id=self.session_id, session_persisted=True)
        return result


class PostExtractionRecordFailureTests(unittest.IsolatedAsyncioTestCase):
    async def setup_server(self):
        """기존 격리 HTTP/MCP 저장 fixture만 재사용하며 기존 시험을 중복 상속하지 않는다."""
        await fixture.DraftWorkflowTests.setup_server(self)

    @fixture.isolated_server
    async def test_summary_write_failure_preserves_stored_workflow_and_server_comparison(self):
        adapter = ContinuedDraftAdapter()
        with patch("core.client.post_extraction.write_new", side_effect=PermissionError("private path")) as write:
            result = await fixture.DraftWorkflowTests.execute(self, adapter)
        execution = result["ai_execution"]
        self.assertEqual(execution["status"], "stored")
        comparison = execution["comparison"]
        self.assertEqual(comparison["status"], "complete")
        self.assertTrue(comparison["extraction_saved"])
        self.assertEqual(comparison["local_record_error"], "comparison_local_record_failed")
        self.assertNotIn("private path", json.dumps(result))
        self.assertEqual(write.call_count, 1)
        self.assertEqual(adapter.extractions, 1)
        self.assertEqual(len(adapter.continuations), 1)
        self.assertEqual(len([item for tool, item in self.writes
            if tool == "analysis_job_ontology_generate" and item.get("save")]), 1)
        self.assertFalse(list((self.root / "work").rglob("ai-failure.json")))
        local_result = next((self.root / "work").rglob("ai-result.json"))
        self.assertEqual(json.loads(local_result.read_text())["comparison"], comparison)
        scope = self.policy.authorize(self.user["token"], self.tenant, "read")
        self.assertTrue(OntologyStore(scope.store)._path("pump.md").is_file())
        self.assertEqual(ComparisonStore(scope).read(comparison["comparison_id"])["status"], "complete")

    @fixture.isolated_server
    async def test_session_registry_failure_preserves_saved_extraction_and_automatic_comparison(self):
        adapter = ContinuedDraftAdapter()
        with patch("core.client.session_refs.SessionRefs.remember", side_effect=PermissionError("private path")):
            result = await fixture.DraftWorkflowTests.execute(self, adapter)
        execution = result["ai_execution"]
        self.assertEqual(execution["status"], "stored")
        comparison = execution["comparison"]
        self.assertEqual(comparison["status"], "complete")
        self.assertEqual(comparison["session_ref_error"], "comparison_session_ref_write_failed")
        self.assertEqual(adapter.extractions, 1)
        self.assertEqual(len(adapter.continuations), 1)
        self.assertFalse(list((self.root / "work").rglob("ai-failure.json")))
        self.assertNotIn("private path", json.dumps(result))

    async def test_summary_failure_keeps_original_comparison_failure_and_cancellation(self):
        arguments = dict(tenant="fixture", profile=None, job_id="job", receipt={"document": "pump.md",
            "source_revision": "source", "graph_revision": "graph"}, session={"session_id": "session",
            "provider": "codex"}, directory=Path("unused"))
        http = SimpleNamespace(base_url="http://127.0.0.1:8766")
        with patch("core.client.comparison.run_comparison", new_callable=AsyncMock) as comparison, \
                patch("core.client.post_extraction.write_new", side_effect=OSError("private path")) as write:
            comparison.side_effect = AnalysisClientError("comparison_result_unconfirmed")
            result = await compare_stored_extraction(http, object(), **arguments)
            self.assertEqual(result, {"status": "incomplete", "failure": "comparison_result_unconfirmed",
                "extraction_saved": True, "local_record_error": "comparison_local_record_failed"})
            self.assertEqual(comparison.await_count, 1)
            self.assertEqual(write.call_count, 1)
            comparison.side_effect = asyncio.CancelledError()
            with self.assertRaises(asyncio.CancelledError):
                await compare_stored_extraction(http, object(), **arguments)
            self.assertEqual(write.call_count, 1)


if __name__ == "__main__":
    unittest.main()
