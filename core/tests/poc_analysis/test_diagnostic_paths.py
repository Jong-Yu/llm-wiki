"""Exact diagnostic paths describe existing rejections without mutating evidence."""
from copy import deepcopy
import json
import unittest

from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_results.diagnostics import empty_report, validate


class DiagnosticPathTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"stage": "extract_ontology"}
        self.components = {"data/context.json": json.dumps({"documents": [{
            "document": "pump.md", "source": {"content": "First.\nSecond.\n"}}]})}
        self.payload = {"document": "pump.md", "submission": {"entities": [{"id": "pump"}]}}
        self.report = empty_report()
        self.report.update(reviewer_kind="ai_self_check", findings=[{
            "rule_id": "R-S01", "verdict": "supported",
            "source": {"start_line": 2, "end_line": 2, "quote": "Second."},
            "target": {"collection": "entities", "index": 0},
            "reason": "Literal source evidence.", "recommendation": None, "question": None}])

    def check(self, code, path):
        before = deepcopy((self.report, self.manifest, self.components, self.payload))
        with self.assertRaises(ResultError) as caught:
            validate(self.report, self.manifest, self.components, self.payload)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.details["diagnostic_path"], path)
        reason = caught.exception.details["reason"]
        self.assertTrue(reason)
        self.assertNotIn("Second.", reason)
        self.assertEqual((self.report, self.manifest, self.components, self.payload), before)

    def rules(self):
        self.report.update(schema_version=2, semantic_check=None,
            reviewed_ranges=[{"start_line": 1, "end_line": 2}],
            rule_results=[{"rule_id": f"R-S{index:02d}", "status": "not_run",
                "reason": "Not checked.", "finding_indices": []} for index in range(1, 11)])

    def test_valid_report_remains_accepted_and_unchanged(self):
        before = deepcopy(self.report)
        validate(self.report, self.manifest, self.components, self.payload)
        self.assertEqual(self.report, before)

    def test_missing_quote_identifies_finding_source(self):
        self.report["findings"][0]["source"] = None
        self.check("diagnostic_evidence_required", "/diagnostics/findings/0/source")

    def test_inexact_quote_coordinates_identify_finding_source(self):
        self.report["findings"][0]["source"].update(start_line=1, end_line=1)
        self.check("invalid_diagnostics", "/diagnostics/findings/0/source")

    def test_reviewed_range_identifies_out_of_bounds_end(self):
        self.report["reviewed_ranges"] = [{"start_line": 1, "end_line": 3}]
        self.check("invalid_diagnostics", "/diagnostics/reviewed_ranges/0/end_line")

    def test_target_identifies_exact_finding(self):
        self.report["findings"][0]["target"]["index"] = 1
        self.check("invalid_diagnostics", "/diagnostics/findings/0/target")

    def test_rule_status_identifies_exact_rule(self):
        self.rules()
        self.check("invalid_diagnostics", "/diagnostics/rule_results/0/status")

    def test_failed_rule_requires_linked_problem_finding(self):
        self.rules()
        self.report["rule_results"][0]["status"] = "fail"
        self.check("diagnostic_evidence_required", "/diagnostics/rule_results/0/finding_indices")

    def test_link_identifies_exact_index_position(self):
        self.rules()
        self.report["rule_results"][0]["finding_indices"] = [2]
        self.check("invalid_diagnostics", "/diagnostics/rule_results/0/finding_indices/0")


if __name__ == "__main__":
    unittest.main()
