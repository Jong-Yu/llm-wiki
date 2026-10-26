"""대응 HTTP의 실제 Store 연결·권한·판본 보존만 두 핵심 흐름으로 확인한다."""

from copy import deepcopy
import unittest
from core.tests.api import test_sources_api as fixture
from core.tests.modules.test_correspondences import correspondence_fixture


class CorrespondenceApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.SourceApiTests.save_policy
    snapshot = fixture.SourceApiTests.snapshot
    headers = fixture.SourceApiTests.headers
    client = fixture.SourceApiTests.client
    nothing = fixture.SourceApiTests.nothing
    value = fixture.SourceApiTests.value

    def setUp(self):
        """기존 임시 정책/서버 준비만 재사용하고 이전 검사들을 상속하지 않는다."""
        fixture.SourceApiTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = [
            "read", "source_write", "write", "ontology_write", "ontology_review", "ontology_policy"]
        self.save_policy()
        self.draft = correspondence_fixture(self.stores["alpha"])
        self.url = self.base + "/correspondences"

    async def proposal(self, http):
        """준비는 읽기이고, 그 ID·판본을 명시해 별도 제출해야 저장된다."""
        before = self.snapshot()
        prepared = self.value(await http.post(self.url + "/drafts/prepare", json={"draft": self.draft}))
        self.assertEqual(before, self.snapshot())
        result = self.value(await http.post(self.url, json={"correspondence_id": prepared["correspondence_id"],
            "draft": prepared["draft"], "expected_state_revision": prepared["state_revision"], "reason": "합성 시험 제안"}), 201)
        return result

    async def test_full_prepare_review_policy_undo_and_discovery_keep_originals(self):
        """아홉 URL은 같은 기존 원장/prepare 계약을 사용하며 모든 판단은 모의다."""
        originals = {name: self.stores["alpha"].read(name).content for name in ("a.md", "b.md", "d.md")}
        async with self.client() as http:
            proposed = await self.proposal(http)
            path = self.url + "/" + proposed["correspondence_id"]
            found = self.value(await http.post(self.url + "/find", json={"documents": ["a.md", "b.md"]}))
            self.assertTrue(found["results"])
            detail = self.value(await http.post(path + "/query", json={}))
            reviewed = self.value(await http.post(path + "/reviews", json={"action": "defer",
                "expected_state_revision": detail["state_revision"], "reason": "합성 보류"}))
            change = {"event_id": reviewed["event_id"], "reason": "합성 되돌림"}
            ready = self.value(await http.post(path + "/changes/prepare", json={"operation": "review_undo", "change": change}))
            self.value(await http.post(path + "/review-undos", json={**change, "expected_state_revision": ready["state_revision"]}))
            expert = deepcopy(self.draft)
            expert["basis"] = {"kind": "expert", "reason": "모의 업무 판단, 실제 사람 확인 아님", "link_evidence": []}
            policy_change = {"replacement": expert, "reason": "합성 전문가 정책", "judgment_id": None, "supersedes_event_id": None}
            ready = self.value(await http.post(path + "/changes/prepare", json={"operation": "policy", "change": policy_change}))
            policy = self.value(await http.post(path + "/policies", json={**policy_change, "expected_state_revision": ready["state_revision"]}))
            undo = {"event_id": policy["event_id"], "reason": "합성 정책 되돌림"}
            ready = self.value(await http.post(path + "/changes/prepare", json={"operation": "policy_undo", "change": undo}))
            self.value(await http.post(path + "/policy-undos", json={**undo, "expected_state_revision": ready["state_revision"]}))
            final = self.value(await http.post(path + "/query", json={}))
            self.assertEqual(len(final["history"]), 5)
            self.assertEqual(final["access"]["user_id"], "alice")
        self.assertEqual(originals, {name: self.stores["alpha"].read(name).content for name in originals})

    async def test_conflict_unknown_fields_and_permission_denials_do_not_change_ledger(self):
        """권한과 실제 판본을 우회하지 못하며, 같은 내용 재전송도 새 제안으로 만들지 않는다."""
        async with self.client() as http:
            proposed = await self.proposal(http)
            path = self.url + "/" + proposed["correspondence_id"]
            original = self.snapshot()
            bad = await http.post(path + "/reviews", json={"action": "defer", "expected_state_revision": "0" * 64, "reason": "오래된 입력"})
            self.value(bad, 409)
            self.value(await http.post(path + "/query", json={"actor": {"user_id": "forged"}}), 422)
            self.value(await http.post(path + "/query", json={"profile": "unknown"}), 403)
            self.value(await http.post(path + "/query", json={}, headers=self.headers("bob")), 403)
            self.value(await http.post(path + "/reviews", json={"action": "defer", "expected_state_revision": proposed["state_revision"], "reason": "권한 없음"}, headers=self.headers("reader")), 403)
            self.assertEqual(original, self.snapshot())
