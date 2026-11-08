"""Render-local entity normalization preserves claim identity and fresh reviews."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.ontology.snapshots import _query_snapshot
from core.modules.reviews import render, values
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR


class ReviewRenderReuseTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.body = "A uses B.\nB uses C.\nC uses D.\nD uses A.\n"
        self.entities = [{"id": letter.lower(), "label": letter, "type": "system", "evidence": letter}
                         for letter in "ABCD"]
        self.relations = [{"subject": a.lower(), "predicate": "uses", "object": b.lower(),
                           "evidence": f"{a} uses {b}."} for a, b in zip("ABCD", "BCDA")]
        self.document(body=self.body)
        self.regenerate()

    def regenerate(self):
        current = self.reviews.query("a.md")
        return self.ontology.generate("a.md", self.wiki.read("a.md").revision,
            deepcopy(self.entities), deepcopy(self.relations),
            expected_state_revision=current["state_revision"], force_generation=True)

    def captured(self):
        with self.wiki._write_lock():
            return self.reviews._snapshot_locked("a.md")

    def assert_reference_render(self):
        source, raw, ledger, tokens = self.captured()
        entities = _query_snapshot("a.md", source, raw)["entities"]
        helper = values._claim_id_from_identities

        def per_claim(collection, value, unused):
            # The compatibility wrapper's previous per-claim normalization.
            return helper(collection, value, values._entity_identities(entities))

        before = deepcopy(ledger)
        for policies in (True, False):
            with patch.object(values, "_claim_id_from_identities", side_effect=per_claim):
                expected = self.reviews._render(source, raw, ledger, tokens, policies=policies)
            actual = self.reviews._render(source, raw, ledger, tokens, policies=policies)
            self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))
            for claim in actual["claims"]:
                if not claim.get("authored"):
                    self.assertEqual(claim["claim_id"],
                        values._claim_id(claim["collection"], claim["value"], entities))
        self.assertEqual(ledger, before)

    def test_entire_dto_and_ids_match_before_and_after_review_edit_and_policy(self):
        self.assert_reference_render()
        current = self.reviews.query("a.md")
        self.reviews.review("a.md", action="accept", claim_id=current["claims"][0]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated acceptance", actor=ACTOR)
        self.assert_reference_render()
        current = self.reviews.query("a.md")
        claim = current["claims"][1]
        replacement = values._input(claim["value"])
        replacement["predicate"] = "depends_on"
        self.reviews.review("a.md", action="edit", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=current["state_revision"], reason="isolated correction", actor=ACTOR)
        self.assert_reference_render()
        current = self.reviews.query("a.md")
        claim = current["claims"][2]
        replacement = {key: deepcopy(value) for key, value in claim["value"].items()
                       if key not in {"evidence", "provenance"}}
        replacement["predicate"] = "depends_on"
        self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        before = self.tree()
        self.assert_reference_render()
        self.assertEqual(self.tree(), before)

    def test_entities_are_normalized_once_per_render_and_never_shared_between_renders(self):
        source, raw, ledger, tokens = self.captured()
        with patch.object(values, "_entity_identities", wraps=values._entity_identities) as maps, \
                patch.object(values, "_identity", wraps=values._identity) as identities:
            first = self.reviews._render(source, raw, ledger, tokens)
            self.assertEqual(maps.call_count, 1)
            self.assertEqual(identities.call_count, len(self.entities) + len(self.relations))
            second = self.reviews._render(source, raw, ledger, tokens)
            self.assertEqual(maps.call_count, 2)
        self.assertEqual(first, second)
        first["machine_graph"]["entities"][0]["label"] = "Changed returned object"
        self.assertNotEqual(first, second)

    def test_fresh_entities_claims_policy_and_source_change_the_next_projection(self):
        original = self.reviews.query("a.md")
        original_id = original["claims"][0]["claim_id"]
        self.entities[0]["type"] = "physical_object"
        self.regenerate()
        changed = self.reviews.query("a.md")
        self.assertNotEqual(changed["claims"][0]["claim_id"], original_id)
        changed_id = changed["claims"][0]["claim_id"]
        self.relations[0]["predicate"] = "depends_on"
        self.regenerate()
        changed = self.reviews.query("a.md")
        self.assertNotEqual(changed["claims"][0]["claim_id"], changed_id)
        claim = changed["claims"][0]
        replacement = {key: deepcopy(value) for key, value in claim["value"].items()
                       if key not in {"evidence", "provenance"}}
        replacement["predicate"] = "uses"
        policy = self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=changed["state_revision"], reason="fresh policy", actor=ACTOR)
        self.assertEqual(policy["effective_graph"]["relations"][0]["predicate"], "uses")
        self.assertEqual(policy["machine_graph"]["relations"][0]["predicate"], "depends_on")
        source = self.wiki.read("a.md")
        self.wiki.save("a.md", source.content + "New source condition.\n", expected_revision=source.revision)
        stale = self.reviews.query("a.md")
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["claims"], [])
        self.assertEqual(stale["policies"][0]["status"], "pending")

    def test_empty_claims_do_not_eagerly_normalize_entities(self):
        self.relations = []
        self.regenerate()
        captured = self.captured()
        with patch.object(values, "_entity_identities", side_effect=AssertionError("eager identity map")):
            self.assertEqual(self.reviews._render(*captured)["claims"], [])

    def test_entity_error_precedes_first_claim_error_and_map_creation_stays_lazy(self):
        captured = self.captured()
        machine = self.reviews.query("a.md")["machine_graph"]
        for broken_entity in (False, True):
            broken = deepcopy(machine)
            broken["relations"][0] = None
            if broken_entity:
                broken["entities"][-1]["identifiers"] = None
            with self.subTest(broken_entity=broken_entity):
                try:
                    values._claim_id("relations", broken["relations"][0], broken["entities"])
                except Exception as expected:
                    expected_type, expected_message = type(expected), str(expected)
                else:
                    self.fail("The reference invalid claim must fail")
                with patch.object(render, "_query_snapshot", return_value=broken), \
                        self.assertRaises(expected_type) as actual:
                    self.reviews._render(*captured)
                self.assertEqual(str(actual.exception), expected_message)


if __name__ == "__main__":
    unittest.main()
