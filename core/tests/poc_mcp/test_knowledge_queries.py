"""격리된 실제 HTTP/MCP에서 지식 집계의 근거·범위·부분 결과를 비교한다."""
from copy import deepcopy
import json
from unittest.mock import patch
from uuid import uuid4

from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class KnowledgeQueryTransportTests(ServerFixture):
    routes = {
        "knowledge_context_prepare": "/question-context/prepare",
        "ontology_review_queue": "/review-queue/query",
        "wiki_history_query": "/history/query",
    }

    def setUp(self):
        super().setUp()
        self.write("A uses B.\n")
        self.store = self.policy.authorize(self.token, self.tenant, "read").store
        self.ontology = OntologyStore(self.store)
        self.reviews = ReviewStore(self.store)
        self.ontology.generate("example.md", self.store.read("example.md").revision,
                               deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.prefix = f"/api/v1/tenants/{self.tenant}"

    def call(self, name, **fields):
        return self.mcp(name, {"tenant": self.tenant, **fields})

    def http(self, name, payload):
        return self.client.post(self.prefix + self.routes[name], headers=self.headers(), json=payload)

    def equal(self, name, **fields):
        http = self.http(name, fields)
        self.assertEqual(http.status_code, 200, http.text)
        result = self.call(name, **fields)
        self.assertTrue(result["ok"], result)
        self.assertEqual(http.json()["data"], {key: value for key, value in result.items() if key != "ok"})
        return result

    def test_question_exact_claim_source_and_required_documents_are_read_only(self):
        registered = self.client.post(self.prefix + "/sources", headers=self.headers(), json={
            "request_id": uuid4().hex, "title": "Evidence", "format": "txt", "content": "Original evidence.\n"})
        self.assertEqual(registered.status_code, 201, registered.text)
        source = registered.json()["data"]
        source_ref = {key: source[key] for key in ("source_id", "source_version", "source_sha256")}
        current = self.reviews.query("example.md")
        claim = {"document": "example.md", "claim_id": current["claims"][0]["claim_id"],
                 "state_revision": current["state_revision"]}
        before = {path: path.read_bytes() for path in self.store.data_dir.rglob("*") if path.is_file()}
        with patch.object(WikiStore, "save", side_effect=AssertionError("read must not save")), \
                patch.object(ReviewStore, "_commit_locked", side_effect=AssertionError("read must not approve")):
            result = self.equal("knowledge_context_prepare", documents=["example.md"],
                                required_documents=["example.md"], claims=[claim], source_refs=[source_ref])
        self.assertTrue(result["can_prepare"])
        self.assertEqual(result["scope"]["claims"], [claim])
        self.assertEqual(result["originals"][0]["source_ref"], source_ref)
        self.assertEqual(result["originals"][0]["content"], "Original evidence.\n")
        self.assertTrue(result["read_only"])
        self.assertFalse(result["persisted"])
        self.assertFalse(result["ai_executed"])
        self.assertEqual(before, {path: path.read_bytes() for path in self.store.data_dir.rglob("*") if path.is_file()})

    def test_stale_claim_source_and_missing_required_document_remain_partial(self):
        current = self.reviews.query("example.md")
        result = self.equal("knowledge_context_prepare", documents=["example.md"], required_documents=["missing.md"],
            claims=[{"document": "example.md", "claim_id": current["claims"][0]["claim_id"], "state_revision": "0" * 64}],
            source_refs=[{"source_id": "0" * 32, "source_version": "1" * 32, "source_sha256": "2" * 64}])
        self.assertFalse(result["complete"])
        self.assertFalse(result["can_prepare"])
        self.assertEqual({item["kind"] for item in result["skipped"]}, {"document", "claim", "source"})
        self.assertEqual(result["documents"][0]["document"], "example.md")
        self.assertEqual(result["selected_claims"][0]["status"], "changed_or_unavailable")
        self.assertIsNone(result["selected_claims"][0]["claim"])

    def test_selected_and_tenant_queue_pages_and_cursor_scope(self):
        self.store.save("second.md", "A uses B.\n", expected_revision=None)
        self.ontology.generate("second.md", self.store.read("second.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        for fields in ({"documents": ["example.md", "second.md"]}, {"coverage": "tenant"}):
            with self.subTest(fields=fields):
                first = self.equal("ontology_review_queue", **fields, limit=1)
                self.assertFalse(first["complete"])
                self.assertTrue(first["scope_complete"])
                self.assertIsNotNone(first["next_cursor"])
                second = self.equal("ontology_review_queue", **fields, limit=1, cursor=first["next_cursor"])
                self.assertTrue(second["complete"])
                self.assertNotEqual(first["items"][0]["key"], second["items"][0]["key"])
                changed = self.call("ontology_review_queue", **fields, states=["pending"], cursor=first["next_cursor"])
                self.assertEqual(changed["error"]["code"], "invalid_cursor")
        stranger = self.signup("다른 사용자")
        result = self.mcp("ontology_review_queue", {"tenant": self.tenant, "coverage": "tenant", "cursor": first["next_cursor"]}, stranger["token"])
        self.assertEqual(result["error"]["code"], "invalid_cursor")
        current = self.store.read("example.md")
        self.store.save("example.md", current.content + "Changed.\n", expected_revision=current.revision)
        self.assertEqual(self.call("ontology_review_queue", coverage="tenant", cursor=first["next_cursor"])["error"]["code"], "catalog_changed")

    def test_history_pages_and_partial_queue_are_equal_without_writes(self):
        current = self.store.read("example.md")
        self.store.save("example.md", current.content + "Second revision.\n", expected_revision=current.revision)
        current = self.store.read("example.md")
        self.store.save("example.md", current.content + "Third revision.\n", expected_revision=current.revision)
        with patch.object(WikiStore, "save", side_effect=AssertionError("read must not save")), \
                patch.object(ReviewStore, "_commit_locked", side_effect=AssertionError("read must not approve")):
            for fields in ({"documents": ["example.md"]}, {"coverage": "tenant"}):
                first = self.equal("wiki_history_query", **fields, limit=1)
                self.assertIsNotNone(first["next_cursor"])
                second = self.equal("wiki_history_query", **fields, limit=1, cursor=first["next_cursor"])
                self.assertNotEqual(first["items"], second["items"])
            partial = self.equal("ontology_review_queue", documents=["example.md", "missing.md"])
        self.assertFalse(partial["scope_complete"])
        self.assertEqual(partial["skipped"][0]["reference"], "missing.md")

    def test_history_discovers_only_owned_jobs_and_preserves_scan_limits(self):
        stranger = self.signup("다른 작업 소유자")
        jobs = []
        for token in (self.token, stranger["token"]):
            registered = self.client.post(self.prefix + "/sources", headers=self.headers(token), json={
                "request_id": uuid4().hex, "title": "Owned source", "format": "txt", "content": "A uses B.\n"})
            self.assertEqual(registered.status_code, 201, registered.text)
            source = registered.json()["data"]
            job = self.mcp("analysis_registration_create", {"tenant": self.tenant, "request_id": uuid4().hex,
                "source_ref": {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")},
                "document": uuid4().hex + ".md", "title": "Owned document"}, token)
            self.assertTrue(job["ok"], job)
            jobs.append(job["job_id"])
        history = self.equal("wiki_history_query", coverage="tenant")
        self.assertEqual({item["ref"]["job_id"] for item in history["items"] if item["kind"] == "job_event"}, {jobs[0]})
        absent = self.equal("wiki_history_query", documents=["example.md"], job_ids=[jobs[1]])
        self.assertFalse(absent["complete"])
        self.assertEqual(absent["items"], [])
        self.assertEqual(absent["skipped"][0]["reference"], jobs[1])
        with patch("core.modules.knowledge.aggregation.MAX_AGGREGATE_BYTES", 1):
            limited = self.equal("knowledge_context_prepare", documents=["example.md"])
        self.assertFalse(limited["can_prepare"])
        self.assertTrue(limited["truncated"])
        self.assertEqual(limited["skipped"][0]["code"], "capture_limit")

    def test_strict_json_and_opaque_cursor_never_coerce(self):
        bad_by_name = {
            "knowledge_context_prepare": [{"documents": '["example.md"]'}, {"claims": "[]"},
                {"claims": [json.dumps({"document": "example.md"})]}, {"source_refs": "[]"},
                {"source_refs": [{"source_id": 123}]}, {"required_documents": [False]}, {"actor": {}}],
            "ontology_review_queue": [{"limit": True}, {"limit": "20"}, {"documents": "[]"},
                {"states": '["pending"]'}, {"states": [1]}, {"cursor": None}],
            "wiki_history_query": [{"limit": False}, {"limit": "20"}, {"job_ids": "[]"},
                {"correspondence_ids": {}}, {"cursor": None}],
        }
        for name, values in bad_by_name.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    result = self.call(name, **{"documents": ["example.md"], **value})
                    self.assertEqual(result["error"]["code"], "invalid_argument")
        for name in ("ontology_review_queue", "wiki_history_query"):
            for cursor in ("null", "[]", "{}"):
                self.assertEqual(self.call(name, documents=["example.md"], cursor=cursor)["error"]["code"], "invalid_cursor")
            self.assertEqual(self.call(name, documents=["example.md"], cursor="")["items"],
                             self.call(name, documents=["example.md"])["items"])
            self.assertEqual(self.call(name, coverage="tenant", documents=["example.md"])["error"]["code"], "invalid_argument")

    def test_read_rights_and_profile_are_authorized_before_selection(self):
        for name in self.routes:
            self.assertEqual(self.call(name, documents=["example.md"], profile="forbidden")["error"]["code"], "access_denied")
            self.assertEqual(self.mcp(name, {"tenant": "forbidden", "documents": ["example.md"]})["error"]["code"], "access_denied")
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        for name in self.routes:
            self.assertEqual(self.call(name, documents=["example.md"])["error"]["code"], "access_denied")


if __name__ == "__main__":
    import unittest
    unittest.main()
