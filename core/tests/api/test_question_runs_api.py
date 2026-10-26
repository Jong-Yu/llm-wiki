"""실제 모델 없이 개인 질문 실행의 사용권·근거·답변 저장 계약만 검사한다."""

from datetime import timedelta
from hashlib import sha256
import unittest
from unittest.mock import patch
from uuid import uuid4
from core.tests.api import test_result_drafts_api as fixture
from core.modules.personal import question_runs, workflow_io
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.client.question_ai import question_answer_schema
from jsonschema import Draft202012Validator


class QuestionRunsApiTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.ResultDraftApiTests.setUp
    save_policy = fixture.ResultDraftApiTests.save_policy
    headers = fixture.ResultDraftApiTests.headers
    client = fixture.ResultDraftApiTests.client
    nothing = fixture.ResultDraftApiTests.nothing
    seed = fixture.ResultDraftApiTests.seed
    value = fixture.ResultDraftApiTests.value
    context = fixture.ResultDraftApiTests.context

    async def prepare(self, http):
        """원래 대화 API로 질문을 저장한 뒤 그 불변 질문만 실행 대상으로 만든다."""
        conversation = self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex,
            "title": "질문 실행", "profile": "business"}), 201)
        conversation_id = conversation["record"]["id"]
        question = {"request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
            "content": "이 문서의 조건은?", "profile": "business", "context_request": self.context()}
        asked = self.value(await http.post(self.base + f"/conversations/{conversation_id}/turns", json=question))
        run = self.value(await http.post(self.base + "/question-runs", json={"request_id": uuid4().hex,
            "profile": "business", "conversation_id": conversation_id, "question_turn_id": question["request_id"],
            "expected_conversation_revision": asked["revision"]}), 201)
        run_url = self.base + "/question-runs/" + run["record"]["id"]
        claimed = self.value(await http.post(run_url + "/claim", json={"request_id": uuid4().hex,
            "profile": "business", "expected_state_revision": run["state_revision"]}))
        handoff = self.value(await http.get(run_url + "/input", params={"profile": "business", "run_id": claimed["runtime"]["run_id"]}))
        return run_url, asked, claimed, handoff

    def answer_body(self, asked, claimed, handoff):
        """실행 지문은 클라이언트 보고이며 서버는 입력 지문과 실제 인용을 검증한다."""
        content = "합성 AI 답변입니다."
        doc = handoff["basis"]["documents"][0]
        quote = next(line for line in doc["content"].splitlines() if line)
        return {"request_id": uuid4().hex, "profile": "business", "expected_state_revision": claimed["state_revision"],
            "run_id": claimed["runtime"]["run_id"], "expected_conversation_revision": asked["revision"], "content": content,
            "citations": [{"document": "Guide.md", "source_revision": doc["source_revision"], "quote": quote}],
            "execution": {"provider": "synthetic", "cli_version": "fixture-1", "input_sha256": handoff["input_sha256"],
                "prompt_sha256": "1" * 64, "output_sha256": sha256(content.encode()).hexdigest()}}

    async def test_claim_input_heartbeat_progress_answer_and_exact_receipt(self):
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"].append("ontology_policy")
        self.save_policy()
        async with self.client() as http:
            snapshot = ReviewStore(self.stores["alpha"]).query("Guide.md", viewpoint="business")
            original = next(item for item in snapshot["claims"] if item["collection"] == "relations")
            replacement = {key: value for key, value in _input(original["value"]).items() if key not in {"evidence", "provenance"}}
            replacement["context"] = {"domain": None, "viewpoints": ["business"]}
            replacement["qualifiers"]["condition"] = "질문 실행 합성 시험에 한함"
            policy = self.value(await http.post(self.base + "/documents/policies", json={"document": "Guide.md",
                "profile": "business", "claim_id": original["claim_id"], "expected_state_revision": snapshot["state_revision"],
                "reason": "원문 인용 없는 합성 전문가 판단 이유", "replacement": replacement}))
            url, asked, claimed, handoff = await self.prepare(http)
            # 배포 뒤 기본 프롬프트가 바뀌어도 이미 만든 실행의 지문과 계약은 그대로 읽는다.
            with patch.object(question_runs, "INPUT_INSTRUCTIONS", "배포 뒤 다른 기본 지시"), patch.object(question_runs, "OUTPUT_CONTRACT", {"changed": True}):
                retained = self.value(await http.get(url + "/input", params={"profile": "business", "run_id": claimed["runtime"]["run_id"]}))
            self.assertEqual(retained, handoff)
            listed = self.value(await http.get(self.base + "/question-runs"))
            self.assertEqual(listed["items"][0]["id"], claimed["record"]["id"])
            heartbeat = self.value(await http.post(url + "/heartbeat", json={"request_id": uuid4().hex,
                "profile": "business", "run_id": claimed["runtime"]["run_id"], "expected_lease_revision": claimed["lease_revision"]}))
            self.assertEqual(heartbeat["state_revision"], claimed["state_revision"])
            progress = self.value(await http.post(url + "/progress", json={"request_id": uuid4().hex,
                "profile": "business", "run_id": claimed["runtime"]["run_id"], "expected_state_revision": claimed["state_revision"],
                "progress": "answering", "message": "개인 AI 실행 중"}))
            body = self.answer_body(asked, progress, handoff)
            frozen = handoff["basis"]["documents"][0]
            machine = next(item for item in frozen["knowledge"]["claims"] if item["claim_id"] == original["claim_id"])
            body["citations"].extend([
                {"kind": "claim", "document": "Guide.md", "source_revision": frozen["source_revision"],
                 "graph_revision": frozen["knowledge"]["graph_revision"], "state_revision": frozen["knowledge"]["state_revision"],
                 "claim_id": machine["claim_id"], "quote": machine["value"]["evidence"]["quote"]},
                {"kind": "policy", "document": "Guide.md", "state_revision": frozen["knowledge"]["state_revision"], "event_id": policy["event_id"]},
            ])
            self.assertEqual(handoff["contract_version"], "personal-question-v2")
            typed = [{**citation, "kind": citation.get("kind", "document")} for citation in body["citations"]]
            self.assertTrue(Draft202012Validator(question_answer_schema(handoff)).is_valid({"content": body["content"], "citations": typed}))
            invalid_policy = {"kind": "policy", "document": "Guide.md", "state_revision": frozen["knowledge"]["state_revision"], "event_id": uuid4().hex}
            self.value(await http.post(url + "/answers", json={**body, "citations": [invalid_policy]}), 422)
            result = self.value(await http.post(url + "/answers", json=body))
            self.assertEqual((result["state"], result["saved"]), ("complete", True))
            checked = self.value(await http.get(url + "/answers/" + body["request_id"]))
            self.assertEqual(checked["receipt"]["execution"]["origin"], "client_reported")
            self.assertFalse(checked["receipt"]["human_approval"])
            self.assertEqual(checked["receipt"]["semantic_validation"], "not_run")
            self.assertTrue(self.value(await http.post(url + "/answers", json=body))["saved"])
            current = self.value(await http.get(url))
            self.assertEqual(current["runtime"]["status"], "complete")
            conversation = self.value(await http.get(self.base + "/conversations/" + asked["record"]["id"]))
            self.assertEqual(len(conversation["record"]["events"]), 2)
            self.assertEqual(conversation["record"]["events"][1]["basis"], handoff["basis"])
            citations = conversation["record"]["events"][1]["citations"]
            self.assertEqual(citations[-1]["layer"], "expert_policy")
            self.assertIsNone(citations[-1]["quote"])
            self.assertEqual(citations[-1]["reason"], "원문 인용 없는 합성 전문가 판단 이유")
            # 답변→저장 결과→편집 초안→Wiki에서도 인용·실행·당시 판단 이유가 빠지지 않아야 한다.
            saved = self.value(await http.post(self.base + "/saved-results", json={"request_id": uuid4().hex,
                "title": "근거가 보존된 답변", "conversation_id": asked["record"]["id"], "turn_id": body["request_id"]}), 201)
            self.assertEqual(saved["record"]["data"]["answer_provenance"]["citations"], citations)
            draft = self.value(await http.post(self.base + "/result-drafts", json={"request_id": uuid4().hex,
                "profile": "business", "saved_result_id": saved["record"]["id"]}), 201)
            draft_id = draft["record"]["id"]
            ready = self.value(await http.get(self.base + "/result-drafts/" + draft_id, params={"profile": "business"}))
            self.assertIn("원문 인용 없는 합성 전문가 판단 이유", ready["rendered_content"])
            self.assertIn(handoff["input_sha256"], ready["rendered_content"])
            applied = self.value(await http.post(self.base + "/result-drafts/" + draft_id + "/applications", json={
                "request_id": uuid4().hex, "profile": "business", "expected_revision": ready["revision"], "document": "qa-answer.md",
                "expected_document_revision": None, "expected_basis_observation": ready["basis_observation"]["observation_revision"]}))
            self.assertTrue(applied["saved"])
            self.assertIn("원문 인용 없는 합성 전문가 판단 이유", self.stores["alpha"].read("qa-answer.md").content)

    async def test_cancel_owner_expiry_reclaim_and_changed_source_block_new_submission(self):
        async with self.client() as http:
            url, asked, claimed, handoff = await self.prepare(http)
            self.value(await http.get(url, headers=self.headers("carol")), 404)
            self.value(await http.get(url, headers=self.headers("bob")), 403)
            base_time = question_runs._now()
            with patch.object(question_runs, "_now", return_value=base_time + timedelta(seconds=301)):
                claim = {"request_id": uuid4().hex, "profile": "business", "expected_state_revision": claimed["state_revision"]}
                self.value(await http.post(url + "/claim", json=claim), 409)
                reclaimed = self.value(await http.post(url + "/claim", json={**claim, "reclaim": True}))
                self.assertNotEqual(reclaimed["runtime"]["run_id"], claimed["runtime"]["run_id"])
            cancelled = self.value(await http.post(url + "/cancel", json={"request_id": uuid4().hex,
                "profile": "business", "expected_state_revision": reclaimed["state_revision"]}))
            self.assertEqual(cancelled["runtime"]["status"], "cancelled")
            self.value(await http.post(url + "/answers", json=self.answer_body(asked, reclaimed, handoff)), 409)
            other_url, _, other, _ = await self.prepare(http)
            source = self.stores["alpha"].read("Guide.md")
            self.stores["alpha"].save("Guide.md", source.content + "\n추가 조건", expected_revision=source.revision)
            self.value(await http.get(other_url + "/input", params={"profile": "business", "run_id": other["runtime"]["run_id"]}), 409)
            self.assertEqual(self.value(await http.get(other_url))["record"]["data"]["basis"]["documents"][0]["content"], self.source)

    async def test_invalid_evidence_final_lease_guard_and_post_save_receipt_failure(self):
        async with self.client() as http:
            url, asked, claimed, handoff = await self.prepare(http)
            body = self.answer_body(asked, claimed, handoff)
            self.value(await http.post(url + "/answers", json={**body, "execution": {**body["execution"], "input_sha256": "0" * 64}}), 422)
            self.value(await http.post(url + "/answers", json={**body, "citations": [{**body["citations"][0], "quote": "원문에 없는 발명 인용"}]}), 422)
            for citation in (
                {**body["citations"][0], "source_revision": "0" * 64},
                {**body["citations"][0], "document": "Missing.md"},
                {"kind": "source", "source_id": "1" * 32, "source_version": "2" * 32,
                 "source_sha256": "3" * 64, "quote": body["citations"][0]["quote"]},
            ):
                self.value(await http.post(url + "/answers", json={**body, "citations": [citation]}), 422)
            # 초기 active 검사 뒤 저장 직전 사용권이 만료되는 시간 경계를 주입한다.
            now = question_runs._now()
            times = iter([now, now + timedelta(seconds=301)])
            with patch.object(question_runs, "_now", side_effect=lambda: next(times, now + timedelta(seconds=301))):
                self.value(await http.post(url + "/answers", json=body), 409)
            failed = self.value(await http.get(url + "/answers/" + body["request_id"]))
            self.assertFalse(failed["saved"])
            conversation = self.value(await http.get(self.base + "/conversations/" + asked["record"]["id"]))
            self.assertEqual(len(conversation["record"]["events"]), 1)
            body["request_id"] = uuid4().hex
            original = workflow_io.files.write_json
            def fail_final(store, path, value):
                if path.name == "intent.json" and value.get("state") == "complete":
                    raise OSError("injected receipt linkage failure")
                return original(store, path, value)
            with patch.object(workflow_io.files, "write_json", fail_final):
                result = self.value(await http.post(url + "/answers", json=body))
            self.assertEqual((result["state"], result["saved"]), ("pending_reconcile", True))
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.assertTrue(self.value(await http.get(url + "/answers/" + body["request_id"]))["saved"])
