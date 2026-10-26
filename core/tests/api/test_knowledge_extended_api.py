"""기존 조회 서비스를 실제 HTTP로 연결한 핵심 정상·인가·입력 경계만 확인한다."""

import unittest
from unittest.mock import patch

from core.modules.ontology.store import OntologyStore
from core.tests.api import test_read_api as fixture


class ExtendedKnowledgeApiTests(unittest.IsolatedAsyncioTestCase):
    # 준비 함수만 재사용한다. 기존 검사 클래스를 상속해 같은 검사를 반복하지 않는다.
    setUp = fixture.ReadApiTests.setUp
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing
    data = fixture.ReadApiTests.data
    seed = fixture.ReadApiTests.seed
    snapshot = fixture.ReadApiTests.snapshot

    async def test_seven_read_routes_preserve_source_graph_scope_and_policy_layers(self):
        """검색부터 개념·영향까지 실제 서비스 결과의 중요한 출처와 범위를 보존한다."""
        source, saved = self.seed()
        self.stores["alpha"].save("Definitions.md", "필수 정의와 예외\r\n", expected_revision=None)
        before = self.snapshot()
        base = "/api/v1/tenants/alpha"
        async with self.client() as http:
            found = self.data(await http.get(base + "/documents/search", params={"query": "Guide", "limit": "2"}))
            self.assertEqual(found["matches"][0]["revision"], saved.revision)
            graph = self.data(await http.get(base + "/documents/ontology", params={"document": "Guide.md", "profile": "business"}))
            self.assertEqual(graph["layer"], "machine")
            self.assertEqual(graph["access"]["profile_id"], "business")
            context = self.data(await http.post(base + "/knowledge/context/query", json={"documents": ["Guide.md", "Definitions.md"]}))
            self.assertEqual(context["documents"][0]["source"]["content"], source)
            self.assertEqual(len(context["documents"]), 2)
            connections = self.data(await http.get(base + "/documents/connections", params={"document": "Guide.md"}))
            self.assertIn("candidates", connections)
            match = self.data(await http.post(base + "/concepts/find", json={"text": graph["entities"][0]["label"], "documents": ["Guide.md"]}))
            self.assertTrue(match["matches"])
            target = match["matches"][0]["target_ref"]
            detail = self.data(await http.post(base + "/concepts/query", json={"target": target, "documents": ["Guide.md"]}))
            self.assertIn("resource_manifest", detail)
            impact = self.data(await http.post(base + "/documents/impact/query", json={"document": "Guide.md"}))
            self.assertIn("complete", impact)
            self.assertEqual(impact["access"]["tenant"], "alpha")
        self.assertEqual(self.snapshot(), before)

    async def test_denied_tenant_profile_and_unknown_fields_do_not_reach_storage(self):
        """인증 범위를 먼저 검사하고, 쓰기·배열 위치 같은 임의 입력을 받지 않는다."""
        self.seed()
        self.config["users"]["alice"]["memberships"]["alpha"]["profiles"] = ["all"]
        self.save_policy()
        base = "/api/v1/tenants/alpha"
        async with self.client() as http:
            with patch.object(OntologyStore, "query", side_effect=AssertionError("denied storage")):
                self.data(await http.get(base + "/documents/ontology", params={"document": "Guide.md", "profile": "business"}), 403)
                self.data(await http.get("/api/v1/tenants/beta/documents/ontology", params={"document": "Guide.md"}), 403)
            self.data(await http.post(base + "/knowledge/context/query", json={"documents": ["Guide.md"], "profile": "business"}), 403)
            self.data(await http.post(base + "/knowledge/context/query", json={"documents": ["Guide.md"], "actor": {"user_id": "bob"}}), 422)
            self.data(await http.post(base + "/knowledge/context/query?profile=business", json={"documents": ["Guide.md"]}), 422)
            self.data(await http.get(base + "/documents/search", params={"query": "Guide", "limit": "1.5"}), 422)

