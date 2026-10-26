"""규칙별 실행·미실행 및 의미 자기보고를 격리 데이터에서 검증한다. 의미 정확도 평가는 아니다."""

from copy import deepcopy
from hashlib import sha256
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from jsonschema import Draft202012Validator
from core.modules.analysis_results import diagnostics
from core.modules.analysis_results.contracts import ResultError
from core.modules.documents.store import StorageBusyError
from core.modules.extraction_rules import content
from core.tests.modules import test_analysis_diagnostics as fixture, test_analysis_results as results_fixture, test_extraction_rules as rules_fixture


def report_v2(bundle, args, submission, job_id):
    return {**diagnostics.empty_report(), "schema_version": 2, "reviewer_kind": "human_reported",
            "semantic_check": {"check_id": uuid4().hex, "input": {
                "job_id": job_id, "run_id": args["run_id"], "bundle_id": args["bundle_id"],
                "bundle_revision": args["bundle_revision"], "document": args["document"],
                "source_revision": args["expected_revision"], "submission_sha256": canonical_json_hash(submission),
                "schema_version": submission["schema_version"], "ruleset_ref": bundle["ruleset_ref"]},
                "source_audit_execution": None, "assessment_execution": None,
                "source_audit_sha256": None, "source_audit": None},
            "rule_results": [{"rule_id": rule, "status": "not_run", "reason": "합성 계약 시험: 미검사",
                              "finding_indices": []} for rule in diagnostics.SEMANTIC_RULES]}


