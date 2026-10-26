"""고정 근거를 보존하는 결과물 편집·명시 반영의 핵심 세 경로만 검사한다."""

import unittest
from uuid import uuid4
from unittest.mock import patch
from core.tests.api import test_personal_api as fixture
from core.modules.personal import workflow_io


class ResultDraftApiTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.PersonalApiTests.setUp
    save_policy = fixture.PersonalApiTests.save_policy
    headers = fixture.PersonalApiTests.headers
    client = fixture.PersonalApiTests.client
    nothing = fixture.PersonalApiTests.nothing
    seed = fixture.PersonalApiTests.seed
    value = fixture.PersonalApiTests.value
    context = fixture.PersonalApiTests.context

    async def make_draft(self, http):
        """기존 실제 saved-result API에서 전체 근거와 생성문을 준비한다."""
        saved = self.value(await http.post(self.base + "/saved-results", json={"request_id": uuid4().hex,
            "title": "원래 제목", "content": "원래 생성문", "profile": "business", "context_request": self.context()}), 201)
        made = self.value(await http.post(self.base + "/result-drafts", json={"request_id": uuid4().hex,
            "saved_result_id": saved["record"]["id"], "profile": "business"}), 201)
        draft_id = made["record"]["id"]
        ready = self.value(await http.get(self.base + "/result-drafts/" + draft_id, params={"profile": "business"}))
        return draft_id, ready

    def apply_body(self, ready, document="draft.md", expected=None):
        """조회한 초안/근거와 실제 대상의 기준을 각각 지정한다."""
        return {"request_id": uuid4().hex, "profile": "business", "expected_revision": ready["revision"],
            "document": document, "expected_document_revision": expected,
            "expected_basis_observation": ready["basis_observation"]["observation_revision"]}

    async def test_edit_frozen_basis_apply_whole_history_and_exact_replay(self):
        async with self.client() as http:
            draft_id, ready = await self.make_draft(http)
            listed = self.value(await http.get(self.base + "/result-drafts"))
            self.assertEqual(listed["items"][0]["id"], draft_id)
            edited = self.value(await http.put(self.base + "/result-drafts/" + draft_id, json={"request_id": uuid4().hex,
                "expected_revision": ready["revision"], "profile": "business", "title": "편집한 제목", "content": "편집한 본문"}))
            ready = self.value(await http.get(self.base + "/result-drafts/" + draft_id, params={"profile": "business"}))
            self.assertEqual(ready["record"]["data"]["original_generated_content"], "원래 생성문")
            self.assertEqual(ready["draft"]["content"], "편집한 본문")
            self.assertEqual(ready["record"]["data"]["basis"]["documents"][0]["content"], self.source)
            self.assertIn("frozen_basis", ready["rendered_content"])
            self.assertIn("original_generated_content", ready["rendered_content"])
            original = self.stores["alpha"].read("Guide.md")
            body = self.apply_body(ready, "Guide.md", original.revision)
            url = self.base + "/result-drafts/" + draft_id + "/applications"
            result = self.value(await http.post(url, json=body))
            self.assertEqual((result["state"], result["saved"]), ("complete", True))
            self.assertIn("# 편집한 제목\n\n편집한 본문", self.stores["alpha"].read("Guide.md").content)
            self.assertIn(ready["record"]["data"]["basis"]["snapshot_revision"], self.stores["alpha"].read("Guide.md").content)
            history = list((self.stores["alpha"].history_dir / "Guide.md").glob("*.md"))
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0].read_text(), self.source)
            with patch.object(self.stores["alpha"], "save", side_effect=AssertionError("must not save twice")):
                # 인가 scope가 매번 새 WikiStore를 만들므로 실제 모듈 메서드도 교체한다.
                from core.modules.documents.store import WikiStore
                with patch.object(WikiStore, "save", side_effect=AssertionError("must not save twice")):
                    repeated = self.value(await http.post(url, json=body))
            self.assertEqual(repeated["receipt"], result["receipt"])
            self.value(await http.get(self.base + "/result-drafts/" + draft_id, headers=self.headers("carol")), 404)

    async def test_basis_change_requires_latest_ack_and_permissions_before_write(self):
        async with self.client() as http:
            draft_id, ready = await self.make_draft(http)
            body = self.apply_body(ready)
            old = self.stores["alpha"].read("Guide.md")
            self.stores["alpha"].save("Guide.md", self.source + "\n새 조건", expected_revision=old.revision)
            url = self.base + "/result-drafts/" + draft_id + "/applications"
            self.value(await http.post(url, json=body), 409)
            changed = self.value(await http.get(self.base + "/result-drafts/" + draft_id, params={"profile": "business"}))
            self.assertEqual(changed["basis_observation"]["status"], "changed")
            body["expected_basis_observation"] = changed["basis_observation"]["observation_revision"]
            self.value(await http.post(url, json=body), 409)
            body["acknowledge_changed_basis"] = True
            applied = self.value(await http.post(url, json=body))
            self.assertTrue(applied["saved"])
            self.assertEqual(changed["record"]["data"]["basis"]["documents"][0]["content"], self.source)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "result_write"]
            self.save_policy()
            self.value(await http.post(url, json={**body, "request_id": uuid4().hex, "document": "forbidden.md"}), 403)
            self.assertFalse((self.stores["alpha"].wiki_dir / "forbidden.md").exists())

    async def test_post_save_receipt_failure_is_readable_and_unknown_never_rewrites(self):
        async with self.client() as http:
            draft_id, ready = await self.make_draft(http)
            body = self.apply_body(ready, "confirmed.md")
            url = self.base + "/result-drafts/" + draft_id + "/applications"
            original = workflow_io.files.write_json
            def fail_final(store, path, value):
                """실제 Wiki와 saved 증거 뒤 마지막 연결만 실패시킨다."""
                if path.name == "intent.json" and value.get("state") == "complete":
                    raise OSError("injected receipt link failure")
                return original(store, path, value)
            with patch.object(workflow_io.files, "write_json", fail_final):
                pending = self.value(await http.post(url, json=body))
            self.assertEqual((pending["state"], pending["saved"]), ("pending_reconcile", True))
            checked = self.value(await http.get(url + "/" + body["request_id"]))
            self.assertTrue(checked["saved"])
            second = self.apply_body(ready, "unknown.md")
            def fail_evidence(store, path, value):
                """현재 호출의 성공과 재시작 후 증거 미보유를 구분한다."""
                if path.name == "saved.json":
                    raise OSError("injected evidence failure")
                return original(store, path, value)
            with patch.object(workflow_io.files, "write_json", fail_evidence):
                transient = self.value(await http.post(url, json=second))
            self.assertTrue(transient["saved"])
            checked = self.value(await http.get(url + "/" + second["request_id"]))
            self.assertIsNone(checked["saved"])
            self.value(await http.post(url, json=self.apply_body(ready, "do-not-repeat.md")), 409)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.assertTrue(self.value(await http.get(url + "/" + body["request_id"]))["saved"])
