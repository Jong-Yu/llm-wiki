"""Faster review copies preserve bytes, ownership of mutable data and validation."""

from contextlib import contextmanager
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.aggregation import history_query, review_queue
from core.modules.knowledge.impact import ImpactStore
from core.modules.reviews import cleanup_state, render, values
from core.modules.reviews.cleanup import CleanupStore
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR


@contextmanager
def original_copies():
    with patch.object(render, "_copy_value", deepcopy), \
            patch.object(cleanup_state, "_copy_value", deepcopy):
        yield


class ReviewCopyTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(body="A uses B.\nB uses A.\n[Other](b.md)\n")
        self.document("b.md")
        self.generate("b.md")
        self.ontology.generate("a.md", self.wiki.read("a.md").revision,
            [{"id": value.lower(), "label": value, "type": "system", "evidence": "A uses B."}
             for value in "AB"],
            [{"subject": a, "predicate": "uses", "object": b, "evidence": text}
             for a, b, text in (("a", "b", "A uses B."), ("b", "a", "B uses A."))])

    def compare(self, query=None):
        query = query or (lambda: self.reviews.query("a.md"))
        before = self.tree()
        with original_copies():
            expected = query()
        actual = query()
        self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))
        self.assertEqual(self.tree(), before)
        return actual

    def test_json_scalars_nested_values_and_internal_aliases_match_deepcopy(self):
        shared = [{"text": "한글", "numbers": [0, -7, 2 ** 70, -0.0, 1.25, True, False, None]}]
        original = {"first": shared, "second": shared, "nested": {"same": shared}}
        actual = values._copy_value(original)
        self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(deepcopy(original)))
        self.assertIs(actual["first"], actual["second"])
        self.assertIs(actual["first"], actual["nested"]["same"])
        self.assertIsNot(actual["first"], shared)
        actual["first"][0]["numbers"].append(99)
        self.assertNotIn(99, shared[0]["numbers"])
        self.assertNotIn(99, values._copy_value(original)["first"][0]["numbers"])

    def test_cycles_subclasses_and_non_json_values_keep_deepcopy_fallback(self):
        class TaggedString(str):
            pass

        tagged = TaggedString("text")
        tagged.extra = []
        original = {1: bytearray(b"body"), "set": {1, 2}, "tuple": ([3],), "tagged": tagged}
        actual = values._copy_value(original)
        self.assertEqual(actual, deepcopy(original))
        actual[1].append(0)
        actual["tuple"][0].append(4)
        actual["tagged"].extra.append(5)
        self.assertEqual(original[1], bytearray(b"body"))
        self.assertEqual(original["tuple"], ([3],))
        self.assertEqual(original["tagged"].extra, [])
        cycle = {"list": []}
        cycle["self"] = cycle
        cycle["list"].append(cycle)
        copied = values._copy_value(cycle)
        self.assertIs(copied["self"], copied)
        self.assertIs(copied["list"][0], copied)

    def test_review_policy_cleanup_and_undo_preserve_entire_dto_and_ledger(self):
        current = self.compare()
        self.reviews.review("a.md", action="accept", claim_id=current["claims"][0]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated acceptance", actor=ACTOR)
        current = self.compare()
        replacement = values._input(current["claims"][0]["value"])
        replacement["predicate"] = "depends_on"
        for name in ("evidence", "provenance"):
            replacement.pop(name)
        self.reviews.policy("a.md", claim_id=current["claims"][0]["claim_id"], replacement=replacement,
            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        current = self.compare()
        self.reviews.review("a.md", action="reject", claim_id=current["claims"][1]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated rejection", actor=ACTOR)
        cleanup = CleanupStore(self.wiki, ACTOR)
        preview = self.compare(lambda: cleanup.preview("a.md"))
        receipt = cleanup.apply("a.md", request_id=uuid4().hex, preview_revision=preview["preview_revision"],
            item_ids=[item["item_id"] for item in preview["items"]], reason="isolated cleanup")
        self.compare()
        cleanup.undo("a.md", request_id=uuid4().hex, event_id=receipt["event_id"],
            expected_state_revision=self.reviews.query("a.md")["state_revision"], reason="isolated undo")
        self.compare()

    def test_pending_missing_and_corrupt_graph_results_match_original(self):
        self.accept()
        current = self.wiki.read("a.md")
        self.wiki.save("a.md", current.content + "Changed source.\n", expected_revision=current.revision)
        self.assertEqual(self.compare()["status"], "stale")
        graph = self.ontology._path("a.md")
        malformed = json.loads(graph.read_bytes())
        graph.unlink()
        self.assertEqual(self.compare()["status"], "missing")
        malformed["relations"][0]["evidence"]["start_line"] = 0
        graph.write_bytes(canonical_json_bytes(malformed))
        self.assertEqual(self.compare()["status"], "unavailable")

    def test_returned_claims_current_claims_graphs_history_and_next_query_are_isolated(self):
        self.accept()
        current = self.compare()
        expected = deepcopy(current)
        current["claims"][0]["value"]["qualifiers"]["condition"] = "changed claim"
        current["current_claims"][0]["reviewed_value"]["qualifiers"]["scope"] = "changed current"
        current["effective_graph"]["entities"][0]["label"] = "changed effective entity"
        current["history"][0]["target"]["claim"]["evidence"]["quote"] = "changed history"
        self.assertEqual(current["machine_graph"], expected["machine_graph"])
        self.assertEqual(current["claims"][0]["reviewed_value"], expected["claims"][0]["reviewed_value"])
        self.assertEqual(self.reviews.query("a.md"), expected)

    def test_aggregate_pages_impact_and_effective_validation_remain_unchanged(self):
        for query in (
            lambda: history_query(self.wiki, ACTOR, documents=["a.md", "b.md"],
                correspondence_ids=[], job_ids=[], limit=1),
            lambda: review_queue(self.wiki, ACTOR, documents=["a.md", "b.md"],
                correspondence_ids=[], states=["unreviewed", "pending"], limit=1),
            lambda: ImpactStore(self.wiki).query("a.md"),
        ):
            self.compare(query)
        with patch.object(self.reviews, "_validate_effective", wraps=self.reviews._validate_effective) as validate:
            self.reviews.query("a.md")
        self.assertEqual(validate.call_count, 2)
        failure = ValueError("isolated effective validation failure")
        for reference in (False, True):
            with self.subTest(reference=reference), \
                    patch.object(self.reviews, "_validate_effective", side_effect=failure):
                with self.assertRaisesRegex(ValueError, "Current reviewed graph is inconsistent"):
                    if reference:
                        with original_copies():
                            self.reviews.query("a.md")
                    else:
                        self.reviews.query("a.md")


if __name__ == "__main__":
    unittest.main()
