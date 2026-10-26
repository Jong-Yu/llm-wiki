"""D-040 adversarial selectors and bounded projection; isolated simulations."""
from copy import deepcopy
import unittest
import unicodedata
from unittest.mock import patch

from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.schema import ConceptValidationError
from core.common.json_codec import canonical_json_bytes as _encode
from core.tests.modules import test_concepts as cases


class ConceptBoundaries(unittest.TestCase):
    setUp = cases.ConceptCases.setUp
    generate_a = cases.ConceptCases.generate_a
    anchor = cases.ConceptCases.anchor
    target = cases.ConceptCases.target
    find = cases.ConceptCases.find
    query = cases.ConceptCases.query
    create = cases.ConceptCases.create
    policy = cases.ConceptCases.policy
    source_review = cases.ConceptCases.source_review

    def test_small_output_budget_omits_whole_document_and_duplicate_context(self):
        store = ConceptStore(self.wiki, actor=self.actor, budgets={"output_bytes": 9000})
        result = store.query(self.target(), application_context=self.context)
        self.assertLessEqual(len(_encode(result)), 9000)
        self.assertFalse(result["complete"])
        self.assertFalse(result["completeness"]["output"]["complete"])
        self.assertEqual(result["documents"], [])
        self.assertEqual(result["map_context"]["nodes"], [])
        self.assertEqual(result["map_context"]["claim_refs"], [])
        self.assertEqual(result["explanation_context"]["claim_refs"], [])
        self.assertTrue(any(row["reason"] == "output_budget" for row in result["skipped"]))

    def test_profile_override_groups_claims_using_selected_profile(self):
        values = deepcopy(self.graph_input)
        values["relations"][0]["context"] = {"domain": "상품", "viewpoints": ["business"]}
        self.generate_a(values)
        result = self.query(profile={"profile_id": "developer", "domain": "상품", "viewpoint": "developer"})
        self.assertEqual(result["focus_refs"], [])
        self.assertTrue(result["other_context"])
        self.assertEqual(result["evaluation"]["profile_definition"]["viewpoint"], "developer")

    def test_other_scope_is_current_observation_but_not_currently_applicable(self):
        self.policy()
        found = self.find("희소분류", documents=["a.md"], profile={"domain": "catalog", "viewpoint": "developer"}, limit=100)
        match = next(item for item in found["matches"] if item["target_ref"]["kind"] == "entity")
        self.assertEqual(match["currentness"], "current")
        self.assertFalse(match["selectable_as_current"])
        self.assertEqual(match["policy_status"], "other_scope")

    def test_forged_policy_origin_and_snapshot_never_resolve_to_current(self):
        self.policy()
        found = self.find("희소분류", documents=["a.md"], limit=100)
        original = next(item["target_ref"] for item in found["matches"] if item["target_ref"]["kind"] == "entity")
        forged = deepcopy(original)
        forged["origin_ref"]["snapshot"]["value"]["qualifiers"]["condition"] = "위조된 조건"
        result = self.query(forged, expansion="direct_confirmed")
        self.assertEqual(result["target"]["status"], "version_changed")
        self.assertFalse(result["scope"]["auto_expanded"])
        forged = deepcopy(original)
        forged["snapshot"]["label"] = "위조 용어"
        self.assertEqual(self.query(forged)["target"]["status"], "missing")
        forged = deepcopy(original)
        forged["layer"] = "machine"
        with self.assertRaises(ConceptValidationError):
            self.query(forged)

    def test_invalid_json_types_and_encoded_target_are_argument_errors(self):
        for target in ("{}", {"kind": []}, {"kind": "anchor", "anchor": "{}", "observation": {}},
                       {**self.target(), "unknown": True}):
            with self.subTest(target=target), self.assertRaises(ConceptValidationError):
                self.query(target)
        for documents in ([{}], ["a.md", "a.md"], "a.md"):
            with self.subTest(documents=documents), self.assertRaises(ConceptValidationError):
                self.find("상품", documents=documents)
        with self.assertRaises(ConceptValidationError):
            self.find("상품", as_of="2026-10-23T00:00:00")

    def test_source_anchor_does_not_depend_on_unrelated_graph_revision(self):
        target = self.target()
        values = deepcopy(self.graph_input)
        values["entities"][0]["type"] = "system"
        self.generate_a(values)
        self.assertEqual(self.query(target)["target"]["status"], "current")

    def test_unobserved_history_is_not_replaced_by_empty_revision(self):
        target = self.target()
        target["observation"]["history_revision"] = None
        result = self.query(target, expansion="direct_confirmed")
        self.assertEqual(result["target"]["status"], "unavailable")
        self.assertFalse(result["scope"]["auto_expanded"])

    def test_source_correspondence_endpoint_null_judgment_roundtrips(self):
        cid = self.create()
        match = next(item for item in self.find("매진", documents=["b.md"], limit=100)["matches"]
                     if item["target_ref"]["kind"] == "correspondence_endpoint")
        self.assertIsNone(match["target_ref"]["judgment_id"])
        result = self.query(match["target_ref"])
        self.assertEqual(result["target"]["status"], "current")
        self.assertIn(cid, result["scope"]["content_correspondences"])

    def test_subject_selector_expands_only_exact_entity_graph_reference(self):
        state = self.reviews.query("a.md")
        claim = next(item for item in state["claims"] if item["collection"] == "attributes")
        entity = next(item for item in state["machine_graph"]["entities"] if item["id"] == claim["value"]["subject"])
        value = deepcopy(self.draft)
        value["condition"]["graph_ref"] = {"collection": "entities", "entity_id": entity["id"], "graph_revision": state["graph_revision"], "state_revision": state["state_revision"], "layer": "machine", "snapshot": entity}
        self.create(value)
        target = {"kind": "document_claim", "document": "a.md", "source_revision": state["source_revision"], "graph_revision": state["graph_revision"], "state_revision": state["state_revision"],
                  "original_collection": "attributes", "claim_id": claim["claim_id"], "layer": "machine", "snapshot": claim["value"], "selector": "attribute_subject"}
        result = self.query(target, expansion="direct_confirmed")
        self.assertEqual(set(result["scope"]["content_documents"]), {"a.md", "b.md", "d.md"})
        target["selector"] = "value"
        result = self.query(target, expansion="direct_confirmed")
        self.assertEqual(result["scope"]["content_documents"], ["a.md"])

    def test_result_limit_is_partial_and_does_not_truncate_claim_values(self):
        result = self.find("상품", documents=["a.md"], limit=1)
        self.assertEqual(len(result["matches"]), 1)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        ref = result["matches"][0]["target_ref"]
        self.assertEqual(self.query(ref)["target"]["status"], "current")

    def test_long_source_unicode_match_quote_preserves_combining_sequence(self):
        content = "x" * 1200 + "A\u030A tail\n"
        self.wiki.save("unicode.md", content, expected_revision=None)
        found = self.find("Å", documents=["unicode.md"])
        source = next(item for item in found["matches"] if item["match_origin"] == "source")
        quote = source["target_ref"]["anchor"]["quote"]
        self.assertIn("å", unicodedata.normalize("NFKC", quote).casefold())
        self.assertIn(quote, content)
        self.assertLessEqual(len(quote), 1000)
        self.assertEqual(self.query(source["target_ref"])["target"]["status"], "current")

    def test_unreadable_required_component_is_unavailable_not_version_changed(self):
        found = self.find("상품", documents=["a.md"], limit=100)
        targets = [next(item["target_ref"] for item in found["matches"] if item["target_ref"]["kind"] == kind and item["target_ref"].get("layer") == "reviewed") for kind in ("entity", "document_claim")]
        original = self.ontology._context_bytes
        for component in ("graph", "review"):
            selected_path = self.ontology._path("a.md") if component == "graph" else self.reviews._path("a.md")
            def failing(owner, path, *args, **kwargs):
                if path == selected_path:
                    raise PermissionError("isolated denied capture")
                return original(path, *args, **kwargs)
            from core.modules.ontology.store import OntologyStore
            with patch.object(OntologyStore, "_context_bytes", failing):
                for target in targets:
                    with self.subTest(component=component, kind=target["kind"]):
                        result = self.query(target)
                        self.assertEqual(result["target"]["status"], "unavailable")
                        self.assertIsNotNone(result["documents"][0]["source"])
                        self.assertFalse(result["complete"])
        import os
        original_scan = os.scandir
        history = self.wiki._document_path(self.wiki.history_dir, "a.md")
        def denied_history(path):
            if path == history:
                raise PermissionError("isolated history denial")
            return original_scan(path)
        with patch("os.scandir", denied_history):
            self.assertEqual(self.query(targets[0])["target"]["status"], "unavailable")

    def test_confirmed_missing_graph_is_missing_and_review_absence_is_valid(self):
        found = self.find("상품", documents=["a.md"], limit=100)
        target = next(item["target_ref"] for item in found["matches"] if item["target_ref"]["kind"] == "entity")
        self.assertEqual(self.query(target)["target"]["status"], "current")
        self.ontology._path("a.md").unlink()
        result = self.query(target)
        self.assertEqual(result["target"]["status"], "missing")
        self.assertEqual(result["documents"][0]["components"]["graph"]["status"], "missing")

    def test_different_partial_output_projections_have_different_view_hashes(self):
        for document in ("x1.md", "x2.md"):
            self.wiki.save(document, self.wiki.read("a.md").content, expected_revision=None)
            self.ontology.generate(document, self.wiki.read(document).revision, **self.graph_input)
        values = []
        for budget in (40000, 60000):
            store = ConceptStore(self.wiki, actor=self.actor, budgets={"output_bytes": budget})
            values.append(store.query(self.target(), documents=["a.md", "x1.md", "x2.md"], as_of="2026-10-23T00:00:00Z"))
        self.assertTrue(all(not result["complete"] for result in values))
        self.assertNotEqual([entry["document"] for entry in values[0]["documents"]], [entry["document"] for entry in values[1]["documents"]])
        self.assertEqual(values[0]["snapshot_revision"], values[1]["snapshot_revision"])
        self.assertNotEqual(values[0]["view_revision"], values[1]["view_revision"])

    def test_selected_historical_correspondence_event_keeps_full_audit(self):
        cid = self.create()
        accepted = self.correspondences.query(cid)["source_proposal"]["event_id"]
        state = self.correspondences.query(cid)
        rejected = self.correspondences.review(cid, "reject", state["state_revision"], "합성 거절 provenance")
        found = self.find("매진", documents=["b.md"], include_history=True, limit=100)
        target = next(item["target_ref"] for item in found["matches"] if item["target_ref"].get("selected_event_id") == accepted)
        result = self.query(target)
        detail = next(item for item in result["correspondences"] if item["correspondence_id"] == cid)
        by_id = {event["id"]: event for event in detail["events"]}
        self.assertTrue(result["target"]["historical"])
        self.assertIn(accepted, by_id)
        self.assertIn(rejected["event_id"], by_id)
        self.assertEqual(by_id[accepted]["actor"], self.actor)
        self.assertTrue(by_id[accepted]["reason"])
        self.assertTrue(by_id[accepted]["timestamp"])
        self.assertIn(accepted, detail["history_projection"]["returned_refs"])

    def test_selected_historical_policy_undo_keeps_restored_decision_audit(self):
        first = self.policy(collection="attributes", value="57")
        second = self.policy(collection="attributes", value="81")
        state = self.reviews.query("a.md")
        undo = self.reviews.policy_undo("a.md", event_id=second["event_id"], expected_state_revision=state["state_revision"], reason="선택 과거 판단 복원 simulation", actor=self.actor)
        self.policy(collection="attributes", value="97")
        found = self.find("57", documents=["a.md"], include_history=True, limit=100)
        target = next(item["target_ref"] for item in found["matches"] if item["target_ref"].get("origin_ref", {}).get("selected_event_id") == undo["event_id"])
        result = self.query(target)
        doc = result["documents"][0]
        by_id = {event["id"]: event for event in doc["events"]}
        self.assertEqual(target["origin_ref"]["decision_event_id"], first["event_id"])
        self.assertIn(undo["event_id"], by_id)
        self.assertIn(first["event_id"], by_id)
        self.assertEqual(by_id[first["event_id"]]["actor"], self.actor)
        self.assertIn(first["event_id"], doc["history_projection"]["returned_refs"])

    def test_additional_ledger_limit_and_explicit_root_priority_are_preserved(self):
        from itertools import count
        from uuid import UUID
        sequence = count(1)
        # Keep accepted dependencies first in the bounded UUID filename scan.
        with patch("core.modules.correspondences.identifiers.uuid4", side_effect=lambda: UUID(int=next(sequence), version=4)):
            dependencies = [self.create() for _ in range(32)]
            roots = []
            for offset in range(0, 32, 8):
                value = deepcopy(self.draft)
                for cid in dependencies[offset:offset + 8]:
                    detail = self.correspondences.query(cid, application_context=self.context)
                    event = detail["history"][-1]
                    value["references"].append({"kind": "correspondence", "correspondence_id": cid, "event_id": event["id"], "correspondence_revision": detail["correspondence_revision"], "snapshot": event["after"], "scope": event["after"]["policy_scope"]})
                roots.append(self.create(value, accept=False))
            roots.extend(self.create() for _ in range(4))
        zero = self.query()
        captured = {row["key"] for row in zero["resource_manifest"] if row["kind"] == "correspondence" and row["revision"] is not None}
        self.assertEqual(len(captured), 24)
        self.assertTrue(zero["truncated"])
        limited = self.query(expansion="direct_confirmed", limit=1)
        self.assertEqual(len(limited["scope"]["expanded_via"]), 1)
        self.assertTrue(limited["truncated"])
        self.assertFalse(limited["completeness"]["output"]["complete"])
        self.assertTrue(any(item.get("component") == "expanded_via" and item["reason"] == "expansion_limit" for item in limited["skipped"]))
        self.assertTrue(any(item.get("expansion_reason") == "result_limit" for item in limited["scope"]["unexpanded_connections"]))
        self.assertEqual(limited["documents"][0]["source"]["content"], self.wiki.read("a.md").content)
        selected = self.query(correspondence_ids=roots)
        captured = {row["key"] for row in selected["resource_manifest"] if row["kind"] == "correspondence" and row["revision"] is not None}
        self.assertTrue(set(roots) <= captured)
        self.assertEqual(len(captured - set(roots)), 24)
        self.assertEqual({item["correspondence_id"] for item in selected["correspondences"]}, set(roots))
        self.assertTrue(all(item["correspondence_revision"] is not None for item in selected["correspondences"]))
        # Explicit roots remain in the connection loop even if a bounded
        # directory scan omits them entirely.
        from core.modules.knowledge.capture import ConceptCapture
        with patch.object(ConceptCapture, "scan_correspondences", return_value=[]):
            explicit = self.query(correspondence_ids=[roots[-1]], expansion="direct_confirmed")
        self.assertTrue(explicit["scope"]["expanded_via"])
        self.assertIn("b.md", explicit["scope"]["content_documents"])
        found = self.find("일치하지않는용어", documents=["a.md"], limit=100)
        captured = {row["key"] for row in found["resource_manifest"] if row["kind"] == "correspondence" and row["revision"] is not None}
        self.assertEqual(len(captured), 40)


if __name__ == "__main__":
    unittest.main()
