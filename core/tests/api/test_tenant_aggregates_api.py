"""공간 전체 조회의 범위·예산·cursor·개인 작업 격리만 실제 API로 확인한다."""

from copy import deepcopy
from hashlib import sha256
import secrets
import unittest
from unittest.mock import patch
from uuid import uuid4
from core.tests.api import test_read_api as fixture
from core.modules.analysis_jobs import records


class TenantAggregateTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.ReadApiTests.save_policy
    client = fixture.ReadApiTests.client
    headers = fixture.ReadApiTests.headers
    nothing = fixture.ReadApiTests.nothing
    data = fixture.ReadApiTests.data
    seed = fixture.ReadApiTests.seed

    def setUp(self):
        """기존 fixture의 준비만 재사용하며 운영 자료와 기존 전체 검사는 실행하지 않는다."""
        fixture.ReadApiTests.setUp(self)
        self.seed()
        for index in range(9):
            self.stores["alpha"].save(f"other-{index}.md", f"미추출 문서 {index}\n", expected_revision=None)
        self.base = "/api/v1/tenants/alpha"

    async def test_tenant_queue_exceeds_selection_scope_and_binds_pages(self):
        """8개 선택 상한을 넘는 자료도 공간 전체로 발견하고 관점/판본 cursor를 검사한다."""
        async with self.client() as http:
            body = {"coverage": "tenant", "states": ["pending"], "limit": 1}
            first = self.data(await http.post(self.base + "/review-queue/query", json=body))
            self.assertEqual(first["scope"]["coverage"], "tenant_visible_resources")
            self.assertEqual(first["scope"]["discovered_counts"]["documents"], 10)
            self.assertEqual(first["total_items"], 9)
            self.assertTrue(first["scope_complete"])
            self.assertFalse(first["complete"])
            self.assertIsNotNone(first["next_cursor"])
            next_body = {**body, "cursor": first["next_cursor"]}
            second = self.data(await http.post(self.base + "/review-queue/query", json=next_body))
            self.assertNotEqual(first["items"][0]["key"], second["items"][0]["key"])
            self.data(await http.post(self.base + "/review-queue/query", json={**next_body, "profile": "business"}), 422)
            self.stores["alpha"].save("later.md", "새 문서\n", expected_revision=None)
            self.data(await http.post(self.base + "/review-queue/query", json=next_body), 409)
            self.data(await http.post(self.base + "/review-queue/query", json={**body, "documents": ["Guide.md"]}), 422)

    async def test_denial_before_discovery_and_limits_remain_incomplete(self):
        """권한 거부는 탐색 전에 끝나며 한도에 걸린 빈 결과를 전체 완료로 표시하지 않는다."""
        from core.modules.knowledge import tenant_aggregation
        async with self.client() as http:
            with patch.object(tenant_aggregation, "_scan", side_effect=AssertionError("denied storage")):
                self.data(await http.post("/api/v1/tenants/beta/review-queue/query", json={"coverage": "tenant"}), 403)
            with patch.object(tenant_aggregation, "MAX_TENANT_RESOURCES", 1):
                partial = self.data(await http.post(self.base + "/review-queue/query", json={"coverage": "tenant"}))
            self.assertFalse(partial["scope_complete"])
            self.assertTrue(partial["truncated"])
            with patch.object(tenant_aggregation, "MAX_AGGREGATE_BYTES", 1):
                empty = self.data(await http.post(self.base + "/review-queue/query", json={"coverage": "tenant"}))
            self.assertEqual(empty["items"], [])
            self.assertFalse(empty["complete"])
            self.assertTrue(empty["skipped"])

    async def test_history_discovers_only_current_owner_jobs(self):
        """같은 공간의 문서 이력은 읽되 다른 사용자의 개인 작업은 먼저 읽지도 않는다."""
        membership = self.config["users"]["alice"]["memberships"]["alpha"]
        membership["permissions"] = ["read", "source_write"]
        self.tokens["carol"] = secrets.token_urlsafe(32)
        self.config["users"]["carol"] = {"token_sha256": sha256(self.tokens["carol"].encode()).hexdigest(),
            "memberships": {"alpha": deepcopy(membership)}}
        self.save_policy()
        async with self.client() as http:
            job_ids = {}
            for user in ("alice", "carol"):
                source = await http.post(self.base + "/sources", headers=self.headers(user), json={"request_id": uuid4().hex,
                    "title": user + " 작업 원본", "format": "txt", "content": "원본\n"})
                self.assertEqual(source.status_code, 201, source.text)
                ref = source.json()["data"]
                created = await http.post(self.base + "/analysis-jobs", headers=self.headers(user), json={"request_id": uuid4().hex,
                    "source_id": ref["source_id"], "source_version": ref["source_version"], "source_sha256": ref["source_sha256"],
                    "expected_registration_revision": ref["registration_revision"], "targets": [user + ".md"], "outputs": ["wiki"]})
                self.assertEqual(created.status_code, 201, created.text)
                job_ids[user] = created.json()["data"]["job_id"]
            original = records.owned_state
            def owned(owner, job_id, tenant, user_id):
                """다른 주체의 index를 탐색하면 결과에서 숨겼더라도 검사 실패로 처리한다."""
                self.assertNotEqual(job_id, job_ids["carol"])
                return original(owner, job_id, tenant, user_id)
            with patch.object(records, "owned_state", owned):
                result = self.data(await http.post(self.base + "/history/query", json={"coverage": "tenant", "limit": 100}))
            self.assertTrue(result["complete"])
            seen = {item["ref"]["job_id"] for item in result["items"] if item["kind"] == "job_event"}
            self.assertEqual(seen, {job_ids["alice"]})
            self.assertEqual(result["scope"]["job_visibility"], "current_user_only")
