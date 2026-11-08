"""Identical HTTP/MCP cleanup operations and denied requests on isolated tenants."""
import asyncio
from copy import deepcopy
from threading import Event
from unittest.mock import patch
from uuid import uuid4

from core.tests.poc_mcp.test_server_integration import ServerFixture
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.api.dependencies import access_value
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.cleanup import CleanupStore
from core.modules.access.policy import AccessDenied
from core.api.concurrency import run_owned_thread


class CleanupTransportTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.write("A uses B.\n")
        self.scope = self.policy.authorize(self.token, self.tenant, "ontology_review")
        self.store = self.scope.store
        self.actor = access_value(self.scope)
        self.ontology = OntologyStore(self.store)
        self.reviews = ReviewStore(self.store)
        self.ontology.generate("example.md", self.store.read("example.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.review("reject")
        self.prefix = f"/api/v1/tenants/{self.tenant}/documents"

    def review(self, action):
        snapshot = self.reviews.query("example.md")
        return self.reviews.review("example.md", action=action, claim_id=snapshot["claims"][0]["claim_id"],
            expected_state_revision=snapshot["state_revision"], reason="simulation", actor=self.actor)

    def get(self, path, **params):
        return self.client.get(self.prefix + path, headers=self.headers(), params={"document": "example.md", **params})

    def preview(self, **params):
        response = self.get("/cleanup-preview", **params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    def payload(self, preview=None):
        preview = preview or self.preview()
        return dict(document="example.md", request_id=uuid4().hex, preview_revision=preview["preview_revision"],
                    item_ids=[item["item_id"] for item in preview["items"]], reason="simulation cleanup")

    def call(self, name, **fields):
        return self.mcp(name, {"tenant": self.tenant, "document": "example.md", **fields})

    def test_http_mcp_preview_apply_receipt_history_undo_and_raw_layer_equivalence(self):
        http = self.preview()
        mcp = self.call("ontology_cleanup_preview")
        self.assertEqual(http, {key: value for key, value in mcp.items() if key != "ok"})
        payload = self.payload(http)
        saved = self.client.post(self.prefix + "/cleanup", headers=self.headers(), json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        receipt = saved.json()["data"]
        replay = self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})
        self.assertTrue(replay["ok"], replay)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["event"], receipt["event"])
        actual = self.get("/cleanup-requests/" + payload["request_id"]).json()["data"]
        self.assertEqual(actual, {key: value for key, value in self.call("ontology_cleanup_request", request_id=payload["request_id"]).items() if key != "ok"})
        knowledge = self.get("/knowledge")
        self.assertEqual(knowledge.status_code, 200, knowledge.text)
        self.assertEqual(knowledge.json()["data"]["current_claims"], [])
        self.assertEqual(len(knowledge.json()["data"]["claims"]), 1)
        self.assertEqual(knowledge.json()["data"], {key: value for key, value in self.call("ontology_review_query").items() if key != "ok"})
        self.assertEqual(len(self.call("ontology_query")["relations"]), 1)
        history = self.get("/cleanup-events").json()["data"]
        self.assertEqual(history, {key: value for key, value in self.call("ontology_cleanup_history").items() if key != "ok"})
        undone = self.call("ontology_cleanup_undo", request_id=uuid4().hex, event_id=receipt["event_id"],
            expected_state_revision=receipt["state_revision"], reason="simulation undo")
        self.assertTrue(undone["ok"], undone)
        self.assertEqual(len(self.get("/knowledge").json()["data"]["current_claims"]), 1)
        self.assertEqual(self.preview()["total_items"], 1)

    def test_access_denial_both_transports_and_read_receipt_after_revocation(self):
        payload = self.payload()
        saved = self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})
        self.assertTrue(saved["ok"], saved)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        forbidden = self.client.post(self.prefix + "/cleanup", headers=self.headers(), json=payload)
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})["error"]["code"], "access_denied")
        self.assertTrue(self.call("ontology_cleanup_request", request_id=payload["request_id"])["ok"])
        self.assertEqual(self.get("/cleanup-requests/" + payload["request_id"]).status_code, 200)
        stranger = self.signup("다른 사용자")
        # Signup joins the configured shared PoC workspace; it does not confer another user's receipt.
        own = self.mcp("ontology_cleanup_request", {"tenant": self.tenant, "document": "example.md", "request_id": payload["request_id"]}, stranger["token"])
        self.assertEqual(own["error"]["code"], "not_found")
        denied = self.client.get("/api/v1/tenants/forbidden/documents/cleanup-preview", headers=self.headers(stranger["token"]), params={"document": "example.md"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.mcp("ontology_cleanup_preview", {"tenant": "forbidden", "document": "example.md"}, stranger["token"])["error"]["code"], "access_denied")
        self.assertEqual(self.get("/cleanup-preview", profile="forbidden").status_code, 403)
        self.assertEqual(self.call("ontology_cleanup_preview", profile="forbidden")["error"]["code"], "access_denied")

    def test_permission_checked_again_before_commit_for_both_transports(self):
        original = CleanupStore._snapshot
        def revoke(owner, document):
            result = original(owner, document)
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
            return result
        for transport in ("http", "mcp"):
            with self.subTest(transport=transport):
                self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read", "ontology_review"]))
                payload = self.payload()
                before = self.reviews._path("example.md").read_bytes()
                with patch.object(CleanupStore, "_snapshot", revoke):
                    if transport == "http":
                        self.assertEqual(self.client.post(self.prefix + "/cleanup", headers=self.headers(), json=payload).status_code, 403)
                    else:
                        self.assertEqual(self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})["error"]["code"], "access_denied")
                self.assertEqual(self.reviews._path("example.md").read_bytes(), before)

    def test_stale_preview_pagination_and_strict_json_errors(self):
        preview = self.preview()
        payload = self.payload(preview)
        self.review("defer")
        self.assertEqual(self.client.post(self.prefix + "/cleanup", headers=self.headers(), json=payload).status_code, 409)
        self.assertEqual(self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})["error"]["code"], "conflict")
        self.review("reject")
        current = self.reviews.query("example.md")
        self.ontology.generate("example.md", self.store.read("example.md").revision, deepcopy(ENTITIES), deepcopy(RELATIONS),
            expected_state_revision=current["state_revision"], force_generation=True)
        first = self.preview(limit=1)
        payload = self.payload(first)
        self.assertTrue(self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **payload})["ok"])
        self.assertEqual(self.get("/cleanup-preview", cursor=first["next_cursor"]).status_code, 409)
        self.assertEqual(self.call("ontology_cleanup_preview", cursor=first["next_cursor"])["error"]["code"], "catalog_changed")
        for bad in ({"item_ids": "[]"}, {"item_ids": [True]}, {"request_id": 123}, {"reason": None}, {"actor": self.actor}):
            fields = {**self.payload(), **bad}
            self.assertEqual(self.client.post(self.prefix + "/cleanup", headers=self.headers(), json=fields).status_code, 422)
            self.assertFalse(self.mcp("ontology_cleanup_apply", {"tenant": self.tenant, **fields})["ok"])
        self.assertFalse(self.call("ontology_cleanup_preview", limit=True)["ok"])
        self.assertFalse(self.call("ontology_cleanup_preview", limit="20")["ok"])
        self.assertEqual(self.call("ontology_cleanup_request", request_id=uuid4().hex)["error"]["code"], "not_found")

    def test_cancelled_wait_preserves_owned_commit_and_receipt(self):
        payload = self.payload()
        started, release = Event(), Event()
        cleanup = CleanupStore(self.store, self.actor)
        def mutation():
            def gate():
                started.set()
                if not release.wait(5):
                    raise TimeoutError("test gate")
            return cleanup.apply("example.md", **{key: value for key, value in payload.items() if key != "document"}, before_commit=gate)
        async def cancel():
            task = asyncio.create_task(run_owned_thread(mutation))
            await asyncio.to_thread(started.wait, 5)
            self.assertTrue(started.is_set())
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        asyncio.run(cancel())
        self.assertTrue(self.call("ontology_cleanup_request", request_id=payload["request_id"])["saved"])
        self.assertEqual(len(self.get("/cleanup-events").json()["data"]["items"]), 1)
