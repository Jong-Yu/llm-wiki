"""격리 자료에서 원문 문맥·판본·주장 보존과 일반 채팅 무변경을 확인한다."""

from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import CatalogChangedError
from core.modules.documents.metadata import parse_document
from core.modules.documents.store import WikiStore
from core.modules.knowledge.aggregation import prepare_question
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.schema import ConceptValidationError
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import ACTOR, ENTITIES, RELATIONS, KnowledgeFixture


class GlossaryTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document()
        self.generate()
        self.service = ConceptStore(self.wiki, ACTOR)

    def card(self, document="a.md", entity_id="a", **options):
        revision = self.reviews.query(document)["state_revision"]
        return self.service.glossary(document, entity_id, revision, **options)

    def test_exact_document_entity_source_and_unchanged_chat_and_canonical_files(self):
        self.document("b.md", body="A uses B.\n\nA belongs to this second business.\n")
        self.generate("b.md")
        options = dict(documents=["a.md"], required_documents=[], claims=[], source_refs=[])
        question = prepare_question(self.wiki, ACTOR, **options)
        query = self.reviews.query("a.md")
        before = self.tree()
        with patch.object(WikiStore, "save", side_effect=AssertionError("read only")):
            first, second = self.card(), self.card("b.md")
        self.assertNotEqual(first["document"]["document"], second["document"]["document"])
        self.assertEqual(first["entity"], query["effective_graph"]["entities"][0])
        self.assertEqual(first["relations"][0]["claim_id"], query["claims"][0]["claim_id"])
        self.assertEqual(first["relations"][0]["decision"], "unreviewed")
        self.assertEqual(first["source_passage"]["quote"], "A uses B.")
        self.assertEqual(first["source_passage"]["start_line"], parse_document(self.wiki.read("a.md").content).body_start_line)
        self.assertEqual(first["source_passage_status"], "available")
        self.assertTrue(first["coverage"]["complete"])
        self.assertFalse({"history", "source", "machine_graph", "effective_graph"} & first.keys())
        first["entity"]["label"] = "modified response"
        first["relations"][0]["value"]["predicate"] = "modified response"
        self.assertEqual(self.card()["entity"], query["effective_graph"]["entities"][0])
        self.assertEqual(self.reviews.query("a.md"), query)
        self.assertEqual(canonical_json_hash(prepare_question(self.wiki, ACTOR, **options)), canonical_json_hash(question))
        self.assertEqual(self.tree(), before)

    def test_paragraph_heading_and_bounded_fallback_keep_complete_text(self):
        for document, body, evidence, status, passage in (
            ("heading.md", "# A\n\nA handles orders when enabled.\n\nUnrelated.\n", "# A", "available", "# A\n\nA handles orders when enabled."),
            ("context.md", "Before.\n\nA means business.\nOnly when enabled.\n\nAfter.\n", "A means business.", "available", "A means business.\nOnly when enabled."),
            ("crlf.md", "Before.\r\n\r\nA means business.\r\nOnly when enabled.\r\n\r\nAfter.\r\n", "A means business.", "available", "A means business.\r\nOnly when enabled."),
            ("unicode.md", "Before.\u2028Same source line.\n\nA means business.\n", "A means business.", "available", "A means business."),
            ("long.md", "A means business. " + "long context " * 400 + "\n", "A means business.", "limited", "A means business."),
        ):
            source = self.document(document, body=body)
            self.ontology.generate(document, source.revision,
                [{"id": "a", "label": "A", "type": "concept", "evidence": evidence}], [])
            card = self.card(document)
            self.assertEqual(card["source_passage_status"], status)
            self.assertEqual(card["source_passage"]["quote"], passage)
            self.assertEqual(card["coverage"]["truncated"], status == "limited")
            self.assertIn(passage, source.content)

    def test_unicode_metadata_line_separator_uses_extraction_coordinates(self):
        source = self.document("unicode-title.md", title="Before\u2028After")
        self.generate("unicode-title.md")
        graph = self.reviews.query("unicode-title.md")["effective_graph"]
        evidence = graph["entities"][0]["evidence"]
        self.assertNotEqual(evidence["start_line"], parse_document(source.content).body_start_line)
        card = self.card("unicode-title.md")
        self.assertEqual(card["source_passage_status"], "available")
        self.assertEqual(card["source_passage"], {**evidence, "source_revision": source.revision})
        self.assertTrue(card["coverage"]["complete"])

    def test_stale_source_metadata_body_and_review_fail_closed(self):
        for document, change in (("metadata.md", lambda content: content.replace('title: "A uses B."', 'title: "Updated"')),
                                 ("body.md", lambda content: content + "Changed.\n")):
            source = self.document(document)
            self.generate(document)
            state = self.reviews.query(document)["state_revision"]
            updated = change(source.content)
            self.assertNotEqual(updated, source.content)
            self.wiki.save(document, updated, expected_revision=source.revision)
            with self.assertRaises(CatalogChangedError):
                self.service.glossary(document, "a", state)
        old = self.reviews.query("a.md")["state_revision"]
        self.accept()
        with self.assertRaises(CatalogChangedError):
            self.service.glossary("a.md", "a", old)
        self.assertEqual(self.card()["relations"][0]["decision"], "accept")

    def test_missing_source_unknown_entities_and_strict_input_validation(self):
        state = self.reviews.query("a.md")["state_revision"]
        for options in ({"document": "../a.md"}, {"document": "/a.md"}, {"entity_id": True},
                        {"entity_id": {}}, {"entity_id": ""}, {"entity_id": "missing"},
                        {"entity_id": "anchor:fake"}, {"limit": True}, {"limit": 0}, {"limit": 21},
                        {"expected_state_revision": "old"}):
            args = dict(document="a.md", entity_id="a", expected_state_revision=state)
            args.update(options)
            with self.subTest(options=options), self.assertRaises(ConceptValidationError):
                self.service.glossary(**args)
        with self.assertRaises(FileNotFoundError):
            self.service.glossary("absent.md", "a", state)
        with patch.object(self.service.reviews, "_query_captured", side_effect=OSError("unavailable")):
            with self.assertRaises(CatalogChangedError):
                self.service.glossary("a.md", "a", state)

    def test_current_qualifiers_candidates_attributes_limits_and_review_decisions(self):
        quote = "A may not use B when enabled."
        source = self.document("qualified.md", body=quote + "\nA mode is test.\nB may depend on A.\n")
        entities = [{"id": char.lower(), "label": char, "type": "system", "evidence": quote} for char in "AB"]
        relation = {"subject": "a", "predicate": "uses", "object": "b", "evidence": quote,
                    "qualifiers": {"polarity": "negative", "modality": "possible", "condition": "when enabled"}}
        candidate = {"id": "candidate", "subject": "b", "predicate": "depends_on", "object": "a",
                     "reason": "uncertain", "question": "Does B depend on A?", "evidence": "B may depend on A."}
        attribute = {"id": "mode", "subject": "a", "property": "mode", "datatype": "text",
                     "value": "test", "unit": None, "evidence": "A mode is test."}
        self.ontology.generate("qualified.md", source.revision, entities, [relation], [candidate], attributes=[attribute])
        current = self.reviews.query("qualified.md")
        card = self.card("qualified.md")
        self.assertEqual(card["relations"][0]["value"], current["effective_graph"]["relations"][0])
        self.assertEqual(card["relations"][1]["value"], current["effective_graph"]["relation_candidates"][0])
        self.assertEqual(card["attributes"][0]["value"], current["effective_graph"]["attributes"][0])
        limited = self.card("qualified.md", limit=1)
        self.assertEqual(limited["totals"], {"attributes": 1, "relations": 2})
        self.assertEqual(len(limited["relations"]), 1)
        self.assertFalse(limited["coverage"]["complete"])
        self.assertTrue(limited["coverage"]["truncated"])
        candidate_claim = next(claim for claim in current["claims"] if claim["collection"] == "relation_candidates")
        self.reviews.review("qualified.md", action="accept", claim_id=candidate_claim["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated", actor=ACTOR)
        accepted = next(claim for claim in self.card("qualified.md")["relations"] if claim["claim_id"] == candidate_claim["claim_id"])
        self.assertEqual((accepted["collection"], accepted["original_collection"]), ("relations", "relation_candidates"))
        for action in ("defer", "reject"):
            current = self.reviews.query("qualified.md")
            self.reviews.review("qualified.md", action=action, claim_id=candidate_claim["claim_id"],
                expected_state_revision=current["state_revision"], reason="isolated", actor=ACTOR)
            self.assertNotIn(candidate_claim["claim_id"], [claim["claim_id"] for claim in self.card("qualified.md")["relations"]])

    def test_policy_entity_has_no_invented_quote_and_real_event_scope(self):
        current = self.reviews.query("a.md")
        replacement = _input(current["claims"][0]["value"])
        replacement.update(object="new")
        replacement.pop("evidence")
        replacement.pop("provenance")
        receipt = self.reviews.policy("a.md", claim_id=current["claims"][0]["claim_id"], replacement=replacement,
            entities=[{"id": "new", "label": "New concept", "type": "concept"}],
            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        entity = self.reviews.query("a.md")["effective_graph"]["entities"][-1]
        card = self.card(entity_id=entity["id"])
        self.assertEqual(card["entity"], entity)
        self.assertIsNone(card["source_passage"])
        self.assertEqual(card["source_passage_status"], "no_source_evidence")
        self.assertEqual(card["relations"][0]["origin"], "policy")
        self.assertEqual(card["relations"][0]["provenance"]["decision_event_id"], receipt["event_id"])
        self.assertEqual(card["relations"][0]["provenance"]["policy_scope"], {"domain": None, "viewpoint": None})
        other_scope = ConceptStore(self.wiki, {**ACTOR, "domain": "other", "viewpoint": "business"})
        with self.assertRaises(ConceptValidationError):
            other_scope.glossary("a.md", entity["id"], card["document"]["state_revision"])
        source_card = other_scope.glossary("a.md", "a", card["document"]["state_revision"])
        self.assertEqual(source_card["relations"][0]["origin"], "machine")

    def test_source_anchor_relation_is_preserved_without_fake_entity(self):
        source = self.document("anchored.md")
        line = parse_document(source.content).body_start_line
        anchor = dict(kind="source_anchor", document="anchored.md", source_revision=source.revision,
                      quote="B", start_line=line, end_line=line, occurrence=0)
        relation = {**RELATIONS[0], "object": anchor}
        self.ontology.generate("anchored.md", source.revision, deepcopy(ENTITIES), [relation], schema_version=4)
        card = self.card("anchored.md")
        self.assertEqual(card["relations"][0]["value"]["object"], anchor)
        self.assertEqual(card["totals"]["relations"], 1)
        self.assertEqual(self.card("anchored.md", entity_id="b")["relations"], [])

    def test_authored_relation_keeps_real_claim_and_event(self):
        source = self.document("authored.md", body="A uses B.\nB depends on A.\n")
        self.generate("authored.md")
        current = self.reviews.query("authored.md")
        value = _input(current["machine_graph"]["relations"][0])
        value.update(subject="b", predicate="depends_on", object="a", evidence="B depends on A.")
        receipt = RelationStore(self.wiki, ACTOR).create("authored.md", kind="source", replacement=value,
            request_id=uuid4().hex, expected_state_revision=current["state_revision"], reason="isolated")
        claim = next(item for item in self.card("authored.md")["relations"] if item["origin"] == "independent")
        self.assertEqual(claim["claim_id"], receipt["claim_id"])
        self.assertEqual(claim["provenance"]["authored_event_id"], receipt["event_id"])


if __name__ == "__main__":
    unittest.main()
