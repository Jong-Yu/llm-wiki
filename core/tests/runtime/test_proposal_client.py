"""실제 loopback 제출에 응답 유실·권한/원문 변경을 주입한다. 모델은 합성 프로세스다."""

from pathlib import Path
import os
import unittest
from unittest.mock import patch

from core.client.ai.codex import CodexAdapter
from core.client.proposal import run_proposal
from core.client import proposal as implementation
from core.client.transport import AnalysisClientError
from core.tests.runtime import test_proposal_cli as fixture


@unittest.skipUnless(os.name == "posix", "Synthetic executable uses a POSIX shebang; not Windows verification.")
class ProposalClientTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.ProposalCliTests.setUp
    save_policy = fixture.ProposalCliTests.save_policy
    server = fixture.ProposalCliTests.server
    proposal = fixture.ProposalCliTests.proposal
    fake_cli = fixture.ProposalCliTests.fake_cli
    canonical = fixture.ProposalCliTests.canonical

    async def run_client(self, url, proposal, **options):
        arguments = dict(base_url=url, tenant="alpha", profile="all", token=self.tokens["alice"],
            work_dir=self.work, proposal_id=proposal["proposal_id"], expected_proposal_revision=proposal["state_revision"])
        if "adapter" not in options:
            arguments["adapter"] = CodexAdapter(cli=str(self.fake_cli()), timeout_seconds=15)
        arguments.update(options)
        return await run_proposal(**arguments)

    async def test_lost_link_response_then_read_recovery_never_repeats_post_or_model(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            calls = []
            original = implementation._call
            async def lose(http, method, path, body=None):
                calls.append((method, path))
                result = await original(http, method, path, body)
                if method == "POST" and "/result-links" in path or method == "GET" and "/requests/" in path:
                    raise AnalysisClientError("connection_failed")
                return result
            before = self.canonical()
            with patch.object(implementation, "_call", lose):
                unknown = await self.run_client(url, proposal)
            self.assertEqual(unknown["status"], "unconfirmed", unknown)
            self.assertIsNone(unknown["candidate_saved"])
            draft = Path(unknown["work_dir"]) / "invocation/result.json"
            observed = draft.stat().st_mtime_ns
            calls.clear()
            async def track(http, method, path, body=None):
                calls.append((method, path))
                return await original(http, method, path, body)
            with patch.object(implementation, "_call", track):
                recovered = await self.run_client(url, proposal, resume_dir=unknown["work_dir"], adapter=None)
            self.assertTrue(recovered["candidate_saved"], recovered)
            self.assertFalse(any(method == "POST" for method, _ in calls))
            self.assertEqual(draft.stat().st_mtime_ns, observed)
            self.assertEqual(self.canonical(), before)

    async def test_lost_start_and_result_responses_match_exact_receipts_without_repost(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            original_http, original_tool = implementation._call, implementation.tool_call
            counts = {"start": 0, "result": 0}
            async def lose_http(http, method, path, body=None):
                value = await original_http(http, method, path, body)
                if method == "POST" and path.endswith("/executions"):
                    counts["start"] += 1
                    raise AnalysisClientError("connection_failed")
                return value
            async def lose_tool(client, name, arguments):
                value = await original_tool(client, name, arguments)
                if name == "analysis_job_ontology_generate":
                    counts["result"] += 1
                    raise AnalysisClientError("connection_failed")
                return value
            with patch.object(implementation, "_call", lose_http), patch.object(implementation, "tool_call", lose_tool):
                result = await self.run_client(url, proposal)
            self.assertEqual(result["status"], "candidate_ready", result)
            self.assertEqual(counts, {"start": 1, "result": 1})

    async def test_start_receipt_hash_mismatch_prevents_model_execution(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            original = implementation._call
            async def tamper(http, method, path, body=None):
                value = await original(http, method, path, body)
                if method == "GET" and "/executions/" in path:
                    value["payload_hash"] = "0" * 64
                return value
            with patch.object(implementation, "_call", tamper):
                result = await self.run_client(url, proposal)
            self.assertEqual(result["error"]["code"], "proposal_execution_mismatch", result)
            self.assertFalse((Path(result["work_dir"]) / "invocation").exists())

    async def test_partial_semantic_failure_resumes_without_regenerating_candidate(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            async def fail(**_):
                raise AnalysisClientError("synthetic_interruption")
            with patch("core.client.semantic_check.run_semantic_check", fail):
                partial = await self.run_client(url, proposal, semantic_check=True)
            self.assertEqual(partial["status"], "partial", partial)
            self.assertTrue(partial["candidate_saved"])
            draft = Path(partial["work_dir"]) / "invocation/result.json"
            observed = draft.stat().st_mtime_ns
            resumed = await self.run_client(url, proposal, semantic_check=True, resume_dir=partial["work_dir"])
            self.assertEqual(resumed["status"], "candidate_ready", resumed)
            self.assertTrue(resumed["diagnostics_saved"])
            self.assertEqual(draft.stat().st_mtime_ns, observed)
            view = (await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"])).json()["data"]
            self.assertEqual([row["mode"] for row in view["result_links"]], ["candidate", "diagnostics"])

    async def test_permission_revocation_and_source_change_stop_before_any_submission(self):
        async with self.server() as (http, url):
            for change in ("permission", "source"):
                with self.subTest(change=change):
                    proposal = await self.proposal(http)
                    fired = False
                    def event(value):
                        nonlocal fired
                        if value["type"] != "candidate_preview" or fired:
                            return
                        fired = True
                        if change == "permission":
                            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                            self.save_policy()
                        else:
                            current = self.store.read("target.md")
                            self.store.save("target.md", current.content + "합성 조건 변경\n", expected_revision=current.revision)
                    result = await self.run_client(url, proposal, on_event=event,
                        adapter=CodexAdapter(cli=str(self.fake_cli(delay=6)), timeout_seconds=15))
                    self.assertTrue(fired, result)
                    self.assertFalse(result["candidate_saved"], result)
                    self.assertEqual(result["error"]["code"], "access_denied" if change == "permission" else "proposal_execution_basis_changed", result)
                    self.assertFalse(list(Path(result["work_dir"]).glob("*-result-request.json")))
                    self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "source_write", "ontology_write", "write"]
                    self.save_policy()

    async def test_receipt_payload_hash_mismatch_blocks_candidate_link(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            original = implementation.tool_call
            async def tamper(client, name, arguments):
                result = await original(client, name, arguments)
                if name == "analysis_job_result_query":
                    result["submission_ref"]["payload_hash"] = "0" * 64
                return result
            with patch.object(implementation, "tool_call", tamper):
                result = await self.run_client(url, proposal)
            self.assertEqual(result["error"]["code"], "proposal_result_mismatch", result)
            self.assertFalse(list(Path(result["work_dir"]).glob("*-link-request.json")))

    async def test_heartbeat_failure_cancels_own_process_and_retains_canonical(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            before = self.canonical()
            async def lost(*_, **__):
                raise AnalysisClientError("synthetic_lease_loss")
            with patch("core.client.ai.lease.HEARTBEAT_SECONDS", 0.15), patch("core.client.ai.lease.api_call", lost):
                result = await self.run_client(url, proposal, adapter=CodexAdapter(cli=str(self.fake_cli(delay=6)), timeout_seconds=15))
            self.assertEqual(result["error"]["code"], "analysis_lease_lost", result)
            self.assertFalse(result["candidate_saved"])
            self.assertEqual(self.canonical(), before)
            self.assertFalse(list(Path(result["work_dir"]).glob("*-result-request.json")))


if __name__ == "__main__":
    unittest.main()
