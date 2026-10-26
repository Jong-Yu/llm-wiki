"""고정 입력의 결과 저장·거부·영수증 조회를 격리 tenant의 실제 MCP/API로 확인한다."""

from copy import deepcopy
import json
import unittest
from uuid import uuid4

from mcp import Client

from core.mcp.tenant import create_tenant_server
from core.modules.ontology.store import OntologyStore
from core.modules.analysis_results.diagnostics import empty_report
from core.tests.api import test_analysis_inputs_protocol as fixture


class AnalysisResultsProtocolTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.AnalysisInputsProtocolTests.setUp
    save_policy = fixture.AnalysisInputsProtocolTests.save_policy
    snapshot = fixture.AnalysisInputsProtocolTests.snapshot
    headers = fixture.AnalysisInputsProtocolTests.headers
    client = fixture.AnalysisInputsProtocolTests.client
    nothing = fixture.AnalysisInputsProtocolTests.nothing
    value = fixture.AnalysisInputsProtocolTests.value
    create = fixture.AnalysisInputsProtocolTests.create
    claim = fixture.AnalysisInputsProtocolTests.claim
    tool_value = fixture.AnalysisInputsProtocolTests.tool_value

    async def wiki_input(self, http, mcp):
        common, claimed = await self.claim(http, mcp)
        reading = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
            **common, "expected_job_revision": claimed["job_revision"], "stage": "read_source"}))
        extraction = self.tool_value(await mcp.call_tool("source_extraction_submit", {
            **common, "expected_job_revision": reading["job_revision"], "bundle_id": reading["bundle_id"],
            "bundle_revision": reading["bundle_revision"], "request_id": uuid4().hex,
            "content": "원본\r\n🌱", "method": "verbatim"}))
        prepared = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
            **common, "expected_job_revision": extraction["job_revision"], "stage": "prepare_wiki",
            "extraction_id": extraction["extraction_id"]}))
        return common, prepared

    def write_arguments(self, common, prepared, *, expected_revision=None):
        return {**common, "expected_job_revision": prepared["job_revision"],
            "bundle_id": prepared["bundle_id"], "bundle_revision": prepared["bundle_revision"],
            "request_id": uuid4().hex, "document": "분석/결과.md",
            "content": "시스템 A가 장치 B를 사용한다.\n", "expected_revision": expected_revision}

    async def graph_arguments(self, mcp, common, wiki):
        document = "분석/결과.md"
        prepared = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
            **common, "expected_job_revision": wiki["job_revision"],
            "stage": "extract_ontology", "target_document": document}))
        current = self.tool_value(await mcp.call_tool("ontology_review_query", {
            "tenant": "alpha", "document": document}))
        quote = "시스템 A가 장치 B를 사용한다."
        submission = {"schema_version": 3,
            "entities": [{"id": "a", "type": "system", "label": "시스템 A", "evidence": quote},
                         {"id": "b", "type": "physical_object", "label": "장치 B", "evidence": quote}],
            "relations": [{"subject": "a", "predicate": "uses", "object": "b", "evidence": quote,
                "qualifiers": {"polarity": "positive", "modality": "asserted",
                               "condition": None, "scope": None, "time": None}}],
            "attributes": [], "relation_candidates": []}
        return {**common, "expected_job_revision": prepared["job_revision"],
            "bundle_id": prepared["bundle_id"], "bundle_revision": prepared["bundle_revision"],
            "request_id": uuid4().hex, "document": document,
            "expected_revision": self.stores["alpha"].read(document).revision,
            "expected_state_revision": current["state_revision"], "submission": submission}

    async def test_wiki_graph_receipts_and_read_only_queries_preserve_original_history(self):
        store = self.stores["alpha"]
        before = store.save("분석/결과.md", "수정 전 전체 본문\r\n", expected_revision=None)
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, prepared = await self.wiki_input(http, mcp)
            args = self.write_arguments(common, prepared, expected_revision=before.revision)
            wiki = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", args))
            self.assertTrue(wiki["saved"])
            self.assertEqual(store.read("분석/결과.md").content, args["content"])
            self.assertIn("수정 전 전체 본문\r\n".encode(),
                          [path.read_bytes() for path in store.history_dir.rglob("*.md") if path.is_file()])
            graph_args = await self.graph_arguments(mcp, common, wiki)
            graph = self.tool_value(await mcp.call_tool("analysis_job_ontology_generate", graph_args))
            self.assertTrue(graph["saved"])
            self.assertIsNotNone(graph["receipt"])
            self.assertEqual(len(OntologyStore(store).query("분석/결과.md")["relations"]), 1)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.rules_config["tenants"]["alpha"]["revoked"] = [dict(self.reference)]
            self.rules_policy.write_text(json.dumps(self.rules_config), encoding="utf-8")
            for submitted in (args, graph_args):
                query = {"tenant": "alpha", "job_id": common["job_id"], "request_id": submitted["request_id"]}
                result = self.tool_value(await mcp.call_tool("analysis_job_result_query", query))
                self.assertTrue(result["saved"])
                self.assertEqual(result["state"], "complete")
                endpoint = self.base + f"/analysis-jobs/{common['job_id']}/results/{submitted['request_id']}"
                api = self.value(await http.get(endpoint))
                self.assertEqual(api["receipt"], result["receipt"])
                self.value(await http.get(endpoint, headers=self.headers("reader")), 404)

    async def test_permission_raw_types_and_invalid_graph_do_not_replace_saved_wiki(self):
        store = self.stores["alpha"]
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, prepared = await self.wiki_input(http, mcp)
            args = self.write_arguments(common, prepared)
            for changed in ({**args, "content": []}, {**args, "unexpected": True}):
                rejected = await mcp.call_tool("analysis_job_wiki_write", changed)
                self.assertTrue(rejected.is_error)
                self.assertEqual(rejected.structured_content["error"]["code"], "invalid_argument")
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "source_write"]
            self.save_policy()
            denied = await mcp.call_tool("analysis_job_wiki_write", args)
            self.assertTrue(denied.is_error)
            self.assertEqual(denied.structured_content["error"]["code"], "access_denied")
            self.assertFalse((store.wiki_dir / args["document"]).exists())
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = [
                "read", "source_write", "write", "ontology_write"]
            self.save_policy()
            wiki = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", args))
            graph_args = await self.graph_arguments(mcp, common, wiki)
            invalid = deepcopy(graph_args)
            del invalid["submission"]["relations"][0]["qualifiers"]
            before = store.read(args["document"])
            rejected = await mcp.call_tool("analysis_job_ontology_generate", invalid)
            self.assertTrue(rejected.is_error)
            self.assertEqual(rejected.structured_content["error"]["code"], "invalid_submission")
            self.assertEqual(store.read(args["document"]), before)
            self.assertFalse(OntologyStore(store)._path(args["document"]).exists())
            report = self.tool_value(await mcp.call_tool("analysis_job_result_query", {
                "tenant": "alpha", "job_id": common["job_id"], "request_id": invalid["request_id"]}))
            self.assertIsNot(report["saved"], True)
            self.assertIsNotNone(report["validation_report"])

    async def test_draft_diagnostics_are_queryable_by_owner_without_saving_or_approval(self):
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, prepared = await self.wiki_input(http, mcp)
            report = {**empty_report(), "omissions": ["원본 일부 해석 불가"], "unread_ranges": ["2행"]}
            args = {**self.write_arguments(common, prepared), "diagnostics": report, "save": False}
            draft = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", args))
            self.assertEqual((draft["state"], draft["saved"]), ("draft", False))
            self.assertEqual(draft["diagnostics"]["report"], report)
            self.assertFalse((self.stores["alpha"].wiki_dir / args["document"]).exists())
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            query = {"tenant": "alpha", "job_id": common["job_id"], "request_id": args["request_id"]}
            received = self.tool_value(await mcp.call_tool("analysis_job_result_query", query))
            endpoint = self.base + f"/analysis-jobs/{common['job_id']}/results/{args['request_id']}"
            self.assertEqual(self.value(await http.get(endpoint))["diagnostics"], received["diagnostics"])
            self.assertFalse(received["diagnostics"]["human_approval"])
            self.value(await http.get(endpoint, headers=self.headers("reader")), 404)


if __name__ == "__main__":
    unittest.main()
