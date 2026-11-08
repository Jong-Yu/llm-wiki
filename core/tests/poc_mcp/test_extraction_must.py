"""Isolated MCP preservation and review boundaries; synthetic data, no model calls.

Diagnostics-to-review-item routing is intentionally reported as an absent capability,
not a semantic quality guarantee or a permanent prohibition on a future bridge.
"""
from copy import deepcopy
import unittest
from uuid import uuid4

from core.api.dependencies import access_value
from core.common.json_codec import canonical_json_hash
from core.modules.analysis_results import repository
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.analysis_results.store import ResultStore
from core.modules.extraction_rules.content import _policy_example
from core.modules.knowledge.aggregation import review_queue
from core.tests.poc_mcp import test_compact_responses as fixtures


class ExtractionMustTransport(unittest.TestCase):
    def setUp(self):
        # Compose the existing fixture: do not inherit and rerun its response tests.
        self.transport = fixtures.CompactAnalysisTransport(methodName="runTest")
        self.addCleanup(self.transport.doCleanups)
        self.transport.setUp()
        self.call, self.input, self.wiki = self.transport.call, self.transport.input, self.transport.wiki
        self.example = _policy_example("example.md")
        self.submission = deepcopy(self.example["submission"])
        plan = "시험 계획: 승인되면 시스템 A는 다음 달 장치 B를 사용할 예정이다."
        quantity = "시스템 A의 시험 수량은 10,000 개다."
        lines = self.example["source"].splitlines()
        lines[0] = plan
        self.source = "\n".join([*lines, quantity])
        relation = self.submission["relations"][0]
        relation["evidence"] = plan
        relation["qualifiers"] = {**relation["qualifiers"], "condition": "승인되면"}
        attribute = deepcopy(self.submission["attributes"][1])
        attribute.update(id="quantity", subject="a", property="시험 수량", datatype="text",
                         value="10,000", unit="개", evidence=quantity)
        self.submission["attributes"].append(attribute)
        # Register a separate synthetic source using the same isolated server.
        # The fixture's original unexecuted job is never used as this source's basis.
        created_source = self.transport.client.post(
            f"/api/v1/tenants/{self.transport.tenant}/sources", headers=self.transport.headers(),
            json=dict(request_id=uuid4().hex, title="MUST fixture", format="txt", content=self.source))
        self.assertEqual(created_source.status_code, 201)
        source = created_source.json()["data"]
        job = self.transport.mcp("analysis_registration_create", dict(
            tenant=self.transport.tenant, request_id=uuid4().hex, document="example.md", title="MUST fixture",
            source_ref={key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")}))
        self.assertTrue(job["ok"], job)
        self.transport.job_id = job["job_id"]
        claimed = self.call("analysis_job_claim", expected_job_revision=job["job_revision"])
        self.assertTrue(claimed["ok"], claimed)
        self.transport.run_id = claimed["run_id"]
        _, written = self.wiki()
        self.assertTrue(written["ok"], written)
        self.scope = self.transport.policy.authorize(self.transport.token, self.transport.tenant, "read")
        self.store = self.scope.store

    def review(self):
        result = self.transport.mcp("ontology_review_query", dict(
            tenant=self.transport.tenant, document="example.md"))
        self.assertTrue(result["ok"], result)
        return result

    def queue(self):
        return review_queue(self.store, access_value(self.scope), documents=["example.md"],
                            correspondence_ids=[], states=["unreviewed", "defer", "pending"], limit=100)

    def arguments(self):
        arguments, manifest = self.input("extract_ontology")
        target = manifest["dependency"]["documents"][0]
        return {**arguments, "expected_revision": target["source_revision"],
                "expected_state_revision": target["state_revision"], "submission": deepcopy(self.submission)}

    def retained(self, request_id):
        service = ResultStore(self.store, self.transport.rules)
        job = service.jobs.query(self.transport.job_id, tenant=self.transport.tenant,
                                 user_id=self.transport.user["user_id"])
        return repository.load(service, job, request_id)

    def preserved_files(self):
        return {str(path.relative_to(self.store.data_dir)): path.read_bytes()
                for name in ("wiki", "_history", "_knowledge", "_ontology", "_reviews")
                for path in (self.store.data_dir / name).rglob("*") if path.is_file()}

    def diagnostics(self):
        source_lines = self.store.read("example.md").content.splitlines()
        findings = []
        for verdict, collection, index in (("ambiguous", "relation_candidates", 0), ("schema_limit", "attributes", 0)):
            quote = self.submission[collection][index]["evidence"]
            line = source_lines.index(quote) + 1
            findings.append(dict(rule_id="R-S10", verdict=verdict,
                source=dict(start_line=line, end_line=line, quote=quote),
                target=dict(collection=collection, index=index), reason="synthetic unresolved meaning",
                recommendation="전문가 검토 필요", question="원문 범위에서 확인하거나 보류해 주세요."))
        return {**empty_report(), "reviewer_kind": "ai_self_check",
                "warnings": ["synthetic diagnostic, not a human decision"], "findings": findings}

    def test_plans_conditions_original_number_and_candidate_question_survive_transport(self):
        arguments = self.arguments()
        result = self.call("analysis_job_ontology_generate", **arguments)
        self.assertTrue(result["ok"], result)
        queried = self.call("analysis_job_result_query", request_id=arguments["request_id"])
        self.assertTrue(queried["saved"])
        _, raw = self.retained(arguments["request_id"])
        self.assertEqual(raw["submission"], arguments["submission"])
        reviewed = self.review()
        relation = reviewed["machine_graph"]["relations"][0]
        self.assertEqual(relation["qualifiers"], self.submission["relations"][0]["qualifiers"])
        self.assertEqual(relation["qualifiers"]["modality"], "planned")
        self.assertEqual(relation["evidence"]["quote"], self.submission["relations"][0]["evidence"])
        number = next(item for item in reviewed["machine_graph"]["attributes"] if item["id"] == "quantity")
        self.assertEqual(number["value"], "10,000")
        candidate = reviewed["machine_graph"]["relation_candidates"][0]
        for key in ("reason", "question"):
            self.assertEqual(candidate[key], self.submission["relation_candidates"][0][key])
        self.assertEqual(candidate["status"], "needs_review")
        self.assertEqual({item["decision"] for item in reviewed["claims"]}, {"unreviewed"})
        self.assertEqual(reviewed["history"], [])

    def test_forged_candidate_approval_is_rejected_and_raw_failure_is_retained(self):
        initial = self.arguments()
        generated = self.call("analysis_job_ontology_generate", **initial)
        self.assertTrue(generated["ok"], generated)
        before, files = self.review(), self.preserved_files()
        for field, value in (("status", "approved"), ("user_approved", True)):
            with self.subTest(field=field):
                arguments = self.arguments()
                arguments["submission"]["relation_candidates"][0][field] = value
                failed = self.call("analysis_job_ontology_generate", **arguments)
                self.assertFalse(failed["ok"], failed)
                self.assertEqual(failed["error"]["code"], "invalid_submission", failed)
                detail = self.call("analysis_job_result_query", request_id=arguments["request_id"])
                self.assertEqual(detail["state"], "rejected")
                self.assertFalse(detail["saved"])
                self.assertTrue(detail["submission_ref"]["retained"])
                _, raw = self.retained(arguments["request_id"])
                self.assertEqual(raw["submission"], arguments["submission"])
                self.assertEqual(self.review(), before)
                self.assertEqual(self.preserved_files(), files)

    def test_capability_boundary_diagnostics_are_retained_without_review_items_or_approval(self):
        arguments = self.arguments()
        report = self.diagnostics()
        result = self.call("analysis_job_ontology_generate", **arguments, diagnostics=report)
        self.assertTrue(result["ok"], result)
        detail = self.call("analysis_job_result_query", request_id=arguments["request_id"])
        diagnostic = detail["diagnostics"]
        self.assertEqual(diagnostic["report"], report)
        self.assertEqual(diagnostic["report_hash"], canonical_json_hash(report))
        self.assertFalse(diagnostic["human_approval"])
        self.assertEqual(diagnostic["origin"], "client_reported")
        self.assertEqual(diagnostic["basis"]["submission_hash"], canonical_json_hash(self.submission))
        _, raw = self.retained(arguments["request_id"])
        self.assertEqual(raw["diagnostics"], report)
        reviewed, queue = self.review(), self.queue()
        self.assertEqual({claim["decision"] for claim in reviewed["claims"]}, {"unreviewed"})
        self.assertEqual(reviewed["history"], [])
        # Current capability boundary: queue items derive from claims, not findings.
        self.assertEqual(len(queue["items"]), len(reviewed["claims"]))
        self.assertEqual({item["kind"] for item in queue["items"]}, {"document_claim"})
        self.assertEqual({item["claim"]["claim_id"] for item in queue["items"]},
                         {claim["claim_id"] for claim in reviewed["claims"]})
        candidate = next(item["claim"] for item in queue["items"] if item["claim"]["collection"] == "relation_candidates")
        self.assertEqual(candidate["decision"], "unreviewed")

    def test_diagnostic_only_draft_preserves_report_without_graph_claims_or_events(self):
        arguments = self.arguments()
        report, files = self.diagnostics(), self.preserved_files()
        result = self.call("analysis_job_ontology_generate", **arguments, diagnostics=report, save=False)
        self.assertTrue(result["ok"], result)
        detail = self.call("analysis_job_result_query", request_id=arguments["request_id"])
        self.assertEqual(detail["state"], "draft")
        self.assertFalse(detail["saved"])
        self.assertFalse(detail["diagnostics"]["human_approval"])
        self.assertEqual(detail["diagnostics"]["report"], report)
        self.assertEqual(self.preserved_files(), files)
        state = self.review()
        self.assertEqual(state["claims"], [])
        self.assertEqual(state["history"], [])
        self.assertFalse(any(item["kind"] == "document_claim" for item in self.queue()["items"]))
        _, raw = self.retained(arguments["request_id"])
        self.assertEqual(raw["submission"], self.submission)
        self.assertEqual(raw["diagnostics"], report)


if __name__ == "__main__":
    unittest.main()
