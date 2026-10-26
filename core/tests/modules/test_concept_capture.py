"""TemporaryDirectory tests for D-040 request capture and preservation."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.knowledge.capture import ConceptCapture
from core.modules.knowledge.contracts import ConceptCaptureLimitError
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import CorrespondenceCorruptError
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.documents.store import WikiStore
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture


class ConceptCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.wiki = WikiStore(self.temp.name)
        self.actor = correspondence_actor()
        self.correspondences = CorrespondenceStore(self.wiki, self.actor)
        self.draft = correspondence_fixture(self.wiki)
        self.reviews = ReviewStore(self.wiki)
        self.ontology = OntologyStore(self.wiki)

    def capture(self, **kwargs):
        return ConceptCapture(self.wiki, actor=self.actor, **kwargs)

    def create(self, draft=None):
        draft = deepcopy(self.draft if draft is None else draft)
        ready = self.correspondences.query(draft=draft)
        result = self.correspondences.propose(ready["correspondence_id"], draft, ready["state_revision"], "합성 제안")
        return self.correspondences.review(result["correspondence_id"], "accept", result["state_revision"], "합성 수용")

    def protected(self):
        return {path.relative_to(self.wiki.data_dir).as_posix(): path.read_bytes()
                for path in self.wiki.data_dir.rglob("*") if path.is_file() and path.name != ".storage.lock"}

    def generate(self, document="a.md"):
        source = self.wiki.read(document)
        return self.ontology.generate(document, source.revision,
            [{"id": "product", "label": "상품", "type": "concept", "evidence": source.content.strip()}], [])

    def test_shared_raw_bytes_are_charged_once_and_manifest_merges_purpose(self):
        protected = self.protected()
        with self.wiki._write_lock():
            cap = self.capture()
            first = cap.document("a.md", "content", "target", full=False)
            size = cap.captured_bytes
            second = cap.document("a.md", "dependency", "correspondence:example", full=False)
            self.assertEqual(first["source_revision"], second["source_revision"])
            self.assertEqual(size, cap.captured_bytes)
            source = next(item for item in cap.manifest if item["kind"] == "source")
            self.assertEqual(source["purpose"], ["content", "dependency"])
            self.assertEqual(source["required_by"], ["correspondence:example", "target"])
        self.assertEqual(protected, self.protected())

    def test_no_public_queries_or_nested_lock_are_called(self):
        correspondence = self.create()
        self.generate()
        with self.wiki._write_lock(), patch.object(self.wiki, "_write_lock", side_effect=AssertionError("nested lock")), patch.object(ReviewStore, "query", side_effect=AssertionError("public query")), patch.object(CorrespondenceStore, "query", side_effect=AssertionError("public query")):
            cap = self.capture(application_context={"service": "catalog"})
            self.assertTrue(cap.document("a.md", root=True)["complete"])
            self.assertEqual(cap.correspondence(correspondence["correspondence_id"], root=True)["source_proposal"]["applicability"], "applicable")

    def test_history_empty_and_aba_observations(self):
        with self.wiki._write_lock():
            initial = self.capture().document("a.md", full=False)
        before = self.wiki.read("a.md")
        changed = self.wiki.save("a.md", before.content + "변경\n", expected_revision=before.revision)
        self.wiki.save("a.md", before.content, expected_revision=changed.revision)
        with self.wiki._write_lock():
            result = self.capture().document("a.md", full=False)
        self.assertEqual(initial["source_revision"], result["source_revision"])
        self.assertNotEqual(initial["history_revision"], result["history_revision"])
        self.assertTrue(initial["complete"])
        self.assertFalse(initial["components"]["history"]["exists"])

    def test_shared_history_limit_never_hashes_partial_names_as_empty(self):
        for name in ("a.md", "b.md"):
            source = self.wiki.read(name)
            self.wiki.save(name, source.content + "추가\n", expected_revision=source.revision)
        with self.wiki._write_lock():
            cap = self.capture(budgets={"history_entries": 1})
            a = cap.document("a.md", full=False)
            b = cap.document("b.md", full=False)
            self.assertIsNotNone(a["history_revision"])
            self.assertIsNone(b["history_revision"])
            self.assertEqual(b["components"]["history"]["status"], "unavailable")
            self.assertFalse(b["complete"])
            self.assertTrue(cap.truncated)
            count = cap.history_entries
            cap.document("b.md", full=False)
            self.assertEqual(count, cap.history_entries)

    def test_source_only_correspondence_survives_unrelated_graph_review_corruption(self):
        correspondence = self.create()
        self.wiki._mkdir(self.ontology.ontology_dir)
        self.wiki._mkdir(self.reviews.review_dir)
        self.ontology._path("a.md").write_bytes(b"bad graph")
        self.reviews._path("a.md").write_bytes(b"bad review")
        with self.wiki._write_lock():
            cap = self.capture(application_context={"service": "catalog"})
            document = cap.document("a.md")
            self.assertIsNotNone(document["source"])
            self.assertEqual(document["components"]["graph"]["status"], "unavailable")
            self.assertEqual(document["components"]["review"]["status"], "unavailable")
            self.assertIsNone(document["effective_graph"])
            result = cap.correspondence(correspondence["correspondence_id"], root=True)
            self.assertEqual(result["source_proposal"]["applicability"], "applicable")
            self.assertTrue(result["complete"])

    def test_root_failures_raise_and_component_failures_preserve_source(self):
        correspondence = self.create()
        self.correspondences._path(correspondence["correspondence_id"]).write_bytes(b"bad root")
        with self.wiki._write_lock():
            cap = self.capture()
            with self.assertRaises(FileNotFoundError):
                cap.document("missing.md", root=True)
            with self.assertRaises(CorrespondenceCorruptError):
                cap.correspondence(correspondence["correspondence_id"], root=True)
            self.assertFalse(cap.correspondence(correspondence["correspondence_id"])["complete"])

    def test_dependency_read_error_is_partial_even_for_a_valid_correspondence_root(self):
        result = self.create()
        original = self.protected()
        underlying = self.ontology._context_bytes
        def broken(path, *args, **kwargs):
            if path == self.wiki.wiki_dir / "d.md":
                raise PermissionError(13, "injected read failure")
            return underlying(path, *args, **kwargs)
        with self.wiki._write_lock():
            cap = self.capture(application_context={"service": "catalog"})
            with patch.object(cap.ontology, "_context_bytes", side_effect=broken):
                partial = cap.correspondence(result["correspondence_id"], root=True)
            self.assertEqual(partial["source_proposal"]["applicability"], "unavailable")
            self.assertFalse(partial["complete"])
            self.assertEqual(partial["history"][-1]["id"], result["event_id"])
        self.assertEqual(original, self.protected())

    def test_byte_budget_failure_is_cached_and_never_returns_a_prefix(self):
        with self.wiki._write_lock():
            cap = self.capture(budgets={"capture_bytes": 1})
            first = cap.document("a.md", full=False)
            self.assertIsNone(first["source"])
            self.assertEqual(cap.captured_bytes, 0)
            with patch.object(cap.ontology, "_context_bytes", side_effect=AssertionError("must reuse failed capture")):
                second = cap.document("a.md", full=False)
            self.assertIsNone(second["source"])
            self.assertTrue(cap.truncated)
            with self.assertRaises(ConceptCaptureLimitError):
                cap.document("a.md", root=True, full=False)

    def test_unique_document_budget_counts_graph_and_review_once(self):
        with self.wiki._write_lock():
            cap = self.capture(budgets={"documents": 1})
            cap.document("a.md")
            second = cap.document("b.md", full=False)
            self.assertIsNone(second["source"])
            self.assertEqual(cap.coverage["documents"], 1)
            self.assertTrue(cap.truncated)

    def test_independent_roots_share_bytes_without_combining_d038_document_limits(self):
        ids = []
        for number in range(4):
            draft = deepcopy(self.draft)
            for field in ("condition", "concept"):
                document = f"{number}-{field}.md"
                content = draft[field]["quote"] + "\n"
                saved = self.wiki.save(document, content, expected_revision=None)
                draft[field].update(document=document, source_revision=saved.revision)
            ids.append(self.create(draft)["correspondence_id"])
        with self.wiki._write_lock():
            cap = self.capture(application_context={"service": "catalog"})
            for cid in ids:
                self.assertEqual(cap.correspondence(cid, root=True)["source_proposal"]["applicability"], "applicable")
            self.assertEqual(cap.coverage["documents"], 9)
            self.assertLess(cap.captured_bytes, 32 * 1024 * 1024)

    def test_discovery_limits_and_symlink_rejection(self):
        self.wiki.wiki_dir.joinpath("alias.md").symlink_to(self.wiki.wiki_dir / "a.md")
        with self.wiki._write_lock():
            cap = self.capture(mode="find", budgets={"entries": 1})
            names = cap.scan_documents()
            self.assertLessEqual(cap.scanned_entries, 1)
            self.assertTrue(cap.truncated)
            self.assertNotIn("alias.md", names)

    def test_review_only_discovery_uses_validated_envelope_and_preserves_user_files(self):
        self.generate()
        snapshot = self.reviews.query("a.md")
        # Empty relation set still permits testing an intact v1 ledger envelope
        # through a second document fixture with an actual reviewed relation.
        source = self.wiki.read("b.md")
        self.ontology.generate("b.md", source.revision,
            [{"id": "product", "label": "상품", "type": "concept", "evidence": source.content.strip()},
             {"id": "shipping", "label": "출고", "type": "process", "evidence": source.content.strip()}],
            [{"subject": "product", "predicate": "uses", "object": "shipping", "evidence": source.content.strip()}])
        snapshot = self.reviews.query("b.md")
        self.reviews.review("b.md", action="accept", claim_id=snapshot["claims"][0]["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="모의 검토", actor=self.actor)
        self.wiki.wiki_dir.joinpath("b.md").unlink()
        protected = self.protected()
        with self.wiki._write_lock():
            cap = self.capture(mode="find")
            self.assertIn("b.md", cap.scan_documents())
            result = cap.document("b.md")
            self.assertIsNone(result["source"])
            self.assertEqual(len(result["history"]), 1)
        self.assertEqual(protected, self.protected())

    def make_document_review(self, document="b.md"):
        source = self.wiki.read(document)
        self.ontology.generate(document, source.revision,
            [{"id": "product", "label": "상품", "type": "concept", "evidence": source.content.strip()},
             {"id": "shipping", "label": "출고", "type": "process", "evidence": source.content.strip()}],
            [{"subject": "product", "predicate": "uses", "object": "shipping", "evidence": source.content.strip()}])
        snapshot = self.reviews.query(document)
        self.reviews.review(document, action="accept", claim_id=snapshot["claims"][0]["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="모의 검토", actor=self.actor)

    def test_review_discovery_reuses_already_captured_bytes(self):
        self.make_document_review()
        with self.wiki._write_lock():
            cap = self.capture(mode="find")
            cap.document("b.md")
            consumed = cap.captured_bytes
            with patch.object(cap.ontology, "_context_bytes", side_effect=AssertionError("duplicate file read")):
                self.assertIn("b.md", cap.scan_documents())
            self.assertEqual(consumed, cap.captured_bytes)

    def test_review_symlink_is_reported_as_incomplete(self):
        self.wiki._mkdir(self.reviews.review_dir)
        self.reviews._path("b.md").symlink_to(self.wiki.wiki_dir / "b.md")
        with self.wiki._write_lock():
            cap = self.capture(mode="find")
            cap.scan_documents()
            self.assertFalse(cap.complete)
            self.assertTrue(any(item["reason"] == "review_corrupt" for item in cap.skipped))
            self.assertEqual(cap.captured_bytes, 0)

    def test_unknown_malformed_review_files_also_consume_candidate_slots(self):
        self.wiki._mkdir(self.reviews.review_dir)
        for character in ("a", "b"):
            self.reviews.review_dir.joinpath(character * 64 + ".json").write_bytes(b"malformed")
        with self.wiki._write_lock():
            cap = self.capture(mode="find", budgets={"documents": 1})
            cap.scan_documents()
            self.assertEqual(cap.coverage["documents"], 1)
            self.assertEqual(cap.captured_bytes, len(b"malformed"))
            self.assertTrue(cap.truncated)
            self.assertTrue(any(item["status"] == "unavailable" for item in cap.manifest))


if __name__ == "__main__":
    unittest.main()
