"""진단의 원문 바인딩·별도 보존·미독 차단을 실제 임시 저장소에서 확인한다."""

from copy import deepcopy
import unittest
from uuid import uuid4
from unittest.mock import patch

from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.modules import test_analysis_results as fixture


class AnalysisDiagnosticsTests(unittest.TestCase):
    setUp = fixture.AnalysisResultTests.setUp
    authorize = fixture.AnalysisResultTests.authorize
    current = fixture.AnalysisResultTests.current
    prepare = fixture.AnalysisResultTests.prepare
    protected = fixture.AnalysisResultTests.protected
    wiki_bundle = fixture.AnalysisResultTests.wiki_bundle
    arguments = fixture.AnalysisResultTests.arguments
    write = fixture.AnalysisResultTests.write
    receipt = fixture.AnalysisResultTests.receipt

    def test_graph_findings_are_preserved_without_becoming_claims_or_human_approval(self):
        self.write()
        bundle = self.prepare("extract_ontology", target_document="target.md")
        args = self.arguments(bundle)
        report = {**empty_report(), "reviewer_kind": "ai_self_check", "omissions": ["별도 수량 모델이 필요함"],
                  "reviewed_ranges": [{"start_line": 1, "end_line": 1}], "findings": [{
                      "rule_id": "R-S10", "verdict": "schema_limit",
                      "source": {"start_line": 1, "end_line": 1, "quote": "모델은 센서를 사용한다."},
                      "target": None, "reason": "합성 진단의 보존 확인", "recommendation": None, "question": "수량 근거가 있는가?"}]}
        result = self.results.generate_ontology(self.job_id, **args,
            submission=fixture.AnalysisResultTests.submission(), diagnostics=report)
        self.assertTrue(result["saved"])
        self.assertFalse(result["diagnostics"]["human_approval"])
        self.assertEqual(result["diagnostics"]["report"], report)
        self.assertEqual(result["diagnostics"]["basis"]["source_revision"], args["expected_revision"])
        self.assertEqual(result["receipt"]["analysis_basis_revision"], bundle["analysis_basis_revision"])
        self.assertEqual(ReviewStore(self.store).query("target.md")["history"], [])
        self.assertEqual(len(OntologyStore(self.store).query("target.md")["relations"]), 1)
        # 최종 응답 영수증을 잃어도 독립 성공 증거에서 진단과 검사 기준을 복원한다.
        path = self.jobs.jobs_dir / self.job_id / "results" / args["request_id"] / "receipt.json"
        path.unlink()
        self.assertEqual(self.receipt(args["request_id"])["diagnostics"], result["diagnostics"])
        self.jobs.cancel(self.job_id, tenant="alpha", user_id="alice",
            expected_job_revision=self.current()["job_revision"], reason="시험 종료", authorize=self.authorize)
        self.rules.allowed = False
        self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["report"], report)

    def test_incomplete_wiki_draft_replay_and_rejection_preserve_existing_content(self):
        args = self.arguments(self.wiki_bundle())
        report = {**empty_report(), "warnings": ["인식 오류 가능"], "omissions": ["미해석 표"], "unread_ranges": ["2행"]}
        before = self.protected()
        draft = self.results.write_wiki(self.job_id, **args, content="부분 초안", diagnostics=report, save=False)
        self.assertEqual((draft["state"], draft["saved"]), ("draft", False))
        self.assertEqual(self.protected(), before)
        self.assertEqual(self.current()["result_summary"]["status"], "draft")
        replay = self.results.write_wiki(self.job_id, **args, content="부분 초안", diagnostics=report, save=False)
        self.assertTrue(replay["replayed"])
        with self.assertRaises(ResultError) as conflict:
            self.results.write_wiki(self.job_id, **args, content="다른 초안", diagnostics=report, save=False)
        self.assertEqual(conflict.exception.code, "request_conflict")
        rejected = {**args, "request_id": uuid4().hex}
        with self.assertRaises(ResultError) as caught:
            self.results.write_wiki(self.job_id, **rejected, content="부분 초안", diagnostics=report)
        self.assertEqual(caught.exception.code, "diagnostic_input_incomplete")
        self.assertEqual(self.receipt(rejected["request_id"])["diagnostics"]["report"], report)
        self.assertEqual(self.protected(), before)
        self.assertNotEqual(self.current()["result_summary"]["status"], "complete")

    def test_fabricated_quotes_targets_and_approval_fields_are_rejected_and_retained(self):
        self.write()
        bundle = self.prepare("extract_ontology", target_document="target.md")
        report = {**empty_report(), "reviewer_kind": "separate_ai", "findings": [{
            "rule_id": "R-S02", "verdict": "supported", "source": {"start_line": 1, "end_line": 1, "quote": "없는 인용"},
            "target": {"collection": "relations", "index": 0}, "reason": "합성 입력", "recommendation": None, "question": None}]}
        variants = [report, {**empty_report(), "human_approval": True},
                    {**empty_report(), "schema_version": True}, {**empty_report(), "schema_version": 1.0}]
        invalid_target = deepcopy(report)
        invalid_target["findings"][0]["source"]["quote"] = "모델은 센서를 사용한다."
        invalid_target["findings"][0]["target"]["index"] = 99
        variants.append(invalid_target)
        before = self.protected()
        for value in variants:
            args = self.arguments(bundle)
            with self.assertRaises(ResultError) as rejected:
                self.results.generate_ontology(self.job_id, **args,
                    submission=fixture.AnalysisResultTests.submission(), diagnostics=value)
            self.assertEqual(rejected.exception.code, "invalid_diagnostics")
            self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["validation"], "not_validated")
            self.assertEqual(self.protected(), before)

        # 입력 파일 부재의 확인 대기나 잘못된 입력 판본의 거부도 작업/진단 조회를 막지 않는다.
        for overrides, state in (({"bundle_id": uuid4().hex}, "pending_reconcile"),
                                 ({"bundle_revision": "0" * 64}, "rejected")):
            args = {**self.arguments(bundle), **overrides}
            def submit():
                return self.results.generate_ontology(self.job_id, **args,
                    submission=fixture.AnalysisResultTests.submission(), diagnostics=empty_report())
            if state == "rejected":
                with self.assertRaises(ResultError):
                    submit()
            else:
                self.assertEqual(submit()["state"], state)
            self.assertEqual(self.receipt(args["request_id"])["diagnostics"]["report"], empty_report())
            row = next(item for item in self.current()["result_summary"]["results"]
                       if item["request_id"] == args["request_id"])
            self.assertIsNone(row["basis_current"])
            self.assertEqual(self.protected(), before)

    def test_old_pending_receipt_remains_visible_without_blocking_rebased_completion(self):
        original = self.results._write_receipt

        def lose_completion(path, value):
            if value["state"] == "complete":
                raise OSError("isolated receipt failure")
            original(path, value)

        with patch.object(self.results, "_write_receipt", lose_completion):
            old, old_args = self.write()
        self.assertEqual(old["state"], "pending_reconcile")
        self.prepare(rebase=True, rebase_reason="실제 저장 상태 확인 후 새 기준")
        self.extraction_id = None
        self.write()
        bundle = self.prepare("extract_ontology", target_document="target.md")
        self.results.generate_ontology(self.job_id, **self.arguments(bundle),
                                       submission=fixture.AnalysisResultTests.submission())
        current = self.current()["result_summary"]
        self.assertEqual(current["status"], "complete")
        old_row = next(row for row in current["results"] if row["request_id"] == old_args["request_id"])
        self.assertEqual(old_row["state"], "pending_reconcile")
        self.assertFalse(old_row["current_scope"])


if __name__ == "__main__":
    unittest.main()
