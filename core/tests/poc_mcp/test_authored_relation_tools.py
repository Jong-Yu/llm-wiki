"""독립 관계의 실제 HTTP/MCP 동등성·재인가·보존 계약을 격리 자료로 검사한다."""
from copy import deepcopy
import json
from unittest.mock import patch
from uuid import uuid4

from core.common.access import access_dict
from core.modules.documents.store import CleanupFailure
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class AuthoredRelationToolTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.write("A uses B.\nB depends on A.\n")
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.reviews = ReviewStore(self.store)
        self.ontology = OntologyStore(self.store)
        self.ontology.generate("example.md", self.store.read("example.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.prefix = f"/api/v1/tenants/{self.tenant}/documents"

    def payload(self, kind="source"):
        current = self.reviews.query("example.md")
        value = _input(current["machine_graph"]["relations"][0])
        value.update(subject="b", predicate="depends_on", object="a")
        if kind == "source":
            value["evidence"] = "B depends on A."
        else:
            value.pop("evidence")
            value.pop("provenance")
        return dict(document="example.md", kind=kind, replacement=value, request_id=uuid4().hex,
                    expected_state_revision=current["state_revision"], reason="isolated simulation")

    def call(self, name, payload):
        return self.mcp(name, {"tenant": self.tenant, **payload})

    def post(self, suffix, payload):
        return self.client.post(self.prefix + suffix, headers=self.headers(), json=payload)

    def receipt(self, request_id):
        return self.client.get(self.prefix + "/relation-requests/" + request_id,
                               headers=self.headers(), params={"document": "example.md"})

    def permissions(self, values):
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=values))

    def test_http_create_mcp_replay_receipt_undo_preserve_actor_and_journal(self):
        payload = self.payload()
        created = self.post("/relations", payload)
        self.assertEqual(created.status_code, 200, created.text)
        saved = created.json()["data"]
        replay = self.call("ontology_relation_create", payload)
        self.assertTrue(replay["ok"], replay)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["event_id"], saved["event_id"])
        query = self.call("ontology_relation_request", {"document": "example.md", "request_id": payload["request_id"]})
        self.assertEqual(self.receipt(payload["request_id"]).json()["data"], {key: value for key, value in query.items() if key != "ok"})
        knowledge = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "example.md"})
        self.assertEqual(len(knowledge["machine_graph"]["relations"]), 1)
        self.assertEqual(len(knowledge["effective_graph"]["relations"]), 2)
        event = knowledge["relation_history"][0]
        self.assertEqual(event["actor"], access_dict(self.scope))
        undo = dict(document="example.md", kind="source", request_id=uuid4().hex, event_id=saved["event_id"],
                    expected_state_revision=saved["state_revision"], reason="isolated inverse")
        undone = self.call("ontology_relation_undo", undo)
        self.assertTrue(undone["ok"], undone)
        http_replay = self.post("/relation-undos", undo)
        self.assertEqual(http_replay.status_code, 200, http_replay.text)
        self.assertTrue(http_replay.json()["data"]["replayed"])
        self.assertEqual(http_replay.json()["data"]["event_id"], undone["event_id"])
        current = self.reviews.query("example.md")
        self.assertEqual(current["relation_history"][0], event)
        self.assertEqual(len(current["relation_history"]), 2)
        self.assertEqual(current["relation_history"][1]["undo_of"], saved["event_id"])
        self.assertEqual(len(current["effective_graph"]["relations"]), 1)

    def test_kind_permissions_and_read_receipt_after_revocation_owner_isolation(self):
        self.permissions(["read", "ontology_review"])
        self.assertEqual(self.call("ontology_relation_create", self.payload("policy"))["error"]["code"], "access_denied")
        payload = self.payload()
        saved = self.call("ontology_relation_create", payload)
        self.assertTrue(saved["ok"], saved)
        self.permissions(["read"])
        self.assertEqual(self.call("ontology_relation_create", payload)["error"]["code"], "access_denied")
        self.assertEqual(self.post("/relations", payload).status_code, 403)
        query = {"document": "example.md", "request_id": payload["request_id"]}
        self.assertTrue(self.call("ontology_relation_request", query)["ok"])
        self.assertEqual(self.receipt(payload["request_id"]).status_code, 200)
        stranger = self.signup("다른 사용자")
        self.assertEqual(self.mcp("ontology_relation_request", {"tenant": self.tenant, **query}, stranger["token"])["error"]["code"], "not_found")
        self.permissions(["read", "ontology_policy"])
        self.assertEqual(self.call("ontology_relation_create", self.payload())["error"]["code"], "access_denied")
        policy = self.call("ontology_relation_create", self.payload("policy"))
        self.assertTrue(policy["ok"], policy)
        event = self.reviews.query("example.md")["relation_history"][-1]
        self.assertIsNone(event["value"]["evidence"])
        self.assertEqual(event["value"]["provenance"]["kind"], "expert_policy")

    def test_reauthorization_before_commit_blocks_revocation_without_journal(self):
        original = RelationStore._mutate
        def revoke(owner, *args, **kwargs):
            self.permissions(["read"])
            return original(owner, *args, **kwargs)
        for kind in ("source", "policy"):
            self.permissions(["read", "ontology_review", "ontology_policy"])
            with self.subTest(kind=kind), patch.object(RelationStore, "_mutate", revoke):
                result = self.call("ontology_relation_create", self.payload(kind))
                self.assertEqual(result["error"]["code"], "access_denied")
            self.assertFalse(self.reviews._path("example.md").exists())

    def test_changed_scope_before_commit_is_denied_even_when_permission_remains(self):
        original = RelationStore._mutate
        def change_scope(owner, *args, **kwargs):
            self.change_policy(lambda value: value["tenants"][self.tenant]["profiles"][self.scope.profile_id].update(domain="changed"))
            return original(owner, *args, **kwargs)
        with patch.object(RelationStore, "_mutate", change_scope):
            result = self.call("ontology_relation_create", self.payload())
        self.assertEqual(result["error"]["code"], "access_denied")
        self.assertFalse(self.reviews._path("example.md").exists())

    def test_receipt_in_another_authorized_profile_is_not_found(self):
        def add_profile(value):
            value["tenants"][self.tenant]["profiles"]["business"] = {"domain": "testing", "viewpoint": "business"}
            value["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("business")
        self.change_policy(add_profile)
        payload = self.payload()
        self.assertTrue(self.call("ontology_relation_create", payload)["ok"])
        result = self.call("ontology_relation_request", {"document": "example.md", "request_id": payload["request_id"], "profile": "business"})
        self.assertEqual(result["error"]["code"], "not_found")

    def test_success_with_cleanup_warning_is_returned_without_retry(self):
        original = ReviewStore._commit_locked
        def with_warning(owner, document, ledger, failures):
            value = original(owner, document, ledger, failures)
            failures.append(CleanupFailure(self.store.data_dir / ".wiki-simulated", OSError("simulated warning")))
            return value
        with patch.object(ReviewStore, "_commit_locked", with_warning):
            result = self.call("ontology_relation_create", self.payload())
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["saved"])
        self.assertEqual(len(result["cleanup_failures"]), 1)
        self.assertEqual(len(self.reviews.query("example.md")["relation_history"]), 1)

    def test_cas_same_id_payload_conflict_and_generation_pending(self):
        payload = self.payload()
        saved = self.call("ontology_relation_create", payload)
        self.assertTrue(saved["ok"], saved)
        before = self.reviews._path("example.md").read_bytes()
        changed = self.call("ontology_relation_create", {**payload, "reason": "different"})
        self.assertEqual(changed["error"]["code"], "conflict")
        self.assertEqual(self.call("ontology_relation_create", {**payload, "request_id": uuid4().hex})["error"]["code"], "conflict")
        self.assertEqual(self.reviews._path("example.md").read_bytes(), before)
        current = self.reviews.query("example.md")
        self.ontology.generate("example.md", self.store.read("example.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS),
                               expected_state_revision=current["state_revision"], force_generation=True)
        current = self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "example.md"})
        self.assertEqual(current["authored_relations"][0]["status"], "pending")
        self.assertEqual(len(current["effective_graph"]["relations"]), 1)
        undo = dict(document="example.md", kind="source", event_id=saved["event_id"],
            request_id=uuid4().hex, expected_state_revision=current["state_revision"], reason="old generation")
        result = self.call("ontology_relation_undo", undo)
        http = self.post("/relation-undos", undo)
        self.assertEqual(http.status_code, 422, http.text)
        self.assertEqual(result["error"]["code"], "invalid_argument")
        self.assertEqual(result["error"]["code"], http.json()["error"]["code"])
        self.assertEqual(self.reviews._path("example.md").read_bytes(), before)

    def test_strict_json_unknown_entities_actor_tenant_and_profile_do_not_bypass(self):
        payload = self.payload()
        for change in ({"replacement": json.dumps(payload["replacement"])}, {"replacement": []},
                       {"actor": access_dict(self.scope)}, {"entities": []}, {"request_id": 123},
                       {"expected_state_revision": None}, {"kind": True}, {"reason": None}):
            with self.subTest(change=change):
                invalid = {**payload, **change}
                self.assertEqual(self.post("/relations", invalid).status_code, 422)
                self.assertEqual(self.call("ontology_relation_create", invalid)["error"]["code"], "invalid_argument")
        unknown = {**payload, "replacement": {**payload["replacement"], "object": "new-entity"}}
        result = self.call("ontology_relation_create", unknown)
        http = self.post("/relations", unknown)
        self.assertEqual(http.status_code, 422, http.text)
        self.assertEqual(result["error"]["code"], "invalid_argument")
        self.assertEqual(result["error"]["code"], http.json()["error"]["code"])
        self.assertEqual(self.call("ontology_relation_create", {**payload, "profile": "forbidden"})["error"]["code"], "access_denied")
        self.assertEqual(self.mcp("ontology_relation_create", {"tenant": "forbidden", **payload})["error"]["code"], "access_denied")
        self.assertFalse(self.reviews._path("example.md").exists())
        missing = self.call("ontology_relation_request", {"document": "example.md", "request_id": uuid4().hex})
        self.assertEqual(missing["error"]["code"], "not_found")


if __name__ == "__main__":
    import unittest
    unittest.main()
