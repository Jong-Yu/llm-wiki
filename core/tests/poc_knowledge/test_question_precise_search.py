"""검색어 선택 안내를 첫 실제 검색 전에만 제공하고 기존 계약을 유지한다."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.client.ai.contracts import AIAdapterError
from core.client.question_grounding import (
    STEP_SCHEMA, _PRECISE_SEARCH_GUIDE, grounding_prompt, initial_grounding_prompt, run_grounded_model,
)
from core.tests.poc_knowledge.test_question_grounding_client import FakeAdapter, FakeOwner, evidence, step
from core.tests.poc_knowledge.test_question_tool_selection import (
    empty_evidence, payload, read_fixture, selection_handoff,
)


class PreciseSearchPromptTests(unittest.TestCase):
    def setUp(self):
        self.handoff = selection_handoff()

    def test_default_false_preserves_prechange_tool_selection_prompt_bytes(self):
        fingerprints = {"initial": "0daea27d8da2baf4322384125984bad2e5f1d2415be76e0acbf329b95a2f9c90",
                        "search": "bb89b67cd7bea225ad535e46887b22752cdd3d4855e09e8896045014549a015a",
                        "read": "62e3c7ec9745b82d22bcc3e41f6452157e774104c8fd79f3a543e000c0924753"}
        for action, expected in fingerprints.items():
            reads = [] if action == "initial" else [read_fixture(action)]
            actual = grounding_prompt(self.handoff, reads, select_tools=True)
            self.assertEqual(sha256(actual.encode()).hexdigest(), expected)
            self.assertEqual(actual, grounding_prompt(self.handoff, reads, select_tools=True, precise_search=False))
        self.assertEqual(initial_grounding_prompt(self.handoff, select_tools=True),
                         initial_grounding_prompt(self.handoff, select_tools=True, precise_search=False))

    def test_guidance_precedes_first_search_with_all_original_data_and_schema(self):
        before, schema = deepcopy(self.handoff), deepcopy(STEP_SCHEMA)
        base = initial_grounding_prompt(self.handoff, select_tools=True)
        precise = initial_grounding_prompt(self.handoff, select_tools=True, precise_search=True)
        self.assertIn(_PRECISE_SEARCH_GUIDE, precise)
        self.assertNotIn(_PRECISE_SEARCH_GUIDE, base)
        self.assertEqual(payload(base), payload(precise))
        self.assertEqual(before, self.handoff)
        self.assertEqual(schema, STEP_SCHEMA)
        self.assertIn(self.handoff["instructions"], precise)
        for marker in ("each requested part", "Any query term can match", "Keep necessary qualifiers",
                       "refine the terms or read surrounding source", "neighboring passages/definitions/exceptions",
                       "only actually returned evidence IDs", "A failed or empty search does not prove absence"):
            self.assertIn(marker, precise)

    def test_guidance_persists_until_first_search_then_existing_search_detail_is_unchanged(self):
        for action in ("read", "claims", "history", "dialogue"):
            prompt = grounding_prompt(self.handoff, [read_fixture(action)], select_tools=True, precise_search=True)
            self.assertIn(_PRECISE_SEARCH_GUIDE, prompt)
        reads = [read_fixture("search")]
        baseline = grounding_prompt(self.handoff, reads, select_tools=True)
        precise = grounding_prompt(self.handoff, reads, select_tools=True, precise_search=True)
        self.assertEqual(precise, baseline)
        self.assertNotIn(_PRECISE_SEARCH_GUIDE, precise)
        self.assertIn("specific terms, names or standard numbers", precise)

    def test_exact_bool_required_and_instruction_bytes_count_toward_limit(self):
        for value in (None, 0, 1, "true", [], {}):
            for entry, args in ((initial_grounding_prompt, (self.handoff,)), (grounding_prompt, (self.handoff, []))):
                with self.assertRaises(AIAdapterError):
                    entry(*args, select_tools=True, precise_search=value)
        for entry, args in ((initial_grounding_prompt, (self.handoff,)), (grounding_prompt, (self.handoff, []))):
            with self.assertRaises(AIAdapterError):
                entry(*args, precise_search=True)
        prompt = initial_grounding_prompt(self.handoff, select_tools=True, precise_search=True)
        with patch("core.client.question_grounding.MAX_CONTEXT_BYTES", len(prompt.encode())-1):
            with self.assertRaises(AIAdapterError) as caught:
                initial_grounding_prompt(self.handoff, select_tools=True, precise_search=True)
            self.assertEqual(caught.exception.code, "ai_input_limit")


class PreciseSearchLoopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.handoff = selection_handoff()

    async def test_first_search_runs_immediately_and_uses_two_model_calls(self):
        adapter = FakeAdapter([step("search", query="Alpha"),
                               step("answer", content="Configured only with a key [[s1:2:2]].", evidence_ids=["s1:2:2"])])
        owner = FakeOwner(self.root/"run", [evidence()])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, select_tools=True, precise_search=True)
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(len(owner.queries), 1)
        self.assertEqual(owner.queries[0]["query"], "Alpha")
        self.assertEqual(adapter.calls[0]["prompt"], initial_grounding_prompt(self.handoff, select_tools=True, precise_search=True))
        self.assertIn(_PRECISE_SEARCH_GUIDE, adapter.calls[0]["prompt"])
        self.assertNotIn(_PRECISE_SEARCH_GUIDE, adapter.calls[1]["prompt"])
        self.assertEqual(adapter.calls[0]["schema"], STEP_SCHEMA)
        self.assertEqual(result["evidence_ids"], ["s1:2:2"])

    async def test_empty_search_allows_read_fallback_without_a_classifier(self):
        adapter = FakeAdapter([step("search", query="Alpha"), step("read", material_id="d1", start_line=2, line_count=1),
                               step("answer", content="Configured only with a key [[s1:2:2]].", evidence_ids=["s1:2:2"])])
        owner = FakeOwner(self.root/"fallback", [empty_evidence(), evidence()])
        await run_grounded_model(owner, adapter, self.handoff, select_tools=True, precise_search=True)
        self.assertEqual(len(adapter.calls), 3)
        self.assertEqual([q["action"] for q in owner.queries], ["search", "read"])
        self.assertIn("A failed or empty search does not prove absence", adapter.calls[1]["prompt"])

    async def test_invalid_options_stop_before_any_model_query_or_adapter_mutation(self):
        variants = [{"select_tools": True, "precise_search": x} for x in (None, 0, 1, "true", [], {})]
        variants += [{"precise_search": True}]
        variants += [{"select_tools": True, "precise_search": True, name: True}
                     for name in ("check_draft", "cover_question", "batch_queries")]
        for index, options in enumerate(variants):
            adapter = FakeAdapter([])
            owner = FakeOwner(self.root/str(index))
            with self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, self.handoff, **options)
            self.assertEqual(adapter.calls, [])
            self.assertEqual(owner.queries, [])
            self.assertTrue(adapter.persist_session)

    async def test_false_preserves_complete_existing_tool_selection_records(self):
        outputs, records = [], []
        for name, options in (("default", {}), ("false", {"precise_search": False})):
            directory = self.root/name
            owner = FakeOwner(directory, [evidence()])
            adapter = FakeAdapter([step("search", query="Alpha"),
                                   step("answer", content="Only with a key [[s1:2:2]].", evidence_ids=["s1:2:2"])])
            value = await run_grounded_model(owner, adapter, self.handoff, select_tools=True, **options)
            outputs.append((value, owner.events, owner.queries))
            records.append({str(f.relative_to(directory)): f.read_bytes() for f in directory.rglob("*") if f.is_file()})
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(records[0], records[1])


if __name__ == "__main__":
    unittest.main()
