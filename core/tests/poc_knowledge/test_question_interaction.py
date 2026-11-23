"""확인 질문은 응답을 발명하지 않고 끝나며, 새 실행에서 실제 응답만 승계한다."""

from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from jsonschema import Draft202012Validator

from core.client.ai.contracts import AIAdapterError
from core.client.ai.codex import _strict_schema
from core.client.question_ai import answer_payload, assemble_question, question_answer_schema
from core.client.question_grounding import STEP_SCHEMA, grounding_prompt, run_grounded_model
from core.client.question_interaction import CONTRACT, clarification, step_schema, validate_input
from core.client.question_streaming import GroundedAnswerPreview
from core.client.question_template_writer import part_schema, run_template_parts
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_hash
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeOwner, evidence, handoff_fixture, record_for, step,
)
from core.tests.poc_knowledge.test_question_template_writer import fixture as template_fixture


def handoff(*, exchanges=None):
    value = handoff_fixture()
    value["interaction_contract"] = CONTRACT
    if exchanges is not None:
        value["continuation"] = {"root_question_turn_id": "c" * 32, "clarification_turn_id": "d" * 32,
                                 "exchanges": exchanges}
    value["input_sha256"] = canonical_json_hash({key: item for key, item in value.items() if key != "input_sha256"})
    return value


def interactive_step(action, **values):
    return step(action, **{"clarification_options": None, "clarification_option_details": None, **values})


def prompt_data(prompt):
    return json.JSONDecoder().raw_decode(prompt[prompt.index('{"'):])[0]


class InteractionContractTests(unittest.TestCase):
    def test_optional_details_validate_exact_choices_without_changing_plain_payloads(self):
        self.assertEqual(clarification("범위?", ["요약", "상세"]), {"options": ["요약", "상세"]})
        self.assertEqual(clarification("범위?", ["요약"], None), {"options": ["요약"]})
        detail = {"option": "요약", "description": "빠르게 파악하려는 목적에 맞습니다.", "recommended": True}
        result = clarification("범위?", ["요약", "상세"], [detail])
        self.assertEqual(result["option_details"], [detail])
        result["option_details"][0]["description"] = "변경"
        self.assertNotEqual(result["option_details"][0], detail)
        invalid = [[{**detail, **change}] for change in (
            {"option": "없는 선택"}, {"description": " "}, {"description": "x" * 401},
            {"recommended": 1}, {"recommended": "true"}, {"description": "[[source:1]]"},
            {"description": "wiki-template-result"}, {"extra": "누출"})]
        invalid.extend(([detail, detail], [detail, {**detail, "option": "상세"}], {}, [None]))
        for details in invalid:
            with self.subTest(details=details), self.assertRaises(ValueError):
                clarification("범위?", ["요약", "상세"], details)

    def test_visible_choice_context_is_validated_and_preserved_in_continuation(self):
        context = {"options": ["요약"], "option_details": [
            {"option": "요약", "description": "세 문장으로 정리합니다.", "recommended": False}]}
        value = handoff(exchanges=[{"question": "어떤 형식?", "answer": "요약", "clarification": context}])
        validate_input(value)
        prompt = grounding_prompt(value, [])
        self.assertEqual(prompt_data(prompt)["continuation"]["exchanges"][0]["clarification"], context)
        self.assertIn("not as source evidence", prompt)
        value["continuation"]["exchanges"][0]["clarification"]["option_details"][0]["option"] = "없는 선택"
        with self.assertRaises(ValueError):
            validate_input(value)

    def test_provider_schema_keeps_long_answers_but_bounds_clarification(self):
        schema = step_schema(STEP_SCHEMA, handoff())
        for current in (schema, _strict_schema(schema)):
            validator = Draft202012Validator(current)
            self.assertTrue(validator.is_valid(interactive_step("answer", content="a" * 5000)))
            self.assertTrue(validator.is_valid(interactive_step("clarify", content="q" * 4000)))
            self.assertFalse(validator.is_valid(interactive_step("clarify", content="q" * 4001)))
            self.assertFalse(validator.is_valid(interactive_step("clarify", content="질문?", query="내부 조회")))

    def test_opt_in_handoff_and_record_are_part_of_the_frozen_fingerprint(self):
        value = handoff(exchanges=[{"question": "어느 범위인가요?", "answer": "국내만 작성해 주세요."}])
        record = record_for(value)
        record["data"].update({key: deepcopy(value[key]) for key in ("interaction_contract", "continuation")})
        prompt = assemble_question(value, record)
        self.assertEqual(prompt_data(prompt)["continuation"], value["continuation"])
        self.assertEqual(prompt_data(prompt)["question"], value["question"])
        changed = deepcopy(value)
        changed["continuation"]["exchanges"][0]["answer"] = "다른 답변"
        with self.assertRaisesRegex(AnalysisClientError, "question_input_mismatch"):
            assemble_question(changed, record)
        del record["data"]["interaction_contract"]
        with self.assertRaisesRegex(AnalysisClientError, "question_input_mismatch"):
            assemble_question(value, record)

    def test_unopted_schema_prompt_and_payload_contract_remain_unchanged(self):
        old = handoff_fixture()
        self.assertIs(step_schema(STEP_SCHEMA, old), STEP_SCHEMA)
        self.assertNotIn("clarification", question_answer_schema(old)["properties"])
        self.assertNotIn("continuation", prompt_data(grounding_prompt(old, [])))
        self.assertNotIn("clarification_options", STEP_SCHEMA["properties"])
        self.assertNotIn("clarification_option_details", STEP_SCHEMA["properties"])
        self.assertEqual(part_schema([{"id": "f1"}])["properties"]["action"]["enum"], ["write_fields", "clarify"])

    def test_continuation_shape_and_bounds_are_checked(self):
        base = handoff(exchanges=[{"question": "확인?", "answer": "답변"}])
        variants = []
        value = deepcopy(base); del value["interaction_contract"]; variants.append(value)
        value = deepcopy(base); value["interaction_contract"] = "future"; variants.append(value)
        value = deepcopy(base); value["continuation"]["root_question_turn_id"] = "bad"; variants.append(value)
        value = deepcopy(base); value["continuation"]["exchanges"] *= 6; variants.append(value)
        value = deepcopy(base); value["continuation"]["exchanges"][0]["question"] = "q" * 4001; variants.append(value)
        value = deepcopy(base); value["continuation"]["exchanges"][0]["answer"] = "a" * 16001; variants.append(value)
        value = deepcopy(base); value["continuation"]["exchanges"][0]["answer"] = " "; variants.append(value)
        value = deepcopy(base); value["continuation"]["exchanges"][0]["approved"] = True; variants.append(value)
        for value in variants:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_input(value)

    def test_clarification_partial_json_and_internal_plan_are_not_streamed(self):
        events = []
        preview = GroundedAnswerPreview(lambda kind, **data: events.append((kind, data)), clock=lambda: 1)
        raw = json.dumps(interactive_step("clarify", content="어떤 범위인가요?"), ensure_ascii=False)
        for end in range(len(raw) + 1):
            preview({"type": "agent_message", "kind": "structured_output", "text": raw[:end], "event": "item.completed"})
        self.assertEqual(events, [])


class InteractionExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    async def test_clarify_returns_once_with_choices_and_save_payload(self):
        value = handoff()
        owner = FakeOwner(self.root)
        question = interactive_step("clarify", content="작성할 대상 범위를 선택해 주세요.")
        question["clarification_options"] = ["국내", "해외"]
        adapter = FakeAdapter([question, interactive_step("answer", content="호출되면 안 됨")])
        result, prompt = await run_grounded_model(owner, adapter, value)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(owner.queries, [])
        self.assertIn("anyOf", adapter.calls[0]["schema"])
        self.assertNotIn("anyOf", adapter.calls[0]["options"]["output_schema"])
        self.assertEqual(result["value"]["clarification"], {"options": ["국내", "해외"]})
        payload = answer_payload(result, handoff=value, prompt=prompt)
        self.assertEqual(payload["clarification"], result["value"]["clarification"])
        self.assertEqual(payload["content"], question["content"])
        self.assertEqual(payload["evidence_ids"], [])

    async def test_contextual_details_survive_citation_render_and_save_without_requiring_recommendation(self):
        for recommended in (False, True):
            with self.subTest(recommended=recommended):
                value = handoff()
                owner = FakeOwner(self.root / str(recommended), [evidence()])
                details = [{"option": "요약", "description": "빠른 검토를 위해 세 문장으로 정리합니다.",
                            "recommended": recommended}]
                adapter = FakeAdapter([interactive_step("read", material_id="d1"), interactive_step(
                    "clarify", content="키 조건 [[s1:2:2]]을 어떤 깊이로 정리할까요?", evidence_ids=["s1:2:2"],
                    clarification_options=["요약", "상세"], clarification_option_details=details)])
                result, prompt = await run_grounded_model(owner, adapter, value)
                payload = answer_payload(result, handoff=value, prompt=prompt)
                self.assertEqual(payload["clarification"], {"options": ["요약", "상세"], "option_details": details})
                self.assertIn("[1]", payload["content"])
                self.assertNotIn("[[", payload["content"])
                self.assertEqual(len(adapter.calls), 2)
                self.assertIn("use null when plain choices are enough", prompt)
                self.assertIn("Do not add generic descriptions or recommendations", prompt)
                # 제출 직전에도 선택지와 메타데이터의 관계를 재검사합니다.
                result["value"]["clarification"]["option_details"][0]["option"] = "없는 선택"
                with self.assertRaises(AnalysisClientError):
                    answer_payload(result, handoff=value, prompt=prompt)

    async def test_details_are_rejected_for_normal_answers_and_invalid_clarifications(self):
        detail = {"option": "요약", "description": "빠른 검토에 적합합니다.", "recommended": True}
        variants = [interactive_step("answer", content="최종 답변", clarification_option_details=[detail]),
            interactive_step("clarify", content="형식?", clarification_option_details=[detail]),
            interactive_step("clarify", content="형식?", clarification_options=["요약", "상세"],
                             clarification_option_details=[detail, {**detail, "option": "상세"}])]
        for index, invalid in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(AIAdapterError):
                await run_grounded_model(FakeOwner(self.root / str(index)), FakeAdapter([invalid]), handoff())

    async def test_incompatible_development_modes_fail_before_any_model_or_read(self):
        for option in ("cover_question", "batch_queries"):
            with self.subTest(option=option):
                owner, adapter = FakeOwner(self.root / option), FakeAdapter([])
                with self.assertRaisesRegex(AIAdapterError, "ai_invalid_input"):
                    await run_grounded_model(owner, adapter, handoff(), **{option: True})
                self.assertEqual(adapter.calls, [])
                self.assertEqual(owner.queries, [])

    async def test_clarify_preserves_validated_citations_and_null_options(self):
        value = handoff()
        owner = FakeOwner(self.root, [evidence()])
        adapter = FakeAdapter([interactive_step("read", material_id="d1"),
            interactive_step("clarify", content="키가 필요한 조건 [[s1:2:2]]을 어느 대상에 적용할까요?", evidence_ids=["s1:2:2"])])
        result, prompt = await run_grounded_model(owner, adapter, value)
        payload = answer_payload(result, handoff=value, prompt=prompt)
        self.assertEqual(payload["clarification"], {"options": []})
        self.assertIn("[1]", payload["content"])
        self.assertNotIn("s1:", payload["content"])
        self.assertEqual(len(payload["citations"]), 1)

    async def test_received_reply_is_in_original_context_for_final_or_another_question(self):
        exchanges = [{"question": "어느 범위인가요?", "answer": "국내로 작성해 주세요."}]
        value = handoff(exchanges=exchanges)
        for action in ("answer", "clarify"):
            with self.subTest(action=action):
                owner = FakeOwner(self.root / action)
                content = "국내 범위의 자료가 제공되지 않아 사실을 확정할 수 없습니다." if action == "answer" else "국내 대상 중 시범 운영 범위를 선택해 주세요."
                adapter = FakeAdapter([interactive_step(action, content=content)])
                result, prompt = await run_grounded_model(owner, adapter, value)
                data = prompt_data(prompt)
                self.assertEqual(data["continuation"]["exchanges"], exchanges)
                self.assertEqual(data["question"], value["question"])
                self.assertEqual(data["materials"], value["basis"])
                self.assertIn("not factual source evidence, expert approval", prompt)
                self.assertEqual("clarification" in result["value"], action == "clarify")
                self.assertEqual(len(adapter.calls), 1)

    async def test_five_replies_remove_clarify_but_allow_honest_final_answer(self):
        value = handoff(exchanges=[{"question": "확인?", "answer": "아직 미정입니다."}] * 5)
        owner = FakeOwner(self.root)
        adapter = FakeAdapter([interactive_step("answer", content="필수 결정이 미정이어서 결과를 확정할 수 없습니다.")])
        result, prompt = await run_grounded_model(owner, adapter, value)
        self.assertNotIn("clarify", adapter.calls[0]["schema"]["properties"]["action"]["enum"])
        self.assertNotIn("clarification", result["value"])
        self.assertIn("five-question clarification limit", prompt)
        self.assertNotIn("clarification", question_answer_schema(value)["properties"])

    async def test_bad_clarification_or_options_never_become_a_saved_answer(self):
        variants = [interactive_step("clarify", content="q" * 4001),
                    interactive_step("clarify", content=" "),
                    interactive_step("clarify", content="질문?", query="internal"),
                    interactive_step("clarify", content="```wiki-template-result 내부 계획")]
        for options in (["a", "b", "c", "d"], ["a", "a"], [" "], ["a" * 201], ["[[s1:1:1]]"]):
            value = interactive_step("clarify", content="질문?"); value["clarification_options"] = options; variants.append(value)
        value = interactive_step("answer", content="최종 본문"); value["clarification_options"] = ["선택"]; variants.append(value)
        for index, value in enumerate(variants):
            owner = FakeOwner(self.root / str(index))
            with self.subTest(value=value), self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, FakeAdapter([value]), handoff())
            self.assertFalse(any(event[0] == "answer_preview" for event in owner.events))

    async def test_old_run_rejects_new_clarify_shape(self):
        owner = FakeOwner(self.root)
        with self.assertRaises(AIAdapterError):
            await run_grounded_model(owner, FakeAdapter([interactive_step("clarify", content="질문?")]), handoff_fixture())

    async def test_template_clarification_discards_plan_and_propagates_capability_only(self):
        for opted in (False, True):
            with self.subTest(opted=opted):
                value, detail, registry, reads, parts = template_fixture()
                if opted:
                    value.update(interaction_contract=CONTRACT, continuation=handoff(exchanges=[
                        {"question": "범위?", "answer": "국내"}])["continuation"])
                parts[1] = {"action": "clarify", "replacements": [], "clarification": "국내 대상의 필수 조건을 선택해 주세요."}
                owner, adapter = FakeOwner(self.root / str(opted)), FakeAdapter(parts)
                result, prompt = await run_template_parts(owner, adapter, value, reads, registry, [], detail, max_bytes=192 * 1024)
                self.assertEqual(len(adapter.calls), 2)
                self.assertNotIn("wiki-template-result", result["value"]["content"])
                self.assertEqual("clarification" in result["value"], opted)
                if opted:
                    self.assertEqual(result["value"]["clarification"], {"options": []})
                    self.assertEqual(prompt_data(prompt)["continuation"], value["continuation"])
                self.assertFalse(result["execution"]["question_template_parts"]["complete"])

    async def test_template_question_can_optionally_explain_and_recommend_choices(self):
        value, detail, registry, reads, parts = template_fixture()
        value["interaction_contract"] = CONTRACT
        options = ["요약", "상세"]
        details = [{"option": "요약", "description": "보고서의 개요부터 검토할 수 있습니다.", "recommended": True}]
        parts[0] = {"action": "clarify", "replacements": [], "clarification": "어떤 깊이로 작성할까요?",
                    "clarification_options": options, "clarification_option_details": details}
        owner, adapter = FakeOwner(self.root), FakeAdapter(parts)
        result, prompt = await run_template_parts(owner, adapter, value, reads, registry, [], detail, max_bytes=192 * 1024)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(result["value"]["clarification"], {"options": options, "option_details": details})
        self.assertEqual(answer_payload(result, handoff=value, prompt=prompt)["clarification"], result["value"]["clarification"])
        self.assertNotIn("wiki-template-result", result["value"]["content"])
        self.assertIn("clarification_option_details", adapter.calls[0]["schema"]["properties"])

    async def test_template_at_limit_can_finish_or_stop_without_another_question(self):
        for stop in (False, True):
            with self.subTest(stop=stop):
                value, detail, registry, reads, parts = template_fixture()
                value.update(interaction_contract=CONTRACT, continuation=handoff(exchanges=[
                    {"question": "필수 조건?", "answer": "미정"}] * 5)["continuation"])
                if stop:
                    parts[1] = {"action": "stop", "replacements": [], "clarification": "필수 조건이 미정이어서 문서를 완성할 수 없습니다."}
                owner, adapter = FakeOwner(self.root / str(stop)), FakeAdapter(parts)
                result, prompt = await run_template_parts(owner, adapter, value, reads, registry, [], detail, max_bytes=192 * 1024)
                self.assertEqual(adapter.calls[0]["schema"]["properties"]["action"]["enum"], ["write_fields", "stop"])
                self.assertNotIn("clarification", result["value"])
                self.assertEqual(result["execution"]["question_template_parts"]["complete"], not stop)
                self.assertEqual("wiki-template-result" in result["value"]["content"], not stop)
                self.assertIn("action=stop", prompt)
                self.assertEqual(len(adapter.calls), 2 if stop else 3)


if __name__ == "__main__":
    unittest.main()
