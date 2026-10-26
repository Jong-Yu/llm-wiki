"""실제 원문 근거 검토·별도 전문가 판단과 원장 페이지의 핵심 경계만 확인한다."""

import unittest
from unittest.mock import patch

from core.api.v1.reviews.router import router as review_router
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.tests.api import test_read_api as fixture


class ReviewApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing
    data = fixture.ReadApiTests.data
    seed = fixture.ReadApiTests.seed
    snapshot = fixture.ReadApiTests.snapshot

    def setUp(self):
        """새 라우터가 아직 부모에서 결합되기 전에도 동일한 실제 앱으로 시험한다."""
        fixture.ReadApiTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "ontology_review", "ontology_policy"]
        self.save_policy()
        if not any(getattr(route, "path", "") == "/api/v1/tenants/{tenant}/documents/reviews" for route in self.app.routes):
            self.app.include_router(review_router, prefix="/api/v1/tenants/{tenant}")
        self.seed()

    def query(self):
        """요청 직전의 실제 복합 판본과 원문 주장을 가져온다."""
        return ReviewStore(self.stores["alpha"]).query("Guide.md", viewpoint="business")

    def review_body(self, snapshot, action="accept"):
        claim = next(item for item in snapshot["claims"] if item["collection"] == "relations")
        return {"document": "Guide.md", "profile": "business", "claim_id": claim["claim_id"],
                "expected_state_revision": snapshot["state_revision"], "reason": "합성 검사상의 명시 요청", "action": action}

    async def test_review_undo_policy_undo_and_event_pages(self):
        base = "/api/v1/tenants/alpha/documents"
        async with self.client(lifespan=False) as http:
            first = self.query()
            body = self.review_body(first)
            accepted = self.data(await http.post(base + "/reviews", json=body))
            self.assertEqual(accepted["history"][-1]["actor"]["user_id"], "alice")
            self.assertEqual(accepted["history"][-1]["actor"]["profile_id"], "business")
            self.data(await http.post(base + "/reviews", json=body), 409)
            undone = self.data(await http.post(base + "/review-undos", json={"document": "Guide.md", "profile": "business",
                "event_id": accepted["event_id"], "expected_state_revision": accepted["state_revision"], "reason": "합성 되돌림"}))
            original = next(item for item in undone["claims"] if item["claim_id"] == body["claim_id"])
            replacement = {key: value for key, value in _input(original["value"]).items() if key not in {"evidence", "provenance"}}
            replacement["context"] = {"domain": None, "viewpoints": ["business"]}
            replacement["qualifiers"]["condition"] = "합성 프로젝트에 한함"
            policy = self.data(await http.post(base + "/policies", json={"document": "Guide.md", "profile": "business",
                "claim_id": body["claim_id"], "expected_state_revision": undone["state_revision"], "reason": "합성 업무 판단",
                "replacement": replacement}))
            reversed_policy = self.data(await http.post(base + "/policy-undos", json={"document": "Guide.md", "profile": "business",
                "event_id": policy["event_id"], "expected_state_revision": policy["state_revision"], "reason": "합성 판단 되돌림"}))
            self.assertEqual(len(reversed_policy["history"]), 4)
            page = self.data(await http.get(base + "/events", params={"document": "Guide.md", "profile": "business", "limit": 1}))
            self.assertFalse(page["complete"])
            event = self.data(await http.get(base + "/events/" + accepted["event_id"], params={"document": "Guide.md", "profile": "business"}))
            self.assertEqual(event["event"], accepted["history"][-1])
            self.assertEqual(event["event"]["after"]["decision"], "accept")
            self.data(await http.get(base + "/events", params={"document": "Guide.md", "profile": "all", "cursor": page["next_cursor"]}), 422)

    async def test_separate_permissions_forged_actor_and_late_revocation_preserve_ledger(self):
        base = "/api/v1/tenants/alpha/documents"
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "ontology_review"]
        self.save_policy()
        body = self.review_body(self.query())
        async with self.client(lifespan=False) as http:
            self.data(await http.post(base + "/reviews", json={**body, "actor": {"user_id": "forged"}}), 422)
            replacement = {"document": "Guide.md", "profile": "business", "claim_id": body["claim_id"],
                "expected_state_revision": body["expected_state_revision"], "reason": "허용하지 않음", "replacement": {}}
            self.data(await http.post(base + "/policies", json=replacement), 403)
            before = self.snapshot()
            old_validate = ReviewStore._validate_all_layers
            def revoke_after_validation(store, *args):
                """저장 직전 정책 회수를 흉내 내며 이미 있는 원장은 그대로 둔다."""
                old_validate(store, *args)
                self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                self.save_policy()
            with patch.object(ReviewStore, "_validate_all_layers", revoke_after_validation):
                self.data(await http.post(base + "/reviews", json=body), 403)
            self.assertEqual(self.snapshot(), before)
