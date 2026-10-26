"""Integrity regressions for answer replay, independent of semantic grades."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from core.modules.ontology.store import OntologyStore
from core.modules.documents.store import WikiStore
from tools.verify_answers import LIMITS, digest, validate_answer, validate_archive, validate_graph


def record(value):
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    return {"text": text, "sha256": digest(text)}


class AnswerReplayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-answer-tests-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "archive.json"
        content = "재고가 있으면 주문서비스가 배송서비스를 사용한다.\n예약상품은 제외한다.\n"
        self.source = {"id": "shipping", "document": "업무/배송.md", "content": content,
                       "sha256": digest(content), "url": "https://example.test/source",
                       "title": "주문 처리 규칙", "version": "2026-10-22"}
        self.bundle = {"documents": [self.source]}
        self.questions = [{"id": f"q{index}", "question": "주문 처리 조건은?", "profile": "business"}
                          for index in range(1, 7)]
        quote = "재고가 있으면 주문서비스가 배송서비스를 사용한다."
        case = {"document": self.source["document"], "source_revision": self.source["sha256"],
                "entities": [{"id": identifier, "type": "system", "label": label, "evidence": quote}
                             for identifier, label in (("order", "주문서비스"), ("shipping", "배송서비스"))],
                "relations": [{"subject": "order", "predicate": "uses", "object": "shipping",
                               "evidence": quote, "qualifiers": {"condition": "재고가 있으면"}}],
                "attributes": [], "relation_candidates": [], "omissions": ["예약상품 제외는 구조화하지 않았다."]}
        self.raw = {"documents": [case]}
        store_dir = self.root / "store"
        store_dir.mkdir()
        store = WikiStore(store_dir)
        store.save(self.source["document"], content, expected_revision=None)
        ontology = OntologyStore(store)
        ontology.generate(case["document"], case["source_revision"], case["entities"], case["relations"])
        public = ontology.context([case["document"]])["documents"][0]["ontology"]
        public.update(title=self.source["title"], url=self.source["url"], source_version=self.source["version"])
        self.public = {"documents": [public]}
        self.access = {"user_id": "reader", "tenant": "sample", "profiles": ["business"],
                       "permissions": ["read"], "policy_revision": "a" * 64}
        self.answer = {"answers": [
            {"question_id": question["id"], "answer": "재고가 있을 때 처리합니다.",
             "citations": [{"document": self.source["document"], "source_revision": self.source["sha256"],
                            "quote": quote}], "uncertainties": []}
            for question in self.questions]}
        self.archive = {"records": {"source_bundle": record(self.bundle),
                                    "questions": record({"questions": self.questions}),
                                    "protocol": record(LIMITS), "access": record(self.access),
                                    "graph_raw": record(self.raw), "graph_public": record(self.public)},
                        "runs": []}
        for mode in ("natural", "graph", "combined"):
            packet = {"questions": self.questions, "access": self.access, "mode": mode, "budget": dict(LIMITS)}
            if mode in ("natural", "combined"):
                packet["documents"] = self.bundle["documents"]
            if mode in ("graph", "combined"):
                packet["graph"] = self.public
            for replicate in (1, 2):
                identifier = f"{mode}-{replicate}"
                self.archive["records"][f"input_{identifier}"] = record(packet)
                self.archive["records"][f"output_{identifier}"] = record(self.answer)
                self.archive["runs"].append({
                    "id": identifier, "mode": mode, "replicate": replicate,
                    "input_record": f"input_{identifier}", "output_record": f"output_{identifier}",
                    "input_sha256": self.archive["records"][f"input_{identifier}"]["sha256"],
                    "output_sha256": self.archive["records"][f"output_{identifier}"]["sha256"],
                    "session_id": f"fresh-{identifier}"})

    def validate(self):
        self.path.write_text(json.dumps(self.archive, ensure_ascii=False), encoding="utf-8")
        return validate_archive(self.path)

    def update(self, name, value):
        self.archive["records"][name] = record(value)
        for run in self.archive["runs"]:
            for kind in ("input", "output"):
                if run[f"{kind}_record"] == name:
                    run[f"{kind}_sha256"] = self.archive["records"][name]["sha256"]

    def assert_invalid(self, report, substring):
        self.assertFalse(report["ok"], report)
        self.assertTrue(any(substring in error for error in report["errors"]), report)

    def test_exact_bytes_and_six_runs_replay_without_semantic_grade(self):
        before = deepcopy(self.archive)
        result = self.validate()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["semantic_evaluation"], "not_performed")
        self.assertEqual(len(result["runs"]), 6)
        self.assertEqual(sum(run["citation_count"] for run in result["runs"]), 36)
        self.assertEqual(self.archive, before)

    def test_whitespace_tampering_breaks_exact_record_hash(self):
        self.archive["records"]["questions"]["text"] += " "
        self.assert_invalid(self.validate(), "hash mismatch")

    def test_unknown_or_duplicate_questions_are_rejected(self):
        for question_id in ("unknown", "q1"):
            answer = deepcopy(self.answer)
            answer["answers"][1]["question_id"] = question_id
            self.assert_invalid(validate_answer(answer, self.bundle, [item["id"] for item in self.questions]),
                                "question coverage")

    def test_wrong_revision_foreign_document_and_fabricated_quote(self):
        for field, value, message in (
            ("source_revision", "0" * 64, "revision mismatch"),
            ("document", "private/Secret.md", "outside allowed"),
            ("quote", "예약상품도 승인한다.", "not a contiguous"),
        ):
            answer = deepcopy(self.answer)
            answer["answers"][0]["citations"][0][field] = value
            self.assert_invalid(validate_answer(answer, self.bundle, [item["id"] for item in self.questions]), message)

    def test_source_snapshot_hash_is_checked(self):
        bundle = deepcopy(self.bundle)
        bundle["documents"][0]["content"] += "후속 변경"
        self.assert_invalid(validate_answer(self.answer, bundle, [item["id"] for item in self.questions]),
                            "source hash mismatch")

    def test_character_citation_and_quote_budgets(self):
        for field, value, message in (
            ("answer", "가" * 1601, "character budget"),
            ("uncertainties", ["가" * 1601], "character budget"),
            ("citations", self.answer["answers"][0]["citations"] * 6, "too many citations"),
        ):
            answer = deepcopy(self.answer)
            answer["answers"][0][field] = value
            self.assert_invalid(validate_answer(answer, self.bundle, [item["id"] for item in self.questions]), message)
        answer = deepcopy(self.answer)
        answer["answers"][0]["citations"][0]["quote"] = "가" * 241
        self.assert_invalid(validate_answer(answer, self.bundle, [item["id"] for item in self.questions]), "quote budget")

    def test_claimed_equal_budget_cannot_relax_frozen_limit(self):
        protocol = dict(LIMITS, answer_max_chars=1601)
        self.update("protocol", protocol)
        self.assert_invalid(self.validate(), "frozen limit")

    def test_missing_run_duplicate_run_and_reused_session_fail(self):
        original = deepcopy(self.archive)
        self.archive["runs"].pop()
        self.assert_invalid(self.validate(), "every mode/replicate")
        self.archive = deepcopy(original)
        self.archive["runs"][1] = deepcopy(self.archive["runs"][0])
        self.assert_invalid(self.validate(), "every mode/replicate")
        self.archive = deepcopy(original)
        self.archive["runs"][1]["session_id"] = self.archive["runs"][0]["session_id"]
        self.assert_invalid(self.validate(), "distinct session")

    def test_packet_cannot_add_private_rubric_or_change_access(self):
        for change, message in (({"rubric": "private answer key"}, "packet fields"),
                                ({"access": {"tenant": "foreign"}}, "packet access")):
            packet = json.loads(self.archive["records"]["input_natural-1"]["text"])
            packet.update(change)
            self.update("input_natural-1", packet)
            self.assert_invalid(self.validate(), message)
            packet.pop("rubric", None)
            packet["access"] = self.access
            self.update("input_natural-1", packet)

    def test_mode_packet_cannot_include_hidden_source_or_changed_question(self):
        packet = json.loads(self.archive["records"]["input_graph-1"]["text"])
        packet["documents"] = self.bundle["documents"]
        self.update("input_graph-1", packet)
        self.assert_invalid(self.validate(), "packet fields")
        packet.pop("documents")
        packet["questions"][0]["question"] = "다른 질문"
        self.update("input_graph-1", packet)
        self.assert_invalid(self.validate(), "packet questions")

    def test_output_cannot_add_grader_commentary(self):
        answer = deepcopy(self.answer)
        answer["expected_score"] = 100
        self.assert_invalid(validate_answer(answer, self.bundle, [item["id"] for item in self.questions]),
                            "only answers")

    def test_graph_validation_reuses_store_and_detects_changed_qualifier(self):
        self.assertTrue(validate_graph(self.raw, self.bundle, self.public)["ok"])
        public = deepcopy(self.public)
        public["documents"][0]["relations"][0]["qualifiers"]["condition"] = None
        self.assert_invalid(validate_graph(self.raw, self.bundle, public), "relations changed")
        raw = deepcopy(self.raw)
        raw["documents"][0]["relations"][0]["evidence"] = "원문에 없는 인용"
        self.assert_invalid(validate_graph(raw, self.bundle), "OntologyValidationError")

    def test_graph_only_cannot_quote_unextracted_source_sentence(self):
        answer = deepcopy(self.answer)
        answer["answers"][0]["citations"][0]["quote"] = "예약상품은 제외한다."
        self.update("output_graph-1", answer)
        self.assert_invalid(self.validate(), "absent from supplied graph evidence")

    def test_duplicate_json_keys_fail_closed(self):
        self.path.write_text('{"records": {}, "records": {}}', encoding="utf-8")
        self.assert_invalid(validate_archive(self.path), "duplicate JSON key")

    def test_duplicate_graph_and_malformed_questions_report_errors(self):
        raw = deepcopy(self.raw)
        raw["documents"].append(deepcopy(raw["documents"][0]))
        self.assert_invalid(validate_graph(raw, self.bundle), "duplicate document")
        self.update("questions", [])
        self.assert_invalid(self.validate(), "questions.questions")

    def test_utf8_output_budget_is_separate_from_character_budget(self):
        bundle = deepcopy(self.bundle)
        bundle["documents"][0]["content"] = "가" * 240
        bundle["documents"][0]["sha256"] = digest(bundle["documents"][0]["content"])
        answer = deepcopy(self.answer)
        for item in answer["answers"]:
            item["answer"] = "가" * 1600
            item["citations"] = [{"document": self.source["document"],
                                  "source_revision": bundle["documents"][0]["sha256"],
                                  "quote": "가" * 240}] * 5
        result = validate_answer(answer, bundle, [item["id"] for item in self.questions])
        self.assert_invalid(result, "UTF-8 byte budget")
        self.assertFalse(any("character budget" in error for error in result["errors"]))

    def test_graph_public_rejects_document_and_wrapper_prose_channels(self):
        for field in ("content", "reviewer_answer"):
            public = deepcopy(self.public)
            public["documents"][0][field] = "원문 또는 평가 정답을 몰래 제공"
            self.assert_invalid(validate_graph(self.raw, self.bundle, public), "document fields")
            public = deepcopy(self.public)
            public[field] = "원문 또는 평가 정답을 몰래 제공"
            self.assert_invalid(validate_graph(self.raw, self.bundle, public), "only documents")

    def test_graph_public_metadata_is_bound_to_source_and_server_state(self):
        for field, value in (("title", "평가 답안"), ("source_version", "다른 판본"),
                             ("url", "https://example.test/foreign"), ("status", "approved"),
                             ("needs_reextraction", True), ("schema_version", 2),
                             ("graph_revision", "a" * 64), ("generation_id", "not-a-generation-id")):
            public = deepcopy(self.public)
            public["documents"][0][field] = value
            self.assert_invalid(validate_graph(self.raw, self.bundle, public), field)

    def test_raw_output_whitespace_still_consumes_output_budget(self):
        name = "output_natural-1"
        text = self.archive["records"][name]["text"] + " " * 40000
        self.archive["records"][name] = {"text": text, "sha256": digest(text)}
        self.archive["runs"][0]["output_sha256"] = digest(text)
        result = self.validate()
        self.assert_invalid(result, "raw output record exceeds")
        self.assertLess(result["runs"][0]["output_bytes"], LIMITS["output_max_bytes"])
        self.assertGreater(result["runs"][0]["output_record_bytes"], LIMITS["output_max_bytes"])


if __name__ == "__main__":
    unittest.main()
