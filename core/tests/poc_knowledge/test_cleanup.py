"""Cleanup integration on isolated files only; all judgments here are simulations."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import json
from threading import Barrier
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES, RELATIONS
from core.modules.reviews.cleanup import CleanupStore
from core.modules.reviews.contracts import ReviewConflictError, ReviewCorruptError, ReviewLimitError
from core.modules.reviews.values import _input
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import CleanupFailure
from core.modules.reviews.store import ReviewStore
from core.modules.knowledge.aggregation import review_queue
from core.modules.knowledge.capture import ConceptCapture
from core.modules.knowledge.impact_history import _review_prefix
from core.modules.ontology.errors import OntologyValidationError
from core.modules.access.policy import AccessDenied
from core.modules.reviews import contracts
from core.common.json_codec import canonical_json_hash, canonical_json_bytes


class CleanupTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document()
        self.generate()
        self.cleanup = CleanupStore(self.wiki, ACTOR)

    def review(self, action):
        snapshot = self.reviews.query("a.md")
        return self.reviews.review("a.md", action=action, claim_id=snapshot["claims"][0]["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="simulation", actor=ACTOR)

    def apply(self, preview=None, **fields):
        preview = preview or self.cleanup.preview("a.md")
        payload = dict(request_id=uuid4().hex, preview_revision=preview["preview_revision"],
                       item_ids=[item["item_id"] for item in preview["items"]], reason="simulation cleanup")
        payload.update(fields)
        return self.cleanup.apply("a.md", **payload)

    def undo(self, event):
        return self.cleanup.undo("a.md", request_id=uuid4().hex, event_id=event["event_id"],
            expected_state_revision=self.reviews.query("a.md")["state_revision"], reason="simulation undo")

    def test_preview_apply_preserves_originals_and_projection_survives_restart(self):
        rejected = self.review("reject")
        raw_before = self.reviews._path("a.md").read_bytes()
        tree = self.tree()
        preview = self.cleanup.preview("a.md")
        self.assertEqual(self.tree(), tree)
        self.assertEqual(preview["items"][0]["kind"], "archive_rejected")
        receipt = self.apply(preview)
        after = self.reviews.query("a.md")
        self.assertEqual(after["state_revision"], receipt["state_revision"])
        self.assertEqual(after["claims"], rejected["claims"])
        self.assertEqual(after["history"], rejected["history"])
        self.assertEqual(after["machine_graph"], rejected["machine_graph"])
        self.assertEqual(after["current_claims"], [])
        self.assertEqual(after["effective_graph"]["relations"], [])
        changed = [key for key, value in self.tree().items() if tree.get(key) != value]
        self.assertEqual(len(changed), 1)
        ledger = self.reviews._ledger(self.reviews._path("a.md").read_bytes(), "a.md")
        self.assertEqual(ledger["events"], json.loads(raw_before)["events"])
        self.assertEqual(_review_prefix(ledger, rejected["review_revision"]), 1)
        self.assertEqual(CleanupStore(self.wiki, ACTOR).preview("a.md")["items"], [])
        self.assertEqual(receipt["event"]["items"][0]["target"], rejected["history"][0]["target"])
        restored = self.undo(receipt)
        self.assertEqual(self.reviews.query("a.md")["current_claims"], rejected["claims"])
        self.assertEqual(restored["event"]["undo_of"], receipt["event_id"])
        with self.assertRaises(ValueError):
            self.undo(receipt)

    def test_lost_response_replay_changed_payload_and_read_receipt(self):
        self.review("reject")
        preview = self.cleanup.preview("a.md")
        request_id = uuid4().hex
        saved = self.apply(preview, request_id=request_id)
        before = self.tree()
        replay = self.apply(preview, request_id=request_id)
        self.assertEqual(self.tree(), before)
        self.assertTrue(replay["replayed"])
        self.assertFalse(replay["changed"])
        self.assertEqual(saved["event"], replay["event"])
        self.assertEqual(self.cleanup.request("a.md", request_id=request_id)["event_id"], saved["event_id"])
        with self.assertRaises(ReviewConflictError):
            self.apply(preview, request_id=request_id, reason="changed")
        with self.assertRaises(FileNotFoundError):
            CleanupStore(self.wiki, {**ACTOR, "user_id": "bob"}).request("a.md", request_id=request_id)
        undone = self.undo(saved)
        self.assertEqual(self.apply(preview, request_id=request_id)["event_id"], saved["event_id"])
        self.assertEqual(len(self.reviews.query("a.md")["current_claims"]), 1)
        self.assertEqual(len(self.cleanup.history("a.md")["items"]), 2)
        self.assertTrue(self.cleanup.undo("a.md", request_id=undone["request_id"], event_id=saved["event_id"],
            expected_state_revision=undone["event"]["base_state_revision"], reason="simulation undo")["replayed"])

    def test_pending_cleanup_queue_and_current_generation_never_inherit_acceptance(self):
        accepted = self.review("accept")
        self.generate(expected_state_revision=accepted["state_revision"], force_generation=True)
        raw = self.reviews.query("a.md")
        saved = self.apply()
        current = self.reviews.query("a.md")
        self.assertEqual(current["pending_history"], [accepted["event_id"]])
        self.assertEqual(current["current_pending_history"], [])
        self.assertEqual(current["claims"][0]["decision"], "unreviewed")
        queue = review_queue(self.wiki, ACTOR, documents=["a.md"], correspondence_ids=[], states=["pending", "unreviewed"])
        self.assertEqual([item["status"] for item in queue["items"]], ["unreviewed"])
        self.assertEqual(current["machine_graph"], raw["machine_graph"])
        self.generate(expected_state_revision=current["state_revision"], force_generation=True)
        current = self.reviews.query("a.md")
        self.assertEqual(current["current_pending_history"], [accepted["event_id"]])
        self.undo(saved)
        self.assertEqual(self.reviews.query("a.md")["claims"][0]["decision"], "unreviewed")

    def test_uncertainty_negation_and_candidate_are_not_automatically_rejected(self):
        self.assertFalse(self.cleanup.preview("a.md")["items"])
        self.review("defer")
        preview = self.cleanup.preview("a.md")
        self.assertFalse(preview["items"])
        self.assertEqual(self.reviews.query("a.md")["claims"][0]["decision"], "defer")
        current = self.reviews.query("a.md")
        candidate = {"id": "maybe", "subject": "a", "predicate": "uses", "object": "b",
                     "reason": "insufficient evidence", "question": "Does A use B?"}
        self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), [], [candidate],
            expected_state_revision=current["state_revision"])
        # Old defer can be archived as a past review, but is never rewritten as reject.
        preview = self.cleanup.preview("a.md")
        self.assertEqual({item["decision"] for item in preview["items"]}, {"defer"})
        self.assertEqual({item["kind"] for item in preview["items"]}, {"archive_pending_review"})
        self.apply(preview)
        current = self.reviews.query("a.md")
        self.assertEqual(current["claims"][0]["decision"], "unreviewed")
        self.assertEqual(len(current["effective_graph"]["relation_candidates"]), 1)
        self.review("reject")
        self.assertEqual(self.cleanup.preview("a.md")["items"][0]["collection"], "relation_candidates")

    def test_duplicate_boundaries_and_similarity_do_not_generate_merge_items(self):
        original = self.tree()
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), RELATIONS * 2)
        self.assertEqual(self.tree(), original)
        candidate = {"id": "dup", **RELATIONS[0], "reason": "maybe", "question": "same?"}
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), RELATIONS, [candidate])
        # Different polarity and modality remain distinct source assertions, not merge candidates.
        relation = {**RELATIONS[0], "qualifiers": {"polarity": "negative", "modality": "possible"}}
        self.ontology.generate("a.md", self.wiki.read("a.md").revision, deepcopy(ENTITIES), [*RELATIONS, relation])
        preview = self.cleanup.preview("a.md")
        self.assertEqual(preview["items"], [])
        self.assertEqual(preview["capabilities"][2]["reason"], "duplicate_claims_prevented_by_validation")
        self.assertEqual(len(self.reviews.query("a.md")["effective_graph"]["relations"]), 2)

    def test_policy_boundary_scope_and_policy_pending_are_preserved(self):
        self.review("reject")
        snapshot = self.reviews.query("a.md")
        replacement = _input(snapshot["claims"][0]["value"])
        for name in ("evidence", "provenance"):
            replacement.pop(name)
        policy = self.reviews.policy("a.md", claim_id=snapshot["claims"][0]["claim_id"], replacement=replacement,
            expected_state_revision=snapshot["state_revision"], reason="simulated expert policy", actor=ACTOR)
        self.assertFalse(self.cleanup.preview("a.md")["items"])
        other = CleanupStore(self.wiki, {**ACTOR, "domain": "other"})
        self.assertEqual(len(other.preview("a.md")["items"]), 1)
        saved = other.apply("a.md", request_id=uuid4().hex, preview_revision=other.preview("a.md")["preview_revision"],
            item_ids=[other.preview("a.md")["items"][0]["item_id"]], reason="simulation")
        self.assertEqual(len(self.reviews.query("a.md")["current_claims"]), 1)
        with self.assertRaises(ValueError):
            self.undo(saved)
        current = self.reviews.query("a.md")
        self.generate(expected_state_revision=current["state_revision"], force_generation=True)
        preview = self.cleanup.preview("a.md")
        self.assertNotIn(policy["event_id"], [item["event_id"] for item in preview["items"]])
        self.apply(preview)
        self.assertIn(policy["event_id"], self.reviews.query("a.md")["current_pending_history"])

    def test_changed_review_source_graph_or_access_conflicts(self):
        self.review("reject")
        preview = self.cleanup.preview("a.md")
        self.review("defer")
        with self.assertRaises(ReviewConflictError):
            self.apply(preview)
        self.review("reject")
        preview = self.cleanup.preview("a.md")
        with self.assertRaises(ReviewConflictError):
            CleanupStore(self.wiki, {**ACTOR, "access_revision": "f" * 64}).apply("a.md",
                request_id=uuid4().hex, preview_revision=preview["preview_revision"],
                item_ids=[preview["items"][0]["item_id"]], reason="simulation")
        source = self.wiki.read("a.md")
        self.wiki.save("a.md", source.content + "Changed.\n", expected_revision=source.revision)
        with self.assertRaises(ReviewConflictError):
            self.apply(preview)
        preview = self.cleanup.preview("a.md")
        self.generate(expected_state_revision=self.reviews.query("a.md")["state_revision"])
        with self.assertRaises(ReviewConflictError):
            self.apply(preview)

    def test_unknown_duplicate_selection_and_failures_are_atomic(self):
        self.review("reject")
        preview = self.cleanup.preview("a.md")
        before = self.tree()
        item = preview["items"][0]["item_id"]
        for items in ([item, "f" * 64], [item, item], [], [True]):
            with self.assertRaises(ValueError):
                self.apply(preview, item_ids=items)
            self.assertEqual(self.tree(), before)
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("simulated publication failure")):
            with self.assertRaises(OSError):
                self.apply(preview)
        self.assertEqual(self.tree(), before)
        with self.assertRaises(AccessDenied):
            self.apply(preview, before_commit=lambda: (_ for _ in ()).throw(AccessDenied()))
        self.assertEqual(self.tree(), before)
        with patch.object(contracts, "MAX_REVIEW_EVENTS", 1):
            with self.assertRaises(ReviewLimitError):
                self.apply(preview)
        self.assertEqual(self.tree(), before)
        with patch.object(contracts, "MAX_REVIEW_BYTES", len(self.reviews._path("a.md").read_bytes()) + 10):
            with self.assertRaises(ReviewLimitError):
                self.apply(preview)
        self.assertEqual(self.tree(), before)

    def test_concurrent_same_basis_has_one_winner_and_exact_retry_is_safe(self):
        self.review("reject")
        preview = self.cleanup.preview("a.md")
        barrier = Barrier(2)
        def attempt(_):
            barrier.wait()
            try:
                return self.apply(preview)
            except ReviewConflictError:
                return None
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(len(self.cleanup.history("a.md")["items"]), 1)

    def test_pagination_scope_and_change_conflict(self):
        for action in ("accept", "reject", "defer"):
            self.review(action)
        current = self.reviews.query("a.md")
        self.generate(expected_state_revision=current["state_revision"], force_generation=True)
        first = self.cleanup.preview("a.md", limit=1)
        self.assertFalse(first["complete"])
        second = self.cleanup.preview("a.md", limit=1, cursor=first["next_cursor"])
        self.assertEqual(first["preview_revision"], second["preview_revision"])
        with self.assertRaises(InvalidCursorError):
            CleanupStore(self.wiki, {**ACTOR, "domain": "other"}).preview("a.md", cursor=first["next_cursor"])
        saved = self.apply(first)
        with self.assertRaises(CatalogChangedError):
            self.cleanup.preview("a.md", cursor=first["next_cursor"])
        self.undo(saved)
        self.assertFalse(self.cleanup.history("a.md", limit=1)["complete"])

    def test_corrupt_cleanup_is_not_ignored_or_replaced(self):
        self.review("reject")
        self.apply()
        path = self.reviews._path("a.md")
        original = path.read_bytes()
        for field, value in (("hash", "0" * 64), ("scope", {"domain": "other", "viewpoint": None})):
            ledger = json.loads(original)
            ledger["cleanup_events"][0][field] = value
            path.write_bytes(canonical_json_bytes(ledger))
            before = self.tree()
            with self.assertRaises(ReviewCorruptError):
                self.cleanup.preview("a.md")
            self.assertEqual(self.tree(), before)
        path.write_bytes(original)
        self.assertEqual(self.cleanup.preview("a.md")["items"], [])

    def test_injected_cleanup_warning_is_success_and_review_prefixes_remain_restorable(self):
        self.review("reject")
        commit = ReviewStore._commit_locked
        def with_warning(owner, document, ledger, failures):
            result = commit(owner, document, ledger, failures)
            failures.append(CleanupFailure(self.root / ".wiki-simulated", OSError("simulated cleanup warning")))
            return result
        with patch.object(ReviewStore, "_commit_locked", with_warning):
            receipt = self.apply()
        self.assertTrue(receipt["saved"])
        self.assertEqual(len(receipt["cleanup_failures"]), 1)
        baseline = self.reviews.query("a.md")["review_revision"]
        self.review("defer")
        self.undo(receipt)
        ledger = self.reviews._ledger(self.reviews._path("a.md").read_bytes(), "a.md")
        self.assertEqual(_review_prefix(ledger, baseline), 1)
        self.assertEqual(len(ledger["events"]), 2)
        self.assertEqual(self.reviews.query("a.md")["current_claims"][0]["decision"], "defer")

    def test_review_mutation_after_cleanup_and_undo_cannot_hide_new_judgment(self):
        self.review("reject")
        applied = self.apply()
        self.review("accept")
        current = self.reviews.query("a.md")
        self.assertEqual(len(current["current_claims"]), 1)
        self.assertEqual(len(current["effective_graph"]["relations"]), 1)
        self.undo(applied)
        self.assertEqual(self.reviews.query("a.md")["claims"][0]["decision"], "accept")
        self.review("reject")
        self.assertEqual(self.cleanup.preview("a.md")["total_items"], 1)

    def test_same_request_concurrency_and_independent_later_cleanup_undo(self):
        for action in ("accept", "reject", "defer"):
            self.review(action)
        self.generate(expected_state_revision=self.reviews.query("a.md")["state_revision"], force_generation=True)
        first = self.cleanup.preview("a.md", limit=1)
        request_id = uuid4().hex
        barrier = Barrier(2)
        def attempt(_):
            barrier.wait()
            return self.apply(first, request_id=request_id)
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(result["changed"] for result in results), 1)
        self.assertEqual({result["event_id"] for result in results}, {results[0]["event_id"]})
        self.assertEqual(self.cleanup.preview("a.md")["total_items"], 2)
        second = self.apply(self.cleanup.preview("a.md", limit=1))
        self.undo(results[0])
        now = self.reviews.query("a.md")
        self.assertEqual(now["cleanup"]["archived_item_ids"], [second["event"]["items"][0]["item_id"]])
        self.assertEqual(self.cleanup.preview("a.md")["total_items"], 2)
        with self.wiki._write_lock():
            captured = ConceptCapture(self.wiki, actor=ACTOR).document("a.md")
        self.assertEqual(captured["pending_history"], now["current_pending_history"])
        self.assertEqual(len(captured["snapshot"]["pending_history"]), 3)
        self.assertEqual(captured["history"], now["history"])

    def test_rejected_claim_concept_projection_and_failed_staging_cleanup_preserve_bytes(self):
        self.review("reject")
        before = self.reviews._path("a.md").read_bytes()
        unlink = Path.unlink
        def fail_temp(path, *args, **kwargs):
            if path.name.startswith(".wiki-"):
                raise OSError("simulation staging cleanup failure")
            return unlink(path, *args, **kwargs)
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("simulation publication failure")), patch.object(Path, "unlink", fail_temp):
            with self.assertRaises(OSError) as failed:
                self.apply()
        self.assertIn("publication failure", str(failed.exception))
        self.assertEqual(len(failed.exception.cleanup_failures), 1)
        self.assertEqual(self.reviews._path("a.md").read_bytes(), before)
        self.apply()
        with self.wiki._write_lock():
            captured = ConceptCapture(self.wiki, actor=ACTOR).document("a.md")
        self.assertEqual(captured["claims"], [])
        self.assertEqual(len(captured["snapshot"]["claims"]), 1)
        self.assertEqual(len(captured["machine_graph"]["relations"]), 1)
