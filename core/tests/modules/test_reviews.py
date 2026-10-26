"""Isolated contract tests for durable ontology reviews, not LLM accuracy."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.ontology.store import OntologyStore
from core.modules.ontology.errors import OntologyValidationError
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import (
    ReviewConflictError, ReviewCorruptError, ReviewLimitError, ReviewValidationError,
)
from core.modules.reviews.values import _input
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.documents.store import CleanupFailure, WikiStore


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = WikiStore(self.temp.name)
        self.ontology = OntologyStore(self.store)
        self.reviews = ReviewStore(self.store)
        self.document = "guide/상품.md"
        self.source = (
            "카탈로그 상품은 재고가 10개 이상이면 할인에 사용된다. 가격은 20 원이며 변경 가격은 30 원이다.\n"
            "상품은 배송에 사용될 수 있다.\n"
            "보고서가 상품과 배송을 기술한다. 팀이 보고서를 작성한다.\n"
        )
        self.revision = self.store.save(self.document, self.source, expected_revision=None).revision
        self.entities = [
            {"id": "product", "label": "상품", "type": "concept", "evidence": self.source.splitlines()[0]},
            {"id": "discount", "label": "할인", "type": "concept", "evidence": self.source.splitlines()[0]},
            {"id": "shipping", "label": "배송", "type": "process", "evidence": self.source.splitlines()[1]},
            {"id": "report", "label": "보고서", "type": "document", "evidence": self.source.splitlines()[2]},
            {"id": "team", "label": "팀", "type": "organization", "evidence": self.source.splitlines()[2]},
        ]
        self.relations = [{"subject": "product", "predicate": "uses", "object": "discount",
                           "evidence": self.source.splitlines()[0],
                           "qualifiers": {"condition": "재고가 10개 이상이면"},
                           "context": {"domain": "카탈로그", "viewpoints": ["business"]}}]
        self.attributes = [{"id": "price", "subject": "product", "property": "가격", "datatype": "number",
                            "value": "20", "unit": "원", "evidence": self.source.splitlines()[0]}]
        self.candidates = [{"id": "shipping_candidate", "subject": "product", "predicate": "uses", "object": "shipping",
                            "evidence": self.source.splitlines()[1], "qualifiers": {"modality": "possible"},
                            "reason": "주장 확인 필요", "question": "현재 적용 가능한가?"}]
        self.actor = {"user_id": "alice", "tenant": "acme", "profile_id": "business",
                      "domain": "카탈로그", "viewpoint": "business", "policy_revision": "a" * 64}
        self.generate()

    def generate(self, **kwargs):
        values = {"document": self.document, "expected_revision": self.revision,
                  "entities": self.entities, "relations": self.relations,
                  "relation_candidates": self.candidates, "attributes": self.attributes}
        values.update(kwargs)
        return self.ontology.generate(**values)

    def query(self, **kwargs):
        return self.reviews.query(self.document, **kwargs)

    def claim(self, collection="relations", snapshot=None):
        return next(claim for claim in (snapshot or self.query())["claims"] if claim["collection"] == collection)

    def review(self, action, collection="relations", snapshot=None, **kwargs):
        snapshot = snapshot or self.query()
        values = {"document": self.document, "action": action,
                  "claim_id": self.claim(collection, snapshot)["claim_id"],
                  "expected_state_revision": snapshot["state_revision"],
                  "reason": "고정 fixture의 모의 검토", "actor": self.actor}
        values.update(kwargs)
        return self.reviews.review(**values)

    def undo(self, event_id, snapshot=None, **kwargs):
        snapshot = snapshot or self.query()
        return self.reviews.undo(self.document, event_id=event_id,
                                 expected_state_revision=snapshot["state_revision"],
                                 reason="고정 fixture 모의 되돌림", actor=self.actor, **kwargs)

    def protected(self):
        return {path.relative_to(self.store.data_dir).as_posix(): path.read_bytes()
                for directory in (self.store.wiki_dir, self.store.history_dir, self.ontology.ontology_dir)
                for path in directory.rglob("*") if path.is_file()}

    def policy(self, collection="relations", *, snapshot=None, actor=None, replacement=None, **kwargs):
        actor = actor or self.actor
        snapshot = snapshot or self.query(domain=actor["domain"], viewpoint=actor["viewpoint"])
        claim = self.claim(collection, snapshot)
        if replacement is None:
            replacement = {key: value for key, value in _input(claim["value"]).items()
                           if key not in {"evidence", "provenance"}}
            replacement["context"] = {"domain": actor["domain"], "viewpoints": [actor["viewpoint"]]}
            if collection == "attributes":
                replacement["value"] = "57"
            else:
                replacement["predicate"] = "related_to"
            replacement["qualifiers"]["condition"] = "전문가가 승인한 프로젝트에 한함"
        return self.reviews.policy(self.document, claim_id=claim["claim_id"], replacement=replacement,
                                   expected_state_revision=snapshot["state_revision"],
                                   reason="모의 업무 전문가의 프로젝트 정책 결정", actor=actor, **kwargs)

    def policy_undo(self, event_id, *, snapshot=None, actor=None):
        actor = actor or self.actor
        snapshot = snapshot or self.query(domain=actor["domain"], viewpoint=actor["viewpoint"])
        return self.reviews.policy_undo(self.document, event_id=event_id,
                                        expected_state_revision=snapshot["state_revision"],
                                        reason="모의 전문가 정책 되돌림", actor=actor)

    def test_query_is_read_only_preserves_graph_and_profile_partition(self):
        protected = self.protected()
        result = self.query(domain="카탈로그", viewpoint="business")
        self.assertEqual(result["machine_graph"], result["effective_graph"])
        self.assertIsNone(result["review_revision"])
        self.assertEqual(result["history"], [])
        self.assertTrue(result["needs_review"])
        self.assertEqual(result["selection"]["machine"]["relations"]["focus"], [0])
        self.assertFalse(self.reviews.review_dir.exists())
        self.assertEqual(protected, self.protected())

    def test_relation_accept_reject_defer_and_history_preserve_full_values(self):
        protected = self.protected()
        original = self.claim()["value"]
        accepted = self.review("accept")
        self.assertEqual(self.claim(snapshot=accepted)["decision"], "accept")
        self.assertEqual(accepted["effective_graph"]["relations"], [original])
        rejected = self.review("reject")
        self.assertEqual(rejected["effective_graph"]["relations"], [])
        deferred = self.review("defer")
        self.assertEqual(deferred["effective_graph"]["relations"], [])
        self.assertEqual([event["action"] for event in deferred["history"]], ["accept", "reject", "defer"])
        for event in deferred["history"]:
            self.assertEqual(event["actor"], self.actor)
            self.assertEqual(event["target"]["claim"], original)
            self.assertEqual(event["before"]["value"], original)
            self.assertEqual(event["after"]["value"], original)
            self.assertEqual({e["id"] for e in event["target"]["entities"]}, {"product", "discount"})
            self.assertEqual(event["source_revision"], self.revision)
        self.assertEqual(deferred["history"], self.query()["history"])
        self.assertEqual(protected, self.protected())

    def test_edit_relation_preserves_restrictions_and_undo_appends_inverse(self):
        original = self.claim()["value"]
        replacement = _input(original)
        replacement["predicate"] = "related_to"
        changed = self.review("edit", replacement=replacement)
        self.assertEqual(changed["machine_graph"]["relations"], [original])
        self.assertEqual(changed["effective_graph"]["relations"][0]["predicate"], "related_to")
        self.assertEqual(changed["effective_graph"]["relations"][0]["qualifiers"], original["qualifiers"])
        restored = self.undo(changed["event_id"])
        self.assertEqual(len(restored["history"]), 2)
        self.assertEqual(restored["history"][0], changed["history"][0])
        self.assertEqual(restored["history"][1]["undo_of"], changed["event_id"])
        self.assertEqual(restored["effective_graph"]["relations"], [original])
        self.assertEqual(self.claim(snapshot=restored)["decision"], "unreviewed")
        redone = self.undo(restored["event_id"])
        self.assertEqual(redone["effective_graph"]["relations"], changed["effective_graph"]["relations"])
        self.assertEqual(len(self.query()["history"]), 3)

    def test_attribute_all_actions_and_edit_full_values(self):
        original = self.claim("attributes")["value"]
        self.review("accept", "attributes")
        replacement = _input(original)
        replacement["value"] = "30"
        changed = self.review("edit", "attributes", replacement=replacement)
        self.assertEqual(changed["effective_graph"]["attributes"][0]["value"], "30")
        rejected = self.review("reject", "attributes")
        self.assertEqual(rejected["effective_graph"]["attributes"], [])
        deferred = self.review("defer", "attributes")
        self.assertEqual(deferred["effective_graph"]["attributes"], [])
        self.assertEqual(deferred["history"][-1]["after"]["value"]["value"], "30")
        self.assertEqual(len(self.query()["history"]), 4)

    def test_candidate_accept_promotes_only_reviewed_layer_and_undo_restores(self):
        original = self.claim("relation_candidates")["value"]
        accepted = self.review("accept", "relation_candidates")
        self.assertEqual(accepted["effective_graph"]["relation_candidates"], [])
        self.assertEqual(len(accepted["effective_graph"]["relations"]), 2)
        self.assertEqual(accepted["effective_graph"]["relations"][-1]["qualifiers"]["modality"], "possible")
        self.assertEqual(accepted["machine_graph"]["relation_candidates"], [original])
        restored = self.undo(accepted["event_id"])
        self.assertEqual(restored["effective_graph"], restored["machine_graph"])
        self.assertEqual(self.query()["history"], restored["history"])

    def test_candidate_edit_reject_and_defer(self):
        original = self.claim("relation_candidates")["value"]
        replacement = {key: value for key, value in _input(original).items() if key not in {"id", "reason", "question"}}
        replacement["predicate"] = "related_to"
        edited = self.review("edit", "relation_candidates", replacement=replacement)
        self.assertEqual(edited["effective_graph"]["relations"][-1]["predicate"], "related_to")
        for action in ("reject", "defer"):
            result = self.review(action, "relation_candidates")
            self.assertEqual(len(result["effective_graph"]["relations"]), 1)
            self.assertEqual(result["effective_graph"]["relation_candidates"], [])
        self.assertEqual(len(self.query()["history"]), 3)

    def test_unquoted_candidate_cannot_be_accepted_but_can_be_deferred(self):
        candidate = {key: value for key, value in self.candidates[0].items() if key not in {"evidence", "qualifiers"}}
        self.generate(relation_candidates=[candidate])
        with self.assertRaises(OntologyValidationError):
            self.review("accept", "relation_candidates")
        self.assertFalse(self.reviews.review_dir.exists())
        self.review("defer", "relation_candidates")
        self.assertEqual(len(self.query()["history"]), 1)

    def test_edit_cannot_invent_evidence_entities_or_drop_metadata_implicitly(self):
        original = _input(self.claim()["value"])
        invalid = []
        bad = deepcopy(original); bad["evidence"] = "없는 근거"; invalid.append(bad)
        bad = deepcopy(original); bad["object"] = "nonexistent"; invalid.append(bad)
        bad = deepcopy(original); del bad["qualifiers"]["condition"]; invalid.append(bad)
        bad = deepcopy(original); del bad["context"]; invalid.append(bad)
        bad = deepcopy(original); bad["extra"] = "ignored?"; invalid.append(bad)
        before = self.protected()
        for replacement in invalid:
            with self.subTest(replacement=replacement):
                with self.assertRaises((ReviewValidationError, OntologyValidationError)):
                    self.review("edit", replacement=replacement)
                self.assertEqual(self.query()["history"], [])
        self.assertEqual(before, self.protected())

    def test_stale_review_token_conflicts_even_when_same_action(self):
        base = self.query()
        self.review("accept", snapshot=base)
        with self.assertRaises(ReviewConflictError):
            self.review("accept", snapshot=base)
        self.assertEqual(len(self.query()["history"]), 1)

    def test_concurrent_reviews_commit_exactly_one_event(self):
        base = self.query()
        def submit(action):
            try:
                self.review(action, snapshot=base)
                return "saved"
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, ["accept", "reject"]))
        self.assertCountEqual(results, ["saved", "conflict"])
        self.assertEqual(len(self.query()["history"]), 1)

    def test_generation_and_review_share_state_cas(self):
        base = self.query()
        def review():
            try:
                self.review("accept", snapshot=base)
                return "saved"
            except ReviewConflictError:
                return "conflict"
        def generate():
            try:
                self.generate(relations=[], expected_state_revision=base["state_revision"])
                return "saved"
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [future.result() for future in [pool.submit(review), pool.submit(generate)]]
        self.assertCountEqual(results, ["saved", "conflict"])

    def test_generation_requires_current_review_state_after_first_decision(self):
        original = self.ontology._path(self.document).read_bytes()
        result = self.review("reject")
        with self.assertRaises(ReviewConflictError):
            self.generate(relations=[])
        self.assertEqual(self.ontology._path(self.document).read_bytes(), original)
        unchanged = self.generate(expected_state_revision=result["state_revision"])
        self.assertFalse(unchanged["changed"])
        self.assertEqual(self.claim()["decision"], "reject")

    def test_reextraction_retains_decisions_but_does_not_apply_them(self):
        accepted = self.review("accept")
        replacement = _input(self.claim("attributes")["value"])
        replacement["value"] = "30"
        edited = self.review("edit", "attributes", replacement=replacement)
        rejected = self.review("reject", snapshot=edited)
        self.assertEqual(rejected["effective_graph"]["relations"], [])
        ledger_before = self.reviews._path(self.document).read_bytes()
        self.generate(relations=[], expected_state_revision=rejected["state_revision"])
        result = self.query()
        self.assertEqual(result["history"], rejected["history"])
        self.assertEqual(self.reviews._path(self.document).read_bytes(), ledger_before)
        self.assertEqual([event["action"] for event in result["history"]], ["accept", "edit", "reject"])
        self.assertEqual(self.claim("attributes")["decision"], "unreviewed")
        self.assertEqual(result["effective_graph"]["attributes"][0]["value"], "20")
        self.assertTrue(result["pending_history"])
        self.assertTrue(result["needs_review"])
        with self.assertRaises(ReviewValidationError):
            self.undo(accepted["event_id"])

    def test_graph_aba_cannot_revive_old_review(self):
        accepted = self.review("accept")
        original_graph_revision = accepted["graph_revision"]
        self.generate(relations=[], expected_state_revision=accepted["state_revision"])
        self.generate(expected_state_revision=self.query()["state_revision"])
        result = self.query()
        self.assertNotEqual(result["graph_revision"], original_graph_revision)
        self.assertEqual(self.claim()["decision"], "unreviewed")
        self.assertEqual(result["history"], accepted["history"])

    def test_source_change_stale_and_aba_never_revive_old_review(self):
        accepted = self.review("accept")
        changed = self.store.save(self.document, self.source + "추가\n", expected_revision=self.revision)
        stale = self.query()
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["claims"], [])
        self.assertEqual(stale["history"], accepted["history"])
        self.store.save(self.document, self.source, expected_revision=changed.revision)
        result = self.query()
        self.assertEqual(result["source_revision"], accepted["source_revision"])
        self.assertNotEqual(result["history_revision"], accepted["history_revision"])
        self.assertEqual(self.claim()["decision"], "unreviewed")
        with self.assertRaises(ReviewConflictError):
            self.review("reject", snapshot=accepted)
        histories = list(self.store._document_path(self.store.history_dir, self.document).glob("*.md"))
        self.assertCountEqual([path.read_bytes() for path in histories], [self.source.encode(), (self.source + "추가\n").encode()])

    def test_renaming_and_reordering_entity_ids_keeps_claim_identity_without_auto_binding(self):
        before = self.review("reject")
        entities = deepcopy(self.entities)
        mapping = {entity["id"]: "new_" + entity["id"] for entity in entities}
        for entity in entities:
            entity["id"] = mapping[entity["id"]]
        relations, candidates, attributes = deepcopy((self.relations, self.candidates, self.attributes))
        for value in relations + candidates + attributes:
            for key in ("subject", "object"):
                if key in value:
                    value[key] = mapping[value[key]]
            if "id" in value:
                value["id"] = "new_" + value["id"]
        self.generate(entities=list(reversed(entities)), relations=relations, relation_candidates=candidates,
                      attributes=attributes, expected_state_revision=before["state_revision"])
        after = self.query()
        self.assertEqual([claim["claim_id"] for claim in before["claims"]], [claim["claim_id"] for claim in after["claims"]])
        self.assertEqual(self.claim(snapshot=after)["decision"], "unreviewed")
        self.assertEqual(after["history"], before["history"])
        self.assertEqual(after["history"][0]["target"]["entities"][0]["id"], "product")

    def test_provenance_entity_ids_are_semantic_identity_and_history_remains_readable(self):
        relation = {"subject": "report", "predicate": "authored_by", "object": "team",
                    "evidence": self.source.splitlines()[2],
                    "provenance": {"source_entity": "report", "attributed_to": "team"}}
        self.generate(relations=[relation])
        reviewed = self.review("accept")
        entities = deepcopy(self.entities)
        for entity in entities:
            if entity["id"] in {"report", "team"}:
                entity["id"] = "new_" + entity["id"]
        relation["subject"] = "new_report"; relation["object"] = "new_team"
        relation["provenance"] = {"source_entity": "new_report", "attributed_to": "new_team"}
        self.generate(entities=entities, relations=[relation], expected_state_revision=reviewed["state_revision"])
        self.assertEqual(self.claim()["claim_id"], self.claim(snapshot=reviewed)["claim_id"])
        self.assertEqual(self.query()["history"], reviewed["history"])

    def test_undo_requires_latest_claim_event_and_preserves_other_claims(self):
        first = self.review("accept")
        self.review("accept", "attributes")
        self.review("reject")
        with self.assertRaises(ReviewValidationError):
            self.undo(first["event_id"])
        latest = self.query()
        undone = self.undo(latest["history"][-1]["id"])
        self.assertEqual(self.claim(snapshot=undone)["decision"], "accept")
        self.assertEqual(self.claim("attributes", undone)["decision"], "accept")
        self.assertEqual(len(self.query()["history"]), 4)

    def test_fsync_failure_preserves_ledger_graph_source_and_history(self):
        self.review("accept")
        original = self.reviews._path(self.document).read_bytes()
        protected = self.protected()
        with patch("core.modules.documents.store.os.fsync", side_effect=OSError("injected fsync failure")):
            with self.assertRaisesRegex(OSError, "fsync"):
                self.review("reject")
        self.assertEqual(self.reviews._path(self.document).read_bytes(), original)
        self.assertEqual(protected, self.protected())
        self.assertEqual(list(self.reviews.review_dir.glob(".wiki-*.tmp")), [])

    def test_replace_failure_preserves_ledger_and_original_error_with_cleanup_failure(self):
        self.review("accept")
        original = self.reviews._path(self.document).read_bytes()
        real_unlink = Path.unlink
        def fail_own_temp(path, *args, **kwargs):
            if path.name.startswith(".wiki-"):
                raise OSError("injected cleanup failure")
            return real_unlink(path, *args, **kwargs)
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("injected replace failure")), patch.object(Path, "unlink", fail_own_temp):
            with self.assertRaisesRegex(OSError, "replace") as caught:
                self.review("reject")
        self.assertEqual(len(caught.exception.cleanup_failures), 1)
        self.assertEqual(self.reviews._path(self.document).read_bytes(), original)
        for path in self.reviews.review_dir.glob(".wiki-*.tmp"):
            path.unlink()  # Only the deliberately leaked fixture created above.

    def test_success_with_cleanup_warning_does_not_report_failed_commit(self):
        original_staging = self.store._staged_file
        @contextmanager
        def staging(directory, content, failures):
            with original_staging(directory, content, failures) as staged:
                yield staged
            failures.append(CleanupFailure(directory / ".wiki-simulated.tmp", OSError("simulated cleanup warning")))
        with patch.object(self.store, "_staged_file", staging):
            result = self.review("accept")
        self.assertTrue(result["changed"])
        self.assertEqual(len(result["cleanup_failures"]), 1)
        self.assertEqual(self.query()["review_revision"], result["review_revision"])
        self.assertEqual(len(self.query()["history"]), 1)

    def test_first_commit_failure_keeps_ledger_absent(self):
        protected = self.protected()
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("replace")):
            with self.assertRaises(OSError):
                self.review("accept")
        self.assertFalse(self.reviews._path(self.document).exists())
        self.assertEqual(self.query()["history"], [])
        self.assertEqual(protected, self.protected())

    def test_event_and_byte_limits_preserve_all_prior_history(self):
        self.review("accept")
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        with patch("core.modules.reviews.contracts.MAX_REVIEW_EVENTS", 1):
            with self.assertRaises(ReviewLimitError):
                self.review("reject")
        self.assertEqual(path.read_bytes(), original)
        with patch("core.modules.reviews.contracts.MAX_REVIEW_BYTES", len(original) + 1):
            with self.assertRaises(ReviewLimitError):
                self.review("reject")
        self.assertEqual(path.read_bytes(), original)

    def test_malformed_duplicate_keys_and_broken_chain_fail_closed(self):
        self.review("accept")
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        malformed = [b"{", b'{"version":1,"version":1}', b"[]"]
        data = json.loads(original)
        data["events"][0]["reason"] = "tampered reason"
        malformed.append(json.dumps(data).encode())
        for raw in malformed:
            path.write_bytes(raw)  # Deliberate corruption of this isolated fixture only.
            with self.subTest(raw=raw):
                with self.assertRaises(ReviewCorruptError):
                    self.query()
                with self.assertRaises(ReviewCorruptError):
                    self.generate(relations=[], expected_state_revision="a" * 64)
                self.assertEqual(path.read_bytes(), raw)
        path.write_bytes(original)
        self.assertEqual(len(self.query()["history"]), 1)

    def test_symlink_fifo_and_traversal_paths_are_rejected(self):
        for name in ("../escape.md", "foo/../escape.md", "/absolute.md"):
            with self.assertRaises(ValueError):
                self.reviews.query(name)
        self.reviews.review_dir.mkdir()
        path = self.reviews._path(self.document)
        outside = self.store.data_dir / "untouched.txt"
        outside.write_text("keep")
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.query()
        self.assertEqual(outside.read_text(), "keep")
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(ReviewCorruptError):
            self.query()

    def test_history_symlink_blocks_review_instead_of_following_it(self):
        changed = self.store.save(self.document, self.source + "extra", expected_revision=self.revision)
        self.store.save(self.document, self.source, expected_revision=changed.revision)
        directory = self.store._document_path(self.store.history_dir, self.document)
        (directory / "bad.md").symlink_to(self.store._document_path(self.store.wiki_dir, self.document))
        with self.assertRaises(ReviewCorruptError):
            self.query()

    def test_invalid_actions_actor_reason_and_replacement_do_not_write(self):
        base = self.query()
        cases = [dict(action="approve"), dict(reason=" "), dict(actor={**self.actor, "permissions": ["all"]}),
                 dict(expected_state_revision=None), dict(claim_id="0" * 64), dict(replacement={})]
        for kwargs in cases:
            action = kwargs.pop("action", "accept")
            with self.subTest(kwargs=kwargs):
                with self.assertRaises((ReviewValidationError, ReviewConflictError)):
                    self.review(action, snapshot=base, **kwargs)
        self.assertFalse(self.reviews.review_dir.exists())

    def test_current_v3_required_for_review_but_old_graph_can_be_inspected(self):
        self.generate(schema_version=2, attributes=[], entities=self.entities,
                      relations=[{key: value for key, value in self.relations[0].items() if key != "context"}])
        self.assertEqual(self.query()["machine_graph"]["schema_version"], 2)
        with self.assertRaises(ReviewValidationError):
            self.review("accept")

    def test_active_edited_evidence_is_revalidated_even_if_event_hash_is_recomputed(self):
        replacement = _input(self.claim()["value"])
        replacement["predicate"] = "related_to"
        self.review("edit", replacement=replacement)
        path = self.reviews._path(self.document)
        ledger = json.loads(path.read_bytes())
        event = ledger["events"][0]
        event["after"]["value"]["evidence"]["quote"] = "이 문장은 원문에 없다. 재고가 10개 이상이면 카탈로그"
        event["hash"] = _hash({key: value for key, value in event.items() if key != "hash"})
        path.write_text(json.dumps(ledger), encoding="utf-8")
        with self.assertRaises(ReviewCorruptError):
            self.query()

    def test_accept_reject_and_defer_cannot_hide_value_changes_in_stored_events(self):
        self.review("accept")
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        for action in ("accept", "reject", "defer"):
            ledger = json.loads(original)
            event = ledger["events"][0]
            event["action"] = event["after"]["decision"] = action
            event["after"]["value"]["qualifiers"]["condition"] = None
            event["hash"] = _hash({key: value for key, value in event.items() if key != "hash"})
            path.write_text(json.dumps(ledger), encoding="utf-8")
            with self.subTest(action=action), self.assertRaises(ReviewCorruptError):
                self.query()

    def test_mutation_and_undo_selection_match_authorized_actor_profile(self):
        result = self.review("accept")
        self.assertEqual(result["selection"]["domain"], self.actor["domain"])
        self.assertEqual(result["selection"]["viewpoint"], self.actor["viewpoint"])
        restored = self.undo(result["event_id"])
        self.assertEqual(restored["selection"]["domain"], self.actor["domain"])
        self.assertEqual(restored["selection"]["viewpoint"], self.actor["viewpoint"])

    def test_corrupt_derived_graph_returns_cas_and_history_for_explicit_repair(self):
        accepted = self.review("accept")
        path = self.ontology._path(self.document)
        path.write_bytes(b'{"broken":')
        current = self.query()
        self.assertEqual(current["status"], "unavailable")
        self.assertEqual(current["machine_graph"]["error"], "ontology_corrupt")
        self.assertEqual(current["claims"], [])
        self.assertEqual(current["history"], accepted["history"])
        self.assertTrue(current["pending_history"])
        self.generate(expected_state_revision=current["state_revision"])
        repaired = self.query()
        self.assertEqual(repaired["status"], "ready")
        self.assertEqual(repaired["history"], accepted["history"])
        self.assertEqual(self.claim(snapshot=repaired)["decision"], "unreviewed")

    def test_edit_new_endpoint_keeps_all_old_and_new_entities_in_history(self):
        replacement = _input(self.claim()["value"])
        replacement["object"] = "shipping"
        replacement["predicate"] = "related_to"
        changed = self.review("edit", replacement=replacement)
        self.assertEqual({entity["id"] for entity in changed["history"][-1]["target"]["entities"]},
                         {"product", "discount", "shipping"})
        self.assertEqual(self.query()["history"], changed["history"])
        self.undo(changed["event_id"])
        self.assertEqual(len(self.query()["history"]), 2)

    def test_ambiguous_claim_identity_is_never_applied(self):
        with patch("core.modules.reviews.values._claim_id", return_value="a" * 64):
            current = self.query()
            self.assertTrue(all(claim["ambiguous"] for claim in current["claims"]))
            with self.assertRaises(ReviewValidationError):
                self.review("accept", snapshot=current)
        self.assertEqual(self.query()["history"], [])

    def test_duplicate_effective_claim_is_rejected_without_changing_history(self):
        replacement = _input(self.claim()["value"])
        protected = self.protected()
        with self.assertRaises(OntologyValidationError):
            self.review("edit", "relation_candidates", replacement=replacement)
        self.assertEqual(self.query()["history"], [])
        self.assertEqual(self.protected(), protected)

    def test_unreviewed_generation_does_not_acquire_new_review_history_limits(self):
        changed = self.store.save(self.document, self.source + "추가", expected_revision=self.revision)
        with patch("core.modules.reviews.contracts.MAX_HISTORY_ENTRIES", 0):
            self.generate(expected_revision=changed.revision)
        self.assertFalse(self.reviews.review_dir.exists())

    def test_expert_policy_without_quotes_preserves_source_and_full_action_log(self):
        protected = self.protected()
        old = self.query()
        changed = self.policy()
        value = changed["effective_graph"]["relations"][0]
        self.assertIsNone(value["evidence"])
        self.assertEqual(value["provenance"], {"kind": "expert_policy", "event_id": changed["event_id"]})
        self.assertEqual(value["qualifiers"]["condition"], "전문가가 승인한 프로젝트에 한함")
        event = changed["history"][-1]
        self.assertEqual(event["action"], "policy")
        self.assertEqual(event["actor"], self.actor)
        self.assertEqual(event["scope"], {"domain": "카탈로그", "viewpoint": "business"})
        self.assertEqual(event["base_state_revision"], old["state_revision"])
        self.assertEqual(event["before_effective"]["value"], old["effective_graph"]["relations"][0])
        self.assertEqual(event["after_effective"]["value"], value)
        self.assertEqual(event["source_revision"], self.revision)
        self.assertEqual(protected, self.protected())
        fresh = ReviewStore(WikiStore(self.temp.name)).query(self.document, domain="카탈로그", viewpoint="business")
        self.assertEqual(fresh["effective_graph"], changed["effective_graph"])
        self.assertEqual(fresh["history"], changed["history"])
        self.assertEqual(fresh["policies"][0]["status"], "active")

    def test_expert_new_endpoint_is_namespaced_and_source_extraction_stays_strict(self):
        replacement = {key: value for key, value in _input(self.claim()["value"]).items() if key not in {"evidence", "provenance"}}
        replacement.update(object="animal", predicate="instance_of")
        changed = self.policy(replacement=replacement, entities=[{"id": "animal", "label": "동물", "type": "concept"}])
        relation = changed["effective_graph"]["relations"][0]
        entity = next(item for item in changed["effective_graph"]["entities"] if item["id"] == relation["object"])
        self.assertTrue(entity["id"].startswith("policy_" + changed["event_id"]))
        self.assertEqual(entity["label"], "동물")
        self.assertIsNone(entity["evidence"])
        protected = self.protected()
        ledger = self.reviews._path(self.document).read_bytes()
        with self.assertRaises(OntologyValidationError):
            self.generate(entities=_input(changed["effective_graph"]["entities"]),
                          relations=_input(changed["effective_graph"]["relations"]),
                          expected_state_revision=changed["state_revision"])
        self.assertEqual(protected, self.protected())
        self.assertEqual(ledger, self.reviews._path(self.document).read_bytes())
        restored = self.policy_undo(changed["event_id"])
        self.assertEqual(restored["effective_graph"], restored["machine_graph"])
        self.assertEqual(restored["history"][0]["after"]["entities"][0], entity)

    def test_expert_attribute_latest_value_undo_redo_and_legacy_v1_events(self):
        legacy = self.review("accept", "attributes")
        first = self.policy("attributes")
        value = {key: item for key, item in first["effective_graph"]["attributes"][0].items() if key not in {"evidence", "provenance"}}
        value["value"] = "81"
        second = self.policy("attributes", replacement=value)
        self.assertEqual(second["effective_graph"]["attributes"][0]["value"], "81")
        restored = self.policy_undo(second["event_id"])
        self.assertEqual(restored["effective_graph"]["attributes"][0]["value"], "57")
        redone = self.policy_undo(restored["event_id"])
        self.assertEqual(redone["effective_graph"]["attributes"][0]["value"], "81")
        self.assertEqual(redone["history"][0], legacy["history"][0])
        self.assertEqual(json.loads(self.reviews._path(self.document).read_bytes())["version"], 2)
        with self.assertRaises(ReviewValidationError):
            self.policy_undo(first["event_id"])

    def test_expert_scopes_do_not_overwrite_each_other_or_apply_to_unselected_scope(self):
        business = self.policy("attributes")
        developer = {**self.actor, "user_id": "bob", "profile_id": "dev", "viewpoint": "developer"}
        replacement = {key: value for key, value in _input(self.claim("attributes")["value"]).items() if key not in {"evidence", "provenance"}}
        replacement["context"] = {"domain": "카탈로그", "viewpoints": ["developer"]}
        replacement["value"] = "93"
        dev = self.policy("attributes", actor=developer, replacement=replacement)
        self.assertEqual(dev["effective_graph"]["attributes"][0]["value"], "93")
        selected = self.query(domain="카탈로그", viewpoint="business")
        self.assertEqual(selected["effective_graph"]["attributes"][0]["value"], "57")
        self.assertEqual([item["status"] for item in selected["policies"]], ["active", "other_scope"])
        self.assertEqual(self.query()["effective_graph"]["attributes"][0]["value"], "20")
        self.assertEqual(self.query(domain="배송", viewpoint="business")["effective_graph"]["attributes"][0]["value"], "20")
        with self.assertRaises(ReviewValidationError):
            self.policy_undo(business["event_id"], actor=developer)
        self.assertEqual(len(self.query()["history"]), 2)

    def test_source_review_cannot_undo_or_replace_expert_decision(self):
        changed = self.policy()
        source_review = self.review("reject")
        self.assertEqual(source_review["effective_graph"]["relations"][0], changed["effective_graph"]["relations"][0])
        self.assertEqual(self.claim(snapshot=source_review)["source_decision"], "reject")
        with self.assertRaises(ReviewValidationError):
            self.undo(changed["event_id"])
        with self.assertRaises(ReviewValidationError):
            self.policy_undo(source_review["event_id"])
        removed = self.policy_undo(changed["event_id"])
        self.assertEqual(removed["effective_graph"]["relations"], [])
        self.assertEqual(removed["history"][-1]["after_effective"]["decision"], "reject")
        self.assertEqual(len(self.query()["history"]), 3)

    def test_expert_policy_conflicts_and_competing_policies_commit_once(self):
        base = self.query()
        def submit(_):
            try:
                self.policy(snapshot=base)
                return "saved"
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(submit, range(2))), ["saved", "conflict"])
        with self.assertRaises(ReviewConflictError):
            self.policy(snapshot=base)
        self.assertEqual(len(self.query()["history"]), 1)

    def test_expert_source_change_reextraction_keep_pending_history(self):
        changed = self.policy()
        raw = self.reviews._path(self.document).read_bytes()
        new_source = self.store.save(self.document, self.source + "추가 내용\n", expected_revision=self.revision)
        stale = self.query(domain="카탈로그", viewpoint="business")
        self.assertEqual(stale["policies"][0]["status"], "pending")
        self.assertEqual(stale["effective_graph"]["relations"], [])
        self.assertEqual(self.reviews._path(self.document).read_bytes(), raw)
        self.revision = new_source.revision
        self.generate(expected_state_revision=stale["state_revision"])
        fresh = self.query(domain="카탈로그", viewpoint="business")
        self.assertEqual(fresh["policies"][0]["status"], "pending")
        self.assertEqual(fresh["effective_graph"]["relations"][0]["predicate"], "uses")
        self.assertIn(changed["event_id"], fresh["pending_history"])
        with self.assertRaises(ReviewValidationError):
            self.policy_undo(changed["event_id"])
        reapplied = self.policy()
        self.assertEqual(reapplied["policies"][0]["status"], "active")
        self.assertEqual(reapplied["history"][0], changed["history"][0])
        self.assertEqual(reapplied["pending_history"], [])

    def test_expert_source_and_graph_aba_never_reactivate_old_policies(self):
        first = self.policy()
        changed = self.store.save(self.document, self.source + "추가\n", expected_revision=self.revision)
        self.store.save(self.document, self.source, expected_revision=changed.revision)
        source_aba = self.query(domain="카탈로그", viewpoint="business")
        self.assertEqual(source_aba["source_revision"], first["source_revision"])
        self.assertEqual(source_aba["graph_revision"], first["graph_revision"])
        self.assertNotEqual(source_aba["history_revision"], first["history_revision"])
        self.assertEqual(source_aba["policies"][0]["status"], "pending")
        current = self.policy()
        self.generate(relations=[], expected_state_revision=current["state_revision"])
        self.generate(expected_state_revision=self.query()["state_revision"])
        graph_aba = self.query(domain="카탈로그", viewpoint="business")
        self.assertNotEqual(graph_aba["graph_revision"], current["graph_revision"])
        self.assertEqual(graph_aba["policies"][0]["status"], "pending")
        self.assertEqual(graph_aba["effective_graph"]["relations"][0]["predicate"], "uses")
        self.assertEqual(graph_aba["history"], current["history"])

    def test_first_expert_policy_failure_preserves_absence_or_exact_legacy_ledger(self):
        protected = self.protected()
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("first policy failure")):
            with self.assertRaisesRegex(OSError, "first policy failure"):
                self.policy()
        self.assertFalse(self.reviews._path(self.document).exists())
        self.review("accept")
        raw = self.reviews._path(self.document).read_bytes()
        with patch("core.modules.documents.store.os.fsync", side_effect=OSError("upgrade failure")):
            with self.assertRaisesRegex(OSError, "upgrade failure"):
                self.policy()
        self.assertEqual(self.reviews._path(self.document).read_bytes(), raw)
        self.assertEqual(json.loads(raw)["version"], 1)
        self.assertEqual(protected, self.protected())
        self.assertEqual(list(self.reviews.review_dir.glob(".wiki-*.tmp")), [])

    def test_expert_policy_reextraction_and_source_review_use_same_cas(self):
        initial = self.policy()
        with self.assertRaises(ReviewConflictError):
            self.generate(relations=[])
        base = self.query()
        def edit():
            try:
                self.policy(snapshot=base)
                return "saved"
            except ReviewConflictError:
                return "conflict"
        def review():
            try:
                self.review("reject", snapshot=base)
                return "saved"
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [future.result() for future in (pool.submit(edit), pool.submit(review))]
        self.assertCountEqual(outcomes, ["saved", "conflict"])
        self.assertEqual(self.query()["history"][0], initial["history"][0])

    def test_expert_fsync_replace_failures_and_limits_preserve_previous_bytes(self):
        self.policy()
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        protected = self.protected()
        for target in ("core.modules.documents.store.os.fsync", "core.modules.reviews.ledger.os.replace"):
            with self.subTest(target=target), patch(target, side_effect=OSError("injected policy failure")):
                with self.assertRaisesRegex(OSError, "injected policy failure"):
                    self.policy()
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(self.protected(), protected)
            self.assertEqual(list(self.reviews.review_dir.glob(".wiki-*.tmp")), [])
        with patch("core.modules.reviews.contracts.MAX_REVIEW_EVENTS", 1), self.assertRaises(ReviewLimitError):
            self.policy()
        with patch("core.modules.reviews.contracts.MAX_REVIEW_BYTES", len(original) + 1), self.assertRaises(ReviewLimitError):
            self.policy()
        self.assertEqual(path.read_bytes(), original)

    def test_expert_undo_failure_preserves_policy_and_success_cleanup_warning_is_saved(self):
        changed = self.policy()
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        with patch("core.modules.reviews.ledger.os.replace", side_effect=OSError("undo failure")):
            with self.assertRaisesRegex(OSError, "undo failure"):
                self.policy_undo(changed["event_id"])
        self.assertEqual(path.read_bytes(), original)
        original_staging = self.store._staged_file
        @contextmanager
        def staging(directory, content, failures):
            with original_staging(directory, content, failures) as staged:
                yield staged
            failures.append(CleanupFailure(directory / ".wiki-simulated.tmp", OSError("simulated cleanup")))
        with patch.object(self.store, "_staged_file", staging):
            restored = self.policy_undo(changed["event_id"])
        self.assertTrue(restored["changed"])
        self.assertEqual(len(restored["cleanup_failures"]), 1)
        self.assertEqual(len(self.query()["history"]), 2)

    def test_expert_invalid_input_scope_fabricated_provenance_and_unused_entities_rejected(self):
        value = {key: item for key, item in _input(self.claim()["value"]).items() if key not in {"evidence", "provenance"}}
        cases = []
        bad = deepcopy(value); bad["evidence"] = "가짜 인용"; cases.append(bad)
        bad = deepcopy(value); bad["provenance"] = {"actor": "admin"}; cases.append(bad)
        bad = deepcopy(value); bad["context"]["viewpoints"] = ["developer"]; cases.append(bad)
        bad = deepcopy(value); bad["qualifiers"].pop("time"); cases.append(bad)
        bad = deepcopy(value); bad["object"] = "missing"; cases.append(bad)
        for replacement in cases:
            with self.subTest(replacement=replacement), self.assertRaises((ReviewValidationError, OntologyValidationError)):
                self.policy(replacement=replacement)
        with self.assertRaises(ReviewValidationError):
            self.policy(entities=[{"id": "unused", "label": "사용 안 됨", "type": "concept"}])
        with self.assertRaises(ReviewValidationError):
            self.policy(entities=[{"id": "product", "label": "바꿔치기", "type": "concept"}])
        with self.assertRaises(ReviewValidationError):
            self.policy("relation_candidates", replacement=value)
        self.assertFalse(self.reviews.review_dir.exists())

    def test_expert_corrupt_event_even_with_rehashed_chain_fails_closed(self):
        self.policy()
        path = self.reviews._path(self.document)
        original = path.read_bytes()
        for change in ("evidence", "scope", "before_effective", "provenance"):
            ledger = json.loads(original)
            event = ledger["events"][0]
            if change == "evidence":
                event["after"]["value"]["evidence"] = "없는 인용"
            elif change == "scope":
                event["scope"]["viewpoint"] = "developer"
            elif change == "before_effective":
                event["before_effective"]["value"]["predicate"] = "instance_of"
            else:
                event["after"]["value"]["provenance"]["event_id"] = "f" * 32
            event["hash"] = _hash({key: item for key, item in event.items() if key != "hash"})
            path.write_text(json.dumps(ledger), encoding="utf-8")
            with self.subTest(change=change), self.assertRaises(ReviewCorruptError):
                self.query()
        path.write_bytes(original)
        self.assertEqual(len(self.query()["history"]), 1)

    def test_source_review_cannot_break_another_policy_scope_with_duplicate_attribute_ids(self):
        second = deepcopy(self.attributes[0])
        second.update(id="second_price", value="30")
        self.generate(attributes=self.attributes + [second])
        replacement = {key: value for key, value in _input(self.claim("attributes")["value"]).items()
                       if key not in {"evidence", "provenance"}}
        replacement.update(id="custom_price", value="57", context={"domain": "카탈로그", "viewpoints": ["business"]})
        self.policy("attributes", replacement=replacement)
        base = self.query(domain="카탈로그", viewpoint="developer")
        claim = [item for item in base["claims"] if item["collection"] == "attributes"][1]
        value = _input(claim["reviewed_value"])
        value["id"] = "custom_price"
        actor = {**self.actor, "profile_id": "dev", "viewpoint": "developer"}
        before = self.reviews._path(self.document).read_bytes()
        with self.assertRaises(ReviewValidationError):
            self.reviews.review(self.document, action="edit", claim_id=claim["claim_id"], replacement=value,
                                expected_state_revision=base["state_revision"], reason="타 관점 충돌 검사", actor=actor)
        self.assertEqual(before, self.reviews._path(self.document).read_bytes())
        self.assertEqual(self.query(domain="카탈로그", viewpoint="business")["effective_graph"]["attributes"][0]["id"], "custom_price")

    def test_policy_overlay_cannot_hide_invalid_duplicate_source_attribute_ids(self):
        second = deepcopy(self.attributes[0])
        second.update(id="second_price", value="30")
        self.generate(attributes=self.attributes + [second])
        self.policy("attributes")
        base = self.query(domain="카탈로그", viewpoint="business")
        value = _input(self.claim("attributes", base)["value"])
        value["id"] = "second_price"
        before = self.reviews._path(self.document).read_bytes()
        with self.assertRaises(OntologyValidationError):
            self.review("edit", "attributes", snapshot=base, replacement=value)
        self.assertEqual(before, self.reviews._path(self.document).read_bytes())
        self.assertEqual(len(self.query(domain="카탈로그", viewpoint="business")["history"]), 1)


if __name__ == "__main__":
    unittest.main()
