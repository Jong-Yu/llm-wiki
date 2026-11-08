"""선택 웹 근거의 보존·인용·거부와 구 질문 호환을 격리 저장에서 검사한다."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from jsonschema import Draft202012Validator
from pydantic import ValidationError

from core.api.v1.knowledge.schemas import QuestionContextRequest
from core.api.v1.personal.workflows_schemas import AnswerCitation, RunAnswer
from core.client.question_ai import assemble_question, question_answer_schema
from core.modules.access.auth import initialize_auth
from core.modules.access.policy import AccessPolicy
from core.modules.knowledge.aggregation import prepare_question
from core.modules.personal.question_runs import QuestionRunStore
from core.modules.personal.store import PersonalStore, PersonalConflictError
from core.modules.personal.web_evidence import public_web_url
from core.runtime.application import create_application
from core.tests.poc_knowledge.test_storage import ACTOR, KnowledgeFixture
import httpx2


def web_result():
    """실제 웹 호출을 대신하는 출처 보존 계약용 합성 자료다."""
    content = "The author's recommendation is to compare local policies with outside advice."
    return {"query": "knowledge policy comparison", "status": "complete", "warnings": [], "sources": [{
        "url": "https://example.com/opinion", "title": "An author's opinion", "content": content,
        "content_sha256": sha256(content.encode()).hexdigest(), "retrieved_at": "2026-11-05T01:00:00Z"}]}


class WebEvidenceTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(); self.generate()
        self.scope = SimpleNamespace(store=self.wiki, **ACTOR)
        self.personal, self.runs = PersonalStore(self.scope), QuestionRunStore(self.scope)

    def basis(self, web=None, documents=None):
        """웹 선택을 제외한 내부 근거 입력은 동일하게 유지한다."""
        return prepare_question(self.wiki, ACTOR, documents=documents if documents is not None else ["a.md"],
            required_documents=[], claims=[], source_refs=[], allow_empty=True, web=web)

    def create(self, web=None, documents=None):
        """기존 개인 대화와 CAS로 웹 선택 질문 하나를 준비한다."""
        self.conversation = self.personal.create("conversations", uuid4().hex, {}, {"title": "웹 비교"}, ACTOR,
            before_commit=lambda: None)
        event = {"role": "user", "content": "외부 의견과 비교해 줘", "basis": self.basis(web, documents),
            "reply_to": None, "status": "complete"}
        question_id = uuid4().hex
        self.conversation = self.personal.append("conversations", self.conversation["record"]["id"], question_id,
            self.conversation["revision"], event, event, ACTOR, before_commit=lambda: None)
        made = self.runs.create(request_id=uuid4().hex, conversation_id=self.conversation["record"]["id"],
            question_turn_id=question_id, expected_conversation_revision=self.conversation["revision"], before_commit=lambda: None)
        return self.runs.command(made["record"]["id"], "claim", {"request_id": uuid4().hex,
            "expected_state_revision": made["state_revision"], "reclaim": False}, authorize=lambda: None)

    def answer(self, made):
        """인용 참조와 실행 지문을 실제 고정 입력에서 복사한다."""
        handoff = self.runs._input(made["record"])
        reference = next(item for item in handoff["output"]["citation_references"] if item["kind"] == "web")
        content = "외부 저자는 내부 정책과 외부 조언의 비교를 권합니다."
        return {"request_id": uuid4().hex, "expected_state_revision": made["state_revision"],
            "run_id": made["runtime"]["run_id"], "expected_conversation_revision": self.conversation["revision"],
            "content": content, "citations": [{**reference, "quote": "The author's recommendation"}],
            "execution": {"provider": "codex", "cli_version": "synthetic-web-contract", "requested_model": None,
                "reported_model": None, "input_sha256": handoff["input_sha256"], "prompt_sha256": "0" * 64,
                "output_sha256": sha256(content.encode()).hexdigest()}}

    def test_optional_web_preserves_old_request_shape_and_v3(self):
        model = QuestionContextRequest(documents=["a.md"])
        self.assertNotIn("web", model.model_dump())
        self.assertEqual(self.basis()["snapshot_revision"], self.basis(web=None)["snapshot_revision"])
        made = self.create()
        handoff = self.runs._input(made["record"])
        self.assertEqual(handoff["contract_version"], "personal-question-v3")
        self.assertNotIn("web", handoff["basis"])
        legacy = AnswerCitation(kind="document", document="a.md", source_revision="0" * 64, quote="A")
        for key in ("url", "title", "retrieved_at", "content_sha256"):
            self.assertNotIn(key, legacy.model_dump())

    def test_web_snapshot_changes_with_content_or_search_and_has_no_wiki_side_effect(self):
        before = self.tree()
        plain, web = self.basis(), self.basis(web_result())
        self.assertNotEqual(plain["snapshot_revision"], web["snapshot_revision"])
        self.assertEqual(web["web"]["origin"], "client_reported")
        self.assertEqual(web["web"]["retrieval_verification"], "not_independently_verified")
        changed = web_result(); changed["query"] = "other public query"
        self.assertNotEqual(web["snapshot_revision"], self.basis(changed)["snapshot_revision"])
        self.assertEqual(before, self.tree())
        self.assertEqual(QuestionContextRequest(web=web_result()).model_dump()["web"], web_result())

    def test_invalid_hash_urls_dates_status_and_duplicate_sources_are_rejected(self):
        variants = []
        for key, value in (("content_sha256", "0" * 64), ("url", "http://127.0.0.1/private"),
                ("url", "https://user:secret@example.com/"), ("retrieved_at", "2026-11-05T12:00:00")):
            changed = web_result(); changed["sources"][0][key] = value; variants.append(changed)
        changed = web_result(); changed["status"] = "empty"; variants.append(changed)
        changed = web_result(); changed["sources"] *= 2; variants.append(changed)
        changed = web_result(); changed["warnings"] = ["page_failed"]; variants.append(changed)
        before = self.tree()
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): self.basis(value)
                with self.assertRaises(ValidationError): QuestionContextRequest(web=value)
        self.assertEqual(before, self.tree())
        for url in ("http://localhost/", "https://10.0.0.1/", "http://[::1]/", "https://intranet/", "file:///tmp/x"):
            with self.subTest(url=url), self.assertRaises(ValueError): public_web_url(url)

    def test_web_only_v4_fixes_exact_references_and_frozen_prompt(self):
        made = self.create(web_result(), [])
        handoff = self.runs._input(made["record"])
        self.assertEqual(handoff["contract_version"], "personal-question-v4")
        self.assertEqual(handoff["basis"]["documents"], [])
        schema = question_answer_schema(handoff)
        payload = self.answer(made)
        self.assertTrue(Draft202012Validator(schema).is_valid({key: payload[key] for key in ("content", "citations")}))
        wrong = deepcopy(payload); wrong["citations"][0]["url"] = "https://example.com/other"
        self.assertFalse(Draft202012Validator(schema).is_valid({key: wrong[key] for key in ("content", "citations")}))
        prompt = assemble_question(handoff, made["record"])
        self.assertIn("external sources' claims/opinions", prompt)
        self.assertIn("Earlier web answers are dialogue context only", prompt)
        self.assertIn(web_result()["sources"][0]["content"], prompt)

    def test_valid_web_answer_is_saved_once_with_exact_origin_and_full_basis(self):
        made = self.create(web_result())
        # 실제 HTTP schema 직렬화를 거친 요청도 저장 계약에 맞아야 한다.
        payload = RunAnswer(**self.answer(made)).model_dump(exclude={"profile"})
        receipt = self.runs.submit(made["record"]["id"], payload, authorize=lambda: None)
        self.assertTrue(receipt["saved"])
        repeated = self.runs.submit(made["record"]["id"], payload, authorize=lambda: None)
        self.assertEqual(receipt, repeated)
        stored = self.personal.read("conversations", self.conversation["record"]["id"])["record"]
        self.assertEqual(len(stored["events"]), 2)
        answer = stored["events"][-1]
        self.assertEqual(answer["basis"]["web"]["sources"], web_result()["sources"])
        self.assertEqual(answer["citations"][0]["layer"], "external_web")
        self.assertFalse(answer["citations"][0]["human_approval"])
        self.assertEqual(answer["citations"][0]["url"], payload["citations"][0]["url"])
        changed = deepcopy(payload); changed["content"] += " changed"
        with self.assertRaises(PersonalConflictError):
            self.runs.submit(made["record"]["id"], changed, authorize=lambda: None)

    def test_forged_web_reference_or_quote_preserves_conversation_and_run(self):
        made = self.create(web_result())
        payload = self.answer(made)
        before = self.tree()
        for key, value in (("quote", "invented external claim"), ("url", "https://example.com/other"),
                ("content_sha256", "0" * 64), ("retrieved_at", "2026-11-04T01:00:00Z"), ("title", "a different title")):
            wrong = deepcopy(payload); wrong["citations"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.runs.submit(made["record"]["id"], wrong, authorize=lambda: None)
        self.assertEqual(before, self.tree())
        with self.assertRaises(ValueError):
            QuestionRunStore._validate_citations(self.basis(), payload["citations"])

    def test_stale_conversation_rejects_answer_without_rewriting_old_web_basis(self):
        made = self.create(web_result())
        payload = self.answer(made)
        event = {"role": "user", "content": "later", "basis": self.basis(), "reply_to": None, "status": "complete"}
        self.personal.append("conversations", self.conversation["record"]["id"], uuid4().hex,
            self.conversation["revision"], event, event, ACTOR, before_commit=lambda: None)
        before = self.tree()
        with self.assertRaises(PersonalConflictError):
            self.runs.submit(made["record"]["id"], payload, authorize=lambda: None)
        self.assertEqual(before, self.tree())
        self.assertEqual(self.runs.read(made["record"]["id"])["record"]["data"]["basis"]["web"]["sources"], web_result()["sources"])

    def test_web_failure_is_frozen_without_inventing_any_citation(self):
        for status in ("empty", "unavailable"):
            with self.subTest(status=status):
                web = {"query": "public query", "status": status, "sources": [], "warnings": ["search_failed"]}
                made = self.create(web, [])
                handoff = self.runs._input(made["record"])
                self.assertEqual(handoff["basis"]["web"]["status"], status)
                self.assertEqual(handoff["output"]["citation_references"], [])
                self.assertEqual(question_answer_schema(handoff)["properties"]["citations"]["maxItems"], 0)

    def test_storage_failure_retains_original_conversation_and_frozen_web_input(self):
        made = self.create(web_result())
        payload = self.answer(made)
        previous = self.personal.read("conversations", self.conversation["record"]["id"])
        with patch.object(self.runs.personal, "append_locked", side_effect=OSError("isolated write failure")):
            result = self.runs.submit(made["record"]["id"], payload, authorize=lambda: None)
        self.assertIsNone(result["saved"])
        self.assertEqual(self.personal.read("conversations", self.conversation["record"]["id"]), previous)
        self.assertEqual(self.runs.read(made["record"]["id"])["record"]["data"]["basis"]["web"]["sources"], web_result()["sources"])


class WebEvidenceHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        (root / "data").mkdir(); (root / "tenancy").mkdir()
        config = root / "tenancy/policy.json"
        config.write_text(json.dumps(dict(version=1, tenants={}, users={})))
        policy = AccessPolicy(config, root / "data")
        auth = initialize_auth(policy)
        self.user = auth.signup("web evidence test")
        self.tenant = self.user["default_tenant"]
        self.app = create_application(policy, auth=auth)

    async def test_http_prepares_web_only_saves_answer_and_rejects_forged_text(self):
        async with self.app.router.lifespan_context(self.app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app),
                    base_url="http://127.0.0.1:8766", headers={"Authorization": "Bearer " + self.user["token"]}) as http:
                params = {}
                prefix = f"/api/v1/tenants/{self.tenant}"
                context = {"allow_empty": True, "web": web_result()}
                prepared = await http.post(f"{prefix}/question-context/prepare", params=params, json=context)
                self.assertEqual(prepared.status_code, 200, prepared.text)
                self.assertTrue(prepared.json()["data"]["can_prepare"])
                conversation = (await http.post(f"{prefix}/conversations", params=params,
                    json={"request_id": uuid4().hex, "title": "external comparison"})).json()["data"]
                cid, qid = conversation["record"]["id"], uuid4().hex
                turn = await http.post(f"{prefix}/conversations/{cid}/turns", params=params, json={
                    "request_id": qid, "expected_revision": conversation["revision"], "role": "user",
                    "content": "외부의 의견은?", "context_request": context})
                self.assertEqual(turn.status_code, 200, turn.text)
                conversation = turn.json()["data"]
                created = await http.post(f"{prefix}/question-runs", params=params, json={
                    "request_id": uuid4().hex, "conversation_id": cid, "question_turn_id": qid,
                    "expected_conversation_revision": conversation["revision"]})
                self.assertEqual(created.status_code, 201, created.text)
                made = created.json()["data"]; rid = made["record"]["id"]
                claimed = (await http.post(f"{prefix}/question-runs/{rid}/claim", params=params,
                    json={"request_id": uuid4().hex, "expected_state_revision": made["state_revision"]})).json()["data"]
                handoff = (await http.get(f"{prefix}/question-runs/{rid}/input", params={
                    **params, "run_id": claimed["runtime"]["run_id"]})).json()["data"]
                content = "외부 저자의 의견입니다."
                reference = handoff["output"]["citation_references"][0]
                payload = {"request_id": uuid4().hex, "run_id": claimed["runtime"]["run_id"],
                    "expected_state_revision": claimed["state_revision"], "expected_conversation_revision": conversation["revision"],
                    "content": content, "citations": [{**reference, "quote": "invented"}],
                    "execution": {"provider": "codex", "cli_version": "synthetic-http", "requested_model": None,
                        "reported_model": None, "input_sha256": handoff["input_sha256"], "prompt_sha256": "0" * 64,
                        "output_sha256": sha256(content.encode()).hexdigest()}}
                forged = await http.post(f"{prefix}/question-runs/{rid}/answers", params=params, json=payload)
                self.assertEqual(forged.status_code, 422, forged.text)
                payload["citations"][0]["quote"] = "The author's recommendation"
                saved = await http.post(f"{prefix}/question-runs/{rid}/answers", params=params, json=payload)
                self.assertEqual(saved.status_code, 200, saved.text)
                self.assertTrue(saved.json()["data"]["saved"])
                replayed = await http.post(f"{prefix}/question-runs/{rid}/answers", params=params, json=payload)
                self.assertEqual(replayed.json()["data"], saved.json()["data"])
                after = (await http.get(f"{prefix}/conversations/{cid}", params=params)).json()["data"]["record"]["events"]
                self.assertEqual(len(after), 2)
                self.assertEqual(after[-1]["citations"][0]["kind"], "web")
                self.assertEqual(after[-1]["basis"]["web"]["sources"], web_result()["sources"])


if __name__ == "__main__":
    unittest.main()
