"""규약·고정 입력의 실제 MCP 연결 두 흐름만 임시 tenant에서 확인한다."""

from hashlib import sha256
import json
import unittest
from uuid import uuid4

from mcp import Client

from core.mcp.tenant import create_tenant_server
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema
from core.tests.api import test_analysis_jobs_api as job_fixture


class AnalysisInputsProtocolTests(unittest.IsolatedAsyncioTestCase):
    save_policy = job_fixture.AnalysisJobApiTests.save_policy
    snapshot = job_fixture.AnalysisJobApiTests.snapshot
    headers = job_fixture.AnalysisJobApiTests.headers
    client = job_fixture.AnalysisJobApiTests.client
    nothing = job_fixture.AnalysisJobApiTests.nothing
    value = job_fixture.AnalysisJobApiTests.value
    create = job_fixture.AnalysisJobApiTests.create

    def setUp(self):
        job_fixture.AnalysisJobApiTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = [
            "read", "source_write", "write", "ontology_write"]
        self.save_policy()
        self.rules_root = self.root / "rules"
        self.rules_policy = self.root / "rules-policy.json"
        schema = build_submission_schema()
        self.reference = {"ruleset_id": "wiki", "ruleset_version": "1"}
        publish(self.rules_root, tenant_root=self.tenant_root, reason="isolated protocol test",
                schema=schema, expected_schema=schema, **self.reference)
        self.rules_config = {"version": 1, "tenants": {"alpha": {
            "default": dict(self.reference), "allowed": [dict(self.reference)], "revoked": []}}}
        self.rules_policy.write_text(json.dumps(self.rules_config), encoding="utf-8")
        self.rulesets = RulesetRegistry(self.rules_root, self.rules_policy, self.tenant_root,
                                       expected_schema=schema)
        self.app.state.rulesets = self.rulesets

    def tool_value(self, result):
        value = result.structured_content
        self.assertIsInstance(value, dict)
        self.assertTrue(value["ok"], value)
        self.assertNotIn(str(self.root), json.dumps(value, ensure_ascii=False))
        return value

    async def claim(self, http, mcp):
        created, _, _ = await self.create(http)
        claimed = self.tool_value(await mcp.call_tool("analysis_job_claim", {
            "tenant": "alpha", "job_id": created["job_id"], "expected_job_revision": created["job_revision"]}))
        return {"tenant": "alpha", "job_id": created["job_id"], "run_id": claimed["run_id"]}, claimed

    async def test_rules_and_frozen_input_pages_connect_to_immutable_reading_submission(self):
        self.stores["alpha"].save("정의.md", "참고 정의와 예외\r\n", expected_revision=None)
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            rules = self.tool_value(await mcp.call_tool("extraction_rules_read", {"tenant": "alpha"}))
            self.assertEqual(rules["ruleset_revision"], self.rulesets.read("alpha")["ruleset_revision"])
            common, claimed = await self.claim(http, mcp)
            prepared = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                **common, "expected_job_revision": claimed["job_revision"], "stage": "read_source",
                "context_documents": [{"document": "정의.md", "required": True, "reason": "용어 정의"}]}))
            reference = {**common, "bundle_id": prepared["bundle_id"], "bundle_revision": prepared["bundle_revision"]}
            manifest = self.tool_value(await mcp.call_tool("analysis_job_input_read", reference))
            self.assertEqual(sha256(manifest["manifest_text"].encode()).hexdigest(), prepared["bundle_revision"])
            self.assertTrue(manifest["input_ready"])
            contents = []
            for component, metadata in manifest["components"].items():
                text, offset = "", 0
                while True:
                    page = self.tool_value(await mcp.call_tool("analysis_job_input_read", {
                        **reference, "component": component, "offset": offset, "limit": 65536}))
                    text += page["content"]
                    if page["next_offset"] is None:
                        break
                    offset = page["next_offset"]
                self.assertEqual(sha256(text.encode()).hexdigest(), metadata["sha256"])
                contents.append(text)
            self.assertIn("참고 정의와 예외", "".join(contents))
            submitted = self.tool_value(await mcp.call_tool("source_extraction_submit", {
                **reference, "expected_job_revision": prepared["job_revision"], "request_id": uuid4().hex,
                "content": "원본\r\n🌱", "method": "verbatim", "warnings": [], "omissions": [], "scope": {}}))
            self.assertEqual(submitted["content_sha256"], sha256("원본\r\n🌱".encode()).hexdigest())
            wiki_input = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                **common, "expected_job_revision": submitted["job_revision"], "stage": "prepare_wiki",
                "extraction_id": submitted["extraction_id"]}))
            self.assertEqual(wiki_input["stage"], "prepare_wiki")
            self.assertTrue(wiki_input["input_ready"])
            self.assertEqual(list(self.stores["alpha"].wiki_dir.rglob("결과.md")), [])

    async def test_changed_context_revocation_and_original_json_types_block_reuse(self):
        saved = self.stores["alpha"].save("조건.md", "변경 전 조건", expected_revision=None)
        server = create_tenant_server(self.policy, self.tokens["alice"], rulesets=self.rulesets)
        async with self.client() as http, Client(server, mode="legacy") as mcp:
            common, claimed = await self.claim(http, mcp)
            prepared = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                **common, "expected_job_revision": claimed["job_revision"], "stage": "read_source",
                "context_documents": [{"document": "조건.md", "required": True, "reason": "현재 조건"}]}))
            reference = {**common, "bundle_id": prepared["bundle_id"], "bundle_revision": prepared["bundle_revision"]}
            self.stores["alpha"].save("조건.md", "변경 후 조건", expected_revision=saved.revision)
            stale = await mcp.call_tool("analysis_job_input_read", reference)
            self.assertTrue(stale.is_error)
            self.assertEqual(stale.structured_content["error"]["code"], "input_basis_changed")
            current = self.tool_value(await mcp.call_tool("analysis_job_query", {
                "tenant": "alpha", "job_id": common["job_id"]}))
            retry = {**common, "expected_job_revision": current["job_revision"], "stage": "read_source"}
            changed = await mcp.call_tool("analysis_job_input_prepare", retry)
            self.assertTrue(changed.is_error)
            self.assertEqual(changed.structured_content["error"]["code"], "analysis_basis_changed")
            explicit_empty = await mcp.call_tool("analysis_job_input_prepare", {**retry, "context_documents": []})
            self.assertTrue(explicit_empty.is_error)
            renewed = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                **retry, "rebase": True, "rebase_reason": "원문과 변경된 필수 조건을 대조한 뒤 재준비"}))
            self.assertNotEqual(renewed["analysis_basis_revision"], prepared["analysis_basis_revision"])
            inherited = self.tool_value(await mcp.call_tool("analysis_job_input_read", {
                **common, "bundle_id": renewed["bundle_id"], "bundle_revision": renewed["bundle_revision"]}))
            self.assertEqual(inherited["manifest"]["selection"][0]["document"], "조건.md")
            bad_bool = await mcp.call_tool("analysis_job_input_prepare", {
                **retry, "rebase": "true", "rebase_reason": "원래 JSON 타입 확인"})
            self.assertTrue(bad_bool.is_error)
            self.assertEqual(bad_bool.structured_content["error"]["code"], "invalid_argument")
            malformed = await mcp.call_tool("extraction_rules_read", {"tenant": "alpha", "ruleset_id": ["wiki"]})
            self.assertTrue(malformed.is_error)
            self.assertEqual(malformed.structured_content["error"]["code"], "invalid_argument")
            self.rules_config["tenants"]["alpha"]["revoked"] = [dict(self.reference)]
            self.rules_policy.write_text(json.dumps(self.rules_config), encoding="utf-8")
            denied = await mcp.call_tool("extraction_rules_read", {"tenant": "alpha", **self.reference})
            self.assertTrue(denied.is_error)


if __name__ == "__main__":
    unittest.main()
