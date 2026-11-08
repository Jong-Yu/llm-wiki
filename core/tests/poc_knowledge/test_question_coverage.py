"""문서 정답 없이 고정 질문 항목의 누락·표시·인용 계약을 확인한다."""

from copy import deepcopy
from hashlib import sha256
from itertools import permutations
import json
import unittest
from unittest.mock import patch

from jsonschema import Draft202012Validator

from core.client.ai.contracts import AIAdapterError
from core.client.question_coverage import CoverageState


BASE = {"type": "object", "additionalProperties": False, "properties": {
    "action": {"type": "string", "enum": ["search", "read", "claims", "history", "dialogue", "answer"]},
    "content": {"type": ["string", "null"]}, "evidence_ids": {"type": "array", "items": {"type": "string"}}},
    "required": ["action", "content", "evidence_ids"]}


def query(parts, covers, action="read"):
    return {"action": action, "content": None, "evidence_ids": [], "parts": parts, "covers": covers, "answers": []}


def final(parts, answers):
    return {"action": "answer", "content": None, "evidence_ids": [], "parts": parts, "covers": [], "answers": answers}


def supported(part, text="확인 [[s7:2:4]]", identifiers=None):
    return {"part": part, "status": "supported", "text": text,
            "evidence_ids": ["s7:2:4"] if identifiers is None else identifiers}


def unavailable(part, status="not_found", text="제공된 자료로 이 항목을 확인하지 못했습니다."):
    return {"part": part, "status": status, "text": text, "evidence_ids": []}


