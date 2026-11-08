"""선택한 개체의 용어 카드를 실제 HTTP/MCP 권한·판본 경계에서 비교한다."""

import asyncio
from copy import deepcopy
from unittest.mock import patch

from core.mcp.server import create_server
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class GlossaryTransportTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.write("A uses B.\n")
        self.store = self.policy.authorize(self.token, self.tenant, "read").store
        OntologyStore(self.store).generate(
            "example.md", self.store.read("example.md").revision,
            deepcopy(ENTITIES), deepcopy(RELATIONS))
        found = self.mcp("ontology_concept_find", {
            "tenant": self.tenant, "text": "A", "documents": ["example.md"]})
        self.assertTrue(found["ok"], found)
        target = next(item["target_ref"] for item in found["matches"]
                      if item["selectable_as_current"] and item["target_ref"]["kind"] == "entity")
        self.selection = {"document": target["document"], "entity_id": target["entity_id"],
                          "expected_state_revision": target["state_revision"]}
        self.url = f"/api/v1/tenants/{self.tenant}/ontology/glossary"

    def card(self, **overrides):
        return self.mcp("ontology_glossary_query", {"tenant": self.tenant, **self.selection, **overrides})

    def post(self, **overrides):
        return self.client.post(self.url, headers=self.headers(), json={**self.selection, **overrides})

    def tree(self):
        return {path: path.read_bytes() for path in self.store.data_dir.rglob("*")
                if path.is_file() and "_index" not in path.parts}

    def test_find_then_card_matches_http_and_preserves_all_stored_data(self):
        before = self.tree()
        with patch.object(WikiStore, "save", side_effect=AssertionError("term read must not save")), \
                patch.object(ReviewStore, "_commit_locked", side_effect=AssertionError("term read must not review")):
            response = self.post()
            self.assertEqual(response.status_code, 200, response.text)
            card = self.card()
        self.assertTrue(card["ok"], card)
        self.assertEqual(response.json()["data"], {key: value for key, value in card.items() if key != "ok"})
        self.assertEqual(card["entity"]["id"], "a")
        self.assertIn("A uses B.", card["source_passage"]["quote"])
        self.assertEqual(card["source_passage_status"], "available")
        self.assertEqual(card["totals"]["relations"], 1)
        self.assertEqual(card["relations"][0]["decision"], "unreviewed")
        self.assertEqual(card["access"]["user_id"], self.user["user_id"])
        self.assertTrue(card["coverage"]["complete"])
        for field in ("source", "content", "history", "effective_graph", "machine_graph"):
            self.assertNotIn(field, card)
        self.assertNotIn(self.token, response.text)
        self.assertEqual(before, self.tree())

    def test_changed_source_requires_new_selection_in_both_transports(self):
        current = self.store.read("example.md")
        self.store.save("example.md", current.content + "Changed.\n", expected_revision=current.revision)
        response = self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "catalog_changed")
        self.assertEqual(self.card()["error"]["code"], "catalog_changed")

    def test_missing_document_and_entity_do_not_fall_back_to_name_search(self):
        for fields, status, code in (({"document": "missing.md"}, 404, "not_found"),
                                    ({"entity_id": "missing"}, 422, "invalid_argument")):
            with self.subTest(fields=fields):
                response = self.post(**fields)
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(self.card(**fields)["error"]["code"], code)

    def test_strict_input_rejects_coercion_and_untrusted_scope_fields(self):
        for fields in ({"limit": True}, {"limit": "10"}, {"limit": 0}, {"limit": 21},
                       {"entity_id": False}, {"document": "../outside.md"},
                       {"expected_state_revision": "old"}, {"expected_state_revision": None},
                       {"actor": {"user_id": "forged"}}, {"cursor": ""}):
            with self.subTest(fields=fields):
                response = self.post(**fields)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.card(**fields)["error"]["code"], "invalid_argument")

    def test_read_permissions_and_profile_checked_on_every_request(self):
        self.assertTrue(self.card()["ok"])
        self.assertEqual(self.post(profile="forbidden").status_code, 403)
        self.assertEqual(self.card(profile="forbidden")["error"]["code"], "access_denied")
        self.assertEqual(self.card(tenant="forbidden")["error"]["code"], "access_denied")
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        self.assertEqual(self.post().status_code, 403)
        self.assertEqual(self.card()["error"]["code"], "access_denied")

    def test_tool_is_optional_read_only_and_only_in_authenticated_tenant_server(self):
        response = self.client.post("/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        tool = next(item for item in response.json()["result"]["tools"] if item["name"] == "ontology_glossary_query")
        self.assertTrue(tool["annotations"]["readOnlyHint"])
        self.assertFalse(tool["annotations"]["destructiveHint"])
        self.assertFalse(tool["annotations"]["openWorldHint"])
        schema = tool["inputSchema"]
        self.assertTrue({"tenant", "document", "entity_id", "expected_state_revision"} <= set(schema["required"]))
        self.assertIn("profile", schema["properties"])
        self.assertNotIn("actor", schema["properties"])
        self.assertFalse(schema["additionalProperties"])
        legacy = asyncio.run(create_server(self.store).list_tools())
        self.assertNotIn("ontology_glossary_query", {item.name for item in legacy})
