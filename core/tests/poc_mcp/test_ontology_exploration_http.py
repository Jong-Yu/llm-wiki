"""격리된 실제 HTTP에서 지도 페이지·접근 범위·판본 고정을 확인한다."""

from copy import deepcopy
from unittest.mock import patch
from core.common.json_codec import canonical_json_hash
from core.api.v1.knowledge.exploration_schemas import OntologyNeighborPage
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class OntologyExplorationHTTP(ServerFixture):
    def setUp(self):
        super().setUp()
        self.store = self.policy.authorize(self.token, self.tenant, "read").store
        self.prefix = f"/api/v1/tenants/{self.tenant}/ontology"
        self.ontology = OntologyStore(self.store)
        for document in ("first.md", "second.md"):
            saved = self.store.save(document, "A uses B.\n", expected_revision=None)
            self.ontology.generate(document, saved.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))

    def post(self, endpoint, body, token=None):
        return self.client.post(self.prefix + endpoint, headers=self.headers(token), json=body)

    def test_search_recent_paging_identity_and_lightweight_neighbors(self):
        first = self.post("/search", {"text": "", "kind": "concept", "limit": 1})
        self.assertEqual(first.status_code, 200, first.text)
        page = first.json()["data"]
        self.assertEqual(page["total"], 4)
        self.assertTrue(page["coverage"]["complete"])
        self.assertIsNotNone(page["next_cursor"])
        concept = page["items"][0]["concept"]
        second = self.post("/search", {"kind": "concept", "limit": 1, "cursor": page["next_cursor"]})
        self.assertEqual(second.status_code, 200, second.text)
        following = second.json()["data"]["items"][0]["concept"]
        self.assertNotEqual((concept["document"], concept["entity_id"]), (following["document"], following["entity_id"]))
        response = self.post("/neighbors", {
            "document": concept["document"], "entity_id": concept["entity_id"],
            "expected_state_revision": concept["ref"]["state_revision"], "limit": 1})
        self.assertEqual(response.status_code, 200, response.text)
        neighbors = response.json()["data"]
        self.assertEqual(neighbors["total"], 1)
        self.assertEqual(len(neighbors["edges"]), 1)
        self.assertEqual(neighbors["edges"][0]["subject"]["document"], concept["document"])
        self.assertNotIn("evidence", neighbors["edges"][0])
        self.assertNotIn("effective_graph", neighbors)
        self.assertEqual(neighbors["anchors"], [])
        self.assertEqual(neighbors["access"]["user_id"], self.user["user_id"])
        self.assertNotIn(self.token, response.text)

    def test_source_anchor_relation_is_readable_as_a_lightweight_distinct_endpoint(self):
        quote = 'Record metadata identifier is B07.'
        saved = self.store.save("record.md", quote + "\n", expected_revision=None)
        anchor = dict(kind="source_anchor", document="record.md", source_revision=saved.revision,
                      quote=quote, start_line=1, end_line=1, occurrence=0)
        self.ontology.generate("record.md", saved.revision,
            [dict(id="record", label="Record", type="document", evidence=quote)],
            [dict(subject="record", predicate="has_source_metadata", object=anchor, evidence=quote)], schema_version=6)
        before = {path: path.read_bytes() for path in self.store.data_dir.rglob("*")
                  if path.is_file() and "_index" not in path.parts}
        response = self.post("/search", {"kind": "concept", "document": "record.md"})
        self.assertEqual(response.status_code, 200, response.text)
        page = response.json()["data"]
        self.assertEqual(page["total"], 1)
        concept = page["items"][0]
        self.assertEqual(concept["relation_count"], 1)
        self.assertTrue(page["coverage"]["complete"])
        payload = dict(document="record.md", entity_id="record",
                       expected_state_revision=concept["concept"]["ref"]["state_revision"], limit=1)
        response = self.post("/neighbors", payload)
        self.assertEqual(response.status_code, 200, response.text)
        neighbors = response.json()["data"]
        self.assertEqual((neighbors["total"], len(neighbors["concepts"]), len(neighbors["anchors"])), (1, 1, 1))
        self.assertEqual(neighbors["edges"][0]["object"],
                         dict(document="record.md", anchor_id=canonical_json_hash(anchor)))
        self.assertEqual(neighbors["anchors"][0], dict(document="record.md", anchor_id=canonical_json_hash(anchor),
            source_revision=saved.revision, start_line=1, end_line=1, occurrence=0, ref=neighbors["document"]))
        self.assertNotIn(quote, response.text)
        self.assertNotIn('"quote"', response.text)
        self.assertNotIn('"evidence"', response.text)
        malformed = []
        for field, value in (("quote", quote), ("document", "second.md"),
                             ("source_revision", "f" * 64), ("start_line", 2)):
            invalid = deepcopy(neighbors)
            invalid["anchors"][0][field] = value
            malformed.append(invalid)
        invalid = deepcopy(neighbors)
        invalid["edges"][0]["object"]["entity_id"] = "record"
        malformed.append(invalid)
        invalid = deepcopy(neighbors)
        invalid["anchors"] = []
        malformed.append(invalid)
        for invalid in malformed:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                OntologyNeighborPage.model_validate(invalid)
        self.assertEqual(before, {path: path.read_bytes() for path in self.store.data_dir.rglob("*")
                         if path.is_file() and "_index" not in path.parts})
        bad_target = self.post("/neighbors", {**payload, "entity_id": canonical_json_hash(anchor)})
        self.assertEqual(bad_target.status_code, 422, bad_target.text)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        denied = self.post("/neighbors", payload)
        self.assertEqual(denied.status_code, 403, denied.text)

    def test_cursor_actor_query_and_changed_revision_boundaries(self):
        page = self.post("/search", {"kind": "concept", "limit": 1}).json()["data"]
        cursor = page["next_cursor"]
        wrong_query = self.post("/search", {"kind": "document", "cursor": cursor})
        self.assertEqual(wrong_query.status_code, 422, wrong_query.text)
        self.assertEqual(wrong_query.json()["error"]["code"], "invalid_cursor")
        other = self.signup("다른 지도 사용자")
        wrong_actor = self.post("/search", {"kind": "concept", "limit": 1, "cursor": cursor}, other["token"])
        self.assertEqual(wrong_actor.status_code, 422, wrong_actor.text)
        self.assertEqual(wrong_actor.json()["error"]["code"], "invalid_cursor")
        selected = page["items"][0]["concept"]
        before = self.store.read(selected["document"])
        self.store.save(selected["document"], before.content + "Changed.\n", expected_revision=before.revision)
        changed_cursor = self.post("/search", {"kind": "concept", "limit": 1, "cursor": cursor})
        self.assertEqual(changed_cursor.status_code, 409, changed_cursor.text)
        self.assertEqual(changed_cursor.json()["error"]["code"], "catalog_changed")
        stale = self.post("/neighbors", {
            "document": selected["document"], "entity_id": selected["entity_id"],
            "expected_state_revision": selected["ref"]["state_revision"]})
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["error"]["code"], "catalog_changed")

    def test_strict_inputs_read_only_and_current_authorization(self):
        for endpoint, payload in (
            ("/search", {"text": "A", "actor": {"user_id": "forged"}}),
            ("/search", {"limit": True}), ("/search", {"limit": 51}),
            ("/search", {"kind": "unknown"}),
            ("/neighbors", {"document": "first.md", "entity_id": "a"}),
            ("/neighbors", {"document": "first.md", "entity_id": "a", "expected_state_revision": "old"}),
        ):
            with self.subTest(endpoint=endpoint, payload=payload):
                self.assertEqual(self.post(endpoint, payload).status_code, 422)
        before = {path: path.read_bytes() for path in self.store.data_dir.rglob("*")
                  if path.is_file() and "_index" not in path.parts}
        with patch.object(WikiStore, "save", side_effect=AssertionError("map read must not save")):
            self.assertEqual(self.post("/search", {"kind": "document"}).status_code, 200)
        after = {path: path.read_bytes() for path in self.store.data_dir.rglob("*")
                 if path.is_file() and "_index" not in path.parts}
        self.assertEqual(before, after)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        denied = self.post("/search", {})
        self.assertEqual(denied.status_code, 403, denied.text)
