"""실제 MCP 도구/ASGI API에서 새 진단의 보존·권한 경계를 확인한다. 모델 실행은 합성이다."""

import unittest
from uuid import uuid4

from mcp import Client

from core.mcp.tenant import create_tenant_server
from core.modules.analysis_results import diagnostics
from core.tests.api import test_analysis_results_protocol as fixture
from core.tests.modules.test_rule_diagnostics import report_v2


class RuleDiagnosticsProtocolTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_v2_mcp_draft_api_read_and_raw_rule_failure_share_exact_reports(self):
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, prepared = await self.wiki_input(http, mcp)
            wiki = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", self.write_arguments(common, prepared)))
            args = await self.graph_arguments(mcp, common, wiki)
            manifest = self.tool_value(await mcp.call_tool("analysis_job_input_read", {
                **common, "bundle_id": args["bundle_id"], "bundle_revision": args["bundle_revision"]}))
            report = report_v2(manifest, args, args["submission"], common["job_id"])
            report["reviewer_kind"] = "separate_ai"
            for row in report["rule_results"]:
                row.update(status="error", reason="합성 모델 실행 오류 보존")
            request = {**args, "save": False, "diagnostics": report}
            draft = self.tool_value(await mcp.call_tool("analysis_job_ontology_generate", request))
            self.assertEqual(draft["state"], "draft")
            self.assertEqual(draft["diagnostics"]["semantic"]["rule_results"], report["rule_results"])
            self.assertFalse(draft["diagnostics"]["human_approval"])
            endpoint = self.base + f"/analysis-jobs/{common['job_id']}/results/{args['request_id']}"
            self.assertEqual(self.value(await http.get(endpoint))["diagnostics"], draft["diagnostics"])
            del args["submission"]["relations"][0]["qualifiers"]["time"]
            args["request_id"] = uuid4().hex
            rejected = await mcp.call_tool("analysis_job_ontology_generate", args)
            self.assertTrue(rejected.is_error)
            result = self.tool_value(await mcp.call_tool("analysis_job_result_query", {
                "tenant": "alpha", "job_id": common["job_id"], "request_id": args["request_id"]}))
            self.assertEqual(next(r["status"] for r in result["validation_report"]["rule_results"]
                                  if r["rule_id"] == "R-A08"), "fail")
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.assertEqual(self.value(await http.get(endpoint))["diagnostics"], draft["diagnostics"])
            self.value(await http.get(endpoint, headers=self.headers("reader")), 404)


if __name__ == "__main__":
    unittest.main()
