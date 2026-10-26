"""Independent D-038 boundary regressions on synthetic, temporary data.

These checks exercise preservation and application scope, not LLM semantic
accuracy or actual human approval.
"""

from copy import deepcopy
import os
import tempfile
import unittest
from unittest.mock import patch

from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import CorrespondenceConflictError, CorrespondenceValidationError
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture


class CorrespondenceBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-d038-boundary-")
        self.addCleanup(temporary.cleanup)
        self.wiki = WikiStore(temporary.name)
        self.actor = correspondence_actor()
        self.store = CorrespondenceStore(self.wiki, self.actor)
        self.draft = correspondence_fixture(self.wiki)

    def create(self, draft=None):
        draft = deepcopy(draft or self.draft)
        prepared = self.store.query(draft=draft)
        self.store.propose(
            correspondence_id=prepared["correspondence_id"], draft=draft,
            expected_state_revision=prepared["state_revision"],
            reason="격리 회귀의 모의 제안",
        )
        return prepared["correspondence_id"]

    def change(self, correspondence_id, operation, **change):
        prepared = self.store.prepare(
            correspondence_id=correspondence_id, operation=operation, change=change,
        )
        return getattr(self.store, operation)(
            correspondence_id=correspondence_id,
            expected_state_revision=prepared["state_revision"], **change,
        )

    def snapshot(self):
        return {p.relative_to(self.wiki.data_dir).as_posix(): p.read_bytes()
                for p in self.wiki.data_dir.rglob("*")
                if p.is_file() and p.name != ".storage.lock"}

    def source(self, correspondence_id):
        result = self.store.query(correspondence_id=correspondence_id)
        event = next(e for e in reversed(result["history"]) if e["lane"] == "source")
        return result, event["after"]

    def document_graph(self, predicate="uses"):
        ontology = OntologyStore(self.wiki)
        quote = self.draft["condition"]["quote"]
        entities = [{"id": "product", "label": "상품", "type": "concept", "evidence": quote},
                    {"id": "stock", "label": "판매 가능 재고", "type": "concept", "evidence": quote}]
        relations = [{"subject": "product", "predicate": predicate, "object": "stock", "evidence": quote,
                      "context": {"domain": None, "viewpoints": ["business"]}}]
        reviews = ReviewStore(self.wiki)
        current = reviews.query("a.md")
        ontology.generate("a.md", self.wiki.read("a.md").revision, entities, relations,
                          expected_state_revision=current["state_revision"])
        return reviews.query("a.md")

    def graph_draft(self, snapshot, *, layer="reviewed"):
        draft = deepcopy(self.draft)
        claim = next(item for item in snapshot["claims"] if item["collection"] == "relations")
        draft["references"] = [{"kind": "graph", "document": "a.md", "graph_ref": {
            "graph_revision": snapshot["graph_revision"], "state_revision": snapshot["state_revision"],
            "collection": "relations", "claim_id": claim["claim_id"], "layer": layer,
            "snapshot": claim["reviewed_value"] if layer == "reviewed" else claim["value"],
        }}]
        return draft

    def test_prepare_is_bound_to_the_entire_change_and_reason(self):
        cid = self.create()
        replacement = deepcopy(self.draft)
        replacement["statement"] = "전체 조건을 보존한 별도의 모의 해석"
        change = {"action": "edit", "replacement": replacement,
                  "decision": "deferred", "reason": "모의 전문가에게 확인할 변경안"}
        prepared = self.store.prepare(cid, "review", change)
        before = self.snapshot()
        changed = deepcopy(change)
        changed["replacement"]["qualifiers"]["quantity"]["upper"] = "3"
        with self.assertRaises(CorrespondenceConflictError):
            self.store.review(cid, expected_state_revision=prepared["state_revision"], **changed)
        changed = deepcopy(change)
        changed["reason"] = "준비 때와 다른 이유"
        with self.assertRaises(CorrespondenceConflictError):
            self.store.review(cid, expected_state_revision=prepared["state_revision"], **changed)
        self.assertEqual(self.snapshot(), before)

    def test_removed_dependency_still_participates_in_prepared_change_cas(self):
        cid = self.create()
        replacement = deepcopy(self.draft)
        replacement["basis"] = {"kind": "candidate", "reason": "연결 정의 확인 필요", "link_evidence": []}
        replacement["questions"] = ["이 정의를 계속 사용하는가?"]
        change = {"action": "edit", "replacement": replacement,
                  "decision": "deferred", "reason": "연결 근거를 제거한 모의 변경"}
        prepared = self.store.prepare(cid, "review", change)
        old = self.wiki.read("d.md")
        self.wiki.save("d.md", old.content + "정의가 바뀌었다.\n", expected_revision=old.revision)
        before = self.snapshot()
        with self.assertRaises(CorrespondenceConflictError):
            self.store.review(cid, expected_state_revision=prepared["state_revision"], **change)
        self.assertEqual(self.snapshot(), before)

    def test_noop_source_write_and_unchanged_queries_preserve_cas(self):
        cid = self.create()
        first = self.store.query(correspondence_id=cid)
        old = self.wiki.read("a.md")
        saved = self.wiki.save("a.md", old.content, expected_revision=old.revision)
        self.assertFalse(saved.changed)
        second = self.store.query(correspondence_id=cid)
        self.assertEqual(first["state_revision"], second["state_revision"])
        self.assertEqual(first["history"], second["history"])

    def test_explicit_new_decision_has_history_even_when_value_is_unchanged(self):
        cid = self.create()
        first = self.change(cid, "review", action="accept", reason="첫 번째 모의 검토")
        self.change(cid, "review", action="accept", reason="같은 값에 대한 새 모의 판단")
        current = self.store.query(correspondence_id=cid)
        self.assertEqual(len(current["history"]), 3)
        self.assertNotEqual(first["state_revision"], current["state_revision"])
        self.assertEqual(current["history"][-1]["before"]["value"], current["history"][-1]["after"]["value"])

    def test_restore_previous_rejection_and_undo_the_undo(self):
        cid = self.create()
        self.change(cid, "review", action="reject", reason="모의 거절")
        accepted = self.change(cid, "review", action="accept", reason="모의 재검토 수용")
        undone = self.change(cid, "review_undo", event_id=accepted["event_id"], reason="모의 수용 취소")
        _, state = self.source(cid)
        self.assertEqual(state["decision"], "rejected")
        self.change(cid, "review_undo", event_id=undone["event_id"], reason="모의 취소를 다시 취소")
        _, state = self.source(cid)
        self.assertEqual(state["decision"], "accepted")

    def test_fixed_document_pair_applies_to_both_review_and_expert_replacement(self):
        cid = self.create()
        self.wiki.save("other.md", "별도의 상품 조건이다.\n", expected_revision=None)
        other = self.wiki.read("other.md")
        replacement = deepcopy(self.draft)
        replacement["condition"] = {"document": "other.md", "source_revision": other.revision,
                                    "quote": other.content.strip(), "start_line": 1, "end_line": 1}
        for operation in ("review", "policy"):
            change = {"replacement": deepcopy(replacement), "reason": "문서 쌍 우회 시도인 모의 검사"}
            if operation == "review":
                change.update(action="edit", decision="deferred")
            else:
                change["replacement"]["basis"] = {"kind": "expert", "reason": "모의 업무 판단", "link_evidence": []}
            with self.subTest(operation=operation):
                before = self.snapshot()
                with self.assertRaises(CorrespondenceValidationError):
                    self.store.prepare(cid, operation, change)
                self.assertEqual(self.snapshot(), before)

    def test_all_quantity_boundaries_and_conditions_are_preserved_in_history(self):
        draft = deepcopy(self.draft)
        draft["qualifiers"]["quantity"].update(lower="1.0", upper="5.0", lower_inclusive=False)
        draft["qualifiers"]["conditions"] = {"status": "specified", "items": ["판매 중이어야 한다", "단종 대상이 아니어야 한다"]}
        draft["qualifiers"]["exceptions"] = {"status": "unknown", "items": []}
        draft["direction"] = "equivalent_definition"
        cid = self.create(draft)
        self.change(cid, "review", action="defer", reason="조건과 동치의 의미는 실제 검토가 필요하다")
        _, state = self.source(cid)
        self.assertEqual(state["value"]["qualifiers"], draft["qualifiers"])
        self.assertEqual(state["value"]["direction"], "equivalent_definition")

    def test_period_boundaries_and_query_times_do_not_mutate_the_ledger(self):
        draft = deepcopy(self.draft)
        draft["business_scope"]["validity"] = {
            "status": "specified", "source": "합성 시험 기간",
            "start": "2026-11-01T00:00:00+09:00", "end": "2026-12-01T00:00:00+09:00",
            "start_inclusive": True, "end_inclusive": False, "timezone": "Asia/Seoul",
        }
        cid = self.create(draft)
        self.change(cid, "review", action="accept", reason="합성 기간을 보존하는 모의 수용")
        before = self.snapshot()
        contexts = {"service": "catalog"}
        beginning = self.store.query(cid, application_context=contexts, as_of="2026-11-01T00:00:00+09:00")
        ending = self.store.query(cid, application_context=contexts, as_of="2026-12-01T00:00:00+09:00")
        self.assertEqual(beginning["state_revision"], ending["state_revision"])
        self.assertEqual(beginning["source_proposal"]["applicability"], "applicable")
        self.assertEqual(ending["source_proposal"]["applicability"], "out_of_period")
        self.assertEqual(self.snapshot(), before)

    def test_invalid_timezone_and_bool_anchor_are_rejected_before_writing(self):
        drafts = []
        bad = deepcopy(self.draft); bad["condition"]["start_line"] = True; drafts.append(bad)
        bad = deepcopy(self.draft)
        bad["business_scope"]["validity"] = {
            "status": "specified", "source": "잘못된 offset을 가진 합성 기간",
            "start": "2026-11-01T00:00:00+00:00", "end": "2026-12-01T00:00:00+00:00",
            "start_inclusive": True, "end_inclusive": False, "timezone": "Asia/Seoul",
        }
        drafts.append(bad)
        before = self.snapshot()
        for draft in drafts:
            with self.subTest(draft=draft):
                with self.assertRaises(CorrespondenceValidationError):
                    self.store.query(draft=draft)
                self.assertEqual(self.snapshot(), before)

    def test_explicit_scope_precedent_can_be_reused_and_its_dependencies_propagate(self):
        precedent = self.create()
        self.change(precedent, "review", action="accept", reason="선례의 모의 수용")
        detail = self.store.query(precedent, application_context={"service": "catalog"})
        event = detail["history"][-1]
        draft = deepcopy(self.draft)
        draft["references"] = [{
            "kind": "correspondence", "correspondence_id": precedent,
            "event_id": event["id"], "correspondence_revision": detail["correspondence_revision"],
            "snapshot": event["after"], "scope": None,
        }]
        # Prepare/propose/review must work from the draft's explicit scope;
        # mutation methods do not accept a query application_context argument.
        dependent = self.create(draft)
        self.change(dependent, "review", action="accept", reason="범위를 보존한 선례 재사용 모의 검토")
        focused = self.store.query(dependent, application_context={"service": "catalog"})
        unknown = self.store.query(dependent)
        self.assertEqual(focused["source_proposal"]["applicability"], "applicable")
        self.assertEqual(unknown["source_proposal"]["applicability"], "unknown_scope")
        self.assertEqual(focused["state_revision"], unknown["state_revision"])
        before_revision = detail["correspondence_revision"]
        definition = self.wiki.read("d.md")
        self.wiki.save("d.md", definition.content + "정의의 추가 조건이 달라졌다.\n",
                       expected_revision=definition.revision)
        self.assertEqual(self.store.query(precedent)["correspondence_revision"], before_revision)
        updated = self.store.query(dependent, application_context={"service": "catalog"})
        self.assertEqual(updated["source_proposal"]["decision"], "accepted")
        self.assertEqual(updated["source_proposal"]["applicability"], "needs_review")

    def test_lineage_does_not_inherit_acceptance_or_add_an_implicit_basis_dependency(self):
        precedent = self.create()
        accepted = self.change(precedent, "review", action="accept", reason="재사용 선례의 모의 수용")
        self.wiki.save("c.md", "판매 가능 재고가 2개인 상품에 안내를 표시한다.\n", expected_revision=None)
        source = self.wiki.read("c.md")
        draft = deepcopy(self.draft)
        draft["condition"] = {"document": "c.md", "source_revision": source.revision,
                              "quote": source.content.strip(), "start_line": 1, "end_line": 1}
        draft["basis"] = {"kind": "candidate", "reason": "새 문서의 의미 차이를 확인해야 한다", "link_evidence": []}
        draft["questions"] = ["새 문서의 조건과 선례의 예외가 일치하는가?"]
        draft["related_to"] = [{"correspondence_id": precedent, "event_id": accepted["event_id"]}]
        dependent = self.create(draft)
        detail, state = self.source(dependent)
        self.assertEqual(state["decision"], "unreviewed")
        self.assertEqual(state["value"]["related_to"], draft["related_to"])
        self.assertEqual(detail["dependencies"]["correspondences"], [])
        self.assertEqual({row["document"] for row in detail["dependencies"]["documents"]}, {"b.md", "c.md"})

    def test_expert_judgment_is_visible_but_not_applicable_in_another_profile(self):
        candidate = correspondence_fixture(self.wiki, basis="candidate")
        cid = self.create(candidate)
        expert = deepcopy(candidate)
        expert["basis"] = {"kind": "expert", "reason": "원문 인용 없는 모의 업무 판단", "link_evidence": []}
        expert["questions"] = []
        self.change(cid, "policy", replacement=expert, reason="현업 범위의 모의 정책")
        current = self.store.query(cid, application_context={"service": "catalog"})
        other = CorrespondenceStore(self.wiki, correspondence_actor(profile_id="developer", viewpoint="developer"))
        switched = other.query(cid, application_context={"service": "catalog"})
        self.assertEqual(current["policies"][0]["applicability"], "applicable")
        self.assertEqual(switched["policies"][0]["applicability"], "other_scope")
        self.assertEqual(switched["source_proposal"]["decision"], "unreviewed")
        self.assertEqual(current["history"], switched["history"])

    def test_find_counts_reference_closure_per_result_not_all_scanned_ledgers(self):
        unrelated = {self.create() for _ in range(9)}
        precedent = self.create()
        self.change(precedent, "review", action="accept", reason="탐색 회귀 선례의 모의 수용")
        detail = self.store.query(precedent)
        event = detail["history"][-1]
        draft = deepcopy(self.draft)
        draft["references"] = [{
            "kind": "correspondence", "correspondence_id": precedent,
            "event_id": event["id"], "correspondence_revision": detail["correspondence_revision"],
            "snapshot": event["after"], "scope": None,
        }]
        dependent = self.create(draft)
        original = os.scandir

        def deterministic_entries(path):
            with original(path) as entries:
                rows = list(entries)
            if os.fspath(path) == os.fspath(self.wiki.data_dir / "_reviews" / "correspondences"):
                rows.sort(key=lambda entry: (0 if entry.name[:-5] in unrelated else
                                            1 if entry.name[:-5] == dependent else 2, entry.name))
            class Entries:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def __iter__(self):
                    return iter(rows)

            return Entries()

        with patch("core.modules.correspondences.queries.os.scandir", side_effect=deterministic_entries):
            result = self.store.find(["b.md"], application_context={"service": "catalog"}, limit=100)
        self.assertTrue(result["complete"], result["skipped"])
        self.assertFalse(result["truncated"])
        self.assertEqual({row["correspondence_id"] for row in result["results"]}, unrelated | {precedent, dependent})

    def test_find_independent_results_can_capture_more_than_eight_total_documents(self):
        wanted = set()
        for index in range(5):
            draft = deepcopy(self.draft)
            for field, document in (("condition", f"a{index}.md"),):
                source = f"재고가 {index + 1}개인 상품 조건이다.\n"
                self.wiki.save(document, source, expected_revision=None)
                snapshot = self.wiki.read(document)
                draft[field] = {"document": document, "source_revision": snapshot.revision,
                                "quote": source.strip(), "start_line": 1, "end_line": 1}
            document = f"d{index}.md"
            source = f"재고가 {index + 1}개이면 이 시험의 매진 임박으로 분류한다.\n"
            self.wiki.save(document, source, expected_revision=None)
            snapshot = self.wiki.read(document)
            draft["basis"]["link_evidence"] = [{"document": document, "source_revision": snapshot.revision,
                                                "quote": source.strip(), "start_line": 1, "end_line": 1}]
            wanted.add(self.create(draft))
        result = self.store.find(["b.md"], limit=100)
        self.assertTrue(result["complete"], result["skipped"])
        self.assertEqual({row["correspondence_id"] for row in result["results"]}, wanted)

    def test_reviewed_graph_reference_uses_the_reviewed_value_in_its_manifest(self):
        snapshot = self.document_graph()
        claim = snapshot["claims"][0]
        replacement = _input(claim["value"])
        replacement["predicate"] = "related_to"
        ReviewStore(self.wiki).review(
            "a.md", action="edit", claim_id=claim["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="모의 추출 해석 수정",
            actor=self.actor, replacement=replacement,
        )
        snapshot = ReviewStore(self.wiki).query("a.md")
        cid = self.create(self.graph_draft(snapshot))
        self.change(cid, "review", action="accept", reason="검토 반영층 참조의 모의 수용")
        detail = self.store.query(cid, application_context={"service": "catalog"})
        document = next(item for item in detail["dependencies"]["documents"] if item["document"] == "a.md")
        self.assertTrue(document["references"])
        self.assertEqual({item["status"] for item in document["references"]}, {"ready"})
        self.assertEqual(detail["source_proposal"]["applicability"], "applicable")

    def test_graph_aba_does_not_restore_correspondence_approval(self):
        first = self.document_graph()
        cid = self.create(self.graph_draft(first, layer="machine"))
        self.change(cid, "review", action="accept", reason="기계층 참조의 모의 수용")
        accepted = self.store.query(cid)
        self.document_graph("related_to")
        restored = self.document_graph("uses")
        self.assertNotEqual(first["graph_revision"], restored["graph_revision"])
        current = self.store.query(cid, application_context={"service": "catalog"})
        self.assertEqual(current["source_proposal"]["decision"], "accepted")
        self.assertEqual(current["source_proposal"]["applicability"], "needs_review")
        self.assertEqual(accepted["history"], current["history"])

    def test_missing_graph_claim_blocks_general_cas_but_allows_explicit_deferral(self):
        first = self.document_graph()
        cid = self.create(self.graph_draft(first, layer="machine"))
        self.change(cid, "review", action="accept", reason="기계 주장 참조의 모의 수용")
        reviews = ReviewStore(self.wiki)
        state = reviews.query("a.md")
        OntologyStore(self.wiki).generate(
            "a.md", self.wiki.read("a.md").revision,
            _input(state["machine_graph"]["entities"]), [], expected_state_revision=state["state_revision"],
        )
        missing = self.store.query(cid)
        self.assertFalse(missing["complete"])
        self.assertNotIn("state_revision", missing)
        self.assertEqual(missing["source_proposal"]["applicability"], "unavailable")
        self.change(cid, "review", action="defer", reason="존재하지 않는 주장 참조를 보류")
        _, deferred = self.source(cid)
        self.assertEqual(deferred["decision"], "deferred")

    def test_document_expert_reference_preserves_exact_scope_and_undo_invalidates_it(self):
        snapshot = self.document_graph()
        claim = snapshot["claims"][0]
        replacement = {key: value for key, value in _input(claim["value"]).items()
                       if key not in {"evidence", "provenance"}}
        replacement["predicate"] = "related_to"
        replacement["context"] = {"domain": "catalog", "viewpoints": ["business"]}
        reviews = ReviewStore(self.wiki)
        reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
                       expected_state_revision=snapshot["state_revision"], reason="문서 전문가의 모의 정책", actor=self.actor)
        policy = reviews.query("a.md", domain="catalog", viewpoint="business")
        event = policy["history"][-1]
        draft = deepcopy(self.draft)
        draft["references"] = [{"kind": "policy", "document": "a.md", "event_id": event["id"],
                                "state_revision": policy["state_revision"], "snapshot": event["after"],
                                "scope": {"domain": "catalog", "viewpoint": "business"}}]
        cid = self.create(draft)
        self.change(cid, "review", action="accept", reason="정책 근거를 참조한 모의 수용")
        other = CorrespondenceStore(self.wiki, correspondence_actor(profile_id="developer", viewpoint="developer"))
        switched = other.query(cid, application_context={"service": "catalog"})
        self.assertEqual(switched["source_proposal"]["applicability"], "other_scope")
        reviews.policy_undo("a.md", event_id=event["id"], expected_state_revision=policy["state_revision"],
                            reason="문서 전문가의 모의 정책 취소", actor=self.actor)
        updated = self.store.query(cid, application_context={"service": "catalog"})
        self.assertEqual(updated["source_proposal"]["decision"], "accepted")
        self.assertEqual(updated["source_proposal"]["applicability"], "needs_review")


if __name__ == "__main__":
    unittest.main()