class RuleDiagnosticTests(unittest.TestCase):
    setUp = fixture.AnalysisDiagnosticsTests.setUp
    authorize = fixture.AnalysisDiagnosticsTests.authorize
    current = fixture.AnalysisDiagnosticsTests.current
    prepare = fixture.AnalysisDiagnosticsTests.prepare
    protected = fixture.AnalysisDiagnosticsTests.protected
    wiki_bundle = fixture.AnalysisDiagnosticsTests.wiki_bundle
    arguments = fixture.AnalysisDiagnosticsTests.arguments
    write = fixture.AnalysisDiagnosticsTests.write
    receipt = fixture.AnalysisDiagnosticsTests.receipt

    def graph_input(self):
        self.write()
        bundle = self.prepare("extract_ontology", target_document="target.md")
        return bundle, self.arguments(bundle), results_fixture.AnalysisResultTests.submission()

    def test_individual_success_and_nonapplicable_rules_are_not_semantic_passes(self):
        bundle, args, submission = self.graph_input()
        result = self.results.generate_ontology(self.job_id, **args, submission=submission)
        checks = {row["rule_id"]: row["status"] for row in result["validation_report"]["rule_results"]}
        self.assertEqual(checks, {**{f"R-A{i:02d}": "pass" for i in range(1, 10)}, "R-A10": "not_applicable"})
        self.assertEqual(result["validation_report"]["semantic"]["status"], "not_run")
        self.assertEqual(result["validation_report"]["basis"]["ruleset_ref"], bundle["ruleset_ref"])

    def test_failures_keep_earlier_passes_and_unreached_checks_and_preserve_graph(self):
        bundle, args, submission = self.graph_input()
        variants = []
        invalid_quote = deepcopy(submission)
        invalid_quote["relations"][0]["evidence"] = "존재하지 않는 인용"
        variants.append((invalid_quote, "R-A07"))
        missing_keys = deepcopy(submission)
        del missing_keys["relations"][0]["qualifiers"]["condition"]
        variants.append((missing_keys, "R-A08"))
        wrong_ref = deepcopy(submission)
        wrong_ref["relations"][0]["object"] = "missing"
        variants.append((wrong_ref, "R-A06"))
        wrong_anchor = deepcopy(submission); wrong_anchor["schema_version"] = 4
        wrong_anchor["relations"][0]["object"] = {"kind": "source_anchor", "document": "target.md",
            "source_revision": "0" * 64, "quote": "센서", "start_line": 1, "end_line": 1, "occurrence": 0}
        variants.append((wrong_anchor, "R-A07"))
        before = self.protected()
        for value, rule in variants:
            request = {**args, "request_id": uuid4().hex}
            with self.assertRaises(ResultError) as caught:
                self.results.generate_ontology(self.job_id, **request, submission=value)
            if value is wrong_anchor:
                self.assertEqual(caught.exception.code, "invalid_ontology")
            rows = {r["rule_id"]: r for r in self.receipt(request["request_id"])["validation_report"]["rule_results"]}
            self.assertEqual(rows[rule]["status"], "fail")
            self.assertEqual(rows["R-A01"]["status"], "pass")
            self.assertEqual(rows["R-A10"]["status"], "not_run")
            self.assertEqual(self.protected(), before)

    def test_storage_busy_is_checker_error_not_rule_failure_and_draft_does_not_claim_validation(self):
        bundle, args, submission = self.graph_input()
        with patch.object(self.store, "_write_lock", side_effect=StorageBusyError(0.01)):
            with self.assertRaises(StorageBusyError):
                self.results.generate_ontology(self.job_id, **args, submission=submission, save=False)
        # Lock could not be acquired: no graph rule was tested and no stored result is inferred.
        record = self.receipt(args["request_id"])
        self.assertFalse(record["saved"])
        self.assertEqual(record["state"], "storage_busy")
        self.assertIn("error", {r["status"] for r in record["validation_report"]["rule_results"]})
        replay = self.results.generate_ontology(self.job_id, **args, submission=submission, save=False)
        self.assertEqual(replay["state"], "draft")
        self.assertEqual(next(r["status"] for r in replay["validation_report"]["rule_results"] if r["rule_id"] == "R-A06"), "not_run")

    def test_v2_rule_opinions_persist_without_approval_and_exact_request_replays(self):
        bundle, args, submission = self.graph_input()
        report = report_v2(bundle, args, submission, self.job_id)
        report["reviewed_ranges"] = [{"start_line": 1, "end_line": 1}]
        report["findings"] = [{"rule_id": "R-S10", "verdict": "schema_limit", "source": {
            "start_line": 1, "end_line": 1, "quote": "모델은 센서를 사용한다."}, "target": None,
            "reason": "합성 표현 한계", "recommendation": None, "question": "추가 구조가 필요한가?"}]
        report["rule_results"][0].update(status="pass")
        report["rule_results"][1].update(status="not_applicable")
        report["rule_results"][2].update(status="error")
        report["rule_results"][-1].update(status="fail", finding_indices=[0])
        before = self.protected()
        result = self.results.generate_ontology(self.job_id, **args, submission=submission, diagnostics=report, save=False)
        self.assertEqual(result["diagnostics"]["semantic"]["rule_results"], report["rule_results"])
        self.assertFalse(result["diagnostics"]["human_approval"])
        self.assertEqual(self.protected(), before)
        self.assertTrue(self.results.generate_ontology(self.job_id, **args, submission=submission,
            diagnostics=report, save=False)["replayed"])
        changed = deepcopy(report); changed["rule_results"][0]["reason"] = "변경된 판단"
        with self.assertRaises(ResultError) as conflict:
            self.results.generate_ontology(self.job_id, **args, submission=submission, diagnostics=changed, save=False)
        self.assertEqual(conflict.exception.code, "request_conflict")
        self.jobs.cancel(self.job_id, tenant="alpha", user_id="alice", expected_job_revision=self.current()["job_revision"],
                         reason="완료", authorize=self.authorize)
        self.rules.allowed = False
        self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["report"], report)

    def test_forged_input_incomplete_rules_and_unexecuted_separate_ai_are_rejected_but_retained(self):
        bundle, args, submission = self.graph_input()
        report = report_v2(bundle, args, submission, self.job_id)
        variants = []
        wrong = deepcopy(report); wrong["semantic_check"]["input"]["submission_sha256"] = "0" * 64
        variants.append(wrong)
        wrong = deepcopy(report); wrong["rule_results"].pop()
        variants.append(wrong)
        wrong = deepcopy(report); wrong["rule_results"][0]["rule_id"] = "R-S02"
        variants.append(wrong)
        wrong = deepcopy(report); wrong["reviewer_kind"] = "separate_ai"
        wrong["rule_results"][0]["status"] = "pass"; wrong["reviewed_ranges"] = [{"start_line": 1, "end_line": 1}]
        variants.append(wrong)
        wrong = deepcopy(report); wrong["human_approval"] = True
        variants.append(wrong)
        wrong = deepcopy(report); wrong["rule_results"][-1]["status"] = "pass"
        wrong["reviewed_ranges"] = [{"start_line": 1, "end_line": 1}]; wrong["omissions"] = ["알려진 누락"]
        variants.append(wrong)
        before = self.protected()
        for value in variants:
            request = {**args, "request_id": uuid4().hex}
            with self.assertRaises(ResultError):
                self.results.generate_ontology(self.job_id, **request, submission=submission, diagnostics=value, save=False)
            retained = self.receipt(request["request_id"])["diagnostics"]
            self.assertEqual(retained["report"], value)
            self.assertEqual(retained["validation"], "not_validated")
            self.assertEqual(self.protected(), before)

    def test_uncertainty_remains_not_run_with_its_finding_instead_of_becoming_pass(self):
        bundle, args, submission = self.graph_input()
        report = report_v2(bundle, args, submission, self.job_id)
        report["findings"] = [{"rule_id": "R-S01", "verdict": "ambiguous", "source": None, "target": None,
            "reason": "원문만으로 경계 확정 불가", "recommendation": None, "question": "어느 모델인가?"}]
        report["rule_results"][0]["finding_indices"] = [0]
        result = self.results.generate_ontology(self.job_id, **args, submission=submission, diagnostics=report, save=False)
        self.assertEqual(result["diagnostics"]["semantic"]["rule_results"][0]["status"], "not_run")
        self.assertEqual(result["diagnostics"]["report"]["findings"], report["findings"])

    def separate_report(self, bundle, args, submission):
        report = report_v2(bundle, args, submission, self.job_id)
        report["reviewer_kind"] = "separate_ai"
        audit = "합성 원문 감사"
        execution = {"provider": "codex", "cli_version": "fixture", "prompt_sha256": "1" * 64,
                     "schema_sha256": "2" * 64, "output_sha256": "3" * 64}
        report["semantic_check"].update(source_audit=audit, source_audit_sha256=sha256(audit.encode()).hexdigest(),
            source_audit_execution=execution, assessment_execution=execution)
        report["reviewed_ranges"] = [{"start_line": 1, "end_line": 1}]
        report["rule_results"][0].update(status="pass", reason="합성 지지 보고")
        report["findings"] = [{"rule_id": "R-S02", "verdict": "schema_limit", "source": {
            "start_line": 1, "end_line": 1, "quote": "모델은 센서를 사용한다."}, "target": {
            "collection": "relations", "index": 0}, "reason": "합성 표현 한계", "recommendation": None, "question": None}]
        report["rule_results"][1]["finding_indices"] = [0]
        manifest = {"stage": "extract_ontology", "ruleset_ref": bundle["ruleset_ref"]}
        components = {"data/context.json": json.dumps({"documents": [{"document": "target.md",
            "source": {"content": self.store.read("target.md").content}}]}),
            "rules/diagnostics.schema.json": json.dumps(diagnostics.schema())}
        payload = {**args, "job_id": self.job_id, "submission": submission}
        return report, manifest, components, payload

    def test_claude_separate_diagnostics_use_existing_frozen_schema_without_rewriting_it(self):
        raw = canonical_json_bytes(diagnostics.legacy_schema())
        self.rules.release["components"]["diagnostics.schema.json"] = {
            "content": raw.decode(), "sha256": sha256(raw).hexdigest()}
        bundle, args, submission = self.graph_input()
        report, manifest, components, payload = self.separate_report(bundle, args, submission)
        report["rule_results"][1]["status"] = "fail"
        for key in ("source_audit_execution", "assessment_execution"):
            report["semantic_check"][key]["provider"] = "claude"
        before = self.protected()
        result = self.results.generate_ontology(self.job_id, **args, submission=submission,
            diagnostics=report, save=False)
        self.assertEqual(result["diagnostics"]["report"], report)
        self.assertEqual(result["diagnostics"]["validation"], "structure_and_source_checked")
        self.assertFalse(result["diagnostics"]["human_approval"])
        self.assertFalse(result["saved"])
        self.assertEqual(self.protected(), before)
        page = self.inputs.read(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            bundle_id=bundle["bundle_id"], bundle_revision=bundle["bundle_revision"],
            authorize=self.authorize, component="rules/diagnostics.schema.json")
        self.assertIsNone(page["next_offset"])
        self.assertEqual(page["content"].encode(), raw)
        self.assertEqual(self.rules.release["components"]["diagnostics.schema.json"]["content"].encode(), raw)
        self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["report"], report)

    def test_unknown_semantic_provider_is_rejected_without_rewriting_graph(self):
        bundle, args, submission = self.graph_input()
        report, manifest, components, payload = self.separate_report(bundle, args, submission)
        report["rule_results"][1]["status"] = "fail"
        report["semantic_check"]["assessment_execution"] = {
            **report["semantic_check"]["assessment_execution"], "provider": "unknown"}
        before = self.protected()
        with self.assertRaises(ResultError) as caught:
            self.results.generate_ontology(self.job_id, **args, submission=submission,
                diagnostics=report, save=False)
        self.assertEqual(caught.exception.code, "invalid_diagnostics")
        self.assertEqual(self.protected(), before)

    def test_partial_report_and_rejected_original_keep_separate_exact_receipts(self):
        bundle, args, submission = self.graph_input()
        report, manifest, components, payload = self.separate_report(bundle, args, submission)
        before = self.protected()
        with self.assertRaises(ResultError):
            self.results.generate_ontology(self.job_id, **args, submission=submission, diagnostics=report, save=False)
        original = self.receipt(args["request_id"])
        self.assertEqual(original["diagnostics"]["report"], report)
        self.assertEqual(original["diagnostics"]["validation"], "not_validated")
        partial, issues = diagnostics.partial_report(report, manifest, components, payload)
        self.assertEqual(partial["rule_results"][0], report["rule_results"][0])
        self.assertEqual(partial["rule_results"][1]["status"], "error")
        self.assertEqual(partial["findings"], report["findings"])
        self.assertEqual(issues[0]["rule_id"], "R-S02")
        request = {**args, "request_id": uuid4().hex, "expected_job_revision": self.current()["job_revision"]}
        draft = self.results.generate_ontology(self.job_id, **request, submission=submission, diagnostics=partial, save=False)
        self.assertEqual(draft["diagnostics"]["report"], partial)
        self.assertEqual(draft["diagnostics"]["report_id"], request["request_id"])
        self.assertNotEqual(draft["diagnostics"]["report_hash"], original["diagnostics"]["report_hash"])
        self.assertFalse(draft["diagnostics"]["human_approval"])
        self.assertFalse(draft["saved"])
        self.assertEqual(self.protected(), before)
        self.assertTrue(self.results.generate_ontology(self.job_id, **request, submission=submission,
            diagnostics=partial, save=False)["replayed"])
        self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["report"], report)

    def test_partial_report_never_repairs_global_binding_or_evidence(self):
        bundle, args, submission = self.graph_input()
        report, manifest, components, payload = self.separate_report(bundle, args, submission)
        for change in ("binding", "audit", "execution", "duplicate_rule", "range", "limit"):
            with self.subTest(change=change):
                value = deepcopy(report)
                if change == "binding":
                    value["semantic_check"]["input"]["submission_sha256"] = "0" * 64
                elif change == "audit":
                    value["semantic_check"]["source_audit"] = "바뀐 감사"
                elif change == "execution":
                    value["semantic_check"]["assessment_execution"] = None
                elif change == "duplicate_rule":
                    value["rule_results"][-1]["rule_id"] = "R-S01"
                elif change == "range":
                    value["reviewed_ranges"][0]["end_line"] = 99
                else:
                    value["warnings"] = ["w" * 2000] * 100
                    value["omissions"] = ["o" * 2000] * 100
                with self.assertRaises(ResultError):
                    diagnostics.partial_report(value, manifest, components, payload)
        # 잘못된 인용/대상은 제거한 파생 보고만 남고 원시 finding을 바꾸지 않는다.
        for field, wrong in (("source", {"start_line": 1, "end_line": 1, "quote": "없는 인용"}),
                             ("target", {"collection": "relations", "index": 99})):
            value = deepcopy(report)
            value["findings"][0][field] = wrong
            snapshot = deepcopy(value)
            partial, issues = diagnostics.partial_report(value, manifest, components, payload)
            self.assertEqual(partial["findings"], [])
            self.assertEqual(partial["rule_results"][1]["status"], "error")
            self.assertEqual(partial["rule_results"][0]["status"], "pass")
            self.assertEqual(value, snapshot)
            self.assertEqual(issues[0]["finding_index"], 0)

    def reclaim(self):
        stopped = self.jobs.update(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            expected_job_revision=self.current()["job_revision"], reported_status="stopped", authorize=self.authorize)
        claimed = self.jobs.claim(self.job_id, tenant="alpha", user_id="alice",
            expected_job_revision=stopped["job_revision"], reclaim=True, authorize=self.authorize)
        self.run_id = claimed["run_id"]
        return claimed

    def test_same_basis_saved_wiki_survives_reclaim_and_missing_graph_completes_once(self):
        saved, args = self.write()
        original_wiki = self.store.read("target.md")
        original_history = {p.name: p.read_bytes() for p in self.store.history_dir.rglob("*.md") if p.is_file()}
        self.reclaim()
        summary = self.current()["result_summary"]
        self.assertEqual((summary["status"], summary["saved_count"]), ("partial", 1))
        row = next(r for r in summary["results"] if r["request_id"] == args["request_id"])
        self.assertFalse(row["current_run"])
        self.assertTrue(row["current_scope"])
        bundle = self.prepare("extract_ontology", target_document="target.md")
        graph = self.results.generate_ontology(self.job_id, **self.arguments(bundle),
                                               submission=results_fixture.AnalysisResultTests.submission())
        self.assertEqual(graph["receipt"]["previous_result"]["request_id"], args["request_id"])
        self.assertEqual(self.current()["result_summary"]["status"], "complete")
        self.assertEqual(self.store.read("target.md"), original_wiki)
        self.assertEqual({p.name: p.read_bytes() for p in self.store.history_dir.rglob("*.md") if p.is_file()}, original_history)

    def test_same_basis_pending_receipt_still_blocks_after_reclaim(self):
        write_receipt = self.results._write_receipt
        def fail_final(path, value):
            if value["state"] == "complete":
                raise OSError("synthetic final receipt failure")
            write_receipt(path, value)
        with patch.object(self.results, "_write_receipt", fail_final):
            saved, args = self.write()
        self.assertTrue(saved["saved"])
        self.reclaim()
        summary = self.current()["result_summary"]
        self.assertEqual(summary["status"], "pending_reconcile")
        self.assertEqual(summary["saved_count"], 0)
        row = next(r for r in summary["results"] if r["request_id"] == args["request_id"])
        self.assertFalse(row["current_run"])
        self.assertTrue(row["current_scope"])


