"""합성 어댑터로 원문 우선 입력 분리·실패/취소 보고를 확인한다. 실제 모델 평가는 아니다."""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.client.semantic_check import run_semantic_check, assessment_schema
from core.client.ai.codex import _strict_schema
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results import diagnostics
from core.modules.analysis_results.contracts import ResultError
from core.runtime.extraction_schema import build_submission_schema
from core.tests.modules import test_analysis_results as fixture
from jsonschema import Draft202012Validator


class FakeAdapter:
    def __init__(self, failure=None, assessment=None):
        self.calls = []
        self.failure = failure
        self.assessment = assessment

    async def run(self, *, prompt, schema, directory):
        self.calls.append({"prompt": prompt, "schema": schema, "directory": directory})
        if len(self.calls) == 2 and self.failure:
            raise self.failure
        if len(self.calls) == 1:
            value = {"audit": "첫 줄의 uses 관계를 확인한다. 합성 원문 감사 질문."}
        else:
            value = {key: value for key, value in diagnostics.empty_report().items()
                     if key not in {"schema_version", "reviewer_kind", "findings"}}
            value.update(reviewed_ranges=[{"start_line": 1, "end_line": 1}], rule_results={
                rule: {"status": "pass", "reason": "합성 실행기의 구조 시험", "findings": []}
                for rule in diagnostics.SEMANTIC_RULES})
            if self.assessment is not None:
                value = deepcopy(self.assessment)
        return {"value": value, "execution": {"provider": "codex", "cli_version": "fixture",
            "prompt_sha256": sha256(prompt.encode()).hexdigest(), "schema_sha256": sha256(canonical_json_bytes(schema)).hexdigest(),
            "output_sha256": sha256(canonical_json_bytes(value)).hexdigest()}}


class SemanticCheckTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="llm-wiki-semantic-check-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = "모델은 센서를 사용한다.\n"
        revision = sha256(self.source.encode()).hexdigest()
        self.submission = fixture.AnalysisResultTests.submission()
        self.submission["relation_candidates"] = [{"id": "guess", "subject": "model", "predicate": "observes",
            "object": "sensor", "evidence": None, "qualifiers": {"polarity": "positive", "modality": "asserted",
                "condition": None, "scope": None, "time": None}, "reason": "SECRET_GENERATOR_REASON", "question": "SECRET_GENERATOR_QUESTION"}]
        self.fixed = {"bundle_revision": "b" * 64}
        self.captured = {"manifest": {"stage": "extract_ontology", "target_document": "target.md",
            "job_id": "1" * 32, "run_id": "2" * 32, "bundle_id": "3" * 32,
            "ruleset_ref": {"ruleset_id": "fixture", "ruleset_version": "1", "ruleset_revision": "a" * 64},
            "dependency": {"documents": [{"document": "target.md", "source_revision": revision}]}},
            "components": {"data/context.json": json.dumps({"documents": [{"document": "target.md", "source": {"content": self.source}}]}),
                "rules/submission.schema.json": json.dumps(build_submission_schema()),
                "rules/diagnostics.schema.json": json.dumps(diagnostics.schema()),
                "rules/ontology.md": "SECRET_EXTRACTION_PROMPT", "data/generator-comments": "SECRET_SELF_REVIEW"}}

    async def run_check(self, adapter, name="result"):
        with patch("core.client.semantic_check.load_input", return_value=deepcopy(self.captured)):
            return await run_semantic_check(fixed_input=self.fixed, directory=self.root,
                target_document="target.md", submission=self.submission, adapter=adapter, output_directory=self.root / name)

    async def test_two_new_sessions_hide_generator_commentary_and_bind_exact_hashes(self):
        adapter = FakeAdapter()
        report = await self.run_check(adapter)
        self.assertEqual(len(adapter.calls), 2)
        self.assertNotEqual(adapter.calls[0]["directory"], adapter.calls[1]["directory"])
        self.assertNotIn('"submission":', adapter.calls[0]["prompt"])
        self.assertIn('"submission":', adapter.calls[1]["prompt"])
        for call in adapter.calls:
            self.assertNotIn("SECRET_", call["prompt"])
        self.assertEqual(report["reviewer_kind"], "separate_ai")
        self.assertEqual(report["rule_results"][0]["status"], "pass")
        self.assertEqual(report["semantic_check"]["input"]["bundle_revision"], self.fixed["bundle_revision"])
        self.assertEqual(json.loads((self.root / "result/diagnostics.json").read_text()), report)
        with self.assertRaises(FileExistsError):
            await self.run_check(FakeAdapter())
        self.assertEqual(json.loads((self.root / "result/diagnostics.json").read_text()), report)

    async def test_execution_failure_preserves_audit_and_error_report(self):
        report = await self.run_check(FakeAdapter(AnalysisClientError("ai_timeout")))
        self.assertEqual({r["status"] for r in report["rule_results"]}, {"error"})
        self.assertIsNotNone(report["semantic_check"]["source_audit"])
        self.assertIsNone(report["semantic_check"]["assessment_execution"])
        self.assertTrue((self.root / "result/source-audit.json").is_file())
        self.assertTrue((self.root / "result/failure.json").is_file())
        self.assertIsNone(json.loads((self.root / "result/failure.json").read_text())["raw_assessment"])

    async def test_cancel_preserves_not_run_report_and_propagates(self):
        with self.assertRaises(asyncio.CancelledError):
            await self.run_check(FakeAdapter(asyncio.CancelledError()))
        report = json.loads((self.root / "result/diagnostics.json").read_text())
        self.assertEqual({r["status"] for r in report["rule_results"]}, {"not_run"})
        self.assertEqual(report["warnings"], ["semantic_check_cancelled"])

    async def test_old_ruleset_and_changed_source_fail_before_any_model_call(self):
        adapter = FakeAdapter()
        self.captured["components"]["rules/diagnostics.schema.json"] = json.dumps(diagnostics.schema(1))
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_check(adapter)
        self.assertEqual(caught.exception.code, "semantic_check_ruleset_required")
        self.captured["components"]["data/context.json"] = json.dumps({"documents": [{"document": "target.md", "source": {"content": "changed"}}]})
        with self.assertRaises(AnalysisClientError):
            await self.run_check(adapter)
        self.assertEqual(adapter.calls, [])
        self.assertFalse((self.root / "result").exists())

    async def test_schema_limit_is_failure_and_ambiguous_stays_unresolved(self):
        adapter = FakeAdapter()
        await adapter.run(prompt="", schema={}, directory=self.root)
        value = (await adapter.run(prompt="", schema={}, directory=self.root))["value"]
        limit = {"verdict": "schema_limit", "source": {"start_line": 1, "end_line": 1,
            "quote": "모델은 센서를 사용한다."}, "target": {"collection": "relations", "index": 0},
            "reason": "합성 표현 한계", "recommendation": None, "question": None}
        value["rule_results"]["R-S02"].update(status="fail", findings=[limit])
        unclear = {**limit, "verdict": "ambiguous", "source": None, "target": None}
        value["rule_results"]["R-S05"].update(status="not_run", findings=[unclear])
        report = await self.run_check(FakeAdapter(assessment=value))
        self.assertEqual(report["rule_results"][1]["status"], "fail")
        self.assertEqual(report["rule_results"][4]["status"], "not_run")
        self.assertEqual(report["findings"][0], {**limit, "rule_id": "R-S02"})
        self.assertEqual(report["findings"][1], {**unclear, "rule_id": "R-S05"})
        self.assertEqual(report["rule_results"][4]["finding_indices"], [1])
        self.assertFalse((self.root / "result/failure.json").exists())

    async def test_invalid_quote_keeps_other_rules_and_raw_report_without_repair(self):
        adapter = FakeAdapter()
        await adapter.run(prompt="", schema={}, directory=self.root)
        value = (await adapter.run(prompt="", schema={}, directory=self.root))["value"]
        valid = {"verdict": "schema_limit", "source": {"start_line": 1, "end_line": 1,
            "quote": "모델은 센서를 사용한다."}, "target": {"collection": "relations", "index": 0},
            "reason": "합성 표현 한계", "recommendation": None, "question": None}
        invalid = {**valid, "source": {**valid["source"], "quote": "없는 원문"}}
        value["rule_results"]["R-S02"].update(status="fail", findings=[invalid])
        value["rule_results"]["R-S05"].update(status="fail", findings=[valid])
        report = await self.run_check(FakeAdapter(assessment=value))
        self.assertEqual(report["rule_results"][1]["status"], "error")
        self.assertEqual(report["rule_results"][4]["status"], "fail")
        self.assertEqual(report["rule_results"][4]["finding_indices"], [0])
        self.assertEqual(report["findings"], [{**valid, "rule_id": "R-S05"}])
        self.assertEqual(json.loads((self.root / "result/assessment.json").read_text()), value)
        raw = json.loads((self.root / "result/assessed-diagnostics.json").read_text())
        self.assertEqual(raw["findings"][0]["source"]["quote"], "없는 원문")
        self.assertEqual(raw["rule_results"][1]["status"], "fail")
        self.assertIsNotNone(report["semantic_check"]["assessment_execution"])
        failure = json.loads((self.root / "result/failure.json").read_text())
        self.assertEqual(failure["preservation"], "validated_partial_report")
        self.assertEqual(failure["raw_assessment"], "assessment.json")

    async def test_malformed_structure_keeps_raw_and_fails_without_model_retry(self):
        value = {"not": "a report"}
        adapter = FakeAdapter(assessment=value)
        report = await self.run_check(adapter)
        self.assertEqual({row["status"] for row in report["rule_results"]}, {"error"})
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(json.loads((self.root / "result/assessment.json").read_text()), value)
        self.assertIsNotNone(report["semantic_check"]["assessment_execution"])


