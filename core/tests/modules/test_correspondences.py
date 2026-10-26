"""Isolated D-038 storage contract fixtures and tests; all expert actions simulate users."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.documents.store import WikiStore


def correspondence_actor(**changes):
    actor = {"user_id": "alice", "tenant": "acme", "profile_id": "business", "domain": "catalog", "viewpoint": "business", "policy_revision": "a" * 64}
    actor.update(changes)
    return actor


def correspondence_fixture(wiki_store, *, basis="source"):
    """Seed three synthetic documents using WikiStore.save; return a full draft."""
    sources = {"a.md": "판매 가능 재고가 1개 이상 5개 이하인 상품을 선별한다.\n", "b.md": "매진 임박 상품은 출고를 우선한다.\n", "d.md": "판매 가능 재고가 1개 이상 5개 이하이면 매진 임박이다.\n"}
    anchors = {}
    for document, content in sources.items():
        try:
            snapshot = wiki_store.read(document)
        except FileNotFoundError:
            wiki_store.save(document, content, expected_revision=None)
            snapshot = wiki_store.read(document)
        anchors[document] = {"document": document, "source_revision": snapshot.revision, "quote": snapshot.content.strip(), "start_line": 1, "end_line": 1}
    return {"condition": anchors["a.md"], "concept": anchors["b.md"],
            "statement": "판매 가능 재고 1~5개 조건을 매진 임박 개념에 단방향으로 대응한다.", "direction": "condition_to_concept",
            "qualifiers": {"quantity": {"status": "specified", "expression": "판매 가능 재고 1개 이상 5개 이하", "subject": "판매 가능 재고", "unit": "개", "lower": "1", "upper": "5", "lower_inclusive": True, "upper_inclusive": True},
                           "conditions": {"status": "none", "items": []}, "exceptions": {"status": "none", "items": []}},
            "business_scope": {"axes": [{"name": "service", "status": "specified", "value": "catalog", "source": "합성 시험의 명시 업무 범위"}], "validity": {"status": "unrestricted", "source": "합성 시험의 명시 무기한 판단"}},
            "basis": {"kind": basis, "reason": "합성 시험의 연결 근거" if basis == "source" else "양끝점 표현 비교; 연결 정의 확인 필요", "link_evidence": [anchors["d.md"]] if basis == "source" else []},
            "references": [], "questions": [] if basis == "source" else ["수량이 판매 가능 재고를 뜻하는가?"], "related_to": []}

from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import (
    CorrespondenceValidationError, CorrespondenceConflictError, CorrespondenceCorruptError, CorrespondenceLimitError,
)
from core.common.json_codec import canonical_json_bytes as _encode, canonical_json_hash as _hash


class CorrespondenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.wiki = WikiStore(self.temp.name)
        self.actor = correspondence_actor()
        self.store = CorrespondenceStore(self.wiki, self.actor)
        self.draft = correspondence_fixture(self.wiki)
        self.context = {"service": "catalog"}

    def create(self, draft=None):
        draft = deepcopy(self.draft if draft is None else draft)
        prepared = self.store.query(draft=draft)
        result = self.store.propose(prepared["correspondence_id"], prepared["draft"], prepared["state_revision"], "합성 제안")
        self.cid = result["correspondence_id"]
        return result

    def query(self):
        return self.store.query(self.cid, application_context=self.context)

    def change(self, operation, **change):
        change.setdefault("reason", "합성 검토 또는 전문가 판단")
        prepared = self.store.prepare(self.cid, operation, change)
        return getattr(self.store, operation)(self.cid, expected_state_revision=prepared["state_revision"], **change)

    def accept(self):
        return self.store.review(self.cid, "accept", self.query()["state_revision"], "모의 원문 수용")

    def protected(self):
        return {p.relative_to(self.wiki.data_dir).as_posix(): p.read_bytes() for directory in (self.wiki.wiki_dir, self.wiki.history_dir, self.wiki.data_dir / "_ontology") for p in directory.rglob("*") if p.is_file()}

    def ledger_bytes(self):
        return self.store._path(self.cid).read_bytes()

    def expert(self, statement="합성 전문가의 업무 범위 내 대응 판단"):
        value = deepcopy(self.draft)
        value["statement"] = statement
        value["basis"] = {"kind": "expert", "reason": "합성 업무 판단; 실제 사람 승인 아님", "link_evidence": []}
        return value

    def test_prepare_is_read_only_and_receipt_identifies_committed_event(self):
        protected = self.protected()
        prepared = self.store.query(draft=self.draft)
        self.assertFalse(self.store.correspondence_dir.exists())
        self.assertIsNone(prepared["correspondence_revision"])
        result = self.store.propose(prepared["correspondence_id"], prepared["draft"], prepared["state_revision"], "합성 제안")
        self.cid = result["correspondence_id"]
        self.assertEqual(result["sequence"], 1)
        self.assertNotIn("history", result)
        history = self.query()["history"]
        self.assertEqual(history[0]["hash"], result["event_hash"])
        self.assertEqual(history[0]["id"], result["event_id"])
        self.assertEqual(protected, self.protected())

    def test_candidate_accept_fails_and_expert_policy_preserves_candidate_lane(self):
        self.create(correspondence_fixture(self.wiki, basis="candidate"))
        with self.assertRaises(CorrespondenceValidationError):
            self.accept()
        policy = self.change("policy", replacement=self.expert())
        queried = self.query()
        self.assertEqual(queried["source_proposal"]["decision"], "unreviewed")
        self.assertEqual(queried["source_proposal"]["value"]["basis"]["kind"], "candidate")
        self.assertEqual(queried["policies"][0]["decision"], "active")
        self.assertEqual(queried["policies"][0]["applicability"], "applicable")
        self.assertEqual(queried["policies"][0]["provenance"]["event_id"], policy["event_id"])
        restored = self.change("policy_undo", event_id=policy["event_id"])
        self.assertEqual(restored["source_proposal"]["decision"], "unreviewed")
        self.assertEqual(restored["policies"][0]["decision"], "inactive")

    def test_accept_reject_defer_and_latest_review_undo(self):
        self.create()
        accepted = self.accept()
        self.assertEqual(self.query()["source_proposal"]["applicability"], "applicable")
        rejected = self.store.review(self.cid, "reject", self.query()["state_revision"], "모의 거절")
        self.assertEqual(rejected["source_proposal"]["decision"], "rejected")
        self.change("review_undo", event_id=rejected["event_id"])
        self.assertEqual(self.query()["source_proposal"]["decision"], "accepted")
        with self.assertRaises(CorrespondenceValidationError):
            self.change("review_undo", event_id=accepted["event_id"])
        self.store.review(self.cid, "defer", self.query()["state_revision"], "모의 보류")
        self.assertEqual(self.query()["source_proposal"]["decision"], "deferred")
        self.assertEqual(len(self.query()["history"]), 5)

    def test_initial_accept_undo_is_unreviewed_and_undo_of_undo_restores(self):
        self.create()
        accepted = self.accept()
        undone = self.change("review_undo", event_id=accepted["event_id"])
        self.assertEqual(undone["source_proposal"]["decision"], "unreviewed")
        self.change("review_undo", event_id=undone["event_id"])
        self.assertEqual(self.query()["source_proposal"]["decision"], "accepted")

    def test_source_aba_is_detected_while_restored_baseline_is_preserved(self):
        self.create()
        accepted = self.accept()
        before = self.query()["source_proposal"]["basis_dependencies"]
        snapshot = self.wiki.read("d.md")
        self.wiki.save("d.md", snapshot.content + "추가\n", expected_revision=snapshot.revision)
        current = self.wiki.read("d.md")
        self.wiki.save("d.md", snapshot.content, expected_revision=current.revision)
        self.assertEqual(self.query()["source_proposal"]["applicability"], "needs_review")
        undone = self.change("review_undo", event_id=accepted["event_id"])
        restored = self.change("review_undo", event_id=undone["event_id"])
        self.assertEqual(restored["source_proposal"]["basis_dependencies"], before)
        self.assertEqual(self.query()["source_proposal"]["applicability"], "needs_review")

    def test_simultaneous_new_creation_and_reviews_have_one_winner(self):
        prepared = self.store.query(draft=self.draft)
        def propose(_):
            try:
                return self.store.propose(prepared["correspondence_id"], self.draft, prepared["state_revision"], "동시 모의 제안")["event_id"]
            except CorrespondenceConflictError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(result is not None for result in pool.map(propose, range(2))), 1)
        self.cid = prepared["correspondence_id"]
        token = self.query()["state_revision"]
        def review(action):
            try:
                return self.store.review(self.cid, action, token, "동시 모의 검토")["event_id"]
            except CorrespondenceConflictError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(result is not None for result in pool.map(review, ["accept", "reject"])), 1)
        self.assertEqual(len(self.query()["history"]), 2)

    def test_stale_token_conflicts_before_stale_anchor_validation(self):
        self.create()
        old = self.query()["state_revision"]
        source = self.wiki.read("d.md")
        self.wiki.save("d.md", source.content + "변경\n", expected_revision=source.revision)
        original = self.ledger_bytes()
        with self.assertRaises(CorrespondenceConflictError):
            self.store.review(self.cid, "accept", old, "오래된 검토")
        with self.assertRaises(CorrespondenceValidationError):
            self.store.review(self.cid, "accept", self.query()["state_revision"], "token만 바꾼 옛 판단")
        self.assertEqual(original, self.ledger_bytes())

    def test_source_only_ignores_unrelated_corrupt_graph_and_document_ledger(self):
        from core.modules.ontology.store import OntologyStore
        from core.modules.reviews.store import ReviewStore
        ontology, reviews = OntologyStore(self.wiki), ReviewStore(self.wiki)
        self.wiki._mkdir(ontology.ontology_dir)
        self.wiki._mkdir(reviews.review_dir)
        for doc in ("a.md", "b.md", "d.md"):
            ontology._path(doc).write_bytes(b"broken graph")
            reviews._path(doc).write_bytes(b"broken ledger")
        protected = self.protected()
        self.create()
        self.accept()
        self.assertEqual(self.query()["source_proposal"]["applicability"], "applicable")
        self.assertTrue(all("graph_revision" not in item for item in self.query()["dependencies"]["documents"]))
        self.assertEqual(protected, self.protected())

    def test_missing_allows_explicit_deferral_and_undo_but_never_acceptance(self):
        self.create()
        accepted = self.accept()
        self.wiki._document_path(self.wiki.wiki_dir, "d.md").unlink()
        result = self.query()
        self.assertFalse(result["complete"])
        self.assertNotIn("state_revision", result)
        self.assertEqual(result["source_proposal"]["applicability"], "unavailable")
        deferred = self.change("review", action="defer")
        self.assertEqual(deferred["source_proposal"]["decision"], "deferred")
        restored = self.change("review_undo", event_id=deferred["event_id"])
        self.assertEqual(restored["source_proposal"]["decision"], "accepted")
        self.assertEqual(restored["source_proposal"]["applicability"], "unavailable")
        before = self.ledger_bytes()
        prepared = self.store.prepare(self.cid, "review", {"action": "accept", "reason": "missing 수용 거부"})
        self.assertNotIn("state_revision", prepared)
        self.assertEqual(before, self.ledger_bytes())

    def test_expert_exact_scope_explicit_source_supersession_and_undo(self):
        self.create()
        accepted = self.accept()
        with self.assertRaises(CorrespondenceValidationError):
            self.change("policy", replacement=self.expert())
        policy = self.change("policy", replacement=self.expert(), supersedes_event_id=accepted["event_id"])
        scoped = self.query()
        self.assertEqual(scoped["source_proposal"]["applicability"], "inactive")
        self.assertEqual(scoped["policies"][0]["applicability"], "applicable")
        alternate = CorrespondenceStore(self.wiki, correspondence_actor(profile_id="developer", viewpoint="developer"))
        queried = alternate.query(self.cid, application_context=self.context)
        self.assertEqual(queried["source_proposal"]["applicability"], "applicable")
        self.assertEqual(queried["policies"][0]["applicability"], "other_scope")
        self.change("policy_undo", event_id=policy["event_id"])
        self.assertEqual(self.query()["source_proposal"]["applicability"], "applicable")

    def test_policy_update_and_undo_preserve_full_previous_value(self):
        self.create(correspondence_fixture(self.wiki, basis="candidate"))
        first = self.change("policy", replacement=self.expert())
        snap = self.query()
        judgment = snap["policies"][0]["judgment_id"]
        second = self.change("policy", replacement=self.expert("변경한 모의 업무 판단"), judgment_id=judgment, supersedes_event_id=first["event_id"])
        restored = self.change("policy_undo", event_id=second["event_id"])
        self.assertEqual(restored["policies"][0]["value"], first["policies"][0]["value"])
        with self.assertRaises(CorrespondenceValidationError):
            self.change("review_undo", event_id=restored["event_id"])

    def test_new_policy_coexistence_reports_known_conflict(self):
        self.create(correspondence_fixture(self.wiki, basis="candidate"))
        self.change("policy", replacement=self.expert("첫 모의 기준"))
        self.change("policy", replacement=self.expert("두 번째 상충 모의 기준"))
        self.assertEqual([policy["applicability"] for policy in self.query()["policies"]], ["conflicting", "conflicting"])

    def test_atomic_creation_and_replace_failures_preserve_previous_bytes(self):
        prepared = self.store.query(draft=self.draft)
        protected = self.protected()
        with patch("core.modules.correspondences.ledger.os.link", side_effect=OSError(5, "publish failure")):
            with self.assertRaises(OSError):
                self.store.propose(prepared["correspondence_id"], self.draft, prepared["state_revision"], "모의 생성 실패")
        self.assertFalse(self.store._path(prepared["correspondence_id"]).exists())
        self.assertEqual(protected, self.protected())
        self.create()
        original = self.ledger_bytes()
        with patch("core.modules.correspondences.ledger.os.replace", side_effect=OSError(5, "replace failure")):
            with self.assertRaises(OSError):
                self.accept()
        self.assertEqual(original, self.ledger_bytes())
        self.assertEqual(protected, self.protected())
        self.assertEqual(list(self.wiki.data_dir.rglob("*.tmp")), [])

    def test_staging_fsync_and_receipt_failures_precede_publication(self):
        self.create()
        original = self.ledger_bytes()
        for target in ("core.modules.documents.store.os.fsync", "core.modules.correspondences.store.CorrespondenceStore._result"):
            with self.subTest(target=target), patch(target, side_effect=OSError(5, "injected")):
                with self.assertRaises(OSError):
                    self.accept()
            self.assertEqual(original, self.ledger_bytes())
        self.assertEqual(list(self.wiki.data_dir.rglob("*.tmp")), [])

    def test_cleanup_failure_is_success_and_primary_failure_is_not_masked(self):
        original_unlink = Path.unlink
        def fail_tmp(path, *args, **kwargs):
            if path.name.endswith(".tmp"):
                raise PermissionError(13, "injected cleanup")
            return original_unlink(path, *args, **kwargs)
        prepared = self.store.query(draft=self.draft)
        with patch.object(Path, "unlink", fail_tmp):
            result = self.store.propose(prepared["correspondence_id"], self.draft, prepared["state_revision"], "정리 실패 뒤 성공")
        self.cid = result["correspondence_id"]
        self.assertEqual(len(result["cleanup_failures"]), 1)
        self.assertEqual(len(self.query()["history"]), 1)
        for path in self.wiki.data_dir.rglob("*.tmp"):
            path.unlink()
        original = self.ledger_bytes()
        with patch.object(Path, "unlink", fail_tmp), patch("core.modules.correspondences.ledger.os.replace", side_effect=OSError(5, "primary")):
            with self.assertRaises(OSError) as caught:
                self.accept()
        self.assertEqual(caught.exception.errno, 5)
        self.assertEqual(len(caught.exception.cleanup_failures), 1)
        self.assertEqual(original, self.ledger_bytes())
        for path in self.wiki.data_dir.rglob("*.tmp"):
            path.unlink()

    def test_no_clobber_external_creation_is_preserved(self):
        prepared = self.store.query(draft=self.draft)
        target = self.store._path(prepared["correspondence_id"])
        original_link = os.link
        def competing_link(source, destination):
            Path(destination).write_bytes(b"external preserved bytes")
            return original_link(source, destination)
        with patch("core.modules.correspondences.ledger.os.link", side_effect=competing_link):
            with self.assertRaises(FileExistsError):
                self.store.propose(prepared["correspondence_id"], self.draft, prepared["state_revision"], "외부 생성 보존")
        self.assertEqual(target.read_bytes(), b"external preserved bytes")

    def test_strict_replay_rejects_rehashed_before_tampering_and_json_duplicates(self):
        self.create()
        self.accept()
        raw = self.ledger_bytes()
        ledger = json.loads(raw)
        ledger["events"][1]["before"]["decision"] = "rejected"
        event = ledger["events"][1]
        event["hash"] = _hash({k: v for k, v in event.items() if k != "hash"})
        self.store._path(self.cid).write_bytes(_encode(ledger))
        with self.assertRaises(CorrespondenceCorruptError):
            self.query()
        self.store._path(self.cid).write_bytes(raw.replace(b'"version":1', b'"version":1,"version":1'))
        with self.assertRaises(CorrespondenceCorruptError):
            self.query()
        self.assertNotEqual(raw, self.ledger_bytes())

    def test_event_byte_capture_and_detail_limits_preserve_whole_history(self):
        self.create()
        original = self.ledger_bytes()
        for name, limit in (("MAX_CORRESPONDENCE_EVENTS", 1), ("MAX_CORRESPONDENCE_BYTES", len(original) + 1), ("MAX_RECEIPT_BYTES", 1)):
            with self.subTest(name=name), patch("core.modules.correspondences.contracts." + name, limit):
                with self.assertRaises(CorrespondenceLimitError):
                    self.accept()
            self.assertEqual(original, self.ledger_bytes())
        with patch("core.modules.correspondences.contracts.MAX_DETAIL_BYTES", 1):
            with self.assertRaises(CorrespondenceLimitError):
                self.query()
        with patch("core.modules.correspondences.contracts.MAX_CAPTURE_BYTES", 10):
            with self.assertRaises(CorrespondenceLimitError):
                self.query()
        self.assertEqual(original, self.ledger_bytes())

    def test_find_reports_own_corrupt_file_and_result_limit(self):
        first = self.create()
        self.create()
        result = self.store.find(["a.md"], limit=1)
        self.assertEqual(len(result["results"]), 1)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.store._path(first["correspondence_id"]).write_bytes(b"malformed")
        result = self.store.find(["a.md"])
        self.assertEqual(len(result["results"]), 1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["skipped"][0]["reason"], "CorrespondenceCorruptError")

    def test_anchor_occurrence_and_symlink_paths_are_rejected(self):
        a = self.wiki.read("a.md")
        self.wiki.save("a.md", "상품 상품\n", expected_revision=a.revision)
        draft = deepcopy(self.draft)
        draft["condition"] = {"document": "a.md", "source_revision": self.wiki.read("a.md").revision, "quote": "상품", "start_line": 1, "end_line": 1}
        with self.assertRaises(CorrespondenceValidationError):
            self.store.query(draft=draft)
        draft["condition"]["occurrence"] = 1
        self.assertTrue(self.store.query(draft=draft)["complete"])
        self.wiki._document_path(self.wiki.wiki_dir, "alias.md").symlink_to(self.wiki.wiki_dir / "a.md")
        draft["condition"]["document"] = "alias.md"
        with self.assertRaises(ValueError):
            self.store.query(draft=draft)

class CorrespondenceReferenceTests(unittest.TestCase):
    setUp = CorrespondenceTests.setUp
    create = CorrespondenceTests.create
    query = CorrespondenceTests.query
    change = CorrespondenceTests.change
    accept = CorrespondenceTests.accept
    protected = CorrespondenceTests.protected
    ledger_bytes = CorrespondenceTests.ledger_bytes
    expert = CorrespondenceTests.expert
    # Reuse lifecycle helpers without inheriting its test methods twice.
    def make_graph(self):
        from core.modules.ontology.store import OntologyStore
        from core.modules.reviews.store import ReviewStore
        self.ontology = OntologyStore(self.wiki)
        self.reviews = ReviewStore(self.wiki)
        source = self.wiki.read("a.md")
        quote = source.content.strip()
        self.graph_entities = [{"id": "product", "label": "상품", "type": "concept", "evidence": quote}, {"id": "stock", "label": "판매 가능 재고", "type": "concept", "evidence": quote}]
        self.graph_relations = [{"subject": "product", "predicate": "uses", "object": "stock", "evidence": quote}]
        self.ontology.generate("a.md", source.revision, self.graph_entities, self.graph_relations)
        return self.reviews.query("a.md", domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])

    def graph_draft(self):
        snap = self.make_graph()
        draft = deepcopy(self.draft)
        draft["condition"]["graph_ref"] = {"graph_revision": snap["graph_revision"], "state_revision": snap["state_revision"], "collection": "entities", "entity_id": "stock", "snapshot": snap["machine_graph"]["entities"][1], "layer": "machine"}
        return draft

    def test_graph_reference_aba_and_current_snapshot_validation(self):
        draft = self.graph_draft()
        self.create(draft)
        self.accept()
        original = self.query()
        source = self.wiki.read("a.md")
        modified = deepcopy(self.graph_relations)
        modified[0]["predicate"] = "related_to"
        self.ontology.generate("a.md", source.revision, self.graph_entities, modified)
        self.ontology.generate("a.md", source.revision, self.graph_entities, self.graph_relations)
        self.assertEqual(self.query()["source_proposal"]["applicability"], "needs_review")
        self.assertNotEqual(original["dependencies"], self.query()["dependencies"])
        with self.assertRaises(CorrespondenceValidationError):
            self.store.review(self.cid, "accept", self.query()["state_revision"], "바뀐 그래프token만 교체 금지")

    def test_graph_reference_missing_and_corrupt_are_distinguished(self):
        from core.modules.ontology.errors import OntologyCorruptError
        self.create(self.graph_draft())
        self.accept()
        graph_path = self.ontology._path("a.md")
        original = graph_path.read_bytes()
        graph_path.unlink()
        self.assertFalse(self.query()["complete"])
        self.change("review", action="reject")
        graph_path.write_bytes(b"corrupt graph")
        ledger = self.ledger_bytes()
        with self.assertRaises(OntologyCorruptError):
            self.store.prepare(self.cid, "review", {"action": "defer", "reason": "손상 우회 금지"})
        self.assertEqual(ledger, self.ledger_bytes())
        graph_path.write_bytes(original)

    def test_document_review_dependency_and_missing_event(self):
        snap = self.make_graph()
        claim = snap["claims"][0]
        accepted = self.reviews.review("a.md", action="accept", claim_id=claim["claim_id"], expected_state_revision=snap["state_revision"], reason="모의 문서 검토", actor=self.actor)
        event = accepted["history"][-1]
        draft = deepcopy(self.draft)
        draft["references"] = [{"kind": "review", "document": "a.md", "event_id": event["id"], "state_revision": accepted["state_revision"], "snapshot": event["after"], "scope": None}]
        self.create(draft)
        self.accept()
        protected = self.reviews._path("a.md").read_bytes()
        self.assertEqual(self.query()["source_proposal"]["applicability"], "applicable")
        self.assertEqual(protected, self.reviews._path("a.md").read_bytes())
        self.reviews._path("a.md").unlink()
        result = self.query()
        self.assertFalse(result["complete"])
        self.assertNotIn("state_revision", result)
        self.assertEqual(result["source_proposal"]["applicability"], "unavailable")
        self.change("review", action="defer")

    def test_document_policy_exact_scope_is_an_additional_restriction(self):
        from core.modules.reviews.values import _input
        snap = self.make_graph()
        claim = snap["claims"][0]
        replacement = _input(claim["value"])
        replacement.pop("evidence")
        replacement.pop("provenance")
        replacement["context"] = {"domain": self.actor["domain"], "viewpoints": [self.actor["viewpoint"]]}
        replacement["qualifiers"]["condition"] = "명시한 합성 시험 업무에 한함"
        policy = self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement, expected_state_revision=snap["state_revision"], reason="모의 업무 정책", actor=self.actor)
        event = policy["history"][-1]
        draft = deepcopy(self.draft)
        draft["references"] = [{"kind": "policy", "document": "a.md", "event_id": event["id"], "state_revision": policy["state_revision"], "snapshot": event["after"], "scope": {"domain": self.actor["domain"], "viewpoint": self.actor["viewpoint"]}}]
        self.create(draft)
        self.accept()
        self.assertEqual(self.query()["source_proposal"]["applicability"], "applicable")
        other = CorrespondenceStore(self.wiki, correspondence_actor(profile_id="developer", viewpoint="developer"))
        result = other.query(self.cid, application_context=self.context)
        self.assertEqual(result["source_proposal"]["applicability"], "other_scope")
        self.assertEqual(self.query()["source_proposal"]["basis_dependencies"], result["source_proposal"]["basis_dependencies"])

    def reference_to(self, result):
        current = self.store.query(result["correspondence_id"], application_context=self.context)
        event = current["history"][-1]
        return {"kind": "correspondence", "correspondence_id": current["correspondence_id"], "event_id": event["id"], "correspondence_revision": current["correspondence_revision"], "snapshot": event["after"], "scope": event["after"]["policy_scope"]}

    def test_correspondence_reference_closure_stale_and_context_stability(self):
        first = self.create()
        first = self.accept()
        reference = self.reference_to(first)
        draft = deepcopy(self.draft)
        draft["references"] = [reference]
        self.create(draft)
        self.accept()
        here = self.query()
        elsewhere = self.store.query(self.cid, application_context={"service": "other"}, as_of="2100-01-01T00:00:00+00:00")
        self.assertEqual(here["state_revision"], elsewhere["state_revision"])
        self.assertEqual(elsewhere["source_proposal"]["applicability"], "other_scope")
        source = self.wiki.read("d.md")
        self.wiki.save("d.md", source.content + "근거 변경\n", expected_revision=source.revision)
        self.assertEqual(self.query()["source_proposal"]["applicability"], "needs_review")

    def test_correspondence_cycles_and_depth_are_rejected_without_publication(self):
        self.create()
        first = self.accept()
        source_cid = self.cid
        reference = self.reference_to(first)
        draft = deepcopy(self.draft)
        draft["references"] = [reference]
        self.create(draft)
        second = self.accept()
        second_ref = self.reference_to(second)
        replacement = deepcopy(self.draft)
        replacement["references"] = [second_ref]
        with self.assertRaises(CorrespondenceValidationError):
            self.store.prepare(source_cid, "review", {"action": "edit", "replacement": replacement, "decision": "accepted", "reason": "순환 생성 금지"})
        for index in range(3):
            draft = deepcopy(self.draft)
            draft["references"] = [self.reference_to(second)]
            self.create(draft)
            second = self.accept()
        draft = deepcopy(self.draft)
        draft["references"] = [self.reference_to(second)]
        with self.assertRaises(CorrespondenceLimitError):
            self.store.query(draft=draft)

    def test_document_closure_limit_and_reference_snapshot_forgery(self):
        draft = deepcopy(self.draft)
        for index in range(6):
            document = f"extra{index}.md"
            saved = self.wiki.save(document, "별도 실제 연결 정의\n", expected_revision=None)
            draft["basis"]["link_evidence"].append({"document": document, "source_revision": saved.revision, "quote": "별도 실제 연결 정의", "start_line": 1, "end_line": 1})
        with self.assertRaises(CorrespondenceLimitError):
            self.store.query(draft=draft)
        draft = self.graph_draft()
        draft["condition"]["graph_ref"]["snapshot"]["label"] = "위조 의미"
        with self.assertRaises(CorrespondenceValidationError):
            self.store.query(draft=draft)

    def test_rehashed_missing_explicit_source_supersession_is_corrupt(self):
        self.create()
        accepted = self.accept()
        self.change("policy", replacement=self.expert(), supersedes_event_id=accepted["event_id"])
        ledger = json.loads(self.ledger_bytes())
        event = ledger["events"][-1]
        event["supersedes_event_id"] = None
        event["after"]["supersedes_event_id"] = None
        event["hash"] = _hash({key: value for key, value in event.items() if key != "hash"})
        malformed = _encode(ledger)
        self.store._path(self.cid).write_bytes(malformed)
        with self.assertRaises(CorrespondenceCorruptError):
            self.query()
        self.assertEqual(malformed, self.ledger_bytes())


if __name__ == "__main__":
    unittest.main()
