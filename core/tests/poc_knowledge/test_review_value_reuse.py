"""An event reuses only successful validation of the same typed JSON value."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.reviews.contracts import ReviewCorruptError, ReviewValidationError
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES


class ReviewValueReuseTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(plain=True)
        self.generate()

    def review(self, action, **options):
        current = self.reviews.query("a.md")
        return self.reviews.review("a.md", action=action, claim_id=current["claims"][0]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated value validation", actor=ACTOR,
            **options)

    def raw(self):
        with self.wiki._write_lock():
            return self.reviews._read_bytes("a.md")

    def read_ledger(self, raw):
        with self.wiki._write_lock():
            return self.reviews._ledger(raw, "a.md")

    def encode_changed(self, event, **changes):
        result = deepcopy(event)
        result.update(changes)
        result["hash"] = canonical_json_hash({key: value for key, value in result.items() if key != "hash"})
        ledger = json.loads(self.raw())
        ledger["events"] = [result]
        return canonical_json_bytes(ledger)

    def test_equal_values_validate_once_per_event_but_again_on_every_read(self):
        self.review("accept")
        raw = self.raw()
        before = self.tree()
        with patch.object(self.reviews, "_check_saved_value", wraps=self.reviews._check_saved_value) as checked:
            first = self.read_ledger(raw)
            self.assertEqual(checked.call_count, 1)
            second = self.read_ledger(raw)
            self.assertEqual(checked.call_count, 2)
        self.assertEqual(canonical_json_bytes(first), canonical_json_bytes(json.loads(raw)))
        self.assertEqual(first, second)
        self.assertEqual(self.tree(), before)

    def test_edit_and_chained_states_are_validated_in_each_event_context(self):
        self.review("accept")
        replacement = _input(self.reviews.query("a.md")["claims"][0]["value"])
        replacement["predicate"] = "depends_on"
        self.review("edit", replacement=replacement)
        self.review("accept")
        raw = self.raw()
        before = self.tree()
        with patch.object(self.reviews, "_check_saved_value", wraps=self.reviews._check_saved_value) as checked:
            result = self.read_ledger(raw)
        self.assertEqual(checked.call_count, 5)  # 1 accept, 2 edit, 2 later accept.
        self.assertEqual(canonical_json_bytes(result), canonical_json_bytes(json.loads(raw)))
        self.assertEqual(self.tree(), before)

    def test_candidate_promotion_still_validates_the_different_after_value(self):
        current = self.reviews.query("a.md")
        candidate = {"id": "maybe", "subject": "a", "predicate": "uses", "object": "b",
                     "evidence": "A uses B.", "reason": "insufficient evidence", "question": "Does A use B?"}
        self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), [], [candidate],
            expected_state_revision=current["state_revision"])
        self.review("accept")
        raw = self.raw()
        with patch.object(self.reviews, "_check_saved_value", wraps=self.reviews._check_saved_value) as checked:
            ledger = self.read_ledger(raw)
        self.assertEqual(checked.call_count, 2)
        self.assertNotEqual(ledger["events"][0]["target"]["claim"], ledger["events"][0]["after"]["value"])
        self.assertEqual(self.reviews.query("a.md")["effective_graph"]["relation_candidates"], [])
        self.assertEqual(len(self.reviews.query("a.md")["effective_graph"]["relations"]), 1)

    def test_bool_and_float_evidence_are_not_treated_as_the_valid_integer(self):
        self.review("accept")
        event = json.loads(self.raw())["events"][0]
        self.assertEqual(event["target"]["claim"]["evidence"]["start_line"], 1)
        before = self.tree()
        for phase in ("before", "after"):
            for changed in (True, 1.0):
                state = deepcopy(event[phase])
                state["value"]["evidence"]["start_line"] = changed
                self.assertEqual(state["value"], event["target"]["claim"])
                with self.subTest(phase=phase, type=type(changed).__name__), \
                        self.assertRaises(ReviewCorruptError):
                    self.read_ledger(self.encode_changed(event, **{phase: state}))
        self.assertEqual(self.tree(), before)

    def test_wrong_values_decisions_hashes_and_chain_still_fail(self):
        self.review("accept")
        event = json.loads(self.raw())["events"][0]
        changed = deepcopy(event["after"])
        changed["value"]["predicate"] = "unknown_predicate"
        mutations = [{"after": changed}, {"before": {**event["before"], "decision": "accept"}},
                     {"previous_hash": "a" * 64}, {"after": {"decision": "unknown", "value": event["after"]["value"]}}]
        for fields in mutations:
            with self.subTest(fields=tuple(fields)), self.assertRaises(ReviewCorruptError):
                self.read_ledger(self.encode_changed(event, **fields))
        malformed = json.loads(self.raw())
        malformed["events"][0]["hash"] = "0" * 64
        with self.assertRaises(ReviewCorruptError):
            self.read_ledger(canonical_json_bytes(malformed))

    def test_policy_state_checks_are_not_deduplicated(self):
        current = self.reviews.query("a.md")
        replacement = _input(current["claims"][0]["value"])
        replacement.pop("evidence")
        replacement.pop("provenance")
        self.reviews.policy("a.md", claim_id=current["claims"][0]["claim_id"], replacement=replacement,
            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        raw = self.raw()
        with patch.object(self.reviews, "_policy_state", wraps=self.reviews._policy_state) as policy:
            result = self.read_ledger(raw)
        self.assertEqual(policy.call_count, 2)
        self.assertEqual(result["events"][0]["action"], "policy")
        event = deepcopy(result["events"][0])
        event["after"]["value"]["context"]["viewpoints"] = ["business"]
        with self.assertRaises(ReviewCorruptError):
            self.read_ledger(self.encode_changed(event))

    def test_failed_validation_is_not_reused_on_the_next_read(self):
        self.review("accept")
        raw = self.raw()
        original = self.reviews._check_saved_value
        calls = 0

        def fail_once(*arguments):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ReviewValidationError("isolated validation failure")
            return original(*arguments)

        with patch.object(self.reviews, "_check_saved_value", side_effect=fail_once):
            with self.assertRaises(ReviewCorruptError):
                self.read_ledger(raw)
            self.assertEqual(self.read_ledger(raw)["events"][0]["action"], "accept")
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
