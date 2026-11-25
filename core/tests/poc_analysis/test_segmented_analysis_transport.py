"""8 MiB 초과 실제 API/MCP 등록·재개 경계. AI는 명시적인 합성 어댑터다."""

from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.api.dependencies import access_value
from core.client.ai import segmented_input
from core.client.transport import AnalysisClientError, client_error_code
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.metadata import parse_document
from core.modules.extraction_rules.store import RulesetRegistry
from core.modules.ontology.store import OntologyStore
from core.modules.sources.store import SourceStore
from core.runtime.extraction_schema import build_submission_schema
from core.tests.poc_analysis.test_draft_workflow import DraftWorkflowTests, isolated_server
from core.tests.poc_analysis.test_segmented_analysis_client import RetainedLimitAdapter


class LargeAdapter(RetainedLimitAdapter):
    def __init__(self, *, stop_before_reconciliation=False):
        super().__init__()
        self.stop_before_reconciliation = stop_before_reconciliation

    async def preflight(self):
        return {"provider": "codex", "cli_version": "synthetic-large-transport"}

    async def run(self, **kwargs):
        data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1])
        if self.stop_before_reconciliation and data["manifest"]["segmented_input"]["phase"] == "reconcile":
            raise AnalysisClientError("synthetic_transport_interruption")
        return await super().run(**kwargs)


