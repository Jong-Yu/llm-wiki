"""변환 누적·상한·중단이 기존 문자·위치·진단을 보존하는지 확인한다."""

from copy import deepcopy
from unittest import TestCase
from unittest.mock import patch

from core.client.source_conversion import empty_conversion as exported_empty
from core.client.source_conversion_formats import Conversion as ExportedConversion, OutputLimit as ExportedLimit
from core.client.source_conversion_report import Conversion, OutputLimit, empty_conversion, interrupt_conversion


class ConversionReportTests(TestCase):
    def test_old_imports_and_empty_failure_contract_are_preserved(self):
        self.assertIs(ExportedConversion, Conversion)
        self.assertIs(ExportedLimit, OutputLimit)
        self.assertIs(exported_empty, empty_conversion)
        self.assertEqual(empty_conversion("pdf", "worker_failed"), {
            "format": "pdf", "method": None, "units": [], "complete": False,
            "unread_ranges": ["whole source: worker_failed"], "warnings": [],
            "diagnostics": [{"code": "worker_failed"}], "unit_methods": {}, "state": "failed",
            "origin": "client_reported", "coverage": "reported_units_only",
            "original_coverage": "not_verified", "semantic_validation": "not_run"})

    def test_checkpoint_records_unit_order_locations_and_completion(self):
        checkpoints = []
        conversion = Conversion("docx", lambda value: checkpoints.append(deepcopy(value)))
        first = {"kind": "paragraphs", "start": 1, "end": 1}
        second = {"kind": "table_cells", "table": 1, "row": 2, "column": 3}
        conversion.add("paragraph-1", first, "한글", "docx_text")
        conversion.add("table-1-2-3", second, "value", "docx_text")
        value = conversion.finish()
        self.assertEqual([item["state"] for item in checkpoints[:3]], ["running"] * 3)
        self.assertEqual([len(item["units"]) for item in checkpoints[:3]], [0, 1, 2])
        self.assertEqual([item["location"] for item in value["units"]], [first, second])
        self.assertEqual((value["state"], value["complete"]), ("complete", True))
        self.assertIn("paragraph-1,table-1-2-3: unit_method=docx_text", value["warnings"])
        self.assertEqual(checkpoints[-1], value)

    def test_utf8_output_limit_keeps_prior_unit_and_reports_remaining_source(self):
        with patch("core.client.source_conversion_report.MAX_TEXT", 4):
            conversion = Conversion("txt")
            conversion.add("first", {"kind": "whole"}, "가", "verbatim")
            with self.assertRaises(OutputLimit):
                conversion.add("second", {"kind": "whole"}, "나", "verbatim")
            value = conversion.finish()
        self.assertEqual([item["content"] for item in value["units"]], ["가"])
        self.assertEqual((value["state"], value["complete"]), ("partial", False))
        self.assertIn("remaining source: conversion_output_limit", value["unread_ranges"])

    def test_unit_limit_does_not_add_a_half_record(self):
        with patch("core.client.source_conversion_report.MAX_UNITS", 1):
            conversion = Conversion("txt")
            conversion.add("first", {"kind": "whole"}, "", "verbatim")
            with self.assertRaises(OutputLimit):
                conversion.add("second", {"kind": "whole"}, "", "verbatim")
        self.assertEqual(conversion.result["unit_methods"], {"first": "verbatim"})
        self.assertEqual(len(conversion.result["units"]), 1)

    def test_report_caps_keep_explicit_unread_marker_and_local_ocr_history(self):
        conversion = Conversion("png")
        for index in range(105):
            conversion.ocr_note("frame 1", f"read_failure_{index}", unread=True)
        value = conversion.finish()
        self.assertEqual(len(value["unread_ranges"]), 100)
        self.assertEqual(len(value["diagnostics"]), 100)
        self.assertIn("additional diagnostics exceed", value["unread_ranges"][-1])
        self.assertEqual(len(value["ocr_processing"]["frame 1"]), 105)
        self.assertEqual((value["state"], value["complete"]), ("failed", False))

    def test_worker_interrupt_preserves_units_execution_and_caps_tail_diagnostics(self):
        for code, expected in (("conversion_timeout", "partial"), ("conversion_cancelled", "cancelled"),
                               ("worker_failed", "partial")):
            with self.subTest(code=code):
                conversion = Conversion("pdf")
                conversion.add("page-1", {"kind": "pages", "start": 1, "end": 1}, "retained", "ocr")
                value = conversion.finish()
                value.update(execution={"converter": "existing"}, diagnostics=[{"code": str(i)} for i in range(100)],
                             unread_ranges=[str(i) for i in range(100)])
                original = deepcopy(value)
                self.assertIs(interrupt_conversion(value, code), value)
                self.assertEqual((value["state"], value["complete"]), (expected, False))
                for field in ("units", "unit_methods", "execution", "method", "warnings"):
                    self.assertEqual(value[field], original[field])
                self.assertEqual(value["unread_ranges"], original["unread_ranges"][:99] + ["remaining source: " + code])
                self.assertEqual(value["diagnostics"][-1], {"code": code, "scope": "remaining source", "unread": True})

    def test_parent_cancel_marks_remaining_scope_without_inventing_worker_diagnostic(self):
        value = empty_conversion("docx", "worker_failed")
        before = deepcopy(value["diagnostics"])
        interrupt_conversion(value, "conversion_cancelled", diagnostic=False)
        self.assertEqual((value["state"], value["complete"]), ("cancelled", False))
        self.assertEqual(value["diagnostics"], before)
        self.assertEqual(value["unread_ranges"], ["whole source: worker_failed", "remaining source: conversion_cancelled"])

    def test_worker_failure_before_any_units_is_failed(self):
        value = Conversion("pdf").result
        interrupt_conversion(value, "worker_failed")
        self.assertEqual((value["state"], value["complete"]), ("failed", False))
