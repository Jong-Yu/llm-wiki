"""실제 AI 호출 없이 실행 자기신고의 저장 연결·권한 위조 거부·기존 호출 호환을 확인한다."""

from hashlib import sha256
import unittest

from mcp import Client

from core.common.json_codec import canonical_json_hash
from core.mcp.tenant import create_tenant_server
from core.modules.analysis_results import repository
from core.modules.analysis_results.store import ResultStore
from core.modules.ontology.store import OntologyStore
from core.tests.api import test_analysis_results_protocol as fixture


class AIExecutionProvenanceTests(unittest.IsolatedAsyncioTestCase):
    # 기존 격리 tenant/규약/입력 준비 도우미만 재사용한다. 다른 테스트 메서드는 상속하지 않는다.
    setUp = fixture.AnalysisResultsProtocolTests.setUp
    save_policy = fixture.AnalysisResultsProtocolTests.save_policy
    snapshot = fixture.AnalysisResultsProtocolTests.snapshot
    headers = fixture.AnalysisResultsProtocolTests.headers
    client = fixture.AnalysisResultsProtocolTests.client
    nothing = fixture.AnalysisResultsProtocolTests.nothing
    value = fixture.AnalysisResultsProtocolTests.value
    create = fixture.AnalysisResultsProtocolTests.create
    claim = fixture.AnalysisResultsProtocolTests.claim
    tool_value = fixture.AnalysisResultsProtocolTests.tool_value
    wiki_input = fixture.AnalysisResultsProtocolTests.wiki_input
    write_arguments = fixture.AnalysisResultsProtocolTests.write_arguments
    graph_arguments = fixture.AnalysisResultsProtocolTests.graph_arguments

    def preserved(self, common, request_id):
        service = ResultStore(self.stores["alpha"], self.rulesets)
        job = service.jobs.query(common["job_id"], tenant="alpha", user_id="alice")
        return repository.load(service, job, request_id)

    async def test_execution_is_client_reported_without_authority_and_omission_preserves_payload(self):
        # 합성 실행 정보다. 형식/계보 계약만 시험하며 실제 모델이나 사람 승인의 증거로 쓰지 않는다.
        execution = {"provider": "codex", "cli_version": "codex-cli fixture",
            "requested_model": None, "reported_model": "fixture-model",
            **{name + "_sha256": sha256(name.encode()).hexdigest()
               for name in ("prompt", "schema", "output")},
            "published_schema_sha256": sha256(b"published-schema").hexdigest()}
        store = self.stores["alpha"]
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, prepared = await self.wiki_input(http, mcp)
            arguments = {**self.write_arguments(common, prepared), "execution": execution}
            wiki = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", arguments))
            self.assertEqual(wiki["receipt"]["execution"], {"origin": "client_reported", **execution})
            self.assertEqual(wiki["receipt"]["bundle_revision"], prepared["bundle_revision"])
            raw_record, raw = self.preserved(common, arguments["request_id"])
            self.assertEqual(raw["execution"], execution)
            self.assertEqual(wiki["receipt"]["payload_hash"], canonical_json_hash(raw))
            self.assertTrue(raw_record["saved"])

            graph_args = {**await self.graph_arguments(mcp, common, wiki), "execution": execution}
            graph = self.tool_value(await mcp.call_tool("analysis_job_ontology_generate", graph_args))
            self.assertEqual(graph["receipt"]["execution"]["origin"], "client_reported")
            self.assertFalse(graph["validation_report"]["semantic"]["human_approval"])

            # 승인/신원은 실행 메타데이터로 끼워 넣을 수 없고 잘못된 원시 신고는 그대로 보존한다.
            for forbidden in ({"actor": "administrator"}, {"human_approval": True}):
                with self.subTest(forbidden=next(iter(forbidden))):
                    current = store.read(arguments["document"])
                    old_graph = OntologyStore(store).query(arguments["document"])["graph_revision"]
                    next_common, next_input = await self.wiki_input(http, mcp)
                    invalid = {**self.write_arguments(next_common, next_input, expected_revision=current.revision),
                               "execution": {**execution, **forbidden}}
                    rejected = await mcp.call_tool("analysis_job_wiki_write", invalid)
                    self.assertTrue(rejected.is_error)
                    self.assertEqual(rejected.structured_content["error"]["code"], "invalid_execution_report")
                    self.assertEqual(store.read(arguments["document"]), current)
                    self.assertEqual(OntologyStore(store).query(arguments["document"])["graph_revision"], old_graph)
                    record, payload = self.preserved(next_common, invalid["request_id"])
                    self.assertFalse(record["saved"])
                    self.assertEqual(payload["execution"], invalid["execution"])

            # execution을 생략한 옛 호출에는 새 키를 넣지 않아 원래 요청의 지문 계산을 보존한다.
            current = store.read(arguments["document"])
            legacy_common, legacy_input = await self.wiki_input(http, mcp)
            legacy_args = self.write_arguments(legacy_common, legacy_input, expected_revision=current.revision)
            legacy = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", legacy_args))
            _, payload = self.preserved(legacy_common, legacy_args["request_id"])
            expected = {key: value for key, value in legacy_args.items() if key != "tenant"}
            expected["stage"] = "prepare_wiki"
            self.assertNotIn("execution", payload)
            self.assertEqual(payload, expected)
            self.assertEqual(legacy["receipt"]["payload_hash"], canonical_json_hash(expected))
            self.assertIsNone(legacy["receipt"]["execution"])


if __name__ == "__main__":
    unittest.main()
