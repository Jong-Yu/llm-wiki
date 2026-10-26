"""Source-anchor review compatibility in isolated synthetic stores only."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.ontology.store import OntologyStore
from core.modules.ontology.errors import OntologyValidationError
from core.modules.reviews.contracts import (
    ReviewConflictError, ReviewCorruptError, ReviewLimitError, ReviewValidationError,
)
from core.modules.reviews.store import ReviewStore
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.reviews.values import _input
from core.modules.documents.store import CleanupFailure, WikiStore


class AnchorReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = WikiStore(self.temp.name)
        self.ontology = OntologyStore(self.store)
        self.reviews = ReviewStore(self.store)
        self.document = "synthetic/anchors.md"
        self.source = (
            "정의는 업로드 기준을 뜻한다.\n"
            "육상용 앱은 개발자 워크스페이스에서 실행 및 테스트할 수 있다.\n"
            "기존 상품은 분류에 사용된다.\n"
        )
        self.revision = self.store.save(self.document, self.source, expected_revision=None).revision
        self.entities = [
            {"id": "product", "label": "상품", "type": "concept", "evidence": self.source.splitlines()[2]},
            {"id": "classification", "label": "분류", "type": "concept", "evidence": self.source.splitlines()[2]},
        ]
        self.old_relation = {"subject": "product", "predicate": "uses", "object": "classification",
                             "evidence": self.source.splitlines()[2]}
        self.actor = {"user_id": "fixture", "tenant": "synthetic", "profile_id": "all",
                      "domain": None, "viewpoint": None, "policy_revision": "a" * 64}

    def anchor(self, quote, *, revision=None, line=2, occurrence=0):
        return {"kind": "source_anchor", "document": self.document,
                "source_revision": revision or self.revision, "quote": quote,
                "start_line": line, "end_line": line, "occurrence": occurrence}

    def relation(self, *, revision=None, line=2):
        return {"subject": self.anchor("개발자 워크스페이스", revision=revision, line=line),
                "predicate": "enables", "object": self.anchor("실행 및 테스트", revision=revision, line=line),
                "evidence": self.source.splitlines()[1],
                "qualifiers": {"polarity": "positive", "modality": "capability",
                               "condition": None, "scope": "육상용 앱", "time": None},
                "context": {"domain": None, "viewpoints": []},
                "provenance": {"source_entity": None, "attributed_to": None, "basis": None}}

    def generate(self, *, version=4, relations=None, **kwargs):
        return self.ontology.generate(
            document=self.document, entities=self.entities,
            relations=relations if relations is not None else [self.old_relation, self.relation()],
            expected_revision=kwargs.pop("expected_revision", self.revision), schema_version=version, **kwargs)

    def query(self):
        return self.reviews.query(self.document)

    def anchor_claim(self, snapshot=None):
        return next(claim for claim in (snapshot or self.query())["claims"]
                    if isinstance(claim["value"].get("subject"), dict))

    def review(self, action, *, snapshot=None, claim=None, **kwargs):
        snapshot = snapshot or self.query()
        claim = claim or self.anchor_claim(snapshot)
        return self.reviews.review(
            self.document, action=action, claim_id=claim["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="합성 fixture의 모의 검토",
            actor=self.actor, **kwargs)

    def undo(self, event_id, snapshot=None):
        snapshot = snapshot or self.query()
        return self.reviews.undo(self.document, event_id=event_id,
                                 expected_state_revision=snapshot["state_revision"],
                                 reason="합성 fixture 모의 되돌림", actor=self.actor)

    def files(self):
        return {p.relative_to(self.store.data_dir).as_posix(): p.read_bytes()
                for p in self.store.data_dir.rglob("*") if p.is_file() and p.name != ".storage.lock"}

    def policy_replacement(self):
        return {"subject": "product", "predicate": "related_to", "object": "classification",
                "qualifiers": {"polarity": "positive", "modality": "asserted",
                               "condition": None, "scope": None, "time": None},
                "context": {"domain": None, "viewpoints": []}}

    def policy(self, snapshot=None, *, replacement=None, claim=None):
        snapshot = snapshot or self.query()
        claim = claim or self.anchor_claim(snapshot)
        return self.reviews.policy(
            self.document, claim_id=claim["claim_id"], replacement=replacement or self.policy_replacement(),
            expected_state_revision=snapshot["state_revision"], reason="합성 전문가 정책, 실제 승인 아님",
            actor=self.actor)

    def test_v3_claim_values_ids_and_populated_ledger_stay_exact_after_v4_generation(self):
        self.generate(version=3, relations=[self.old_relation])
        original = self.query()
        accepted = self.review("accept", snapshot=original, claim=original["claims"][0])
        policy = self.policy(accepted, claim=accepted["claims"][0])
        ledger_path = self.reviews._path(self.document)
        old_bytes = ledger_path.read_bytes()
        old_hash = sha256(old_bytes).hexdigest()
        old_events = deepcopy(policy["history"])
        old_claim = original["claims"][0]
        self.generate(expected_state_revision=policy["state_revision"])
        current = self.query()
        unchanged = next(c for c in current["claims"] if c["claim_id"] == old_claim["claim_id"])
        self.assertEqual(unchanged["value"], old_claim["value"])
        self.assertEqual(unchanged["decision"], "unreviewed")
        self.assertTrue(all(c["decision"] == "unreviewed" for c in current["claims"]))
        self.assertEqual(current["history"], old_events)
        self.assertEqual(ledger_path.read_bytes(), old_bytes)
        self.assertEqual(sha256(ledger_path.read_bytes()).hexdigest(), old_hash)
        self.assertEqual(set(current["pending_history"]), {e["id"] for e in old_events})
        self.assertEqual(current["policies"][0]["status"], "pending")

    def test_anchor_read_accept_reject_defer_and_undo_preserve_full_snapshot(self):
        self.generate()
        machine = self.query()["machine_graph"]
        before = self.files()
        self.assertEqual(self.query()["effective_graph"], machine)
        self.assertEqual(self.files(), before)
        accepted = self.review("accept")
        self.assertEqual(self.anchor_claim(accepted)["decision"], "accept")
        self.assertEqual(accepted["history"][-1]["target"]["entities"], [])
        self.assertEqual(accepted["history"][-1]["target"]["claim"], machine["relations"][-1])
        rejected = self.review("reject")
        self.assertEqual(rejected["effective_graph"]["relations"], [machine["relations"][0]])
        restored = self.undo(rejected["event_id"])
        self.assertEqual(self.anchor_claim(restored)["decision"], "accept")
        deferred = self.review("defer")
        self.assertEqual(self.anchor_claim(deferred)["decision"], "defer")
        self.assertTrue(self.anchor_claim(deferred)["needs_review"])
        self.assertEqual(len(deferred["history"]), 4)
        self.assertEqual(self.query()["history"], deferred["history"])

    def test_anchor_edit_and_undo_retain_qualifiers_provenance_and_raw_history(self):
        self.generate()
        original = self.anchor_claim()["value"]
        replacement = _input(original)
        replacement["predicate"] = "related_to"
        edited = self.review("edit", replacement=replacement)
        self.assertEqual(edited["effective_graph"]["relations"][-1]["predicate"], "related_to")
        self.assertEqual(edited["effective_graph"]["relations"][-1]["subject"], original["subject"])
        old_event = deepcopy(edited["history"][0])
        undone = self.undo(edited["event_id"])
        self.assertEqual(undone["effective_graph"]["relations"][-1], original)
        self.assertEqual(undone["history"][0], old_event)
        self.assertEqual(self.query()["history"], undone["history"])

    def test_mixed_anchor_entity_endpoint_snapshots_only_real_entities(self):
        relation = self.relation()
        relation["object"] = "product"
        self.generate(relations=[relation])
        reviewed = self.review("accept")
        self.assertEqual([e["id"] for e in reviewed["history"][0]["target"]["entities"]], ["product"])
        self.assertEqual(self.query()["history"], reviewed["history"])

    def test_source_change_reextraction_does_not_rebind_or_rewrite_old_events(self):
        self.generate()
        accepted = self.review("accept")
        ledger_path = self.reviews._path(self.document)
        old_bytes = ledger_path.read_bytes()
        changed_source = "추가 설명\n" + self.source
        changed = self.store.save(self.document, changed_source, expected_revision=self.revision)
        stale = self.query()
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["claims"], [])
        self.assertEqual(stale["history"], accepted["history"])
        self.assertEqual(stale["pending_history"], [accepted["event_id"]])
        self.generate(relations=[self.old_relation, self.relation(revision=changed.revision, line=3)],
                      expected_revision=changed.revision, expected_state_revision=stale["state_revision"])
        latest = self.query()
        self.assertEqual(self.anchor_claim(latest)["decision"], "unreviewed")
        self.assertNotEqual(self.anchor_claim(latest)["claim_id"], self.anchor_claim(accepted)["claim_id"])
        self.assertEqual(ledger_path.read_bytes(), old_bytes)
        histories = list(self.store._document_path(self.store.history_dir, self.document).glob("*.md"))
        self.assertEqual([p.read_bytes() for p in histories], [self.source.encode()])
        with self.assertRaises(ReviewConflictError):
            self.review("reject", snapshot=accepted)

    def test_generation_and_review_require_current_composite_cas(self):
        self.generate()
        baseline = self.query()
        reviewed = self.review("accept", snapshot=baseline)
        before = self.files()
        with self.assertRaises(ReviewConflictError):
            self.review("reject", snapshot=baseline)
        with self.assertRaises(ReviewConflictError):
            self.generate(expected_state_revision=baseline["state_revision"])
        with self.assertRaises(ReviewConflictError):
            self.generate()
        self.assertEqual(self.files(), before)
        self.generate(expected_state_revision=reviewed["state_revision"])

    def test_two_competing_anchor_reviews_append_one_event(self):
        self.generate()
        baseline = self.query()
        def apply(action):
            try:
                return self.review(action, snapshot=baseline)["changed"]
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(apply, ["accept", "reject"]))
        self.assertCountEqual(outcomes, [True, "conflict"])
        self.assertEqual(len(self.query()["history"]), 1)

    def test_v4_entity_policy_overlay_undo_and_anchor_policy_endpoint_rejection(self):
        self.generate()
        original = self.query()
        policy = self.policy(original)
        self.assertEqual(policy["effective_graph"]["relations"][-1]["subject"], "product")
        self.assertEqual(self.query()["history"], policy["history"])
        undone = self.reviews.policy_undo(
            self.document, event_id=policy["event_id"], expected_state_revision=policy["state_revision"],
            reason="합성 정책 되돌림", actor=self.actor)
        self.assertEqual(undone["effective_graph"], original["machine_graph"])
        invalid = self.policy_replacement()
        invalid["subject"] = self.anchor("개발자 워크스페이스")
        before = self.files()
        with self.assertRaises((ReviewValidationError, OntologyValidationError)):
            self.policy(undone, replacement=invalid)
        self.assertEqual(self.files(), before)

    def test_candidate_review_cannot_add_anchor_endpoint(self):
        candidate = {"id": "candidate", "subject": "product", "predicate": "related_to",
                     "object": "classification", "evidence": self.source.splitlines()[2],
                     "reason": "합성 확인 필요", "question": "확인할 수 있는가?"}
        self.generate(relation_candidates=[candidate])
        baseline = self.query()
        claim = next(c for c in baseline["claims"] if c["collection"] == "relation_candidates")
        before = self.files()
        with self.assertRaises(ReviewValidationError):
            self.review("edit", snapshot=baseline, claim=claim, replacement=self.relation())
        self.assertEqual(self.files(), before)

    def test_rehashed_historical_anchor_revision_mismatch_fails_closed(self):
        self.generate()
        self.review("accept")
        path = self.reviews._path(self.document)
        ledger = json.loads(path.read_bytes())
        event = ledger["events"][0]
        event["source_revision"] = "b" * 64
        event["hash"] = _hash({key: value for key, value in event.items() if key != "hash"})
        raw = json.dumps(ledger, ensure_ascii=False).encode()
        path.write_bytes(raw)  # Deliberate corruption of this temporary fixture only.
        before = self.files()
        with self.assertRaises(ReviewCorruptError):
            self.query()
        self.assertEqual(self.files(), before)

    def test_rehashed_active_anchor_wrong_location_fails_closed(self):
        self.generate()
        self.review("edit", replacement=self.relation())
        path = self.reviews._path(self.document)
        ledger = json.loads(path.read_bytes())
        event = ledger["events"][0]
        event["after"]["value"]["subject"]["start_line"] = 1
        event["after"]["value"]["subject"]["end_line"] = 1
        event["hash"] = _hash({key: value for key, value in event.items() if key != "hash"})
        path.write_bytes(json.dumps(ledger, ensure_ascii=False).encode())
        before = self.files()
        with self.assertRaises(ReviewCorruptError):
            self.query()
        self.assertEqual(self.files(), before)

    def test_ledger_read_failure_does_not_rewrite_source_graph_or_history(self):
        self.generate()
        self.review("accept")
        before = self.files()
        with patch("core.modules.reviews.store.ReviewStore._read_bytes", side_effect=OSError("injected read failure")):
            with self.assertRaisesRegex(OSError, "read failure"):
                self.query()
            with self.assertRaisesRegex(OSError, "read failure"):
                self.generate(expected_state_revision="a" * 64)
        self.assertEqual(self.files(), before)

    def test_fsync_and_replace_failure_preserve_complete_anchor_ledger(self):
        self.generate()
        accepted = self.review("accept")
        before = self.files()
        for target in ("core.modules.documents.store.os.fsync", "core.modules.reviews.ledger.os.replace"):
            with self.subTest(target=target), patch(target, side_effect=OSError("injected commit failure")):
                with self.assertRaisesRegex(OSError, "commit failure"):
                    self.review("reject", snapshot=accepted)
            self.assertEqual(self.files(), before)
            self.assertEqual(list(self.reviews.review_dir.glob(".wiki-*.tmp")), [])

    def test_success_cleanup_warning_has_one_committed_event(self):
        self.generate()
        original_staging = self.store._staged_file
        @contextmanager
        def staging(directory, content, failures):
            with original_staging(directory, content, failures) as staged:
                yield staged
            failures.append(CleanupFailure(directory / ".wiki-fixture.tmp", OSError("fixture warning")))
        with patch.object(self.store, "_staged_file", staging):
            result = self.review("accept")
        self.assertTrue(result["changed"])
        self.assertEqual(len(result["cleanup_failures"]), 1)
        current = self.query()
        self.assertEqual(current["review_revision"], result["review_revision"])
        self.assertEqual(len(current["history"]), 1)

    def test_event_limit_preserves_full_anchor_events_and_hashes(self):
        self.generate()
        self.review("accept")
        before = self.files()
        with patch("core.modules.reviews.contracts.MAX_REVIEW_EVENTS", 1):
            with self.assertRaises(ReviewLimitError):
                self.review("reject")
        self.assertEqual(self.files(), before)


if __name__ == "__main__":
    unittest.main()
