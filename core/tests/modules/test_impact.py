"""Synthetic preservation and bounded-snapshot tests, not semantic accuracy."""

from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from core.modules.knowledge.impact import ImpactStore
from core.modules.knowledge.impact_history import _review_prefix
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.common.json_codec import canonical_json_bytes as _encode
from core.modules.documents.store import WikiStore


class ImpactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = WikiStore(self.temp.name)
        self.ontology = OntologyStore(self.store)
        self.reviews = ReviewStore(self.store)
        self.impact = ImpactStore(self.store)
        self.root = "Root.md"
        self.source = "카탈로그 상품은 사람으로 분류된다. 할인율 10 이다.\n[대상](Peer.md)\n"
        self.entities = [{"id": "product", "label": "상품", "type": "concept", "evidence": self.source.splitlines()[0]},
                         {"id": "person", "label": "사람", "type": "concept", "evidence": self.source.splitlines()[0]}]
        self.relations = [{"subject": "product", "predicate": "instance_of", "object": "person",
                           "evidence": self.source.splitlines()[0],
                           "context": {"domain": "카탈로그", "viewpoints": ["business"]}}]
        self.revision = self.store.save(self.root, self.source, expected_revision=None).revision
        self.ontology.generate(self.root, self.revision, self.entities, self.relations)
        self.add("Peer.md", "카탈로그 상품은 보관된다.\n", [("product", "상품")])
        self.add("Incoming.md", "별개 주제.\n[참조](Root.md)\n", [("other", "주제")])
        self.actor = {"user_id": "expert", "tenant": "acme", "profile_id": "business",
                      "domain": "카탈로그", "viewpoint": "business", "policy_revision": "a" * 64}

    def add(self, document, source, labels):
        revision = self.store.save(document, source, expected_revision=None).revision
        entities = [{"id": identifier, "label": label, "type": "concept", "evidence": source}
                    for identifier, label in labels]
        self.ontology.generate(document, revision, entities, [])
        return revision

    def baseline(self, result=None):
        result = result or self.impact.query(self.root)
        return {key: result[key] for key in ("source_revision", "graph_revision", "review_revision", "history_revision")}

    def query(self, **kwargs):
        return self.impact.query(self.root, domain="카탈로그", viewpoint="business", **kwargs)

    def protected(self):
        return {str(path.relative_to(self.store.data_dir)): sha256(path.read_bytes()).hexdigest()
                for path in self.store.data_dir.rglob("*") if path.is_file() and not path.is_symlink()}

    def policy(self, label="동물"):
        current = self.reviews.query(self.root, domain="카탈로그", viewpoint="business")
        claim = next(item for item in current["claims"] if item["collection"] == "relations")
        replacement = {key: value for key, value in _input(claim["value"]).items() if key not in {"evidence", "provenance"}}
        replacement["object"] = "new_concept"
        return self.reviews.policy(self.root, claim_id=claim["claim_id"], expected_state_revision=current["state_revision"],
                                   reason="모의 업무 정책", actor=self.actor, replacement=replacement,
                                   entities=[{"id": "new_concept", "label": label, "type": "concept"}])

    def test_current_only_separates_links_candidates_and_never_invents_a_change(self):
        before = self.protected()
        result = self.query()
        self.assertTrue(result["complete"])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["baseline_status"], "not_compared")
        self.assertEqual(result["change_status"], "current_only")
        self.assertTrue(all(value is None for value in result["changes"].values()))
        self.assertEqual({item["document"] for item in result["documents"]}, {"Peer.md", "Incoming.md"})
        self.assertEqual({item["direction"] for item in result["explicit_links"]}, {"incoming", "outgoing"})
        self.assertEqual(result["candidates"][0]["target_entity"]["document"], "Peer.md")
        self.assertFalse(result["candidates"][0]["identity_confirmed"])
        self.assertFalse(result["scope"]["automatic_reextraction"])
        self.assertFalse(result["scope"]["semantic_impact_complete"])
        self.assertEqual(self.protected(), before)

    def test_equal_baseline_reports_unchanged_and_complete_bounded_scope(self):
        initial = self.query()
        result = self.query(baseline=self.baseline(initial))
        self.assertEqual(result["change_status"], "unchanged")
        self.assertTrue(all(value is False for value in result["changes"].values()))
        self.assertTrue(result["complete"])
        self.assertTrue(result["restoration"]["complete"])
        for item in result["documents"]:
            self.assertEqual(item["recommendation"], "consider_review")
            self.assertFalse(item["content_error_confirmed"])

    def test_source_change_recovers_removed_link_and_validates_stale_cached_concepts(self):
        initial = self.query()
        self.store.save(self.root, "새로운 내용만 있다.\n", expected_revision=self.revision)
        before = self.protected()
        result = self.query(baseline=self.baseline(initial))
        self.assertTrue(result["changes"]["source"])
        self.assertTrue(result["changes"]["history"])
        self.assertEqual(result["root"]["ontology_status"], "stale")
        removed = next(item for item in result["explicit_links"] if item["change"] == "removed")
        self.assertEqual(removed["target_document"], "Peer.md")
        self.assertEqual(removed["source_revision"], self.revision)
        self.assertEqual(removed["origin"], "baseline_source")
        self.assertEqual(result["restoration"]["source"], "matching_archive")
        self.assertEqual(result["restoration"]["graph"], "validated_matching_cache")
        self.assertTrue(any(item["source_entity"]["origin"] == "baseline_graph" for item in result["candidates"]))
        self.assertFalse(result["complete"])
        self.assertEqual(next(item for item in result["documents"] if item["document"] == "Peer.md")["ontology_status"], "ready")
        self.assertEqual(self.protected(), before)

    def test_reextraction_does_not_pretend_old_graph_is_recoverable(self):
        base = self.baseline()
        current = self.store.save(self.root, "카탈로그 상품 새 기록.\n", expected_revision=self.revision)
        self.ontology.generate(self.root, current.revision,
                               [{"id": "product", "label": "상품", "type": "concept", "evidence": "카탈로그 상품 새 기록."}], [])
        before = self.protected()
        result = self.query(baseline=base)
        self.assertEqual(result["root"]["ontology_status"], "ready")
        self.assertEqual(result["restoration"]["graph"], "unavailable")
        self.assertTrue(any(item["code"] == "previous_graph_not_preserved" for item in result["skipped"]))
        self.assertFalse(result["complete"])
        self.assertEqual(self.protected(), before)

    def test_forged_baseline_cannot_authorize_or_fabricate_a_history_match(self):
        base = self.baseline()
        base["source_revision"] = "f" * 64
        result = self.query(baseline=base)
        self.assertEqual(result["restoration"]["source"], "unavailable")
        self.assertEqual(result["restoration"]["graph"], "unavailable")
        self.assertFalse(result["complete"])
        self.assertFalse(any(item["origin"] == "baseline_source" for item in result["explicit_links"]))

    def test_policy_only_new_endpoint_is_candidate_in_selected_view_with_event_provenance(self):
        self.add("Animal.md", "동물은 업무 분류다.\n", [("animal", "동물")])
        changed = self.policy()
        before = self.protected()
        result = self.query()
        candidate = next(item for item in result["candidates"] if item["target_entity"]["document"] == "Animal.md")
        self.assertEqual(candidate["source_entity"]["origin"], "expert_policy")
        self.assertEqual(candidate["source_entity"]["event_id"], changed["event_id"])
        self.assertIsNone(candidate["source_entity"]["evidence"])
        other = self.impact.query(self.root, domain="카탈로그", viewpoint="developer")
        self.assertFalse(any(item["target_entity"]["document"] == "Animal.md" for item in other["candidates"]))
        self.assertEqual(self.protected(), before)

    def test_changed_policy_and_undo_keep_old_and_new_endpoint_candidates(self):
        self.add("Animal.md", "동물은 업무 분류다.\n", [("animal", "동물")])
        self.add("Vehicle.md", "차량은 업무 분류다.\n", [("vehicle", "차량")])
        first = self.policy("동물")
        base = self.baseline()
        second = self.policy("차량")
        result = self.query(baseline=base)
        self.assertTrue(result["changes"]["review"])
        self.assertEqual(result["restoration"]["review"], "matched_event_prefix")
        previous = [item for item in result["candidates"] if item["target_entity"]["document"] == "Animal.md"]
        self.assertTrue(previous)
        self.assertEqual(previous[0]["source_entity"]["origin"], "expert_event")
        self.assertEqual(previous[0]["source_entity"]["phase"], "before")
        self.assertEqual(previous[0]["source_entity"]["event_id"], second["event_id"])
        self.assertEqual(previous[0]["source_entity"]["provenance"]["event_id"], first["event_id"])
        before_undo = self.baseline(result)
        self.reviews.policy_undo(self.root, event_id=second["event_id"], expected_state_revision=second["state_revision"],
                                 reason="모의 되돌림", actor=self.actor)
        undone = self.query(baseline=before_undo)
        self.assertEqual({item["target_entity"]["document"] for item in undone["candidates"]} & {"Animal.md", "Vehicle.md"}, {"Animal.md", "Vehicle.md"})

    def test_source_review_old_and_new_endpoints_are_traceable_without_new_quotes(self):
        self.add("Human.md", "사람은 업무 분류다.\n", [("person", "사람")])
        base = self.baseline()
        state = self.reviews.query(self.root)
        claim = next(item for item in state["claims"] if item["collection"] == "relations")
        value = _input(claim["value"])
        value.update(object="product", predicate="related_to")
        changed = self.reviews.review(self.root, action="edit", claim_id=claim["claim_id"], replacement=value,
                                      expected_state_revision=state["state_revision"], reason="모의 원문 검토", actor=self.actor)
        result = self.query(baseline=base)
        events = [item["source_entity"] for item in result["candidates"] if item["source_entity"]["origin"] == "review_source_snapshot"]
        self.assertTrue(events)
        self.assertTrue(all(item["event_id"] == changed["event_id"] for item in events))
        self.assertTrue(all(item["evidence"]["quote"] in self.source for item in events))

    def test_v1_prefix_is_found_after_v2_upgrade_and_unknown_prefix_is_incomplete(self):
        state = self.reviews.query(self.root)
        claim = next(item for item in state["claims"] if item["collection"] == "relations")
        old = self.reviews.review(self.root, action="accept", claim_id=claim["claim_id"],
                                  expected_state_revision=state["state_revision"], reason="모의검토", actor=self.actor)
        base = self.baseline()
        self.policy()
        ledger = json.loads(self.reviews._path(self.root).read_bytes())
        self.assertEqual(_review_prefix(ledger, old["review_revision"]), 1)
        self.assertEqual(self.query(baseline=base)["restoration"]["review"], "matched_event_prefix")
        base["review_revision"] = "e" * 64
        result = self.query(baseline=base)
        self.assertEqual(result["restoration"]["review"], "unavailable")
        self.assertFalse(result["complete"])

    def test_missing_stale_corrupt_graph_and_corrupt_review_are_distinct_and_read_only(self):
        self.ontology._path("Peer.md").write_bytes(b'{"broken":')
        self.reviews.review_dir.mkdir(exist_ok=True)
        self.reviews._path("Incoming.md").write_bytes(b'{"broken":')
        before = self.protected()
        result = self.query()
        peer = next(item for item in result["documents"] if item["document"] == "Peer.md")
        incoming = next(item for item in result["documents"] if item["document"] == "Incoming.md")
        self.assertEqual(peer["ontology_status"], "corrupt")
        self.assertEqual(incoming["review_status"], "corrupt")
        self.assertFalse(result["complete"])
        self.assertTrue(result["skipped"])
        self.assertEqual(self.protected(), before)

    def test_history_symlink_is_not_followed_and_matching_archive_is_not_claimed(self):
        base = self.baseline()
        self.store.save(self.root, "내용 변경\n", expected_revision=self.revision)
        directory = self.store._document_path(self.store.history_dir, self.root)
        archive = next(directory.iterdir())
        external = self.store.data_dir / "private.txt"
        external.write_text(self.source)
        archive.unlink()  # Only this test's own simulated archive.
        archive.symlink_to(external)
        before = self.protected()
        result = self.query(baseline=base)
        self.assertEqual(result["restoration"]["source"], "unavailable")
        self.assertIsNone(result["state_revision"])
        self.assertFalse(result["root"]["state_available"])
        self.assertTrue(any(item["code"] == "history_not_regular" for item in result["skipped"]))
        self.assertEqual(before, self.protected())

    def test_paths_and_baseline_schema_are_checked_before_any_file_read(self):
        base = self.baseline()
        bad = [[], {}, {**base, "tenant": "elsewhere"}, {**base, "source_revision": None},
               {**base, "history_revision": "x" * 64}, {**base, "graph_revision": "A" * 64}]
        with patch.object(self.impact.ontology, "_connections_snapshot_locked", side_effect=AssertionError("must not read")):
            for baseline in bad:
                with self.subTest(baseline=baseline), self.assertRaises(ValueError):
                    self.query(baseline=baseline)
            for document in ("../escape.md", "/Root.md", "other/../Root.md"):
                with self.subTest(document=document), self.assertRaises(ValueError):
                    self.impact.query(document)

    def test_limit_bounds_documents_and_references_without_claiming_complete(self):
        result = self.query(limit=1)
        self.assertEqual(len(result["documents"]), 1)
        self.assertLessEqual(len(result["explicit_links"]), 1)
        self.assertLessEqual(len(result["candidates"]), 1)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        names = {item["document"] for item in result["documents"]}
        for link in result["explicit_links"]:
            self.assertIn(link["target_document"] if link["direction"] == "outgoing" else link["source_document"], names)
        self.assertLessEqual(result["captured_bytes"], result["limits"]["max_capture_bytes"])

    def test_history_entry_budget_and_missing_graph_are_incomplete(self):
        base = self.baseline()
        self.store.save(self.root, "새 내용\n", expected_revision=self.revision)
        with patch("core.modules.knowledge.contracts.MAX_CONNECTION_SCAN_ENTRIES", 3):
            result = self.query(baseline=base)
        self.assertTrue(any(item["code"] == "entry_budget" for item in result["skipped"]))
        self.assertFalse(result["root"]["state_available"])
        self.ontology._path("Peer.md").unlink()  # Own fixture cache only.
        missing = self.query(baseline=base)
        self.assertEqual(next(item for item in missing["documents"] if item["document"] == "Peer.md")["ontology_status"], "missing")
        self.assertFalse(missing["complete"])

    def test_writer_cannot_mix_versions_inside_impact_capture(self):
        original = self.impact.ontology._read_source
        started = threading.Event()
        finished = threading.Event()
        threads = []
        def write():
            started.set()
            self.store.save(self.root, "변경 후 내용\n", expected_revision=self.revision)
            finished.set()
        def read(name):
            value = original(name)
            if name == self.root and not threads:
                thread = threading.Thread(target=write)
                threads.append(thread)
                thread.start()
                self.assertTrue(started.wait(2))
                self.assertFalse(finished.is_set())
            return value
        with patch.object(self.impact.ontology, "_read_source", side_effect=read):
            result = self.query()
        for thread in threads:
            thread.join(2)
        self.assertTrue(finished.is_set())
        self.assertEqual(result["source_revision"], self.revision)
        self.assertEqual(result["root"]["ontology_status"], "ready")
        self.assertTrue(any(item["direction"] == "outgoing" for item in result["explicit_links"]))

    def test_retained_second_fragment_is_never_reported_as_a_removed_document_link(self):
        previous = self.store.save(self.root, "[두 번째](Peer.md#two)\n", expected_revision=self.revision)
        base = self.baseline()
        self.store.save(self.root, "[첫 번째](Peer.md#one)\n[두 번째](Peer.md#two)\n", expected_revision=previous.revision)
        result = self.query(baseline=base)
        self.assertTrue(any(item["target_document"] == "Peer.md" for item in result["explicit_links"]))
        self.assertFalse(any(item["target_document"] == "Peer.md" and item["change"] == "removed" for item in result["explicit_links"]))

    def test_long_archived_href_is_skipped_with_an_explicit_incomplete_reason(self):
        previous = self.store.save(self.root, "[긴 링크](Peer.md#" + "a" * 2100 + ")\n", expected_revision=self.revision)
        base = self.baseline()
        self.store.save(self.root, "링크 없음\n", expected_revision=previous.revision)
        result = self.query(baseline=base)
        self.assertFalse(any(item["change"] == "removed" for item in result["explicit_links"]))
        self.assertTrue(any(item["component"] == "baseline_source" and item["code"] == "link_href_too_long" for item in result["skipped"]))
        self.assertFalse(result["complete"])

    def test_more_candidates_after_exactly_full_first_reference_report_truncation(self):
        text = "공유 " + " ".join("d" + str(index) for index in range(100)) + "\n"
        revision = self.store.save("Shared.md", text, expected_revision=None).revision
        entities = [{"id": "shared_" + str(index), "label": "공유", "type": "concept", "evidence": text,
                     "context": {"domain": "d" + str(index), "viewpoints": []}} for index in range(100)]
        self.ontology.generate("Shared.md", revision, entities, [])
        base = self.baseline()
        self.policy("공유")
        result = self.query(limit=100, baseline=base)
        self.assertEqual(len(result["candidates"]), 100)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertTrue(any(item["code"] == "candidate_budget" for item in result["skipped"]))
        self.assertTrue(all(item["current_fact"] is False for item in result["candidates"]))

    def test_output_bytes_include_the_size_field_and_budget_removes_whole_references(self):
        original = self.query()
        self.assertEqual(original["output_bytes"], len(_encode(original)))
        budget = original["output_bytes"] - 200
        protected = self.protected()
        with patch("core.modules.knowledge.contracts.MAX_IMPACT_OUTPUT_BYTES", budget):
            result = self.query()
        self.assertLessEqual(len(_encode(result)), budget)
        self.assertEqual(result["output_bytes"], len(_encode(result)))
        self.assertTrue(result["truncated"])
        self.assertTrue(any(item["code"] == "output_budget" for item in result["skipped"]))
        for item in result["candidates"]:
            self.assertIn(item, original["candidates"])
        for item in result["explicit_links"]:
            self.assertIn(item, original["explicit_links"])
        with patch("core.modules.knowledge.contracts.MAX_IMPACT_OUTPUT_BYTES", 10), self.assertRaises(ValueError):
            self.query()
        self.assertEqual(self.protected(), protected)

    def test_review_capture_shares_the_total_byte_budget_and_keeps_files_unchanged(self):
        self.policy()
        with self.store._write_lock():
            _, captured = self.ontology._connections_snapshot_locked(self.root, 100)
        budget = captured["captured_bytes"] + 32
        before = self.protected()
        with patch("core.modules.knowledge.contracts.MAX_CONNECTION_BYTES", budget), patch("core.modules.ontology.constants.MAX_CONNECTION_BYTES", budget):
            result = self.query()
        self.assertEqual(result["root"]["review_status"], "unavailable")
        self.assertFalse(result["root"]["state_available"])
        self.assertTrue(any(item["component"] == "review" and item["code"] == "byte_budget" for item in result["skipped"]))
        self.assertLessEqual(result["captured_bytes"], budget)
        self.assertFalse(result["complete"])
        self.assertEqual(self.protected(), before)

    def test_link_to_nonregular_source_is_unavailable_instead_of_missing(self):
        content = self.source + "[막힌 대상](Blocked.md)\n[없는 대상](Missing.md)\n"
        revision = self.store.save(self.root, content, expected_revision=self.revision).revision
        self.ontology.generate(self.root, revision, self.entities, self.relations)
        os.mkfifo(self.store.wiki_dir / "Blocked.md")
        result = self.query()
        blocked = next(item for item in result["documents"] if item["document"] == "Blocked.md")
        missing = next(item for item in result["documents"] if item["document"] == "Missing.md")
        self.assertEqual(blocked["source_status"], "unavailable")
        self.assertEqual(blocked["ontology_status"], "unavailable")
        self.assertEqual(missing["source_status"], "missing")
        self.assertEqual(missing["ontology_status"], "missing")
        self.assertFalse(result["complete"])


if __name__ == "__main__":
    unittest.main()