class LargeSegmentedTransportTests(unittest.IsolatedAsyncioTestCase):
    setup_server = DraftWorkflowTests.setup_server
    execute = DraftWorkflowTests.execute
    graph_writes = DraftWorkflowTests.graph_writes

    def large_registration(self):
        # 원본 업로드의 큰 파일 수신은 별도 검증되어 있다. 여기서는 격리 저장소에
        # 원본만 준비하고 실제 개인 CLI → HTTP/MCP 경로의 분석 입력/결과를 검증한다.
        scope = self.policy.authorize(self.user["token"], self.tenant, "source_write")
        def authorize(permission=None):
            return access_value(self.policy.authorize(self.user["token"], self.tenant, permission or "read"))
        store = scope.store
        sources = SourceStore(store)
        text = "Pump.\nPump direction is toward.\n" + "x" * (9 * 1024 * 1024) + "\n"
        staged = sources.stage(BytesIO(text.encode()), kind="text", title="Large", format="txt")
        receipt = sources.commit(staged, tenant=self.tenant, user_id=self.user["user_id"],
            request_id=uuid4().hex, authorize=authorize)
        catalog = sources.get_source(receipt["receipt"]["source_id"])
        source_ref = {key: catalog["versions"][-1][key] for key in ("source_id", "source_version", "source_sha256")}
        source_ref["registration_revision"] = catalog["registration_revision"]
        registry = RulesetRegistry(self.root / "rules", self.rule_policy, self.root / "data",
                                   expected_schema=build_submission_schema())
        jobs = JobStore(store, rulesets=registry)
        created = jobs.create_registration(tenant=self.tenant, user_id=self.user["user_id"],
            request_id=uuid4().hex, source_ref=source_ref, document="large.md", title="Large", authorize=authorize)
        self.job_id = created["job_id"]
        original_conversion = (jobs.job_root(self.job_id) / "conversion.json").read_bytes()
        return store, jobs, text, original_conversion

    @isolated_server
    async def test_default_disabled_keeps_large_wiki_and_does_not_complete_registration(self):
        store, jobs, text, _ = self.large_registration()
        adapter = LargeAdapter()
        # 실제 제품 기본값을 사용한다. False 패치로 검사를 통과시키지 않는다.
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_prompt_limit")
        saved = store.read("large.md")
        self.assertEqual(parse_document(saved.content).body, text)
        self.assertEqual(adapter.calls, 0)
        self.assertFalse(OntologyStore(store)._path("large.md").exists())
        self.assertEqual(self.graph_writes(), [])
        wiki_writes = [arguments for tool, arguments in self.writes if tool == "analysis_job_wiki_write"]
        self.assertEqual(len(wiki_writes), 1)
        self.assertNotIn("content", wiki_writes[0])
        self.assertEqual(wiki_writes[0]["content_ref"]["component"], "data/registration.md")
        status = jobs.query(self.job_id, tenant=self.tenant, user_id=self.user["user_id"])["result_summary"]
        self.assertEqual(status["status"], "partial")
        self.assertEqual((status["saved_count"], status["required_count"]), (1, 2))
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter, reclaim=True)
        self.assertEqual(client_error_code(stopped.exception), "analysis_prompt_limit")
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(store.read("large.md").revision, saved.revision)
        self.assertEqual(len([tool for tool, _ in self.writes if tool == "analysis_job_wiki_write"]), 1)
        self.assertFalse((self.root / "work" / self.job_id / "segmented").exists())

    @isolated_server
    async def test_large_reference_failure_resume_and_one_final_graph_over_real_mcp(self):
        store, jobs, text, original_conversion = self.large_registration()
        with patch.object(segmented_input, "ENABLED", True):
            first = LargeAdapter(stop_before_reconciliation=True)
            with self.assertRaises(Exception) as stopped:
                await self.execute(first)
            self.assertEqual(client_error_code(stopped.exception), "synthetic_transport_interruption")
            saved = store.read("large.md")
            self.assertEqual(parse_document(saved.content).body, text)
            self.assertFalse(OntologyStore(store)._path("large.md").exists())
            wiki_writes = [arguments for tool, arguments in self.writes if tool == "analysis_job_wiki_write"]
            self.assertEqual(len(wiki_writes), 1)
            self.assertNotIn("content", wiki_writes[0])
            self.assertEqual(wiki_writes[0]["content_ref"]["component"], "data/registration.md")
            self.assertLess(len(canonical_json_bytes(wiki_writes[0])), 4096)
            self.assertEqual(self.graph_writes(), [])
            finished_segments = len(list((self.root / "work" / self.job_id / "segmented").rglob("extract-*.json")))
            self.assertGreater(finished_segments, 30)
            # 최종 저장 응답을 잃어도 같은 request_id 조회로 확인한다.
            from core.client.ai import workflow
            existing_tool = workflow.tool_call
            async def lose_graph_reply(client, tool, arguments):
                value = await existing_tool(client, tool, arguments)
                if tool == "analysis_job_ontology_generate":
                    raise OSError("isolated lost final graph response")
                return value
            second = LargeAdapter()
            with patch.object(workflow, "tool_call", side_effect=lose_graph_reply):
                resumed = await self.execute(second, reclaim=True)
            self.assertEqual(resumed["ai_execution"]["status"], "stored")
            self.assertEqual(second.calls, finished_segments)
            self.assertEqual(store.read("large.md").revision, saved.revision)
            self.assertEqual(len([tool for tool, _ in self.writes if tool == "analysis_job_wiki_write"]), 1)
            self.assertEqual(len(self.graph_writes()), 1)
            self.assertIn("analysis_job_result_query", self.tool_calls)
            graph = OntologyStore(store).query("large.md")
            self.assertEqual(graph["status"], "ready")
            self.assertEqual(len(graph["entities"]), 1)
            self.assertEqual(graph["attributes"][0]["value"], "toward")
            submitted = self.graph_writes()[0]["diagnostics"]
            self.assertEqual(submitted["omissions"], [RetainedLimitAdapter.reason])
            self.assertEqual(submitted["findings"][0]["verdict"], "schema_limit")
            self.assertEqual(submitted["findings"][0]["target"], {"collection": "attributes", "index": 0})
            before, after = json.loads(original_conversion), json.loads((jobs.job_root(self.job_id) / "conversion.json").read_bytes())
            self.assertEqual({key: value for key, value in after.items() if key != "first_markdown"},
                             {key: value for key, value in before.items() if key != "first_markdown"})
