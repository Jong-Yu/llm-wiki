"""Real loopback API + MCP initialization and rollout. Model reports are synthetic."""

import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import time
import unittest
from unittest.mock import patch

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.extraction_rules import content
from core.modules.extraction_rules.administration import RulesetAdministration, write_new
from core.modules.extraction_rules.store import RulesetRegistry
from core.paths import PROJECT_DIR
from core.tests.api import test_analysis_results_protocol as fixture
from core.tests.modules.test_rule_diagnostics import report_v2


class RulesetTransitionProtocolTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.AnalysisResultsProtocolTests.save_policy
    headers = fixture.AnalysisResultsProtocolTests.headers
    value = fixture.AnalysisResultsProtocolTests.value
    create = fixture.AnalysisResultsProtocolTests.create
    claim = fixture.AnalysisResultsProtocolTests.claim
    tool_value = fixture.AnalysisResultsProtocolTests.tool_value
    wiki_input = fixture.AnalysisResultsProtocolTests.wiki_input
    write_arguments = fixture.AnalysisResultsProtocolTests.write_arguments
    graph_arguments = fixture.AnalysisResultsProtocolTests.graph_arguments

    def setUp(self):
        original = content.components
        def legacy(schema):
            return {**original(schema), "diagnostics.schema.json": canonical_json_bytes(content.diagnostics_schema(1))}
        with patch.object(content, "components", side_effect=legacy):
            fixture.AnalysisResultsProtocolTests.setUp(self)
        self.rulesets = RulesetRegistry(self.rules_root.resolve(), self.rules_policy.resolve(),
            self.tenant_root.resolve(), expected_schema=self.rulesets.expected_schema)

    async def test_actual_loopback_rollout_draft_receipt_legacy_rebase_and_rollback(self):
        old_files = {str(p): p.read_bytes() for p in (self.rules_root / "wiki" / "1").iterdir()}
        publication = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "tools.publish_ruleset",
            "--root", str(self.rules_root), "--tenant-root", str(self.tenant_root), "--ruleset-id", "wiki",
            "--version", "diagnostics-v2", "--reason", "Isolated real transport rollout", cwd=PROJECT_DIR,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await publication.communicate()
        self.assertEqual(publication.returncode, 0, stderr.decode())
        published = json.loads(stdout)
        admin = RulesetAdministration(self.rulesets)
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        server = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config_path), "--tenant-root", str(self.tenant_root), "--port", str(port),
            "--ruleset-root", str(self.rules_root), "--ruleset-policy", str(self.rules_policy), cwd=PROJECT_DIR,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        url = f"http://127.0.0.1:{port}"
        try:
            async with httpx2.AsyncClient(base_url=url, headers=self.headers(), trust_env=False, timeout=15) as http:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        if (await http.get("/api/v1/access-context")).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if server.returncode is not None or time.monotonic() > deadline:
                        self.fail("Isolated ruleset API/MCP process did not start.")
                    await asyncio.sleep(0.05)
                async with Client(streamable_http_client(url + "/mcp", http_client=http), mode="legacy") as mcp:
                    old_rules = self.tool_value(await mcp.call_tool("extraction_rules_read", {"tenant": "alpha"}))
                    self.assertEqual(old_rules["ruleset_version"], "1")
                    old_common, claimed = await self.claim(http, mcp)
                    old_input = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                        **old_common, "expected_job_revision": claimed["job_revision"], "stage": "read_source"}))
                    old_ref = {**old_common, "bundle_id": old_input["bundle_id"], "bundle_revision": old_input["bundle_revision"]}
                    old_bundle = self.tool_value(await mcp.call_tool("analysis_job_input_read", old_ref))
                    plan = admin.plan(tenant="alpha", key={"ruleset_id": "wiki", "ruleset_version": "diagnostics-v2"},
                        expected_revision=admin.snapshot()[2], reason="Allow and select v2", make_default=True)
                    applied = admin.apply(plan)
                    pinned = self.tool_value(await mcp.call_tool("analysis_job_input_read", old_ref))
                    self.assertEqual(pinned["manifest_text"], old_bundle["manifest_text"])
                    explicit = {**old_common, "expected_job_revision": old_input["job_revision"], "stage": "read_source",
                                "ruleset_id": "wiki", "ruleset_version": "diagnostics-v2"}
                    refused = await mcp.call_tool("analysis_job_input_prepare", explicit)
                    self.assertTrue(refused.is_error)
                    self.assertEqual(refused.structured_content["error"]["code"], "analysis_basis_changed")
                    rebased = self.tool_value(await mcp.call_tool("analysis_job_input_prepare", {
                        **explicit, "rebase": True, "rebase_reason": "Explicitly reviewed ruleset change"}))
                    self.assertNotEqual(rebased["analysis_basis_revision"], old_input["analysis_basis_revision"])
                # A fresh authenticated HTTP MCP initialization sees the new allowed default.
                async with Client(streamable_http_client(url + "/mcp", http_client=http), mode="legacy") as mcp:
                    rules = self.tool_value(await mcp.call_tool("extraction_rules_read", {"tenant": "alpha"}))
                    self.assertEqual(rules["ruleset_revision"], published["ruleset_revision"])
                    common, prepared = await self.wiki_input(http, mcp)
                    wiki = self.tool_value(await mcp.call_tool("analysis_job_wiki_write", self.write_arguments(common, prepared)))
                    args = await self.graph_arguments(mcp, common, wiki)
                    manifest = self.tool_value(await mcp.call_tool("analysis_job_input_read", {
                        **common, "bundle_id": args["bundle_id"], "bundle_revision": args["bundle_revision"]}))
                    report = report_v2(manifest, args, args["submission"], common["job_id"])
                    report["reviewer_kind"] = "separate_ai"
                    for row in report["rule_results"]:
                        row.update(status="error", reason="Synthetic model failure, actual transport persistence test")
                    draft = self.tool_value(await mcp.call_tool("analysis_job_ontology_generate", {
                        **args, "save": False, "diagnostics": report}))
                    self.assertEqual((draft["state"], draft["saved"]), ("draft", False))
                    self.assertEqual(draft["diagnostics"]["report_hash"], canonical_json_hash(report))
                    self.assertEqual(draft["validation_report"]["basis"]["submission_sha256"], canonical_json_hash(args["submission"]))
                    self.assertFalse(draft["diagnostics"]["human_approval"])
                    rollback = admin.rollback_plan(event_id=applied["event_id"], expected_revision=applied["policy_revision"],
                                                   reason="Verified rollback")
                    restored = admin.apply(rollback)
                    endpoint = self.base + f"/analysis-jobs/{common['job_id']}/results/{args['request_id']}"
                    queried = self.value(await http.get(endpoint))
                    self.assertEqual(queried["diagnostics"], draft["diagnostics"])
                    self.assertEqual(queried["submission_ref"], draft["submission_ref"])
                    old_again = self.tool_value(await mcp.call_tool("extraction_rules_read", {"tenant": "alpha"}))
                    self.assertEqual(old_again["ruleset_revision"], old_rules["ruleset_revision"])
                    denied = await mcp.call_tool("extraction_rules_read", {
                        "tenant": "alpha", "ruleset_id": "wiki", "ruleset_version": "diagnostics-v2"})
                    self.assertTrue(denied.is_error)
                    self.assertEqual(old_files, {str(p): p.read_bytes() for p in (self.rules_root / "wiki" / "1").iterdir()})
                    evidence = os.environ.get("LLM_WIKI_RULESET_EVIDENCE_DIR")
                    if evidence:
                        directory = Path(evidence)
                        write_new(directory / "protocol-receipt.json", canonical_json_bytes({
                            "scope": "isolated_real_loopback_http_mcp_synthetic_model_report",
                            "release": published, "transition": applied, "rollback": restored,
                            "result": queried, "raw_submission_sha256": canonical_json_hash(args["submission"]),
                            "legacy_preserved": True, "explicit_rebase_verified": True}))
        finally:
            if server.returncode is None:
                server.terminate()
            try:
                await asyncio.wait_for(server.communicate(), timeout=5)
            except asyncio.TimeoutError:
                server.kill()
                await server.communicate()


if __name__ == "__main__":
    unittest.main()