class QuestionCoverageTests(unittest.TestCase):
    def setUp(self):
        self.state = CoverageState()
        self.registry = {"s7:2:4": {"kind": "document", "quote": "condition A"},
                         "c3:6": {"kind": "claim", "quote": "condition B"}}

    def reject(self, callback):
        with self.assertRaises(AIAdapterError) as caught:
            callback()
        self.assertEqual(caught.exception.code, "ai_invalid_result")

    def test_schema_is_a_copy_with_explicit_first_plan_and_no_global_answer(self):
        before = deepcopy(BASE)
        schema = self.state.schema(BASE)
        self.assertEqual(BASE, before)
        self.assertEqual(schema["properties"]["content"], {"type": "null"})
        self.assertEqual(schema["properties"]["parts"]["minItems"], 1)
        self.assertEqual(schema["properties"]["evidence_ids"]["maxItems"], 0)
        self.assertTrue(Draft202012Validator(schema).is_valid(query(["역할", "조건"], [1, 2])))
        self.assertFalse(Draft202012Validator(schema).is_valid(query([], [1])))

    def test_schema_not_checked_policy_is_explicit_and_strict(self):
        value = final(["질문"], [unavailable(1, "not_checked")])
        self.assertFalse(Draft202012Validator(self.state.schema(BASE)).is_valid(value))
        self.assertTrue(Draft202012Validator(self.state.schema(BASE, allow_not_checked=True)).is_valid(value))
        self.reject(lambda: self.state.schema(BASE, allow_not_checked=1))

    def test_query_validation_does_not_claim_success_or_freeze_the_plan(self):
        before = self.state.prompt_state()
        self.state.validate_query(query(["역할", "조건"], [2]))
        self.assertEqual(self.state.prompt_state(), before)
        self.state.observe_query(query(["역할", "조건"], [2]))
        self.assertEqual(self.state.prompt_state()["queries_by_part"], [
            {"part": 1, "successful_queries": 0, "factual_queries": 0, "context_available": False},
            {"part": 2, "successful_queries": 1, "factual_queries": 1, "context_available": False}])

    def test_plan_allows_empty_repeat_or_exact_repeat_but_not_edits(self):
        self.state.observe_query(query(["역할", "조건"], [1]))
        self.state.observe_query(query([], [2]))
        self.state.observe_query(query(["역할", "조건"], [1, 2], "search"))
        self.assertEqual(self.state.prompt_state()["queries_by_part"], [
            {"part": 1, "successful_queries": 2, "factual_queries": 2, "context_available": False},
            {"part": 2, "successful_queries": 2, "factual_queries": 2, "context_available": False}])
        for parts in (["조건", "역할"], ["역할"], ["역할", "조건", "기타"], ["다른 역할", "조건"]):
            with self.subTest(parts=parts):
                self.reject(lambda: self.state.observe_query(query(parts, [1])))

    def test_invalid_query_never_changes_existing_plan_or_counts(self):
        self.state.observe_query(query(["A", "B"], [1]))
        before = self.state.prompt_state()
        for covers in ([], [0], [3], [True], [1, 1], "1", [1.0]):
            with self.subTest(covers=covers):
                self.reject(lambda: self.state.observe_query(query([], covers)))
                self.assertEqual(self.state.prompt_state(), before)
        for change in ({"answers": [supported(1)]}, {"action": "answer"}, {"content": "draft"},
                       {"evidence_ids": ["s7:2:4"]}, {"action": []}):
            self.reject(lambda: self.state.observe_query({**query([], [1]), **change}))

    def test_missing_top_level_contract_fields_are_rejected_without_guessing_defaults(self):
        for key in ("content", "evidence_ids", "parts", "covers", "answers", "action"):
            value = query(["요청"], [1])
            value.pop(key)
            with self.subTest(key=key):
                self.reject(lambda: self.state.observe_query(value))
        value = final(["요청"], [supported(1)])
        value.pop("content")
        self.reject(lambda: self.state.render(value, self.registry))

    def test_all_query_kinds_can_cover_multiple_question_parts(self):
        for action in ("search", "read", "claims", "history", "dialogue"):
            with self.subTest(action=action):
                state = CoverageState()
                state.observe_query(query(["a", "b"], [2, 1], action))
                self.assertEqual([x["successful_queries"] for x in state.prompt_state()["queries_by_part"]], [1, 1])
                self.assertEqual([x["factual_queries"] for x in state.prompt_state()["queries_by_part"]],
                                 [0, 0] if action == "dialogue" else [1, 1])

    def test_initial_dialogue_can_answer_without_becoming_current_source_evidence(self):
        state = CoverageState(dialogue_available=True)
        answer = unavailable(1, "context_only", "앞선 대화에서는 작은 모델을 선택하셨습니다.")
        value = final(["이전 선택"], [answer])
        self.assertTrue(Draft202012Validator(state.schema(BASE)).is_valid(value))
        result = state.render(value, {})
        self.assertEqual(result["citations"], [])
        self.assertIn("### 1. 이전 선택 (이전 대화)", result["content"])
        self.assertEqual(state.prompt_state()["queries_by_part"], [
            {"part": 1, "successful_queries": 0, "factual_queries": 0, "context_available": True}])
        self.assertTrue(state.prompt_state()["context_only_is_not_current_factual_evidence"])

    def test_dialogue_response_exposes_context_only_to_targeted_parts(self):
        self.state.observe_query(query(["현재 사실", "이전 선택"], [2], "dialogue"),
                                 {"items": [{"role": "assistant", "content": "previous choice"}]})
        rows = self.state.prompt_state()["queries_by_part"]
        self.assertEqual(rows, [
            {"part": 1, "successful_queries": 0, "factual_queries": 0, "context_available": False},
            {"part": 2, "successful_queries": 1, "factual_queries": 0, "context_available": True}])
        value = final([], [unavailable(1, "not_checked"), unavailable(2, "context_only")])
        self.assertTrue(Draft202012Validator(self.state.schema(BASE, allow_not_checked=True)).is_valid(value))
        self.state.render(value, {}, allow_not_checked=True)
        self.reject(lambda: self.state.render(final([], [unavailable(1, "context_only"),
            unavailable(2, "context_only")]), {}, allow_not_checked=True))

    def test_empty_or_missing_dialogue_does_not_create_context_or_a_factual_query(self):
        for response in (None, {}, {"items": []}, {"items": [{}]}, {"items": ["text"]},
                         {"items": [{"content": ""}]}):
            with self.subTest(response=response):
                state = CoverageState()
                state.observe_query(query(["이전 답변"], [1], "dialogue"), response)
                row = state.prompt_state()["queries_by_part"][0]
                self.assertEqual(row, {"part": 1, "successful_queries": 1,
                                       "factual_queries": 0, "context_available": False})
                missing = final([], [unavailable(1, "context_only")])
                self.assertFalse(Draft202012Validator(state.schema(BASE)).is_valid(missing))
                self.reject(lambda: state.render(missing, {}))
                self.reject(lambda: state.render(final([], [unavailable(1, "not_found")]), {}))
                result = state.render(final([], [unavailable(1, "not_checked")]), {}, allow_not_checked=True)
                self.assertIn("(미확인)", result["content"])

    def test_six_empty_dialogue_queries_still_allow_truthful_unchecked_source_status(self):
        for number in range(6):
            self.state.observe_query(query(["원문 조건"] if number == 0 else [], [1], "dialogue"), {"items": []})
        row = self.state.prompt_state()["queries_by_part"][0]
        self.assertEqual(row, {"part": 1, "successful_queries": 6,
                               "factual_queries": 0, "context_available": False})
        value = final([], [unavailable(1, "not_checked")])
        self.assertTrue(Draft202012Validator(self.state.schema(BASE, allow_not_checked=True)).is_valid(value))
        self.assertIn("(미확인)", self.state.render(value, {}, allow_not_checked=True)["content"])

    def test_dialogue_does_not_establish_source_absence_but_factual_query_does(self):
        self.state.observe_query(query(["조건"], [1], "dialogue"), {"items": [{"content": "old claim"}]})
        self.reject(lambda: self.state.render(final([], [unavailable(1, "not_found")]), {}))
        self.state.observe_query(query([], [1], "search"), {"items": []})
        result = self.state.render(final([], [unavailable(1, "not_found")]), {})
        self.assertIn("(확인 불가)", result["content"])
        self.assertEqual(self.state.prompt_state()["queries_by_part"][0],
            {"part": 1, "successful_queries": 2, "factual_queries": 1, "context_available": True})
        self.reject(lambda: self.state.render(final([], [unavailable(1, "not_checked")]), {}, allow_not_checked=True))

    def test_context_only_forbids_current_citations_and_source_reads_do_not_create_dialogue(self):
        state = CoverageState(dialogue_available=True)
        value = final(["이전 선택"], [{**unavailable(1, "context_only"), "evidence_ids": ["s7:2:4"]}])
        self.reject(lambda: state.render(value, self.registry))
        self.state.observe_query(query(["현재 내용"], [1]), {"items": [{"content": "source is not dialogue"}]})
        self.reject(lambda: self.state.render(final([], [unavailable(1, "context_only")]), self.registry))

    def test_dialogue_configuration_and_response_types_are_strict_and_atomic(self):
        self.reject(lambda: CoverageState(dialogue_available=1))
        self.reject(lambda: self.state.observe_query(query(["역할"], [1], "dialogue"), ["not a response"]))
        self.assertFalse(self.state.prompt_state()["frozen"])

    def test_available_dialogue_is_not_erased_by_a_later_empty_response(self):
        self.state.observe_query(query(["이전 선택"], [1], "dialogue"), {"items": [{"content": "choice"}]})
        self.state.observe_query(query([], [1], "dialogue"), {"items": []})
        result = self.state.render(final([], [unavailable(1, "context_only")]), {})
        self.assertIn("(이전 대화)", result["content"])

    def test_missing_duplicate_foreign_or_boolean_final_part_is_rejected(self):
        self.state.observe_query(query(["역할", "조건"], [1, 2]))
        for answers in ([supported(1)], [supported(1), supported(1)], [supported(1), supported(3)],
                        [supported(True), supported(2)], [supported(1.0), supported(2)]):
            with self.subTest(answers=answers):
                self.reject(lambda: self.state.render(final([], answers), self.registry))

    def test_answers_are_reordered_by_frozen_part_and_citations_by_actual_use(self):
        self.state.observe_query(query(["조건 A", "조건 B"], [1, 2]))
        value = final([], [supported(2, "B [[c3:6]]", ["c3:6"]),
                           supported(1, "A [[s7:2:4]]", ["s7:2:4"])])
        result = self.state.render(value, self.registry)
        self.assertEqual(result["content"], "### 1. 조건 A\n\nA [1]\n\n### 2. 조건 B\n\nB [2]")
        self.assertEqual(result["evidence_ids"], ["s7:2:4", "c3:6"])
        self.assertEqual(result["citations"], [self.registry["s7:2:4"], self.registry["c3:6"]])

    def test_same_served_evidence_can_support_another_part_without_target_query(self):
        self.state.observe_query(query(["역할", "조건"], [1]))
        result = self.state.render(final([], [supported(1), supported(2)]), self.registry)
        self.assertEqual(result["content"].count("[1]"), 2)
        self.assertEqual(result["evidence_ids"], ["s7:2:4"])

    def test_declared_id_order_does_not_determine_display_order(self):
        value = final(["설명"], [supported(1, "B [[c3:6]] A [[s7:2:4]]", ["s7:2:4", "c3:6"])])
        result = self.state.render(value, self.registry)
        self.assertEqual(result["content"], "### 1. 설명\n\nB [1] A [2]")
        self.assertEqual(result["evidence_ids"], ["c3:6", "s7:2:4"])

    def test_each_part_must_declare_its_own_markers_not_borrow_from_another_part(self):
        self.state.observe_query(query(["A", "B"], [1, 2]))
        for answers in ([supported(1, "A [[c3:6]]", ["s7:2:4"]), supported(2)],
                        [supported(1, "A", []), supported(2)],
                        [supported(1, "A [[unknown]]", ["unknown"]), supported(2)],
                        [supported(1, "A [[s7:2:4]]", ["s7:2:4", "s7:2:4"]), supported(2)]):
            with self.subTest(answers=answers):
                self.reject(lambda: self.state.render(final([], answers), self.registry))

    def test_not_found_requires_successful_query_for_that_part_and_shows_uncertainty(self):
        self.state.observe_query(query(["역할", "조건"], [1]))
        self.reject(lambda: self.state.render(final([], [supported(1), unavailable(2)]), self.registry))
        self.state.observe_query(query([], [2]))
        text = "선택한 구절에서는 이 조건을 확인하지 못했습니다."
        result = self.state.render(final([], [supported(1), unavailable(2, text=text)]), self.registry)
        self.assertIn("### 2. 조건 (확인 불가)\n\n" + text, result["content"])

    def test_not_checked_requires_no_query_and_explicit_policy_permission(self):
        self.state.observe_query(query(["역할", "조건"], [1]))
        value = final([], [supported(1), unavailable(2, "not_checked")])
        self.reject(lambda: self.state.render(value, self.registry))
        result = self.state.render(value, self.registry, allow_not_checked=True)
        self.assertIn("### 2. 조건 (미확인)", result["content"])
        self.reject(lambda: self.state.render(final([], [unavailable(1, "not_checked"), unavailable(2, "not_checked")]),
                                             self.registry, allow_not_checked=True))

    def test_initial_answer_without_material_can_freeze_plan_and_report_all_parts(self):
        value = final(["첫 요청", "둘째 요청"], [unavailable(2, "not_checked"), unavailable(1, "not_checked")])
        result = self.state.render(value, {}, allow_not_checked=True)
        self.assertEqual(result["citations"], [])
        self.assertTrue(self.state.prompt_state()["frozen"])
        self.assertEqual(self.state.prompt_state()["parts"], ["첫 요청", "둘째 요청"])
        self.assertEqual(result["content"].count("(미확인)"), 2)

    def test_initial_not_found_cannot_claim_an_unperformed_query(self):
        self.reject(lambda: self.state.render(final(["요청"], [unavailable(1)]), {}))
        self.assertFalse(self.state.prompt_state()["frozen"])

    def test_status_does_not_allow_citations_to_be_hidden_as_uncertainty(self):
        self.state.observe_query(query(["요청"], [1]))
        for status in ("not_found", "not_checked"):
            answer = {**unavailable(1, status), "evidence_ids": ["s7:2:4"]}
            self.reject(lambda: self.state.render(final([], [answer]), self.registry, allow_not_checked=True))

    def test_heading_escapes_markdown_and_cannot_supply_an_evidence_marker(self):
        label = "# [1] [[not-served]] `code` *강조* <tag>"
        result = self.state.render(final([label], [supported(1)]), self.registry)
        self.assertIn(r"\# \[1\] \[\[not\-served\]\] \`code\` \*강조\* \<tag\>", result["content"])
        self.assertEqual(result["evidence_ids"], ["s7:2:4"])
        self.assertTrue(result["content"].endswith("확인 [1]"))

    def test_part_text_whitespace_unicode_and_code_are_preserved(self):
        body = "  한글🙂\t\r\n`values[1]`\n```python\nvalues = [1, 2]\n```\n근거 [[s7:2:4]]\n"
        result = self.state.render(final(["설명🙂"], [supported(1, body)]), self.registry)
        self.assertEqual(result["content"], "### 1. 설명🙂\n\n" + body.replace("[[s7:2:4]]", "[1]"))

    def test_an_open_code_span_or_fence_cannot_swallow_the_next_part_heading(self):
        self.state.observe_query(query(["A", "B"], [1, 2]))
        for first, second in (("```\nA [[s7:2:4]]", "B [[s7:2:4]]"),
                              ("`A [[s7:2:4]]", "B` [[s7:2:4]]")):
            with self.subTest(first=first):
                self.reject(lambda: self.state.render(final([], [supported(1, first), supported(2, second)]), self.registry))

    def test_invalid_labels_are_rejected_without_freezing(self):
        for labels in ([], [""], [" "], ["A", "A"], ["A", " A "], ["A\nB"], ["A\rB"],
                       ["A\x00B"], [False], ["x" * 201], [str(x) for x in range(9)]):
            with self.subTest(labels=labels):
                self.reject(lambda: self.state.observe_query(query(labels, [1])))
                self.assertFalse(self.state.prompt_state()["frozen"])

    def test_one_through_eight_parts_are_supported_with_no_silent_dropping(self):
        for size in range(1, 9):
            with self.subTest(size=size):
                state = CoverageState()
                labels = [f"조건 {i}" for i in range(1, size + 1)]
                result = state.render(final(labels, [supported(i) for i in reversed(range(1, size + 1))]), self.registry)
                self.assertEqual(result["content"].count("### "), size)
                self.assertEqual(result["content"].count("[1]"), size)

    def test_all_answer_permutations_preserve_plan_order_and_cross_part_evidence_reuse(self):
        labels = ["scope", "조건", "責任", "예외🙂"]
        identifiers = ["o21:4:9", "w3:7:9", "p1:8", "c4:11"]
        registry = {value: {"ref": value} for value in identifiers}
        answers = [supported(number, f"body {number} [[{identifiers[number - 1]}]] [[{identifiers[0]}]]",
                             [identifiers[0]] if number == 1 else [identifiers[0], identifiers[number - 1]])
                   for number in range(1, 5)]
        for permutation in permutations(answers):
            state = CoverageState()
            result = state.render(final(labels, list(permutation)), registry)
            with self.subTest(order=[item["part"] for item in permutation]):
                self.assertEqual(result["evidence_ids"], identifiers)
                for number in range(1, 5):
                    self.assertIn(f"body {number} [{number}] [1]", result["content"])
                self.assertEqual([citation["ref"] for citation in result["citations"]], identifiers)

    def test_final_plan_replacement_and_unknown_answer_fields_are_rejected(self):
        self.state.observe_query(query(["원래 요청"], [1]))
        self.reject(lambda: self.state.render(final(["쉬운 다른 요청"], [supported(1)]), self.registry))
        self.reject(lambda: self.state.render(final([], [{**supported(1), "extra": "ignored"}]), self.registry))

    def test_blank_overlong_invalid_status_and_top_level_content_are_rejected(self):
        for change in ({"text": " "}, {"text": "x" * 7001}, {"status": "approved"}, {"text": None}):
            self.reject(lambda: self.state.render(final(["요청"], [{**supported(1), **change}]), self.registry))
        self.reject(lambda: self.state.render({**final(["요청"], [supported(1)]), "content": "omit sections"}, self.registry))
        self.reject(lambda: self.state.render({**final(["요청"], [supported(1)]), "covers": [1]}, self.registry))

    def test_global_citation_cap_is_enforced_across_individually_valid_parts(self):
        registry = {f"c1:{i}": {"ref": i} for i in range(1, 66)}
        ids = list(registry)
        answers = [supported(1, " ".join(f"[[{v}]]" for v in ids[:33]), ids[:33]),
                   supported(2, " ".join(f"[[{v}]]" for v in ids[33:]), ids[33:])]
        self.reject(lambda: self.state.render(final(["첫 부분", "둘째 부분"], answers), registry))
        answers[-1]["text"] = " ".join(f"[[{v}]]" for v in ids[33:64])
        answers[-1]["evidence_ids"] = ids[33:64]
        result = self.state.render(final(["첫 부분", "둘째 부분"], answers), registry)
        self.assertEqual(len(result["citations"]), 64)
        self.assertTrue(result["content"].endswith("[64]"))

    def test_aggregate_content_cap_rejects_without_cutting_text(self):
        value = final(["요청"], [supported(1, "value [[s7:2:4]]")])
        original = deepcopy(value)
        with patch("core.client.question_coverage.MAX_CONTENT_CHARACTERS", 10):
            self.reject(lambda: self.state.render(value, self.registry))
        self.assertEqual(value, original)
        self.assertFalse(self.state.prompt_state()["frozen"])

    def test_prompt_and_output_copies_do_not_mutate_plan_registry_or_model_answer(self):
        self.state.observe_query(query(["A", "B"], [1]))
        before = self.state.prompt_state()
        exposed = self.state.prompt_state()
        exposed["parts"][0] = "changed"
        exposed["queries_by_part"][0]["successful_queries"] = 100
        self.assertEqual(self.state.prompt_state(), before)
        value = final([], [supported(1), supported(2)])
        raw, registry = deepcopy(value), deepcopy(self.registry)
        result = self.state.render(value, self.registry)
        result["citations"][0]["quote"] = "caller edit"
        self.assertEqual(value, raw)
        self.assertEqual(self.registry, registry)
        self.assertIn("not_factual_evidence", self.state.prompt_state()["purpose"])


