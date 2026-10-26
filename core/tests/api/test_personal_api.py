"""개인 기록·고정 근거·별도 권한·CAS와 전체 OpenAPI 연결의 핵심만 검사한다."""

from copy import deepcopy
from hashlib import sha256
import json
import secrets
import unittest
from unittest.mock import patch
from uuid import uuid4
from core.tests.api import test_read_api as fixture
from core.modules.reviews.store import ReviewStore


class PersonalApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing
    seed = fixture.ReadApiTests.seed

    def setUp(self):
        """실제 자료 대신 기존 격리 fixture와 명시적인 새 권한만 사용한다."""
        fixture.ReadApiTests.setUp(self)
        membership = self.config["users"]["alice"]["memberships"]["alpha"]
        membership["permissions"] = ["read", "write", "ontology_review", "conversation_write", "result_write", "comparison_write"]
        self.tokens["carol"] = secrets.token_urlsafe(32)
        self.config["users"]["carol"] = {"token_sha256": sha256(self.tokens["carol"].encode()).hexdigest(),
            "memberships": {"alpha": deepcopy(membership)}}
        self.save_policy()
        self.base = "/api/v1/tenants/alpha"
        self.source, _ = self.seed()

    def value(self, response, status=200):
        """반환 상태와 경로·토큰 비노출을 함께 확인한다."""
        self.assertEqual(response.status_code, status, response.text[:600])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(str(self.root), response.text)
        for token in self.tokens.values():
            self.assertNotIn(token, response.text)
        return response.json()["data" if status < 400 else "error"]

    def context(self):
        """선택 문서와 관점을 실제 질문 준비 API와 같은 입력으로 지정한다."""
        return {"documents": ["Guide.md"], "profile": "business"}

    async def test_turns_preserve_original_basis_replay_and_saved_answer(self):
        async with self.client() as http:
            creation = {"request_id": uuid4().hex, "title": "개인 질문", "profile": "business"}
            made = self.value(await http.post(self.base + "/conversations", json=creation), 201)
            record_id = made["record"]["id"]
            receipt = self.value(await http.get(self.base + "/personal-requests/conversations/" + creation["request_id"]))
            self.assertTrue(receipt["request_confirmed"])
            question = {"request_id": uuid4().hex, "expected_revision": made["revision"], "role": "user",
                "content": "이 문서의 조건은?", "profile": "business", "context_request": self.context()}
            asked = self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json=question))
            old = self.stores["alpha"].read("Guide.md")
            self.stores["alpha"].save("Guide.md", self.source + "\n새 판본", expected_revision=old.revision)
            answer = {"request_id": uuid4().hex, "expected_revision": asked["revision"], "role": "assistant",
                "content": "클라이언트가 작성한 답변", "reply_to": question["request_id"], "profile": "business"}
            answered = self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json=answer))
            self.assertEqual(answered["record"]["events"][1]["basis"]["documents"][0]["content"], self.source)
            self.assertEqual(answered["record"]["events"][1]["origin"], "client_reported")
            repeated = self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json=question))
            self.assertTrue(repeated["replayed"])
            self.assertEqual(len(repeated["record"]["events"]), 2)
            saved = self.value(await http.post(self.base + "/saved-results", json={"request_id": uuid4().hex,
                "title": "보관한 답변", "conversation_id": record_id, "turn_id": answer["request_id"]}), 201)
            self.assertEqual(saved["record"]["data"]["basis"]["documents"][0]["content"], self.source)
            self.assertFalse(saved["record"]["data"]["human_approval"])
            read = self.value(await http.get(self.base + "/saved-results/" + saved["record"]["id"]))
            self.assertEqual(read["record"], saved["record"])

    async def test_ownership_permissions_conflict_and_snapshot_paging(self):
        async with self.client() as http:
            body = {"request_id": uuid4().hex, "title": "소유권 검사"}
            made = self.value(await http.post(self.base + "/conversations", json=body), 201)
            record_id = made["record"]["id"]
            self.value(await http.get(self.base + "/conversations/" + record_id, headers=self.headers("carol")), 404)
            self.value(await http.get(self.base + "/conversations/" + record_id, headers=self.headers("bob")), 403)
            self.value(await http.post(self.base + "/conversations", json={**body, "title": "다른 입력"}), 409)
            self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json={"request_id": uuid4().hex,
                "expected_revision": "0" * 64, "role": "user", "content": "질문", "profile": "business", "context_request": self.context()}), 409)
            self.value(await http.post(self.base + "/conversations", json={**body, "actor": {"user_id": "carol"}}), 422)
            self.value(await http.post(self.base + "/conversations", content='{"request_id":"a","request_id":"b"}',
                headers={"Content-Type": "application/json"}), 422)
            page = self.value(await http.get(self.base + "/conversations", params={"limit": 1}))
            self.assertEqual(len(page["items"]), 1)
            for title in ("다음 기록", "다른 기록"):
                self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": title}), 201)
            page = self.value(await http.get(self.base + "/conversations", params={"limit": 1}))
            self.assertIsNotNone(page["next_cursor"])
            self.value(await http.get(self.base + "/conversations", params={"limit": 1, "profile": "business", "cursor": page["next_cursor"]}), 422)
            membership = self.config["users"]["alice"]["memberships"]["alpha"]
            membership["permissions"] = ["read", "write"]
            self.save_policy()
            self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": "권한 없음"}), 403)
            self.value(await http.get(self.base + "/conversations/" + record_id))

    async def test_comparison_completion_requires_real_current_review(self):
        async with self.client() as http:
            saved = self.value(await http.post(self.base + "/saved-results", json={"request_id": uuid4().hex,
                "title": "이전 근거", "content": "비교 기준", "profile": "business", "context_request": self.context()}), 201)
            query = ReviewStore(self.stores["alpha"]).query("Guide.md", viewpoint="business")
            claim = next(item for item in query["claims"] if item["collection"] == "relations")
            comparison = self.value(await http.post(self.base + "/comparisons", json={"request_id": uuid4().hex,
                "title": "명시 비교", "profile": "business", "baseline_result_id": saved["record"]["id"],
                "context_request": self.context(), "mappings": [{"document": "Guide.md", "old_claim_id": claim["claim_id"],
                    "new_claim_id": claim["claim_id"], "disposition": "same", "reason": "시험 입력의 명시 대응"}]}), 201)
            complete = {"request_id": uuid4().hex, "expected_revision": comparison["revision"], "profile": "business",
                "outcome": "reviewed", "reason": "명시 범위 확인", "reviewed_claims": [{"document": "Guide.md",
                    "claim_id": claim["claim_id"], "state_revision": query["state_revision"]}]}
            url = self.base + "/comparisons/" + comparison["record"]["id"] + "/completions"
            self.value(await http.post(url, json=complete), 422)
            accepted = self.value(await http.post(self.base + "/documents/reviews", json={"document": "Guide.md",
                "profile": "business", "claim_id": claim["claim_id"], "expected_state_revision": query["state_revision"],
                "action": "accept", "reason": "합성 검사의 명시 검토"}))
            complete["reviewed_claims"][0]["state_revision"] = accepted["state_revision"]
            result = self.value(await http.post(url, json=complete))
            self.assertEqual(result["record"]["events"][0]["verified_reviews"][0]["decision"], "accept")
            repeated = self.value(await http.post(url, json=complete))
            self.assertTrue(repeated["replayed"])
            self.assertEqual(len(repeated["record"]["events"]), 1)

    async def test_schema_refs_request_bound_and_commit_revocation(self):
        async with self.client() as http:
            document = (await http.get("/openapi.json")).json()
            operations = sum(len(set(path) & {"get", "post", "put", "patch", "delete"}) for path in document["paths"].values())
            self.assertGreaterEqual(operations, 61)
            def walk(value):
                """JSON 참조가 실제 OpenAPI 문서 안의 모델로 이어지는지 확인한다."""
                if isinstance(value, dict):
                    if "$ref" in value:
                        ref = value["$ref"]
                        if ref.startswith("#/"):
                            target = document
                            for part in ref[2:].split("/"):
                                target = target[part.replace("~1", "/").replace("~0", "~")]
                    for item in value.values():
                        walk(item)
                elif isinstance(value, list):
                    for item in value:
                        walk(item)
            walk(document)
            from core.api import ingress
            with patch.object(ingress, "bounded_stream", self.small_stream):
                self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": "본문 제한"}), 413)
            original = self.policy.authorize
            calls = 0
            def revoke(token, tenant, permission, profile=None):
                """최초 인가 뒤 저장 전에 권한을 회수해 파일이 생기지 않는지 확인한다."""
                nonlocal calls
                if permission == "conversation_write":
                    calls += 1
                    if calls == 4:
                        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                        self.save_policy()
                return original(token, tenant, permission, profile)
            before = self.snapshot()
            with patch.object(self.policy, "authorize", revoke):
                self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": "회수됨"}), 403)
            self.assertFalse(list((self.stores["alpha"].data_dir / "_personal").glob("**/*.json")))

    snapshot = fixture.ReadApiTests.snapshot

    async def test_record_byte_limit_and_corruption_preserve_all_previous_events(self):
        """전체 snapshot 누적으로 1MiB를 넘으면 이전 질문과 요청 기록을 그대로 둔다."""
        current = self.stores["alpha"].read("Guide.md")
        self.stores["alpha"].save("Guide.md", "a" * 600_000, expected_revision=current.revision)
        async with self.client() as http:
            made = self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": "전체 보존"}), 201)
            record_id = made["record"]["id"]
            question = {"request_id": uuid4().hex, "expected_revision": made["revision"], "role": "user",
                "content": "질문", "profile": "business", "context_request": self.context()}
            asked = self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json=question))
            path = next((self.stores["alpha"].data_dir / "_personal").glob(f"*/conversations/{record_id}.json"))
            before = path.read_bytes()
            error = self.value(await http.post(self.base + f"/conversations/{record_id}/turns", json={"request_id": uuid4().hex,
                "expected_revision": asked["revision"], "role": "assistant", "content": "답변", "reply_to": question["request_id"]}), 413)
            self.assertEqual(error["code"], "personal_limit")
            self.assertEqual(path.read_bytes(), before)
            preserved = self.value(await http.get(self.base + "/conversations/" + record_id))
            self.assertEqual(len(preserved["record"]["events"]), 1)
            # 손상은 시험 파일에만 주입한다. 서버가 손상 이력을 초기화하지 않아야 한다.
            damaged = json.loads(before)
            damaged["events"][0]["content"] = "해시와 다른 내용"
            path.write_text(json.dumps(damaged), encoding="utf-8")
            corrupt = path.read_bytes()
            self.value(await http.get(self.base + "/conversations/" + record_id), 500)
            self.assertEqual(path.read_bytes(), corrupt)

    async def small_stream(self, request, *, maximum, error):
        """공용 바이트 수신기가 한도를 넘긴 경우만 짧게 주입한다."""
        raise error
        yield b""
