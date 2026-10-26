"""명시 범위의 집계·페이지 기준·질문 근거 준비를 임시 자료만으로 확인한다."""

import unittest
from uuid import uuid4

from core.modules.reviews.store import ReviewStore
from core.tests.api import test_read_api as fixture


class AggregateApiTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.ReadApiTests.setUp
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing
    data = fixture.ReadApiTests.data
    seed = fixture.ReadApiTests.seed
    snapshot = fixture.ReadApiTests.snapshot

    async def test_review_pages_bind_scope_and_snapshot_and_history_keeps_full_version_refs(self):
        """문서 변경 뒤 예전 cursor를 거부하고 과거 이력의 미기록 작성자를 발명하지 않는다."""
        source, saved = self.seed()
        base = "/api/v1/tenants/alpha"
        body = {"documents": ["Guide.md"], "limit": 1}
        async with self.client() as http:
            page = self.data(await http.post(base + "/review-queue/query", json=body))
            self.assertEqual(page["scope"]["coverage"], "explicit_selection_only")
            self.assertTrue(page["items"])
            self.assertIsNotNone(page["next_cursor"])
            next_body = {**body, "cursor": page["next_cursor"]}
            second = self.data(await http.post(base + "/review-queue/query", json=next_body))
            self.assertNotEqual(page["items"][0]["key"], second["items"][0]["key"])
            self.data(await http.post(base + "/review-queue/query", json={**next_body, "profile": "business"}), 422)
            self.stores["alpha"].save("Guide.md", source + "새 조건\n", expected_revision=saved.revision)
            self.data(await http.post(base + "/review-queue/query", json=next_body), 409)
            history = self.data(await http.post(base + "/history/query", json={"documents": ["Guide.md"]}))
            versions = [item["version"] for item in history["items"] if item["kind"] == "document_version"]
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0]["revision"], saved.revision)
            self.assertIsNone(versions[0]["author"])
            self.assertIsNone(versions[0]["reason"])

    async def test_question_context_preserves_claim_basis_missing_required_and_does_not_write(self):
        """선택한 주장의 판본과 필수 누락을 명시하며 질문 준비가 AI·저장을 실행하지 않는다."""
        source, saved = self.seed()
        store = self.stores["alpha"]
        knowledge = ReviewStore(store).query("Guide.md")
        claim = {"document": "Guide.md", "claim_id": knowledge["claims"][0]["claim_id"],
                 "state_revision": knowledge["state_revision"]}
        before = self.snapshot()
        url = "/api/v1/tenants/alpha/question-context/prepare"
        async with self.client() as http:
            value = self.data(await http.post(url, json={"documents": ["Guide.md"], "claims": [claim]}))
            self.assertTrue(value["can_prepare"])
            self.assertEqual(value["documents"][0]["content"], source)
            self.assertEqual(value["documents"][0]["source_revision"], saved.revision)
            self.assertEqual(value["selected_claims"][0]["status"], "current")
            self.assertFalse(value["ai_executed"])
            self.assertFalse(value["persisted"])
            missing = self.data(await http.post(url, json={"documents": ["Guide.md"], "required_documents": ["Missing.md"]}))
            self.assertFalse(missing["can_prepare"])
            self.assertFalse(missing["complete"])
            self.assertEqual(missing["skipped"][0]["reference"], "Missing.md")
            stale = self.data(await http.post(url, json={"documents": ["Guide.md"], "claims": [{**claim, "state_revision": "0" * 64}]}))
            self.assertFalse(stale["can_prepare"])
            self.assertIsNone(stale["selected_claims"][0]["claim"])
        self.assertEqual(self.snapshot(), before)

    async def test_question_original_keeps_exact_version_hash_and_reports_changed_selection(self):
        """고정 원본의 개행·공백을 유지하고 다른 hash를 최신 판본으로 바꾸지 않는다."""
        self.seed()
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "source_write"]
        self.save_policy()
        base = "/api/v1/tenants/alpha"
        content = "참조 원본\r\n  🌱\t\n"
        async with self.client() as http:
            response = await http.post(base + "/sources", json={"request_id": uuid4().hex,
                "title": "질문 원본", "format": "txt", "content": content})
            self.assertEqual(response.status_code, 201, response.text)
            created = response.json()["data"]
            reference = {name: created[name] for name in ("source_id", "source_version", "source_sha256")}
            before = self.snapshot()
            body = {"documents": ["Guide.md"], "source_refs": [reference]}
            value = self.data(await http.post(base + "/question-context/prepare", json=body))
            self.assertTrue(value["can_prepare"])
            self.assertEqual(value["originals"][0]["content"], content)
            self.assertEqual(value["originals"][0]["source_ref"], reference)
            original_only = self.data(await http.post(base + "/question-context/prepare", json={"source_refs": [reference]}))
            self.assertTrue(original_only["can_prepare"])
            self.assertEqual(original_only["documents"], [])
            self.assertEqual(original_only["originals"][0]["content"], content)
            self.data(await http.post(base + "/question-context/prepare", json={}), 422)
            changed = self.data(await http.post(base + "/question-context/prepare", json={**body,
                "source_refs": [{**reference, "source_sha256": "0" * 64}]}))
            self.assertFalse(changed["can_prepare"])
            self.assertEqual(changed["originals"], [])
            self.assertEqual(changed["skipped"][0]["code"], "selection_changed")
            self.assertEqual(self.snapshot(), before)