class SourceScopeCoverageTests(unittest.TestCase):
    def setUp(self):
        self.state = CoverageState(preserve_source_scope=True)
        self.registry = {"s7:2:4": {"kind": "document", "quote": "core passage"},
                         "c3:6": {"kind": "claim", "quote": "context passage"}}

    def reject(self, callback):
        with self.assertRaises(AIAdapterError) as caught:
            callback()
        self.assertEqual(caught.exception.code, "ai_invalid_result")

    def answer(self, *, text="핵심 답변 [[s7:2:4]]", identifiers=None, contexts=None):
        return {**supported(1, text, identifiers), "source_context": [] if contexts is None else contexts}

    def context(self, kind="condition", text="명시 조건 [[c3:6]]", identifiers=None):
        return {"kind": kind, "text": text, "evidence_ids": ["c3:6"] if identifiers is None else identifiers}

    def test_false_preserves_prior_schema_prompt_and_render_bytes(self):
        def digest(value):
            return sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        state = CoverageState(preserve_source_scope=False)
        self.assertEqual(digest(state.schema(BASE)), "acdd7e31af34a09cf5003a59aab52366d8f895cf2fb4d43de7466c3d147cbbdc")
        self.assertEqual(digest(state.prompt_state()), "4984cbb19e9d33488348556f013f6c08a7c5ed81719cb33acdb51b50b6ae3d02")
        state.observe_query(query(["역할", "조건"], [1]))
        self.assertEqual(digest(state.schema(BASE, allow_not_checked=True)),
                         "972138a26aa03d68c5b716c0cb7483f4cbcdbaceb34579530e609e423363cbd0")
        self.assertEqual(digest(state.prompt_state()), "2a2b8d925e81d578f289b1f04f9910e260b0ba79a1ac62bc2588bb90149ec97b")
        self.assertEqual(digest(state.render(final([], [supported(1), supported(2)]), {"s7:2:4": {"quote": "sample"}})),
                         "44fe96a70d6f6af8ab98cff5a52bb5966bfe64183a1a4e2f40b230a5783240dc")
        self.assertNotIn("source_scope_preservation", state.prompt_state())
        self.reject(lambda: state.render(final([], [self.answer(), supported(2)]), self.registry))

    def test_true_schema_requires_bounded_typed_source_context(self):
        schema = self.state.schema(BASE)
        answer_schema = schema["properties"]["answers"]["items"]
        self.assertIn("source_context", answer_schema["required"])
        self.assertEqual(answer_schema["properties"]["source_context"]["maxItems"], 8)
        self.assertTrue(self.state.prompt_state()["source_scope_preservation"])
        self.assertTrue(Draft202012Validator(schema).is_valid(final(["요청"], [self.answer()])))
        self.assertFalse(Draft202012Validator(schema).is_valid(final(["요청"], [supported(1)])))
        self.assertFalse(Draft202012Validator(schema).is_valid(final(["요청"], [self.answer(contexts=[self.context()] * 9)])))
        self.reject(lambda: CoverageState(preserve_source_scope=1))

    def test_definitions_other_actor_duties_conditions_and_attribution_are_preserved(self):
        examples = [
            ("definition", "주체는 alpha 또는 beta일 수 있습니다. [[c3:6]]", "관련 정의"),
            ("requirement", "다른 담당자는 기록을 제출해야 합니다. [[c3:6]]", "원문의 요구"),
            ("condition", "검사가 끝난 경우에만 시작합니다. [[c3:6]]", "조건"),
            ("exception", "특별 상태에서는 앞 조건의 예외입니다. [[c3:6]]", "예외"),
            ("direction", "관계는 alpha에서 beta로 향합니다. [[c3:6]]", "방향"),
            ("source_claim", "작성자는 이 값이 잠정적이라고 설명합니다. [[c3:6]]", "자료의 주장"),
            ("scope", "설명은 판본 9의 관측 시점에 한정됩니다. [[c3:6]]", "적용 범위"),
        ]
        contexts = [self.context(kind, text) for kind, text, _ in examples]
        result = self.state.render(final(["질문"], [self.answer(contexts=contexts)]), self.registry)
        self.assertTrue(result["content"].startswith("### 1. 질문\n\n핵심 답변 [1]"))
        for _, text, label in examples:
            self.assertIn(f"**{label}**\n\n" + text.replace("[[c3:6]]", "[2]"), result["content"])
        self.assertEqual(result["evidence_ids"], ["s7:2:4", "c3:6"])
        self.assertEqual(len(result["citations"]), 2)

    def test_missing_unknown_and_malformed_context_fields_cannot_be_ignored(self):
        invalid = [None, "context", tuple(), [None], [{**self.context(), "unknown": "lost"}],
                   [{"kind": "condition", "text": "x"}], [{**self.context(), "kind": "condition **spoof**"}],
                   [{**self.context(), "kind": []}], [{**self.context(), "text": " "}],
                   [{**self.context(), "text": "x" * 1001}], [{**self.context(), "evidence_ids": []}]]
        self.reject(lambda: self.state.render(final(["요청"], [supported(1)]), self.registry))
        for contexts in invalid:
            with self.subTest(contexts=contexts):
                value = {**self.answer(), "source_context": contexts}
                self.reject(lambda: self.state.render(final(["요청"], [value]), self.registry))

    def test_core_and_each_context_must_declare_its_own_actual_evidence(self):
        values = [
            self.answer(contexts=[self.context(identifiers=["s7:2:4"])]),
            self.answer(contexts=[self.context(text="근거 없음 [[not-served]]", identifiers=["not-served"])]),
            self.answer(contexts=[self.context(identifiers=["c3:6", "c3:6"])]),
            self.answer(identifiers=[], contexts=[self.context()]),
        ]
        for value in values:
            with self.subTest(value=value):
                self.reject(lambda: self.state.render(final(["요청"], [value]), self.registry))

    def test_part_declarations_can_include_their_own_independently_cited_context(self):
        narrow = self.answer(contexts=[self.context()])
        whole = self.answer(identifiers=["c3:6", "s7:2:4"], contexts=[self.context()])
        first = self.state.render(final(["요청"], [narrow]), self.registry)
        second = self.state.render(final(["요청"], [whole]), self.registry)
        self.assertEqual(first, second)
        self.assertEqual(second["evidence_ids"], ["s7:2:4", "c3:6"])

    def test_context_cannot_mask_missing_core_declaration_or_unused_part_ids(self):
        invalid = [
            self.answer(identifiers=["c3:6"], contexts=[self.context()]),
            self.answer(identifiers=["s7:2:4", "c3:6"], contexts=[]),
            self.answer(identifiers=["s7:2:4", "s7:2:4"], contexts=[self.context()]),
            self.answer(identifiers=["s7:2:4", "not-served"], contexts=[self.context()]),
            self.answer(text="인용 없는 핵심", identifiers=["c3:6"], contexts=[self.context()]),
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.reject(lambda: self.state.render(final(["요청"], [value]), self.registry))

    def test_another_part_cannot_supply_the_use_of_an_extra_part_declaration(self):
        values = [self.answer(identifiers=["s7:2:4", "c3:6"]),
                  {**self.answer(contexts=[self.context()]), "part": 2}]
        self.reject(lambda: self.state.render(final(["첫 요청", "둘째 요청"], values), self.registry))

    def test_unknown_or_previous_dialogue_cannot_smuggle_current_facts_through_context(self):
        for status in ("not_found", "not_checked", "context_only"):
            with self.subTest(status=status):
                state = CoverageState(dialogue_available=True, preserve_source_scope=True)
                if status == "not_found":
                    state.observe_query(query(["요청"], [1]))
                value = {**unavailable(1, status), "source_context": [self.context()]}
                self.reject(lambda: state.render(final([] if status == "not_found" else ["요청"], [value]),
                                                self.registry, allow_not_checked=True))
                value["source_context"] = []
                result = state.render(final([] if status == "not_found" else ["요청"], [value]),
                                      self.registry, allow_not_checked=True)
                self.assertEqual(result["citations"], [])

    def test_combined_core_and_context_content_obeys_the_existing_part_limit(self):
        contexts = [self.context(text="y" * 900 + " [[c3:6]]") for _ in range(2)]
        valid = self.answer(text="x" * 5000 + " [[s7:2:4]]", contexts=contexts)
        result = self.state.render(final(["요청"], [valid]), self.registry)
        self.assertIn("y" * 900, result["content"])
        invalid = self.answer(text="x" * 5200 + " [[s7:2:4]]", contexts=contexts)
        before = deepcopy(invalid)
        self.reject(lambda: self.state.render(final([], [invalid]), self.registry))
        self.assertEqual(invalid, before)

    def test_global_citation_limit_counts_core_and_all_source_context_entries(self):
        registry = {f"c1:{number}": {"record": number} for number in range(1, 66)}
        identifiers = list(registry)
        value = self.answer(text=f"core [[{identifiers[0]}]]", identifiers=identifiers[:1], contexts=[
            self.context(text=" ".join(f"[[{key}]]" for key in identifiers[1:]), identifiers=identifiers[1:])])
        self.reject(lambda: self.state.render(final(["요청"], [value]), registry))
        value["source_context"][0]["text"] = " ".join(f"[[{key}]]" for key in identifiers[1:64])
        value["source_context"][0]["evidence_ids"] = identifiers[1:64]
        result = self.state.render(final(["요청"], [value]), registry)
        self.assertEqual(len(result["citations"]), 64)
        self.assertTrue(result["content"].endswith("[64]"))

    def test_context_markdown_cannot_hide_later_context_labels_or_parts(self):
        values = [
            self.answer(text="```\ncore [[s7:2:4]]", contexts=[self.context()]),
            self.answer(contexts=[self.context(text="`first [[c3:6]]"),
                                  self.context("exception", "second` [[c3:6]]")]),
        ]
        for value in values:
            self.reject(lambda: self.state.render(final(["요청"], [value]), self.registry))
        value = self.answer(contexts=[self.context(text="```txt\n literal[9] [[c3:6]]\n```")])
        result = self.state.render(final(["[1] [[not-source]]"], [value]), self.registry)
        self.assertIn(r"\[1\] \[\[not\-source\]\]", result["content"])
        self.assertIn("literal[9] [2]", result["content"])

    def test_unicode_whitespace_and_context_input_are_preserved_without_aliasing(self):
        body = "  条件🙂\t\r\n`array[1]` [[c3:6]]\n"
        value = final(["다국어"], [self.answer(contexts=[self.context(text=body)])])
        original, registry = deepcopy(value), deepcopy(self.registry)
        result = self.state.render(value, self.registry)
        self.assertIn(body.replace("[[c3:6]]", "[2]"), result["content"])
        result["citations"][1]["quote"] = "caller edit"
        self.assertEqual(value, original)
        self.assertEqual(self.registry, registry)

    def test_overall_content_limit_includes_preserved_source_context(self):
        value = final(["요청"], [self.answer(contexts=[self.context()])])
        with patch("core.client.question_coverage.MAX_CONTENT_CHARACTERS", 50):
            self.reject(lambda: self.state.render(value, self.registry))
        self.assertFalse(self.state.prompt_state()["frozen"])


if __name__ == "__main__":
    unittest.main()
