"""새 작업 흐름의 HTTP/MCP 경계만 다섯 가지 핵심 시나리오로 확인한다."""

import unittest
from unittest.mock import patch
from uuid import uuid4

from mcp import Client

from core.mcp.server import create_server
from core.mcp.tenant import create_tenant_server
from core.tests.api import test_sources_api as source_fixture


class AnalysisJobApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = source_fixture.SourceApiTests.save_policy
    snapshot = source_fixture.SourceApiTests.snapshot
    headers = source_fixture.SourceApiTests.headers
    client = source_fixture.SourceApiTests.client
    nothing = source_fixture.SourceApiTests.nothing
    value = source_fixture.SourceApiTests.value

    def setUp(self):
        source_fixture.SourceApiTests.setUp(self)

    async def create(self, http, **changes):
        original = self.value(await http.post(self.base + "/sources", json={
            "request_id": uuid4().hex, "title": "분석 원본", "format": "txt", "content": "원본\r\n🌱"}), 201)
        body = {"request_id": uuid4().hex, "source_id": original["source_id"],
            "source_version": original["source_version"], "source_sha256": original["source_sha256"],
            "expected_registration_revision": original["registration_revision"],
            "targets": ["분석/결과.md"], "outputs": ["wiki", "ontology"], **changes}
        created = self.value(await http.post(self.base + "/analysis-jobs", json=body), 201)
        return created, body, original

    async def mcp(self):
        return Client(create_tenant_server(self.policy, self.tokens["alice"]), mode="legacy")

    def tool_value(self, result, code=None):
        value = result.structured_content
        self.assertIsInstance(value, dict)
        self.assertEqual(value["ok"], code is None)
        if code is not None:
            self.assertEqual(value["error"]["code"], code)
        return value

    async def test_http_create_mcp_claim_original_and_progress_are_one_job(self):
        async with self.client() as http:
            created, _, original = await self.create(http)
            async with await self.mcp() as mcp:
                current = self.tool_value(await mcp.call_tool("analysis_job_query", {
                    "tenant": "alpha", "job_id": created["job_id"]}))
                self.assertEqual(current["state"], "awaiting_cli")
                self.assertFalse(current["execution_ready"])
                self.assertEqual(set(current["blockers"]), {"common_ruleset_required", "fixed_input_bundle_required"})
                claimed = self.tool_value(await mcp.call_tool("analysis_job_claim", {
                    "tenant": "alpha", "job_id": current["job_id"], "expected_job_revision": current["job_revision"]}))
                source = self.tool_value(await mcp.call_tool("source_read", {
                    "tenant": "alpha", "job_id": current["job_id"], "run_id": claimed["run_id"]}))
                self.assertEqual(source["source_ref"]["source_sha256"], original["source_sha256"])
                self.assertTrue(source["file_ref"].startswith(self.base + "/sources/"))
                self.assertEqual((await http.get(source["file_ref"])).content, "원본\r\n🌱".encode())
                updated = self.tool_value(await mcp.call_tool("analysis_job_update", {
                    "tenant": "alpha", "job_id": current["job_id"], "run_id": claimed["run_id"],
                    "expected_job_revision": claimed["job_revision"], "reported_status": "input_ready"}))
                from_http = self.value(await http.get(self.base + "/analysis-jobs/" + current["job_id"]))
                self.assertEqual(from_http, {key: value for key, value in updated.items() if key != "ok"})
                self.assertEqual(from_http["reported_status"], "input_ready")
                self.assertFalse(list(self.stores["alpha"].wiki_dir.iterdir()))

    async def test_heartbeat_is_separate_from_job_revision_and_cancel_stops_run(self):
        async with self.client() as http:
            created, _, _ = await self.create(http)
            async with await self.mcp() as mcp:
                claimed = self.tool_value(await mcp.call_tool("analysis_job_claim", {
                    "tenant": "alpha", "job_id": created["job_id"], "expected_job_revision": created["job_revision"]}))
                pulse = self.value(await http.post(self.base + "/analysis-jobs/" + created["job_id"] + "/heartbeat", json={
                    "run_id": claimed["run_id"], "expected_lease_revision": claimed["lease_revision"]}))
                self.assertEqual(pulse["job_revision"], claimed["job_revision"])
                self.assertNotEqual(pulse["lease_revision"], claimed["lease_revision"])
                self.value(await http.post(self.base + "/analysis-jobs/" + created["job_id"] + "/cancel", json={
                    "expected_job_revision": pulse["job_revision"], "reason": "사용자가 중단"}))
                result = await mcp.call_tool("analysis_job_update", {"tenant": "alpha", "job_id": created["job_id"],
                    "run_id": claimed["run_id"], "expected_job_revision": claimed["job_revision"], "reported_status": "analyzing"})
                self.assertTrue(result.is_error)

    async def test_permissions_owner_and_strict_inputs_are_not_client_assertions(self):
        async with self.client() as http:
            created, body, _ = await self.create(http)
            self.value(await http.post(self.base + "/analysis-jobs", json=body, headers=self.headers("reader")), 403)
            self.value(await http.get(self.base + "/analysis-jobs/" + created["job_id"], headers=self.headers("reader")), 404)
            self.value(await http.post(self.base + "/analysis-jobs", json={**body, "actor": "admin"}), 422)
            async with await self.mcp() as mcp:
                self.tool_value(await mcp.call_tool("analysis_job_claim", {"tenant": "alpha", "job_id": created["job_id"],
                    "expected_job_revision": created["job_revision"], "reclaim": "false"}), "invalid_argument")
                self.tool_value(await mcp.call_tool("analysis_job_update", {"tenant": "alpha", "job_id": created["job_id"],
                    "run_id": "a" * 32, "expected_job_revision": created["job_revision"], "reported_status": ["complete"]}), "invalid_argument")
                self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                self.save_policy()
                self.tool_value(await mcp.call_tool("analysis_job_claim", {"tenant": "alpha", "job_id": created["job_id"],
                    "expected_job_revision": created["job_revision"]}), "access_denied")

    async def test_replay_preserves_one_job_and_changed_source_blocks_claim(self):
        async with self.client() as http:
            created, body, original = await self.create(http)
            replay = self.value(await http.post(self.base + "/analysis-jobs", json=body))
            self.assertEqual(replay["job_id"], created["job_id"])
            self.assertTrue(replay["replayed"])
            self.value(await http.post(self.base + "/analysis-jobs", json={**body, "targets": ["다른.md"]}), 409)
            self.value(await http.post(self.base + "/sources/" + original["source_id"] + "/versions", json={
                "request_id": uuid4().hex, "title": "새 판본", "format": "txt", "content": "새 원본",
                "expected_registration_revision": original["registration_revision"]}), 201)
            async with await self.mcp() as mcp:
                self.assertTrue((await mcp.call_tool("analysis_job_claim", {"tenant": "alpha", "job_id": created["job_id"],
                    "expected_job_revision": created["job_revision"]})).is_error)

    async def test_json_boundaries_and_new_tools_preserve_legacy_surface(self):
        async with self.client() as http:
            self.value(await http.post(self.base + "/analysis-jobs", content=b"{}", headers={"Content-Type": "text/plain"}), 415)
            self.value(await http.post(self.base + "/analysis-jobs", content=b'{"request_id":"a","request_id":"b"}',
                                      headers={"Content-Type": "application/json"}), 422)
            with patch("core.api.v1.analysis_jobs.ingress.MAX_JOB_REQUEST_BYTES", 2):
                self.value(await http.post(self.base + "/analysis-jobs", content=b"{ }", headers={"Content-Type": "application/json"}), 413)
            async with await self.mcp() as mcp:
                names = {tool.name for tool in (await mcp.list_tools()).tools}
                self.assertTrue({"analysis_job_claim", "analysis_job_query", "analysis_job_update", "source_read"} <= names)
            async with Client(create_server(self.stores["alpha"]), mode="legacy") as legacy:
                self.assertEqual(len((await legacy.list_tools()).tools), 7)


if __name__ == "__main__":
    unittest.main()
