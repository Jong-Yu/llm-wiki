"""Reuse equal source/current graphs without dropping either validation."""

from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.ontology.validation import _graph
from core.modules.reviews import capture, render
from core.modules.reviews.cleanup import CleanupStore
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES, RELATIONS


@contextmanager
def independent_source_render():
    with patch.object(render, "_source_layer_matches", return_value=False), \
            patch.object(capture, "_source_layer_matches", return_value=False):
        yield


class ReviewSourceLayerReuseTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(body="A uses B.\nB depends on A.\n")
        self.generate()

    def query(self, mode, document="a.md", **options):
        if mode == "public":
            return self.reviews.query(document, **options)
        with self.wiki._write_lock():
            source, raw, _, tokens = self.reviews._snapshot_locked(document)
            return self.reviews._query_captured(document, source, raw,
                self.reviews._read_bytes(document), tokens["history_revision"], **options)

    def compare(self, renders, *, validations=2, document="a.md", **options):
        before = self.tree()
        for mode in ("public", "captured"):
            with self.subTest(mode=mode, document=document):
                with independent_source_render():
                    expected = self.query(mode, document, **options)
                with patch.object(self.reviews, "_render", wraps=self.reviews._render) as projected, \
                        patch.object(self.reviews, "_validate_effective", wraps=self.reviews._validate_effective) as checked:
                    actual = self.query(mode, document, **options)
                self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))
                self.assertEqual(projected.call_count, renders)
                self.assertEqual(checked.call_count, validations)
        self.assertEqual(self.tree(), before)
        return actual

    def test_default_unmodified_layers_render_once_and_validate_both_layers(self):
        result = self.compare(1)
        self.assertEqual(result["policies"], [])
        with self.wiki._write_lock():
            source, raw, ledger, tokens = self.reviews._snapshot_locked("a.md")
            original = deepcopy(ledger)
            for domain, viewpoint in ((None, None), ("work", "business")):
                expected = self.reviews._render(source, raw, ledger, tokens, domain, viewpoint, policies=False)
                expected["policies"] = []
                actual = self.reviews._render(source, raw, ledger, tokens, domain, viewpoint)
                self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))
            self.assertEqual(ledger, original)

    def test_source_decisions_cleanup_and_undo_keep_all_fields(self):
        for action in ("accept", "edit", "defer", "reject"):
            current = self.reviews.query("a.md")
            options = {}
            if action == "edit":
                replacement = _input(current["claims"][0]["value"])
                replacement["predicate"] = "depends_on"
                options["replacement"] = replacement
            self.reviews.review("a.md", action=action, claim_id=current["claims"][0]["claim_id"],
                expected_state_revision=current["state_revision"], reason="isolated source review", actor=ACTOR, **options)
            self.compare(1)
        cleanup = CleanupStore(self.wiki, ACTOR)
        preview = cleanup.preview("a.md")
        receipt = cleanup.apply("a.md", request_id=uuid4().hex, preview_revision=preview["preview_revision"],
            item_ids=[item["item_id"] for item in preview["items"]], reason="isolated cleanup")
        self.compare(1)
        cleanup.undo("a.md", request_id=uuid4().hex, event_id=receipt["event_id"],
            expected_state_revision=self.reviews.query("a.md")["state_revision"], reason="isolated undo")
        self.compare(1)

    def payload(self, kind):
        current = self.reviews.query("a.md")
        value = _input(current["machine_graph"]["relations"][0])
        value.update(subject="b", predicate="depends_on", object="a")
        if kind == "source":
            value["evidence"] = "B depends on A."
        else:
            value.pop("evidence")
            value.pop("provenance")
        return dict(kind=kind, replacement=value, request_id=uuid4().hex,
            expected_state_revision=current["state_revision"], reason="isolated authored relation")

    def test_authored_source_is_revalidated_each_request_and_never_shared_after_return(self):
        service = RelationStore(self.wiki, ACTOR)
        service.create("a.md", **self.payload("source"))
        with patch.object(self.reviews, "_normalize", wraps=self.reviews._normalize) as normalized:
            first = self.query("public")
        self.assertEqual(normalized.call_count, 1)
        self.compare(1)
        original = deepcopy(first)
        first["effective_graph"]["relations"][-1]["predicate"] = "changed returned relation"
        self.assertEqual(self.query("public"), original)
        source = self.wiki.read("a.md")
        self.wiki.save("a.md", source.content.replace("B depends on A.", "B is separate."),
            expected_revision=source.revision)
        current = self.compare(1, validations=0)
        self.assertEqual(current["authored_relations"][0]["status"], "pending")

    def test_standard_policy_current_undo_old_and_other_scope_keep_independent_render(self):
        current = self.reviews.query("a.md")
        value = _input(current["claims"][0]["value"])
        value["predicate"] = "depends_on"
        value.pop("evidence")
        value.pop("provenance")
        receipt = self.reviews.policy("a.md", claim_id=current["claims"][0]["claim_id"], replacement=value,
            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        self.compare(2)
        self.compare(2, domain="other", viewpoint="business")
        self.reviews.policy_undo("a.md", event_id=receipt["event_id"],
            expected_state_revision=self.reviews.query("a.md")["state_revision"], reason="isolated undo", actor=ACTOR)
        self.compare(2)
        source = self.wiki.read("a.md")
        self.wiki.save("a.md", source.content + "New generation.\n", expected_revision=source.revision)
        state = self.reviews.query("a.md")
        self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS),
            expected_state_revision=state["state_revision"], force_generation=True)
        self.compare(2)

    def test_authored_policy_and_undo_keep_both_layers_even_without_standard_policy(self):
        service = RelationStore(self.wiki, ACTOR)
        receipt = service.create("a.md", **self.payload("policy"))
        self.compare(2)
        service.undo("a.md", kind="policy", event_id=receipt["event_id"], request_id=uuid4().hex,
            expected_state_revision=self.reviews.query("a.md")["state_revision"], reason="isolated undo")
        self.compare(2)

    def test_non_default_scopes_and_legacy_versions_keep_existing_paths(self):
        for options in ({"domain": "work"}, {"viewpoint": "business"},
                        {"domain": "work", "viewpoint": "business"}):
            self.compare(2, **options)
        for version in (1, 2, 6):
            name = f"legacy{version}.md"
            source = self.document(name, plain=True)
            graph = _graph(name, source.revision, ENTITIES, RELATIONS, source.content, schema_version=version)
            path = self.root / "_ontology" / (sha256(name.encode()).hexdigest() + ".json")
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(canonical_json_bytes(graph))
            self.compare(1, validations=0 if version < 3 else 2, document=name)

    def test_first_and_second_effective_failures_are_not_bypassed(self):
        for mode in ("public", "captured"):
            for second in (False, True):
                failure = ValueError("isolated validation error")
                effects = [None, failure] if second else [failure]
                with self.subTest(mode=mode, second=second), \
                        patch.object(self.reviews, "_validate_effective", side_effect=effects) as checked, \
                        self.assertRaisesRegex(ReviewCorruptError, "Current reviewed graph is inconsistent"):
                    self.query(mode)
                self.assertEqual(checked.call_count, 2 if second else 1)


if __name__ == "__main__":
    unittest.main()
