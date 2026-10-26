"""고정 참조 선택: 공개 실패 원본과 합성 근거로만 검사하며 모델은 호출하지 않는다."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator

from core.client.ai.codex import _strict_schema
from core.client.question_ai import ANSWER_SCHEMA, answer_payload, assemble_question, question_answer_schema
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_hash
from core.modules.personal.question_runs import (
    INPUT_CONTRACT_VERSION, INPUT_INSTRUCTIONS, OUTPUT_CONTRACT, QuestionRunStore, _citation_references,
)


def frozen(basis):
    handoff = {"question_run_id": "1" * 32, "question": "조건은?", "basis": basis,
        "contract_version": INPUT_CONTRACT_VERSION, "instructions": INPUT_INSTRUCTIONS,
        "output": {**deepcopy(OUTPUT_CONTRACT), "citation_references": _citation_references(basis)}}
    handoff["input_sha256"] = canonical_json_hash(handoff)
    record = {"id": handoff["question_run_id"], "data": {"question": handoff["question"], "basis": basis,
        "input_contract_version": handoff["contract_version"], "input_instructions": handoff["instructions"],
        "output_contract": deepcopy(handoff["output"])}}
    return handoff, record


def basis():
    return {"documents": [{"document": "Rule.md", "source_revision": "a" * 64, "content": "조건이 참일 때 허용한다.",
        "knowledge": {"graph_revision": "b" * 64, "state_revision": "c" * 64, "source_revision": "a" * 64,
            "claims": [{"claim_id": "d" * 64, "value": {"evidence": {"quote": "조건이 참일 때"}}, "decision": "unreviewed"},
                {"claim_id": "e" * 64, "value": {"evidence": None}, "decision": "unreviewed"}],
            "policies": [{"status": "active", "event_id": "1" * 32, "decision_event_id": "2" * 32, "scope": "fixture"},
                {"status": "inactive", "event_id": "3" * 32, "scope": "fixture"}],
            "history": [{"id": "1" * 32, "action": "policy", "reason": "합성 판단"},
                {"id": "2" * 32, "action": "policy_undo", "reason": "합성 복구"},
                {"id": "3" * 32, "action": "policy", "reason": "비활성"}]}}],
        "originals": [{"source_ref": {"source_id": "4" * 32, "source_version": "5" * 32, "source_sha256": "f" * 64},
            "content": "등록 원본의 조건"}]}


class QuestionCitationTests(unittest.TestCase):
    def assert_contract(self, handoff, answer, valid):
        for schema in (question_answer_schema(handoff), _strict_schema(question_answer_schema(handoff))):
            Draft202012Validator.check_schema(schema)
            self.assertEqual(Draft202012Validator(schema).is_valid(answer), valid, answer)

    def test_public_document_only_failure_is_reproduced_without_rewriting_output(self):
        root = Path(__file__).resolve().parents[3] / "evals/rfc9111_stale_20261026"
        old = json.loads((root / "question-execution/input.json").read_text())
        raw = (root / "review-answer.json").read_bytes()
        answer = json.loads(raw)
        self.assertEqual(old["basis"]["originals"], [])
        self.assertTrue(Draft202012Validator(ANSWER_SCHEMA).is_valid(answer))
        with self.assertRaises(ValueError):
            QuestionRunStore._validate_citations(old["basis"], answer["citations"])
        handoff, _ = frozen(old["basis"])
        self.assert_contract(handoff, answer, False)
        self.assertNotIn("source", {r["kind"] for r in handoff["output"]["citation_references"]})
        self.assertEqual((root / "review-answer.json").read_bytes(), raw)

    def test_mixed_references_accept_only_whole_tuples_and_real_policy_events(self):
        data = basis()
        second = deepcopy(data["documents"][0])
        second.update(document="Other.md", source_revision="9" * 64)
        second["knowledge"]["claims"] = []
        second["knowledge"]["policies"] = []
        data["documents"].append(second)
        handoff, _ = frozen(data)
        refs = handoff["output"]["citation_references"]
        self.assertEqual({r["kind"] for r in refs}, {"document", "source", "claim", "policy"})
        self.assertEqual([r["event_id"] for r in refs if r["kind"] == "policy"], ["1" * 32, "2" * 32])
        self.assertEqual(len([r for r in refs if r["kind"] == "claim"]), 1)
        citations = []
        for ref in refs:
            citation = dict(ref)
            if ref["kind"] == "document":
                citation["quote"] = data["documents"][0]["content"]
            elif ref["kind"] == "source":
                citation["quote"] = data["originals"][0]["content"]
            citations.append(citation)
        self.assert_contract(handoff, {"content": "합성 답변", "citations": citations}, True)
        self.assertEqual(len(QuestionRunStore._validate_citations(data, citations)), len(citations))
        invalid = [
            {**citations[0], "document": "Missing.md"},
            {**citations[0], "source_revision": "9" * 64},
            {**citations[0], "kind": "source"},
            {**next(c for c in citations if c["kind"] == "source"), "source_version": "6" * 32},
            {**next(c for c in citations if c["kind"] == "claim"), "claim_id": "e" * 64},
            {**next(c for c in citations if c["kind"] == "claim"), "quote": "허용한다."},
            {**next(c for c in citations if c["kind"] == "policy"), "event_id": "3" * 32},
        ]
        for citation in invalid:
            with self.subTest(citation=citation):
                self.assert_contract(handoff, {"content": "합성 답변", "citations": [citation]}, False)

    def test_source_only_conversion_keeps_registered_ids_and_reported_provenance(self):
        data = basis()
        data["documents"] = []
        original = data["originals"][0]
        original["conversion"] = {"conversion_ref": {"conversion_id": "6" * 32, "conversion_revision": "7" * 64},
            "manifest": {"method": "ocr", "coverage": "reported_units_only", "original_coverage": "not_verified"}}
        handoff, _ = frozen(data)
        refs = handoff["output"]["citation_references"]
        self.assertEqual(refs, [{"kind": "source", **original["source_ref"]}])
        citation = {**refs[0], "quote": original["content"]}
        self.assert_contract(handoff, {"content": "합성", "citations": [citation]}, True)
        checked = QuestionRunStore._validate_citations(data, [citation])[0]
        self.assertEqual(checked["layer"], "reported_conversion")
        self.assertEqual(checked["conversion_ref"], original["conversion"]["conversion_ref"])
        self.assertEqual(checked["original_coverage"], "not_verified")
        self.assert_contract(handoff, {"content": "합성", "citations": [{**citation, "source_id": "6" * 32}]}, False)

    def test_legacy_frozen_contract_is_preserved_and_v2_tampering_is_rejected(self):
        handoff, record = frozen(basis())
        original_prompt = assemble_question(handoff, record)
        altered = deepcopy(handoff)
        altered["output"]["citation_references"][0]["source_revision"] = "0" * 64
        with self.assertRaisesRegex(AnalysisClientError, "question_input_mismatch"):
            assemble_question(altered, record)
        legacy, legacy_record = frozen(basis())
        legacy["contract_version"] = legacy_record["data"]["input_contract_version"] = "personal-question-v1"
        legacy["output"] = legacy_record["data"]["output_contract"] = {"content": "UTF-8 answer", "citations": "legacy"}
        legacy["input_sha256"] = canonical_json_hash({k: v for k, v in legacy.items() if k != "input_sha256"})
        self.assertEqual(question_answer_schema(legacy), ANSWER_SCHEMA)
        self.assertIn('"contract_version": "personal-question-v1"', assemble_question(legacy, legacy_record))
        self.assertEqual(assemble_question(handoff, record), original_prompt)

    def test_empty_catalog_and_invalid_result_are_not_filled_or_repaired(self):
        handoff, record = frozen({"documents": [], "originals": []})
        self.assert_contract(handoff, {"content": "근거가 없습니다.", "citations": []}, True)
        prompt = assemble_question(handoff, record)
        answer = {"content": "합성", "citations": [{"kind": "document", "document": "Missing.md", "source_revision": "a" * 64, "quote": "x"}]}
        self.assert_contract(handoff, answer, False)
        result = {"value": answer, "execution": {"status": "completed", "provider": "synthetic", "cli_version": "fixture",
            "prompt_sha256": sha256(prompt.encode()).hexdigest()}}
        before = deepcopy(result)
        with self.assertRaisesRegex(AnalysisClientError, "ai_invalid_result"):
            answer_payload(result, handoff=handoff, prompt=prompt)
        self.assertEqual(result, before)


if __name__ == "__main__":
    unittest.main()
