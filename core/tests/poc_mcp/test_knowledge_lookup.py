"""질문 한 번의 후보 탐색+근거 준비가 권한·부분 표시를 지키고 질문에 맞는 단락·지식만 주는지 확인한다."""
from copy import deepcopy
import json
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.aggregation import lookup_view
from core.modules.documents.store import WikiStore
from core.modules.knowledge.question_evidence import LOOKUP_EVIDENCE_POLICY, LOOKUP_PASSAGE_BYTES
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class KnowledgeLookupTests(ServerFixture):
    def setUp(self):
        super().setUp()
        for name, content in (
                ("sqlite-foreign-keys.md", "SQLite foreign key ON DELETE action defaults to NO ACTION when unspecified.\n"),
                ("python-queue.md", "Python Queue shutdown makes later put calls raise ShutDown.\n"),
                ("meeting-notes.md", "Weekly meeting notes about lunch.\n")):
            result = self.mcp("wiki_write", {"tenant": self.tenant, "document": name, "content": content,
                                             "expected_revision": None})
            self.assertTrue(result["ok"], result)

    def lookup(self, token=None, **fields):
        return self.mcp("knowledge_lookup", fields, token=token)

    def prepared(self, documents):
        result = self.mcp("knowledge_context_prepare", {"tenant": self.tenant, "documents": documents})
        self.assertTrue(result["ok"], result)
        return result

    def assert_exact_passages(self, result):
        """모든 단락은 같은 판본 원문의 해당 줄을 그대로 옮긴 것이다."""
        listed = {item["document"]: item for item in result["documents"]}
        prepared = {item["document"]: item for item in self.prepared(list(listed))["documents"]}
        for passage in result["evidence"]["passages"]:
            source = prepared[passage["document"]]
            self.assertEqual(listed[passage["document"]]["source_revision"], source["source_revision"])
            lines = source["content"].splitlines()
            self.assertEqual(passage["text"], "\n".join(lines[passage["start_line"] - 1:passage["end_line"]]))

    def test_one_call_ranks_and_returns_matching_passages(self):
        with patch.object(WikiStore, "save", side_effect=AssertionError("read must not save")), \
                patch.object(ReviewStore, "_commit_locked", side_effect=AssertionError("read must not approve")):
            result = self.lookup(question="What does SQLite ON DELETE default to for a foreign key?")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["access"]["tenant"], self.tenant)
        retrieval = result["retrieval"]
        self.assertEqual(retrieval["selected_documents"][0], "sqlite-foreign-keys.md")
        self.assertEqual(retrieval["prepared_limit"], 3)
        self.assertFalse(retrieval["absence_proven"])
        self.assertEqual(retrieval["coverage"], "authorized_workspace")
        self.assertNotIn("meeting-notes.md", retrieval["selected_documents"])
        # 문서 목록은 준비한 문서의 경로·판본·크기만 주고 전체 원문·전체 지식은 싣지 않는다.
        prepared = self.prepared(retrieval["selected_documents"])
        self.assertEqual([item["document"] for item in result["documents"]], retrieval["selected_documents"])
        for listed, source in zip(result["documents"], prepared["documents"]):
            self.assertEqual(listed["source_revision"], source["source_revision"])
            self.assertEqual(listed["bytes"], len(source["content"].encode()))
            self.assertNotIn("content", listed)
            self.assertNotIn("knowledge", listed)
        evidence = result["evidence"]
        self.assertEqual(evidence["policy"], LOOKUP_EVIDENCE_POLICY)
        self.assertEqual(evidence["passages"][0]["document"], "sqlite-foreign-keys.md")
        self.assertIn("NO ACTION", evidence["passages"][0]["text"])
        self.assertFalse(evidence["passage_scope"]["absence_proven"])
        self.assert_exact_passages(result)
        self.assertTrue(result["read_only"])
        self.assertFalse(result["ai_executed"])
        self.assertFalse(result["persisted"])
        self.assertEqual(len(result["snapshot_revision"]), 64)

    def test_large_document_returns_matching_passages_within_the_limit(self):
        filler = "".join(f"Unrelated filler paragraph {n} about lunch menus.\n\n" for n in range(2000))
        notes = "".join(f"SQLite note {n}: ON DELETE behaviour for foreign key case {n}.\n\n" for n in range(400))
        content = filler + "The SQLite ON DELETE default is NO ACTION for every foreign key.\n\n" + notes + filler
        self.assertTrue(self.mcp("wiki_write", {"tenant": self.tenant, "document": "large.md", "content": content,
                                                "expected_revision": None})["ok"])
        result = self.lookup(question="SQLite ON DELETE default", documents=["large.md"], max_documents=1)
        self.assertTrue(result["ok"], result)
        evidence = result["evidence"]
        self.assertTrue(any("NO ACTION" in passage["text"] for passage in evidence["passages"]))
        self.assert_exact_passages(result)
        passage_bytes = sum(len(json.dumps(p, ensure_ascii=False, separators=(",", ":")).encode())
                            for p in evidence["passages"])
        self.assertLessEqual(passage_bytes, LOOKUP_PASSAGE_BYTES)
        scope = evidence["passage_scope"]
        self.assertGreater(scope["unmatched_passages"], 0)
        self.assertGreater(scope["omitted_matching_passages"], 0)
        self.assertTrue(evidence["truncated"])
        self.assertFalse(result["complete"])
        # 결과는 같은 문서의 전체 준비보다 훨씬 작고, 단락은 문서 줄 순서로 보인다.
        prepared = self.prepared(["large.md"])
        self.assertLess(len(json.dumps(result)), len(json.dumps(prepared)) / 2)
        starts = [passage["start_line"] for passage in evidence["passages"]]
        self.assertEqual(starts, sorted(starts))

    def test_matching_claims_come_with_current_judgments(self):
        store = self.policy.authorize(self.token, self.tenant, "read").store
        source = store.save("graph.md", "# Controller\nA uses B.\nB is a pump.\n", expected_revision=None)
        OntologyStore(store).generate("graph.md", source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        result = self.lookup(question="What does A use?", documents=["graph.md"], max_documents=1)
        self.assertTrue(result["ok"], result)
        [listed] = result["documents"]
        self.assertEqual(listed["status"], "ready")
        self.assertTrue(listed["needs_review"])
        self.assertEqual(listed["claim_decisions"], {"unreviewed": len(RELATIONS)})
        knowledge = result["evidence"]["knowledge"]
        claims = [item for item in knowledge["items"] if item["kind"] == "claim"]
        self.assertTrue(claims)
        self.assertTrue(all(item["decision"] == "unreviewed" and item["needs_review"] for item in claims))
        self.assertNotIn("retrieval", knowledge["scope"])
        self.assertEqual(knowledge["scope"]["semantic_completeness"], "not_proven")

    def stale_reviewed_document(self, document="z-stale.md"):
        store = self.policy.authorize(self.token, self.tenant, "read").store
        source = store.save(document, "# Controller\nA uses B.\nB is a pump.\n", expected_revision=None)
        OntologyStore(store).generate(document, source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        knowledge = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": document})
        reviewed = self.mcp("ontology_review", {
            "tenant": self.tenant, "document": document, "action": "accept", "reason": "simulation",
            "claim_id": knowledge["claims"][0]["claim_id"], "expected_state_revision": knowledge["state_revision"]})
        self.assertTrue(reviewed["ok"], reviewed)
        source = store.read(document)
        store.save(document, source.content + "Controller maintenance changed.\n", expected_revision=source.revision)
        return store, reviewed["event_id"]

    def test_selected_status_survives_truncated_workspace_warnings(self):
        store, event_id = self.stale_reviewed_document()
        for number in range(21):
            store.save(f"a-no-graph-{number:02d}.md", "Unrelated notes.\n", expected_revision=None)
        result = self.lookup(question="Controller maintenance", documents=["z-stale.md"], max_documents=1)
        self.assertTrue(result["ok"], result)
        # 워크스페이스 경고 20개에 선택 문서가 없더라도 그 문서의 상태를 직접 전달한다.
        self.assertEqual(len(result["retrieval"]["skipped"]), 20)
        self.assertNotIn("z-stale.md", json.dumps(result["retrieval"]["skipped"]))
        [listed] = result["documents"]
        self.assertEqual(listed["status"], "stale")
        self.assertTrue(listed["needs_reextraction"])
        self.assertTrue(listed["needs_review"])
        self.assertEqual(listed["pending_history_count"], 1)
        self.assertEqual(listed["current_pending_history_count"], 1)
        query = listed["detail_query"]
        detail = self.mcp(query["tool"], query["arguments"])
        self.assertTrue(detail["ok"], detail)
        self.assertEqual(detail["state_revision"], listed["state_revision"])
        self.assertEqual(detail["pending_history"], [event_id])
        self.assertFalse(result["complete"])
        self.assert_exact_passages(result)

    def test_pending_summary_preserves_cleanup_scope_and_undo(self):
        store, event_id = self.stale_reviewed_document()
        current = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "z-stale.md"})
        # 재추출 뒤에도 이전 판단을 자동 승계하지 않으며, ready와 pending은 독립이다.
        OntologyStore(store).generate("z-stale.md", store.read("z-stale.md").revision,
            deepcopy(ENTITIES), deepcopy(RELATIONS), expected_state_revision=current["state_revision"])
        arguments = {"tenant": self.tenant, "document": "z-stale.md"}
        preview = self.mcp("ontology_cleanup_preview", arguments)
        self.assertTrue(preview["ok"], preview)
        archived = self.mcp("ontology_cleanup_apply", {**arguments, "request_id": uuid4().hex,
            "preview_revision": preview["preview_revision"], "item_ids": [item["item_id"] for item in preview["items"]],
            "reason": "simulation archive"})
        self.assertTrue(archived["ok"], archived)
        result = self.lookup(question="Controller", documents=["z-stale.md"], max_documents=1)
        [listed] = result["documents"]
        self.assertEqual(listed["status"], "ready")
        self.assertEqual(listed["pending_history_count"], 1)
        self.assertEqual(listed["current_pending_history_count"], 0)
        detail = self.mcp("ontology_review_query", arguments)
        self.assertEqual(listed["needs_review"], detail["needs_review"])
        self.assertEqual(detail["pending_history"], [event_id])
        self.assertEqual(detail["current_pending_history"], [])

        def other_profile(policy):
            policy["tenants"][self.tenant]["profiles"]["other"] = {"domain": "maintenance", "viewpoint": None}
            policy["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("other")
        self.change_policy(other_profile)
        other = self.lookup(question="Controller", documents=["z-stale.md"], max_documents=1, profile="other")
        self.assertTrue(other["ok"], other)
        self.assertEqual(other["documents"][0]["current_pending_history_count"], 1)
        self.assertEqual(other["documents"][0]["detail_query"]["arguments"]["profile"], "other")
        undone = self.mcp("ontology_cleanup_undo", {**arguments, "request_id": uuid4().hex,
            "event_id": archived["event_id"], "expected_state_revision": detail["state_revision"],
            "reason": "simulation undo"})
        self.assertTrue(undone["ok"], undone)
        restored = self.lookup(question="Controller", documents=["z-stale.md"], max_documents=1)
        self.assertEqual(restored["documents"][0]["current_pending_history_count"], 1)

    def test_pending_summary_size_does_not_grow_with_event_history(self):
        self.stale_reviewed_document()
        prepared = self.prepared(["z-stale.md"])
        prepared["retrieval"] = {}
        small = lookup_view(prepared, "Controller")
        many = deepcopy(prepared)
        ids = [*many["documents"][0]["knowledge"]["pending_history"], *[f"{index:032x}" for index in range(9999)]]
        many["documents"][0]["knowledge"].update(pending_history=ids, current_pending_history=ids)
        large = lookup_view(many, "Controller")
        self.assertEqual(large["documents"][0]["pending_history_count"], len(ids))
        self.assertEqual(large["documents"][0]["current_pending_history_count"], len(ids))
        self.assertLess(len(canonical_json_bytes(large)) - len(canonical_json_bytes(small)), 32)
        self.assertNotIn("pending_history", large["documents"][0])
        self.assertNotIn("current_pending_history", large["documents"][0])

    def test_reviewed_claims_come_with_compact_judgments(self):
        store = self.policy.authorize(self.token, self.tenant, "read").store
        source = store.save("graph.md", "# Controller\nA uses B.\nB is a pump.\n", expected_revision=None)
        OntologyStore(store).generate("graph.md", source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        knowledge = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "graph.md"})
        self.assertTrue(knowledge["ok"], knowledge)
        reviewed = self.mcp("ontology_review", {
            "tenant": self.tenant, "document": "graph.md", "action": "accept", "reason": "근거 문장과 맞음",
            "claim_id": knowledge["claims"][0]["claim_id"], "expected_state_revision": knowledge["state_revision"]})
        self.assertTrue(reviewed["ok"], reviewed)
        result = self.lookup(question="What does A use?", documents=["graph.md"], max_documents=1)
        self.assertTrue(result["ok"], result)
        items = result["evidence"]["knowledge"]["items"]
        reviews = [item for item in items if item["kind"] == "review"]
        self.assertTrue(reviews)
        for item in reviews:
            # 판단 ID·이유·상태 번호는 남기고 claim과 겹치는 전후 값과 판단 주체 세부는 뺀다.
            self.assertEqual(item["event_detail"], "compact")
            self.assertEqual(item["state_revision"], reviewed["state_revision"])
            self.assertEqual(item["event"]["id"], reviewed["event_id"])
            self.assertEqual(item["event"]["reason"], "근거 문장과 맞음")
            self.assertNotIn("before", item["event"])
            self.assertNotIn("after", item["event"])
            self.assertLessEqual(set(item["event"]["actor"]), {"user_id", "profile_id"})
        accepted = [item for item in items if item["kind"] == "claim" and item["decision"] == "accept"]
        self.assertEqual([item["claim_id"] for item in accepted], [knowledge["claims"][0]["claim_id"]])
        # 앱 첫 근거(D-124)는 전체 검토 이벤트를 그대로 받는다.
        full = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "graph.md"})
        self.assertIn("before", full["history"][0])

    def test_compact_review_keeps_changed_values_for_other_actions(self):
        from core.modules.knowledge.question_evidence import _compact_review
        event = {"id": "e1", "action": "edit", "claim_id": "c1", "reason": "정정", "timestamp": "t",
                 "actor": {"user_id": "u", "profile_id": "default", "access_revision": "x"},
                 "before": {"decision": "unreviewed"}, "after": {"decision": "edit", "value": {"subject": "a"}},
                 "source_revision": "s", "graph_revision": "g"}
        compact = _compact_review({"kind": "review", "event": event, "state_revision": "r"})
        self.assertEqual(compact["event"]["after"], event["after"])
        self.assertNotIn("before", compact["event"])
        self.assertNotIn("source_revision", compact["event"])
        self.assertEqual(compact["event"]["actor"], {"user_id": "u", "profile_id": "default"})
        self.assertEqual(compact["state_revision"], "r")
        for action in ("accept", "reject", "defer"):
            self.assertNotIn("after", _compact_review({"event": {**event, "action": action}})["event"])

    def test_documents_without_ontology_are_ranked_by_body_terms(self):
        from core.modules.knowledge.question_index import RANKING_POLICY
        store = self.policy.authorize(self.token, self.tenant, "read").store
        sentence = "Pump maintenance schedule applies to every vessel."
        entities = [{"id": "p", "label": "Pump maintenance schedule", "type": "system", "evidence": sentence},
                    {"id": "v", "label": "vessel", "type": "system", "evidence": sentence}]
        relations = [{"subject": "p", "predicate": "uses", "object": "v", "evidence": sentence}]
        for number in range(3):
            saved = store.save(f"graph-{number}.md", f"# Pump {number}\n{sentence}\n", expected_revision=None)
            OntologyStore(store).generate(f"graph-{number}.md", saved.revision, deepcopy(entities), deepcopy(relations))
        # 그래프가 없는 문서는 개념 가중치를 못 받지만, 드문 본문 단어(KSV-40)로 본문 순위 1위가 된다.
        store.save("zz-fleet.md", "KSV-40 pump maintenance schedule is ten hours for this vessel.\n", expected_revision=None)
        result = self.lookup(question="Pump maintenance schedule for vessel KSV-40", max_documents=3)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["retrieval"]["ranking"], RANKING_POLICY)
        self.assertIn("zz-fleet.md", result["retrieval"]["selected_documents"])
        self.assertIn("graph-0.md", result["retrieval"]["selected_documents"])
        self.assertTrue(any("KSV-40" in passage["text"] for passage in result["evidence"]["passages"]))

    def test_limit_pins_and_unprepared_candidates_stay_visible(self):
        question = "SQLite foreign key and Python Queue shutdown"
        one = self.lookup(question=question, max_documents=1)
        self.assertTrue(one["ok"], one)
        self.assertEqual(len(one["documents"]), 1)
        self.assertEqual(len(one["retrieval"]["selected_documents"]), 1)
        self.assertTrue(one["retrieval"]["candidates_not_prepared"])
        pinned = self.lookup(question=question, documents=["python-queue.md"], max_documents=1)
        self.assertEqual(pinned["retrieval"]["selected_documents"], ["python-queue.md"])
        self.assertEqual(pinned["documents"][0]["document"], "python-queue.md")

    def test_no_match_is_empty_selection_not_absence(self):
        result = self.lookup(question="zzqx nonexistent vocabulary")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["documents"], [])
        self.assertEqual(result["scope"]["empty_selection"], "no_matching_documents")
        self.assertFalse(result["retrieval"]["absence_proven"])

    def test_tenant_is_optional_only_for_lookup_and_rights_still_apply(self):
        tools = {tool["name"]: tool for tool in self.client.post(
            "/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).json()["result"]["tools"]}
        self.assertNotIn("tenant", tools["knowledge_lookup"]["inputSchema"].get("required", []))
        self.assertIn("tenant", tools["knowledge_context_prepare"]["inputSchema"]["required"])
        self.assertEqual(self.mcp("knowledge_context_prepare", {"documents": ["python-queue.md"]})["error"]["code"],
                         "invalid_argument")
        self.assertEqual(self.lookup(question="SQLite", tenant="forbidden")["error"]["code"], "access_denied")
        self.assertEqual(self.lookup(question="SQLite", profile="forbidden")["error"]["code"], "access_denied")
        explicit = self.lookup(question="SQLite", tenant=self.tenant)
        self.assertTrue(explicit["ok"], explicit)
        for invalid in ({"question": ""}, {"question": "SQLite", "max_documents": 9},
                        {"question": "SQLite", "max_documents": "2"}, {"question": "SQLite", "documents": ["a.md", "a.md"]}):
            with self.subTest(arguments=invalid):
                self.assertFalse(self.lookup(**invalid)["ok"])
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        self.assertEqual(self.lookup(question="SQLite")["error"]["code"], "access_denied")

    def test_user_without_default_workspace_must_name_tenant(self):
        response = self.client.post("/api/v1/auth/signup", json={"name": "소속 없는 사용자"})
        stranger = response.json()["data"]
        self.assertIsNone(stranger["default_tenant"])
        result = self.lookup(token=stranger["token"], question="SQLite")
        self.assertFalse(result["ok"])
        self.assertIn(result["error"]["code"], {"invalid_argument", "access_denied"})
        self.assertNotIn("documents", result)