class RuleReleaseCompatibilityTests(unittest.TestCase):
    setUp = rules_fixture.ExtractionRulesTests.setUp
    publish = rules_fixture.ExtractionRulesTests.publish
    registry = rules_fixture.ExtractionRulesTests.registry

    def test_provider_compatibility_preserves_exact_legacy_schema_and_other_constraints(self):
        # 구현 전 발행 스키마 지문이다. 실행 제공자 외 변경을 구 규약으로 잘못 인정하지 않는다.
        hashes = {None: "b505f0f3a3b6c0584f92c9f72907e13b1e528c33a29c891a327e2e808be55694",
                  1: "4160fcae17f99c9a91e4ec0805183abf69a7c41a730199c840ff012b45d6ab5a",
                  2: "0af715638e2e302987d2beac63b523b27cb5068e81b61657d8e9032062fc1c38"}
        for version, digest in hashes.items():
            legacy = diagnostics.legacy_schema(version)
            before = canonical_json_bytes(legacy)
            self.assertEqual(sha256(before).hexdigest(), digest)
            compatible = diagnostics.validation_schema(legacy)
            self.assertEqual(compatible, diagnostics.schema(version))
            self.assertEqual(canonical_json_bytes(legacy), before)
            if version != 1:
                compatible["$defs"]["CheckExecution"]["properties"]["provider"] = {
                    "const": "codex", "title": "Provider", "type": "string"}
                self.assertEqual(compatible, legacy)
        changed = diagnostics.legacy_schema()
        changed["$defs"]["CheckExecution"]["properties"]["cli_version"]["maxLength"] = 99
        self.assertEqual(diagnostics.validation_schema(changed), changed)
        provider = diagnostics.validation_schema(changed)["$defs"]["CheckExecution"]["properties"]["provider"]
        self.assertFalse(Draft202012Validator(provider).is_valid("claude"))

    def test_old_codex_release_keeps_bytes_and_revision_when_new_release_adds_claude(self):
        with patch.object(content, "diagnostics_schema", diagnostics.legacy_schema):
            issued = self.publish()
        path = self.releases / "llm-wiki" / "1"
        before = {p.name: p.read_bytes() for p in path.iterdir()}
        registry = self.registry()
        policy_before = self.policy_file.read_bytes()
        old = registry.read("alpha")
        self.assertEqual(old["ruleset_revision"], issued["ruleset_revision"])
        self.assertEqual(old["components"]["diagnostics.schema.json"]["content"].encode(),
                         before["diagnostics.schema.json"])
        from core.modules.extraction_rules.publish import publish
        new = publish(self.releases, tenant_root=self.tenants, ruleset_id="llm-wiki", ruleset_version="2",
                      reason="격리 제공자 호환 검사", schema=self.schema, expected_schema=self.schema)
        updated = json.loads(new["components"]["diagnostics.schema.json"]["content"])
        self.assertEqual(updated["$defs"]["CheckExecution"]["properties"]["provider"]["enum"], ["codex", "claude"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})
        self.assertEqual(self.policy_file.read_bytes(), policy_before)
        self.assertEqual(registry.read("alpha")["ruleset_revision"], issued["ruleset_revision"])

    def test_old_v1_release_remains_byte_identical_and_new_release_advertises_v2(self):
        original = diagnostics.schema
        with patch.object(content, "diagnostics_schema", lambda: original(1)):
            # Publisher reads its own release: retain v1 helper's positional version support there.
            with patch("core.modules.extraction_rules.publish.read_release", return_value={"legacy": True}):
                self.publish()
        path = self.releases / "llm-wiki" / "1"
        before = {p.name: p.read_bytes() for p in path.iterdir()}
        self.registry().read("alpha")
        self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})
        from core.modules.extraction_rules.publish import publish
        release = publish(self.releases, tenant_root=self.tenants, ruleset_id="llm-wiki", ruleset_version="2",
                          reason="격리 v2 진단 규약", schema=self.schema, expected_schema=self.schema)
        self.assertIn("DiagnosticReportV2", release["components"]["diagnostics.schema.json"]["content"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})


if __name__ == "__main__":
    unittest.main()