class AssessmentSchemaTests(unittest.TestCase):
    def test_public_rfc_failure_keeps_seven_valid_rules_and_all_original_findings(self):
        # 공개 실패 출력은 개발 회귀 자료다. 원시 판정/정답/기존 평가 파일은 고치지 않는다.
        root = Path(__file__).resolve().parents[3] / "evals/rfc9111_stale_20261026"
        source = (root / "source.txt").read_text()
        raw_path = root / "generator/separate-check/assessment.json"
        raw_bytes = raw_path.read_bytes()
        raw = json.loads(raw_bytes)
        fallback = json.loads((root / "generator/separate-check/diagnostics.json").read_text())
        report = {**fallback, **raw}
        check = report["semantic_check"]
        submission = json.loads((root / "generator/extraction-execution/result.json").read_text())["submission"]
        basis = check["input"]
        manifest = {"stage": "extract_ontology", "ruleset_ref": basis["ruleset_ref"]}
        components = {"data/context.json": json.dumps({"documents": [{"document": basis["document"],
            "source": {"content": source}}]}), "rules/diagnostics.schema.json": json.dumps(diagnostics.schema())}
        payload = {key: basis[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "document")}
        payload.update(submission=submission, expected_revision=basis["source_revision"])
        self.assertEqual(sha256(source.encode()).hexdigest(), basis["source_revision"])
        with self.assertRaises(ResultError) as error:
            diagnostics.validate(report, manifest, components, payload)
        self.assertEqual(error.exception.code, "invalid_diagnostics")
        preserved, issues = diagnostics.partial_report(report, manifest, components, payload)
        self.assertEqual({row["rule_id"] for row in issues}, {"R-S02", "R-S05", "R-S10"})
        for row, original in zip(preserved["rule_results"], raw["rule_results"]):
            if row["rule_id"] in {"R-S02", "R-S05", "R-S10"}:
                self.assertEqual(row["status"], "error")
            else:
                self.assertEqual(row, original)
        self.assertEqual(preserved["findings"], raw["findings"])
        self.assertEqual(report, {**fallback, **raw})
        self.assertEqual(raw_path.read_bytes(), raw_bytes)
        # 동일 원시 내용을 중첩 출력 모양으로만 옮겨도 새 구조 스키마는 세 조합을 거부한다.
        nested = {key: deepcopy(raw[key]) for key in ("warnings", "omissions", "unread_ranges", "reviewed_ranges")}
        nested["rule_results"] = {row["rule_id"]: {"status": row["status"], "reason": row["reason"],
            "findings": [{key: value for key, value in finding.items() if key != "rule_id"}
                         for finding in raw["findings"] if finding["rule_id"] == row["rule_id"]]}
            for row in raw["rule_results"]}
        contract = assessment_schema()
        errors = list(Draft202012Validator(contract).iter_errors(nested))
        self.assertEqual({list(error.path)[1] for error in errors}, {"R-S02", "R-S05", "R-S10"})

    def test_status_verdict_combinations_and_complete_rule_keys(self):
        contract = assessment_schema()
        Draft202012Validator.check_schema(contract)
        strict = _strict_schema(contract)
        value = {"warnings": [], "omissions": [], "unread_ranges": [], "reviewed_ranges": [],
                 "rule_results": {rule: {"status": "not_run", "reason": "미검사", "findings": []}
                                  for rule in diagnostics.SEMANTIC_RULES}}
        finding = {"verdict": "schema_limit", "source": {"start_line": 1, "end_line": 1, "quote": "원문"},
                   "target": None, "reason": "손실", "recommendation": None, "question": None}
        allowed = {"pass": {"supported"}, "fail": diagnostics.PROBLEM_VERDICTS,
                   "not_run": diagnostics.UNRESOLVED_VERDICTS, "not_applicable": set(),
                   "error": set(diagnostics.Finding.model_fields["verdict"].annotation.__args__)}
        for status, verdicts in allowed.items():
            for verdict in allowed["error"]:
                with self.subTest(status=status, verdict=verdict):
                    value["rule_results"]["R-S02"].update(status=status, findings=[{**finding, "verdict": verdict}])
                    for schema in (contract, strict):
                        self.assertEqual(Draft202012Validator(schema).is_valid(value), verdict in verdicts)
        value["rule_results"]["R-S02"].update(status="fail", findings=[])
        self.assertFalse(Draft202012Validator(contract).is_valid(value))
        value["rule_results"]["R-S02"].update(status="not_applicable")
        self.assertTrue(Draft202012Validator(contract).is_valid(value))
        del value["rule_results"]["R-S10"]
        self.assertFalse(Draft202012Validator(contract).is_valid(value))


if __name__ == "__main__":
    unittest.main()
