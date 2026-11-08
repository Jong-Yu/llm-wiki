"""격리 HTTP에서 선택 용어 카드의 권한·엄격한 계약·판본 고정을 검증한다."""

from copy import deepcopy
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class GlossaryHTTPTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.store = self.policy.authorize(self.token, self.tenant, "read").store
        saved = self.store.save("example.md", "A uses B.\n", expected_revision=None)
        OntologyStore(self.store).generate("example.md", saved.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.url = f"/api/v1/tenants/{self.tenant}/ontology/glossary"
        self.body = {"document": "example.md", "entity_id": "a",
                     "expected_state_revision": ReviewStore(self.store).query("example.md")["state_revision"]}

    def test_current_card_contract_then_changed_state_conflict(self):
        response = self.client.post(self.url, headers=self.headers(), json=self.body)
        self.assertEqual(response.status_code, 200, response.text)
        card = response.json()["data"]
        self.assertEqual(card["access"]["user_id"], self.user["user_id"])
        self.assertEqual(card["source_passage"]["quote"], "A uses B.")
        self.assertEqual(card["entity"]["id"], "a")
        self.assertEqual(card["relations"][0]["decision"], "unreviewed")
        self.assertFalse({"source", "history", "machine_graph", "effective_graph"} & card.keys())
        self.assertNotIn(self.token, response.text)
        source = self.store.read("example.md")
        self.store.save("example.md", source.content + "Changed.\n", expected_revision=source.revision)
        response = self.client.post(self.url, headers=self.headers(), json=self.body)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "catalog_changed")

    def test_strict_json_and_current_authorized_scope(self):
        for changed in ({"limit": True}, {"limit": 21}, {"entity_id": True},
                        {"entity_id": {"kind": "source_anchor"}}, {"document": "../example.md"},
                        {"expected_state_revision": "old"}, {"actor": {"user_id": "forged"}},
                        {"profile": "missing-profile"}):
            response = self.client.post(self.url, headers=self.headers(), json={**self.body, **changed})
            self.assertIn(response.status_code, (403, 422), response.text)
        raw_bool = '{"document":"example.md","entity_id":"a","expected_state_revision":"' + self.body["expected_state_revision"] + '","limit":true}'
        response = self.client.post(self.url, headers={**self.headers(), "Content-Type": "application/json"}, content=raw_bool)
        self.assertEqual(response.status_code, 422, response.text)
        response = self.client.post(self.url + "?profile=all", headers=self.headers(), json=self.body)
        self.assertEqual(response.status_code, 422, response.text)
        other_tenant_url = "/api/v1/tenants/unavailable-space/ontology/glossary"
        response = self.client.post(other_tenant_url, headers=self.headers(), json=self.body)
        self.assertEqual(response.status_code, 403, response.text)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        response = self.client.post(self.url, headers=self.headers(), json=self.body)
        self.assertEqual(response.status_code, 403, response.text)
