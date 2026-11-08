"""동일 근거의 참조 표현이 원문·회차 상태·최종 인용을 보존하는지 확인한다."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.client.ai.contracts import AIAdapterError
from core.client.question_grounding import MAX_CONTEXT_BYTES, grounding_prompt, run_grounded_model
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeOwner, evidence, handoff_fixture, step,
)


def payload(prompt):
    return json.loads(prompt.rsplit("\n", 1)[1])


def expand(reads):
    """생성기의 seen/key 계산을 쓰지 않고 위치 참조에서 원래 항목을 복원한다."""
    original = deepcopy(reads)
    for row_index, row in enumerate(original):
        for item_index, item in enumerate(row.get("result", {}).get("items", [])):
            if set(item) != {"evidence_id", "same_item_as"}:
                continue
            read_number, item_number = item["same_item_as"]
            assert (read_number - 1, item_number - 1) < (row_index, item_index)
            source = original[read_number - 1]["result"]["items"][item_number - 1]
            assert "same_item_as" not in source and source["evidence_id"] == item["evidence_id"]
            row["result"]["items"][item_index] = deepcopy(source)
    return original


def reads_for(items):
    return [{"query": {"action": "read", "material_id": "d1", "start_line": index + 1},
        "result": {"items": values, "evidence_ids": [v["evidence_id"] for v in values],
            "complete": index == 0, "truncated": index != 0,
            "skipped": [] if index == 0 else [{"code": "source_window_partial"}],
            "next_offset": None if index == 0 else 2, "total_matches": len(values),
            "scope": {"absence_proven": False, "completion_scope": "requested_source_window"},
            "read_window": {"requested_range": [1, 20], "returned_ranges": [[1, 8]],
                "remaining_ranges": [[9, 20]], "unavailable_ranges": [[5, 5]], "next_start_line": 9}}}
        for index, values in enumerate(items)]


class PromptCompactionTests(unittest.TestCase):
    def setUp(self):
        self.handoff = handoff_fixture()
        self.item = {"kind": "source", "evidence_id": "s1:1:8", "source_revision": "a" * 64,
            "material_id": "d1", "start_line": 1, "end_line": 8,
            "text": "점검을 마친 경우에만 시작한다. 예외와 부정 조건을 보존한다.\n" * 80}

    def plain_prompt(self, reads):
        with patch("core.client.question_grounding._deduplicated_reads", side_effect=lambda value: value):
            return grounding_prompt(self.handoff, reads)

    def test_exact_items_reconstruct_all_queries_states_and_source_text_without_mutation(self):
        reads = reads_for([[self.item], [deepcopy(self.item)], [deepcopy(self.item)]])
        before = deepcopy(reads)
        result = grounding_prompt(self.handoff, reads)
        compact = payload(result)["evidence_reads"]
        self.assertEqual(expand(compact), before)
        self.assertEqual(reads, before)
        self.assertEqual(compact[0]["result"]["items"][0], self.item)
        self.assertEqual(compact[2]["result"]["items"][0]["same_item_as"], [1, 1])
        self.assertLess(len(result.encode()), len(self.plain_prompt(reads).encode()))

    def test_same_id_different_revision_kind_text_or_array_order_is_not_merged(self):
        variants = [{**self.item, "source_revision": "b" * 64}, {**self.item, "kind": "review"},
                    {**self.item, "text": self.item["text"] + "다른 조건"},
                    {**self.item, "conditions": ["first", "second"]},
                    {**self.item, "conditions": ["second", "first"]}]
        reads = reads_for([[self.item], variants])
        result = grounding_prompt(self.handoff, reads)
        self.assertEqual(result, self.plain_prompt(reads))
        self.assertEqual(payload(result)["evidence_reads"], reads)

    def test_identical_text_with_different_evidence_id_is_not_merged(self):
        reads = reads_for([[self.item], [{**self.item, "evidence_id": "s2:1:8"}]])
        self.assertEqual(grounding_prompt(self.handoff, reads), self.plain_prompt(reads))

    def test_variants_reference_their_first_full_item_and_never_another_reference(self):
        other = {**self.item, "kind": "authored_relation"}
        reads = reads_for([[self.item, other], [deepcopy(other), deepcopy(self.item)], [deepcopy(other)]])
        compact = payload(grounding_prompt(self.handoff, reads))["evidence_reads"]
        self.assertEqual(compact[1]["result"]["items"][0]["same_item_as"], [1, 2])
        self.assertEqual(compact[2]["result"]["items"][0]["same_item_as"], [1, 2])
        self.assertEqual(expand(compact), reads)

    def test_same_id_review_and_authored_relation_keep_both_representations(self):
        review = {**self.item, "kind": "review", "event_type": "accepted"}
        claim = {**self.item, "kind": "authored_relation", "review_status": "unreviewed"}
        reads = reads_for([[review], [claim], [deepcopy(review)]])
        compact = payload(grounding_prompt(self.handoff, reads))["evidence_reads"]
        self.assertEqual(compact[1]["result"]["items"][0], claim)
        self.assertEqual(expand(compact), reads)

    def test_nonidentical_boolean_and_number_values_are_not_collapsed(self):
        reads = reads_for([[{**self.item, "flag": True}], [{**self.item, "flag": 1}]])
        self.assertEqual(grounding_prompt(self.handoff, reads), self.plain_prompt(reads))

    def test_ref_looking_original_field_disables_compaction_for_the_entire_prompt(self):
        reads = reads_for([[self.item], [deepcopy(self.item)],
                           [{**self.item, "evidence_id": "s2:1:8", "same_item_as": [1, 1]}]])
        self.assertEqual(grounding_prompt(self.handoff, reads), self.plain_prompt(reads))

    def test_instruction_overhead_does_not_enlarge_short_or_unique_inputs(self):
        reads = reads_for([[{"evidence_id": "s1:1:1"}], [{"evidence_id": "s1:1:1"}]])
        self.assertEqual(grounding_prompt(self.handoff, reads), self.plain_prompt(reads))
        self.assertEqual(grounding_prompt(self.handoff, []), self.plain_prompt([]))

    def test_unidentified_dialogue_items_keep_their_full_turns(self):
        reads = [{"query": {"action": "dialogue"}, "result": {"items": [
            {"role": "user", "content": "이전 조건을 다시 비교해 주세요."}]}}] * 2
        self.assertEqual(grounding_prompt(self.handoff, reads), self.plain_prompt(reads))

    def test_deduplication_is_prompt_local_and_retains_unknown_fields(self):
        item = {**self.item, "extra": {"nested": {"exception": False}}}
        reads = reads_for([[item], [deepcopy(item)]])
        first = grounding_prompt(self.handoff, reads)
        second = grounding_prompt(self.handoff, reads_for([[deepcopy(item)]]))
        self.assertEqual(expand(payload(first)["evidence_reads"]), reads)
        self.assertEqual(payload(second)["evidence_reads"][0]["result"]["items"][0], item)
        self.assertNotIn("same_item_as", payload(second)["evidence_reads"][0]["result"]["items"][0])

    def test_item_key_order_does_not_change_canonical_equality(self):
        reordered = dict(reversed(list(self.item.items())))
        reads = reads_for([[self.item], [reordered]])
        compact = payload(grounding_prompt(self.handoff, reads))["evidence_reads"]
        self.assertIn("same_item_as", compact[1]["result"]["items"][0])
        self.assertEqual(expand(compact), reads)

    def test_prompt_byte_limit_still_rejects_one_byte_over_after_compaction(self):
        reads = reads_for([[self.item], [deepcopy(self.item)]])
        size = len(grounding_prompt(self.handoff, reads).encode())
        self.handoff["question"] += "x" * (MAX_CONTEXT_BYTES - size)
        prompt = grounding_prompt(self.handoff, reads)
        self.assertEqual(len(prompt.encode()), MAX_CONTEXT_BYTES)
        self.assertEqual(expand(payload(prompt)["evidence_reads"]), reads)
        self.handoff["question"] += "x"
        with self.assertRaises(AIAdapterError) as caught:
            grounding_prompt(self.handoff, reads)
        self.assertEqual(caught.exception.code, "ai_input_limit")

    def test_an_earlier_item_in_the_same_read_can_be_referenced_without_a_chain(self):
        reads = reads_for([[self.item, deepcopy(self.item), deepcopy(self.item)]])
        compact = payload(grounding_prompt(self.handoff, reads))["evidence_reads"]
        self.assertEqual(compact[0]["result"]["items"][2]["same_item_as"], [1, 1])
        self.assertEqual(expand(compact), reads)


class CompactedLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_native_steps_final_answer_ids_and_usage_with_no_extra_call(self):
        with TemporaryDirectory() as directory:
            response = evidence(quote="The original condition and its exception remain available. " * 100)
            original = deepcopy(response)
            owner = FakeOwner(Path(directory), [response, deepcopy(response)])
            adapter = FakeAdapter([step("search", query="condition"), step("read", material_id="d1"),
                step("answer", content="조건과 예외가 있습니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])])
            result, _ = await run_grounded_model(owner, adapter, handoff_fixture())
            self.assertEqual(len(adapter.calls), 3)
            self.assertEqual(len(owner.queries), 2)
            self.assertEqual(result["value"]["content"], "조건과 예외가 있습니다. [1]")
            self.assertEqual(result["evidence_ids"], ["s1:2:2"])
            self.assertEqual(result["value"]["citations"], [response["citations"][0]["citation"]])
            compact = payload(adapter.calls[-1]["prompt"])["evidence_reads"]
            self.assertIn("same_item_as", compact[1]["result"]["items"][0])
            self.assertEqual(response, original)
            self.assertEqual(result["execution"]["question_evidence_reads"], 2)
            self.assertEqual(len(result["execution"]["question_invocations"]), 3)
