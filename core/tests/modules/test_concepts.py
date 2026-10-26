"""D-040 N01–N20 isolated behavior cases. All decisions are simulations."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.documents.store import WikiStore, StorageBusyError
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import CorrespondenceCorruptError
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture


class ConceptCases(unittest.TestCase):
    """One named test per planned case; never use the project's data directory."""

    def setUp(self):
        from core.modules.knowledge.concepts import ConceptStore
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.wiki = WikiStore(self.temp.name, lock_timeout_seconds=0.05)
        self.actor = correspondence_actor()
        self.reviews = ReviewStore(self.wiki)
        self.ontology = OntologyStore(self.wiki)
        self.correspondences = CorrespondenceStore(self.wiki, self.actor)
        self.draft = correspondence_fixture(self.wiki)
        self.extra = (
            "상품은 점검에 사용된다. 가격은 20 원이며 변경 가격은 30 원이다.\n"
            "상품은 배송에 사용될 수 있다.\n"
        )
        a = self.wiki.read("a.md")
        self.wiki.save("a.md", a.content + self.extra, expected_revision=a.revision)
        self.graph_input = {
            "entities": [
                {"id": "product", "type": "concept", "label": "상품", "evidence": self.extra.splitlines()[0]},
                {"id": "inspection", "type": "process", "label": "점검", "evidence": self.extra.splitlines()[0]},
                {"id": "shipping", "type": "process", "label": "배송", "evidence": self.extra.splitlines()[1]},
            ],
            "relations": [{"subject": "product", "predicate": "uses", "object": "inspection", "evidence": self.extra.splitlines()[0]}],
            "attributes": [{"id": "price", "subject": "product", "property": "가격", "datatype": "number", "value": "20", "unit": "원", "evidence": self.extra.splitlines()[0]}],
            "relation_candidates": [{"id": "shipping_candidate", "subject": "product", "predicate": "uses", "object": "shipping", "evidence": self.extra.splitlines()[1], "qualifiers": {"modality": "possible"}, "reason": "모의 후보", "question": "현재 적용 가능한가?"}],
        }
        self.generate_a()
        for doc in ("b.md", "d.md"):
            self.ontology.generate(doc, self.wiki.read(doc).revision, entities=[], relations=[])
        self.store = ConceptStore(self.wiki, actor=self.actor)
        self.context = {"service": "catalog"}

    def generate_a(self, values=None):
        state = self.reviews.query("a.md")["state_revision"]
        return self.ontology.generate("a.md", self.wiki.read("a.md").revision,
                                      expected_state_revision=state, **deepcopy(values or self.graph_input))

    def anchor(self, document="a.md", quote=None):
        source = self.wiki.read(document)
        quote = quote or source.content.splitlines()[0]
        lines = source.content.splitlines()
        start = lines.index(quote) + 1
        return {"document": document, "source_revision": source.revision, "quote": quote,
                "start_line": start, "end_line": start}

    def target(self, document="a.md", quote=None):
        anchor = self.anchor(document, quote)
        return {"kind": "anchor", "anchor": anchor,
                "observation": {"source_revision": anchor["source_revision"],
                                "history_revision": self.reviews._history_revision(document)}}

    def find(self, text, **kwargs):
        return self.store.find(text, application_context=self.context, **kwargs)

    def query(self, target=None, **kwargs):
        kwargs.setdefault("application_context", self.context)
        return self.store.query(self.target() if target is None else target, **kwargs)

    @staticmethod
    def document(result, name="a.md"):
        return next(item for item in result["documents"] if item["document"] == name)

    def create(self, draft=None, *, accept=True):
        value = deepcopy(draft or self.draft)
        for anchor in [value["condition"], value["concept"], *value["basis"]["link_evidence"]]:
            anchor["source_revision"] = self.wiki.read(anchor["document"]).revision
        prepared = self.correspondences.query(draft=value)
        cid = prepared["correspondence_id"]
        self.correspondences.propose(cid, prepared["draft"], prepared["state_revision"], "합성 사례의 미검토 제안")
        if accept:
            state = self.correspondences.query(cid)
            self.correspondences.review(cid, "accept", state["state_revision"], "원문 수용 simulation")
        return cid

    def source_review(self, action, collection="relations"):
        state = self.reviews.query("a.md")
        claim = next(c for c in state["claims"] if c["collection"] == collection)
        return self.reviews.review("a.md", action=action, claim_id=claim["claim_id"],
                                   expected_state_revision=state["state_revision"],
                                   reason="격리 fixture의 source 검토 simulation", actor=self.actor)

    def policy(self, *, collection="relations", term="희소분류", value=None):
        state = self.reviews.query("a.md", domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])
        claim = next(c for c in state["claims"] if c["collection"] == collection)
        replacement = {k: v for k, v in _input(claim["value"]).items() if k not in {"evidence", "provenance"}}
        replacement["context"] = {"domain": self.actor["domain"], "viewpoints": [self.actor["viewpoint"]]}
        replacement["qualifiers"] = {"polarity": "positive", "modality": "asserted", "condition": "판매 중이며 단종 대상이 아닌 경우", "scope": "국내 온라인 판매", "time": "시범 운영 기간"}
        entities = []
        if collection == "attributes":
            replacement["value"] = value or "57"
        else:
            replacement.update(predicate="instance_of", object="classification")
            entities = [{"id": "classification", "label": term, "type": "concept"}]
        return self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
                                   expected_state_revision=state["state_revision"],
                                   reason="합성 전문가 판단; 실제 사람 승인 아님", actor=self.actor, entities=entities)

    def bytes(self):
        return {p.relative_to(self.wiki.data_dir).as_posix(): p.read_bytes()
                for p in self.wiki.data_dir.rglob("*") if p.is_file() and p.name != ".write.lock"}

    def test_n01_same_label_and_normalized_literal_do_not_merge(self):
        other = "다른 업무의 상품은 별도 기준을 쓴다.\n"
        self.wiki.save("other.md", other, expected_revision=None)
        self.ontology.generate("other.md", self.wiki.read("other.md").revision,
                               entities=[{"id": "product", "type": "concept", "label": "상품", "evidence": other.strip()}], relations=[])
        found = self.find("상품", documents=["a.md", "other.md"], limit=100)
        entities = [m for m in found["matches"] if m["target_ref"]["kind"] == "entity"]
        self.assertEqual({m["target_ref"]["document"] for m in entities}, {"a.md", "other.md"})
        self.assertTrue(all(m["target_ref"]["entity_id"] == "product" for m in entities))
        self.wiki.save("latin.md", "ＡＢＣ\n", expected_revision=None)
        self.assertTrue(self.find("abc", documents=["latin.md"])["matches"])

    def test_n02_unreviewed_source_is_not_approved_effective_knowledge(self):
        result = self.query()
        doc = self.document(result)
        self.assertEqual(doc["source"]["content"], self.wiki.read("a.md").content)
        self.assertEqual(doc["claims"][0]["decision"], "unreviewed")
        self.assertEqual(doc["machine_graph"]["relations"], doc["effective_graph"]["relations"])
        self.assertTrue(doc["claims"][0]["needs_review"])
        self.assertTrue(result["complete"])

    def test_n03_confirmed_direct_expansion_preserves_three_sources(self):
        cid = self.create()
        plain = self.query()
        self.assertEqual(plain["scope"]["content_documents"], ["a.md"])
        result = self.query(expansion="direct_confirmed")
        self.assertEqual(set(result["scope"]["content_documents"]), {"a.md", "b.md", "d.md"})
        self.assertIn(cid, result["scope"]["content_correspondences"])
        corr = next(c for c in result["correspondences"] if c["correspondence_id"] == cid)
        self.assertEqual(corr["source_proposal"]["value"]["direction"], "condition_to_concept")
        self.assertEqual(corr["source_proposal"]["decision"], "accepted")
        self.assertEqual(corr["source_proposal"]["applicability"], "applicable")
        for doc in result["documents"]:
            self.assertEqual(doc["source"]["revision"], self.wiki.read(doc["document"]).revision)

    def test_n04_additional_conditions_are_kept_without_instance_inference(self):
        value = deepcopy(self.draft)
        d = self.wiki.read("d.md")
        self.wiki.save("d.md", "상품이 판매 중이고 단종 대상이 아니며 판매 가능 재고가 1개 이상 5개 이하이면 매진 임박이다.\n", expected_revision=d.revision)
        self.ontology.generate("d.md", self.wiki.read("d.md").revision, entities=[], relations=[])
        value["basis"]["link_evidence"] = [self.anchor("d.md")]
        value["qualifiers"]["conditions"] = {"status": "specified", "items": ["판매 중", "단종 대상 아님"]}
        cid = self.create(value)
        result = self.query(correspondence_ids=[cid])
        kept = result["correspondences"][0]["source_proposal"]["value"]["qualifiers"]["conditions"]["items"]
        self.assertEqual(kept, value["qualifiers"]["conditions"]["items"])
        self.assertIn("not_evaluated", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("instance_satisfaction\": \"satisfied", json.dumps(result))

    def test_n05_expert_only_term_has_action_log_not_fake_quote(self):
        policy = self.policy()
        found = self.find("희소분류", documents=["a.md"], limit=100)
        hits = [m for m in found["matches"] if m["match_origin"] == "document_policy"]
        self.assertTrue(hits)
        target = next(m["target_ref"] for m in hits if m["target_ref"]["kind"] == "entity")
        result = self.query(target)
        self.assertEqual(result["target"]["status"], "current")
        entity = next(e for e in self.document(result)["effective_graph"]["entities"] if e["label"] == "희소분류")
        self.assertIsNone(entity["evidence"])
        self.assertEqual(target["origin_ref"]["decision_event_id"], policy["event_id"])
        self.assertNotIn("희소분류", self.document(result)["source"]["content"])
        event = next(e for e in self.document(result)["events"] if e["id"] == policy["event_id"])
        self.assertEqual(event["actor"], self.actor)
        self.assertEqual(event["reason"], "합성 전문가 판단; 실제 사람 승인 아님")
        self.assertTrue(event["timestamp"])

    def test_n06_other_scope_pending_and_historical_policy_diagnostics(self):
        self.policy()
        developer = {"domain": "catalog", "viewpoint": "developer"}
        found = self.find("희소분류", documents=["a.md"], profile=developer, limit=100)
        hit = next(m for m in found["matches"] if m["match_origin"] == "document_policy")
        self.assertFalse(hit["selectable_as_current"])
        result = self.query(hit["target_ref"], profile=developer, expansion="direct_confirmed")
        self.assertEqual(result["target"]["resolution_layer"], "policy_snapshot")
        self.assertNotIn("희소분류", json.dumps(self.document(result)["effective_graph"], ensure_ascii=False))
        self.assertEqual(self.document(result)["policies"][0]["status"], "other_scope")
        self.policy(term="새분류")
        historical = self.find("희소분류", documents=["a.md"], include_history=True, limit=100)
        old = next(m for m in historical["matches"] if m["historical"])
        self.assertFalse(old["selectable_as_current"])
        self.assertEqual(self.query(old["target_ref"])["target"]["resolution_layer"], "policy_snapshot")
        attributes = self.policy(collection="attributes", value="97")
        current = self.reviews.query("a.md")
        self.reviews.policy_undo("a.md", event_id=attributes["event_id"], expected_state_revision=current["state_revision"], reason="초기 속성 정책의 모의 취소", actor=self.actor)
        self.assertTrue(any(p["status"] == "inactive" for p in self.document(self.query())["policies"]))
        inactive = self.find("97", documents=["a.md"], include_history=True, limit=100)
        self.assertTrue(any(m["historical"] and not m["selectable_as_current"] for m in inactive["matches"]))
        a = self.wiki.read("a.md")
        self.wiki.save("a.md", a.content + "원문 변경\n", expected_revision=a.revision)
        pending = self.find("새분류", documents=["a.md"], limit=100)
        self.assertTrue(pending["matches"])
        self.assertTrue(all(not m["selectable_as_current"] for m in pending["matches"]))
        self.assertEqual(self.query(pending["matches"][0]["target_ref"])["target"]["resolution_layer"], "policy_snapshot")

    def test_n07_undo_origin_and_candidate_collection_stay_distinct(self):
        self.source_review("accept", "relation_candidates")
        first = self.policy(collection="attributes", value="57")
        second = self.policy(collection="attributes", value="81")
        current = self.reviews.query("a.md")
        undone = self.reviews.policy_undo("a.md", event_id=second["event_id"], expected_state_revision=current["state_revision"], reason="모의 되돌림", actor=self.actor)
        doc = self.document(self.query())
        claim = next(c for c in doc["claims"] if c["collection"] == "attributes")
        self.assertEqual(claim["latest_policy_event_id"], undone["event_id"])
        self.assertEqual(claim["policy_event_id"], first["event_id"])
        self.assertEqual(claim["reviewed_value"]["value"], "57")
        returned = {e["id"] for e in doc["events"]}
        self.assertTrue({undone["event_id"], first["event_id"]} <= returned)
        self.assertEqual(set(doc["history_projection"]["returned_refs"]), returned)
        found = self.find("배송", documents=["a.md"], limit=100)
        refs = [m["target_ref"] for m in found["matches"] if m["target_ref"]["kind"] == "document_claim" and m["target_ref"]["layer"] == "reviewed"]
        self.assertTrue(any(r["original_collection"] == "relation_candidates" for r in refs))
        self.assertTrue(any(v["object"] == "shipping" for v in doc["effective_graph"]["relations"]))

    def test_n08_source_and_graph_aba_do_not_reapply_old_approvals(self):
        cid = self.create()
        d = self.wiki.read("d.md")
        self.wiki.save("d.md", d.content + "추가\n", expected_revision=d.revision)
        changed = self.wiki.read("d.md")
        self.wiki.save("d.md", d.content, expected_revision=changed.revision)
        result = self.query(correspondence_ids=[cid], expansion="direct_confirmed")
        self.assertEqual(result["correspondences"][0]["source_proposal"]["applicability"], "needs_review")
        self.assertEqual(result["scope"]["content_documents"], ["a.md"])
        self.policy()
        values = deepcopy(self.graph_input); values["attributes"][0]["value"] = "30"
        self.generate_a(values); self.generate_a()
        doc = self.document(self.query())
        self.assertEqual(doc["policies"][0]["status"], "pending")
        self.assertTrue(doc["pending_history"])
        self.assertNotIn("희소분류", json.dumps(doc["effective_graph"], ensure_ascii=False))

    def test_n09_unrelated_graph_corruption_does_not_invalidate_source_correspondence(self):
        cid = self.create()
        state = self.reviews.query("a.md")
        value = deepcopy(self.draft)
        value["references"] = [{"kind": "graph", "document": "a.md", "graph_ref": {"graph_revision": state["graph_revision"], "state_revision": state["state_revision"], "collection": "entities", "layer": "machine", "entity_id": "product", "snapshot": state["machine_graph"]["entities"][0]}}]
        dependent = self.create(value)
        self.ontology._path("a.md").write_bytes(b"broken derived graph")
        result = self.query(correspondence_ids=[cid, dependent])
        states = {c["correspondence_id"]: c["source_proposal"]["applicability"] for c in result["correspondences"]}
        self.assertEqual(states[cid], "applicable")
        self.assertEqual(states[dependent], "unavailable")
        self.assertEqual(self.document(result)["source"]["content"], self.wiki.read("a.md").content)
        self.assertFalse(result["complete"])
        self.assertTrue(result["skipped"])

    def test_n10_review_partial_and_correspondence_root_error_preserve_bytes(self):
        self.policy()
        self.reviews._path("a.md").write_bytes(b"broken preserved ledger")
        before = self.bytes()
        result = self.query()
        doc = self.document(result)
        self.assertFalse(result["complete"])
        self.assertEqual(doc["source"]["content"], self.wiki.read("a.md").content)
        self.assertEqual(doc.get("policies", []), [])
        self.assertEqual(before, self.bytes())
        cid = self.create()
        hit = next(m for m in self.find("매진", documents=["b.md"], limit=100)["matches"] if m["target_ref"]["kind"] == "correspondence_endpoint")
        self.correspondences._path(cid).write_bytes(b"broken root ledger")
        before = self.bytes()
        with self.assertRaises(CorrespondenceCorruptError):
            self.query(hit["target_ref"])
        self.assertEqual(before, self.bytes())

    def test_n11_limits_mark_partial_without_claiming_absence(self):
        from core.modules.knowledge.concepts import ConceptStore
        limited = ConceptStore(self.wiki, actor=self.actor, budgets={"capture_bytes": 32})
        before = self.bytes()
        result = limited.find("확인되지않은용어", documents=["a.md"])
        self.assertFalse(result["complete"])
        self.assertTrue(result["truncated"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["revision_scope"], "partial_manifest")
        self.assertEqual(before, self.bytes())

    def test_n12_dependency_only_and_related_lineage_do_not_expand_content(self):
        precedent = deepcopy(self.draft)
        for original in ("a.md", "b.md", "d.md"):
            self.wiki.save("prior_" + original, self.wiki.read(original).content, expected_revision=None)
        precedent["condition"] = self.anchor("prior_a.md")
        precedent["concept"] = self.anchor("prior_b.md")
        precedent["basis"]["link_evidence"] = [self.anchor("prior_d.md")]
        prior = self.create(precedent)
        prior_state = self.correspondences.query(prior)
        value = deepcopy(self.draft)
        content = "평가용 상품은 점검에 사용된다.\n"
        self.wiki.save("eval.md", content, expected_revision=None)
        self.ontology.generate("eval.md", self.wiki.read("eval.md").revision,
                               entities=[{"id": "external", "type": "concept", "label": "상품", "evidence": content.strip()}], relations=[])
        state = self.reviews.query("eval.md")
        value["references"] = [{"kind": "graph", "document": "eval.md", "graph_ref": {"graph_revision": state["graph_revision"], "state_revision": state["state_revision"], "collection": "entities", "layer": "machine", "entity_id": "external", "snapshot": state["machine_graph"]["entities"][0]}}]
        value["related_to"] = [{"correspondence_id": prior, "event_id": prior_state["history"][-1]["id"]}]
        cid = self.create(value)
        result = self.query(correspondence_ids=[cid], expansion="direct_confirmed")
        self.assertNotIn("eval.md", result["scope"]["content_documents"])
        self.assertIn("eval.md", json.dumps(result["scope"]["dependency_only_resources"]))
        self.assertNotIn(prior, result["scope"]["content_correspondences"])

    def test_n13_default_none_and_missing_definition_coverage_are_explicit(self):
        self.create()
        result = self.query()
        self.assertEqual(result["scope"]["content_documents"], ["a.md"])
        self.assertFalse(result["scope"]["auto_expanded"])
        self.assertIn("semantic_coverage", json.dumps(result))
        explicit = self.query(documents=["a.md", "b.md", "d.md"])
        self.assertEqual(set(explicit["scope"]["content_documents"]), {"a.md", "b.md", "d.md"})

    def test_n14_rejected_deferred_scope_and_period_connections_are_diagnostics(self):
        cid = self.create(accept=False)
        for action in ("reject", "defer", "accept"):
            with self.subTest(action=action):
                current = self.correspondences.query(cid)
                self.correspondences.review(cid, action, current["state_revision"], "합성 검토")
                context = {} if action == "accept" else self.context
                result = self.query(expansion="direct_confirmed", application_context=context)
                self.assertEqual(result["scope"]["content_documents"], ["a.md"])
                self.assertTrue(result["scope"]["unexpanded_connections"])
                self.assertEqual(self.document(result)["claims"][0]["decision"], "unreviewed")
        current = self.correspondences.query(cid)
        self.correspondences.review(cid, "defer", current["state_revision"], "기간 정책과 구분할 원문 판단 보류")
        period = deepcopy(self.draft)
        period["business_scope"]["validity"] = {"status": "specified", "source": "합성 시험 기간", "start": "2026-11-01T00:00:00+09:00", "end": "2026-12-01T00:00:00+09:00", "start_inclusive": True, "end_inclusive": False, "timezone": "Asia/Seoul"}
        bounded = self.create(period, accept=False)
        value = deepcopy(self.correspondences.query(bounded)["source_proposal"]["value"])
        value["basis"] = {"kind": "expert", "reason": "기간과 범위를 정한 모의 업무 판단", "link_evidence": []}
        change = {"replacement": value, "reason": "모의 전문가의 범위 한정 판단"}
        prepared = self.correspondences.prepare(bounded, "policy", change)
        self.correspondences.policy(bounded, expected_state_revision=prepared["state_revision"], **change)
        for profile, at, expected in [({"domain": "catalog", "viewpoint": "business"}, "2026-12-01T00:00:00+09:00", "out_of_period"), ({"domain": "catalog", "viewpoint": "developer"}, "2026-11-01T00:00:00+09:00", "other_scope")]:
            with self.subTest(expected=expected):
                result = self.query(expansion="direct_confirmed", profile=profile, as_of=at)
                self.assertEqual(result["scope"]["content_documents"], ["a.md"])
                states = [c["applicability"] for c in result["scope"]["unexpanded_connections"]]
                self.assertIn(expected, states)

    def test_n15_anchor_aba_and_attribute_selector_are_exact(self):
        old = self.target()
        a = self.wiki.read("a.md")
        self.wiki.save("a.md", a.content + "수정\n", expected_revision=a.revision)
        changed = self.wiki.read("a.md")
        self.wiki.save("a.md", a.content, expected_revision=changed.revision)
        stale = self.query(old, expansion="direct_confirmed")
        self.assertEqual(stale["target"]["status"], "version_changed")
        self.generate_a()
        found = self.find("20", documents=["a.md"], limit=100)
        target = next(m["target_ref"] for m in found["matches"] if m["target_ref"]["kind"] == "document_claim" and m["target_ref"].get("selector") == "value")
        state = self.reviews.query("a.md")
        claim = next(c for c in state["claims"] if c["collection"] == "attributes")
        value = deepcopy(self.draft)
        value["condition"]["graph_ref"] = {"collection": "attributes", "claim_id": claim["claim_id"], "graph_revision": state["graph_revision"], "state_revision": state["state_revision"], "layer": "machine", "snapshot": claim["value"]}
        whole_cid = self.create(value)
        result = self.query(target, expansion="direct_confirmed")
        self.assertEqual(result["scope"]["content_documents"], ["a.md"])
        whole = deepcopy(target); whole.pop("selector")
        self.assertIn(whole_cid, self.query(whole, expansion="direct_confirmed")["scope"]["content_correspondences"])
        entity_value = deepcopy(value)
        entity_value["condition"]["graph_ref"] = {"collection": "entities", "entity_id": "product", "graph_revision": state["graph_revision"], "state_revision": state["state_revision"], "layer": "machine", "snapshot": state["machine_graph"]["entities"][0]}
        entity_cid = self.create(entity_value)
        subject = deepcopy(target); subject["selector"] = "attribute_subject"
        result = self.query(subject, expansion="direct_confirmed")
        self.assertIn(entity_cid, result["scope"]["content_correspondences"])
        self.assertNotIn(whole_cid, result["scope"]["content_correspondences"])

    def test_n16_single_lock_readonly_and_busy_are_distinct(self):
        original = self.wiki._write_lock
        calls = []
        active = [False]
        @contextmanager
        def counted():
            self.assertFalse(active[0], "nested storage lock")
            with original():
                active[0] = True; calls.append(1)
                try: yield
                finally: active[0] = False
        before = self.bytes()
        target = self.target()
        with patch.object(self.wiki, "_write_lock", counted), patch.object(ReviewStore, "query", side_effect=AssertionError("public nested query")), patch.object(CorrespondenceStore, "query", side_effect=AssertionError("public nested query")):
            self.query(target)
        self.assertEqual(len(calls), 1)
        self.assertEqual(before, self.bytes())
        with original(), ThreadPoolExecutor(max_workers=1) as executor:
            with self.assertRaises(StorageBusyError):
                executor.submit(self.query, target).result(timeout=3)

    def test_n17_as_of_hashes_describe_current_capture_not_historical_restore(self):
        value = deepcopy(self.draft)
        value["business_scope"]["validity"] = {"status": "specified", "source": "합성 시험 기간", "start": "2026-11-01T00:00:00+09:00", "end": "2026-12-01T00:00:00+09:00", "start_inclusive": True, "end_inclusive": False, "timezone": "Asia/Seoul"}
        cid = self.create(value)
        before = self.bytes()
        first = self.query(correspondence_ids=[cid], as_of="2026-11-01T00:00:00+09:00")
        later = self.query(correspondence_ids=[cid], as_of="2026-12-01T00:00:00+09:00")
        self.assertEqual(first["snapshot_revision"], later["snapshot_revision"])
        self.assertNotEqual(first["view_revision"], later["view_revision"])
        self.assertEqual(first["documents"], later["documents"])
        self.assertEqual(first["correspondences"][0]["source_proposal"]["applicability"], "applicable")
        self.assertEqual(later["correspondences"][0]["source_proposal"]["applicability"], "out_of_period")
        self.assertEqual(before, self.bytes())

    def test_n18_new_document_precedent_does_not_copy_approval(self):
        prior = self.create()
        self.wiki.save("c.md", "판매 가능 재고가 2개인 상품은 별도 안내를 표시한다.\n", expected_revision=None)
        self.ontology.generate("c.md", self.wiki.read("c.md").revision, entities=[], relations=[])
        result = self.query(self.target("c.md"), correspondence_ids=[prior])
        self.assertIn("selected_precedent", json.dumps(result))
        self.assertEqual(self.correspondences.query(prior)["source_proposal"]["decision"], "accepted")
        value = deepcopy(self.draft); value["condition"] = self.anchor("c.md")
        value["basis"] = {"kind": "candidate", "reason": "수량 포함관계는 자동 증명하지 않음", "link_evidence": []}
        value["questions"] = ["새 문서의 적용 범위가 같은가?"]
        cid = self.create(value, accept=False)
        self.assertEqual(self.correspondences.query(cid)["source_proposal"]["decision"], "unreviewed")

    def test_n19_structural_difference_is_not_logical_contradiction(self):
        first = self.create()
        value = deepcopy(self.draft); value["qualifiers"]["quantity"]["upper"] = "3"
        value["qualifiers"]["quantity"]["expression"] = "판매 가능 재고 1개 이상 3개 이하"
        second = self.create(value)
        result = self.query(correspondence_ids=[first, second])
        self.assertEqual(len(result["correspondences"]), 2)
        assessments = [c["conflict_assessment"] for c in result["scope"]["unexpanded_connections"]]
        self.assertTrue(assessments)
        self.assertTrue(all(a in {"reported", "needs_semantic_review"} for a in assessments))
        self.assertNotIn("logical_contradiction", json.dumps(result))
        self.assertEqual({c["source_proposal"]["value"]["qualifiers"]["quantity"]["upper"] for c in result["correspondences"]}, {"3", "5"})

    def test_n20_full_other_context_and_unclassified_constraints_survive(self):
        values = deepcopy(self.graph_input)
        values["relations"][0]["context"] = {"domain": "상품", "viewpoints": ["developer"]}
        values["relations"][0]["qualifiers"] = {"condition": "상품은 점검에 사용된다."}
        self.generate_a(values)
        result = self.query(profile={"domain": "catalog", "viewpoint": "business"})
        doc = self.document(result)
        self.assertEqual(doc["source"]["content"], self.wiki.read("a.md").content)
        self.assertEqual(len(doc["machine_graph"]["relations"]), 1)
        self.assertEqual(doc["machine_graph"]["relations"][0]["qualifiers"]["condition"], "상품은 점검에 사용된다.")
        self.assertTrue(result["other_context"])
        self.assertTrue(result["unclassified"])
        self.assertTrue(result["explanation_context"])
        self.assertTrue(result["map_context"])
        values["relations"][0]["context"] = {"domain": "상품", "viewpoints": []}
        self.generate_a(values)
        partial = self.query(profile={"domain": "catalog", "viewpoint": "business"})
        claim = next(c for c in self.document(partial)["claims"] if c["collection"] == "relations")
        self.assertTrue(any(r["claim_id"] == claim["claim_id"] for r in partial["unclassified"]))
        self.assertFalse(any(r["claim_id"] == claim["claim_id"] for r in partial["other_context"]))


if __name__ == "__main__":
    unittest.main()
