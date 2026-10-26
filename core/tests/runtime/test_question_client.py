"""합성 모델 + 실제 ASGI/격리 저장소로 질문 실행/취소/실패 보존을 검사한다."""

import asyncio
from datetime import timedelta
from hashlib import sha256
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

from jsonschema import Draft202012Validator

from core.client.question import run_question
from core.client import question as question_client
from core.client.question_ai import AnswerPreview
from core.client.transport import AnalysisClientError
from core.modules.personal import question_runs, workflow_io
from core.tests.api import test_personal_api as fixture


class SyntheticAdapter:
    def __init__(self, hook=None, *, invalid_quote=False):
        self.hook, self.invalid_quote = hook, invalid_quote
        self.calls = 0
        self.stopped = False

    async def preflight(self):
        return {"provider": "synthetic", "capabilities_checked": True}

    async def run(self, *, prompt, schema, directory, on_event=None):
        self.calls += 1
        data = json.loads(prompt.splitlines()[-1])
        if data["basis"]["documents"]:
            doc = data["basis"]["documents"][0]
            citation = {"kind": "document", "document": doc["document"], "source_revision": doc["source_revision"],
                "quote": "invented quote" if self.invalid_quote else doc["content"].splitlines()[0]}
        else:
            original = data["basis"]["originals"][0]
            citation = {"kind": "source", **{key: original["source_ref"][key] for key in ("source_id", "source_version", "source_sha256")},
                "quote": original["content"]}
        value = {"content": "합성 답변입니다. 조건은 원문을 따릅니다.", "citations": [citation]}
        if on_event:
            on_event({"type": "agent_message", "event": "item.updated", "text": '{"content":"합성 답변'})
        try:
            if self.hook:
                await self.hook()
            if on_event:
                on_event({"type": "agent_message", "event": "item.completed", "text": json.dumps(value, ensure_ascii=False)})
            return {"value": value, "execution": {"provider": "synthetic", "cli_version": "fixture-1",
                "status": "completed", "prompt_sha256": sha256(prompt.encode()).hexdigest()}}
        finally:
            self.stopped = True


class DropResponse:
    """실제 요청/저장 뒤 응답만 없애므로 성공 모의값을 만들지 않는다."""
    def __init__(self, http, suffix="/answers", *, before=False, hide_receipt=False):
        self.http, self.suffix, self.before, self.hide_receipt = http, suffix, before, hide_receipt
        self.posts = 0

    async def request(self, method, path, **kwargs):
        if method == "POST" and path.endswith(self.suffix):
            self.posts += 1
            if not self.before:
                await self.http.request(method, path, **kwargs)
            raise OSError("synthetic private network detail")
        if self.hide_receipt and method == "GET" and "/answers/" in path:
            raise OSError("synthetic receipt unavailable")
        return await self.http.request(method, path, **kwargs)


class QuestionClientTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.PersonalApiTests.setUp
    save_policy = fixture.PersonalApiTests.save_policy
    headers = fixture.PersonalApiTests.headers
    client = fixture.PersonalApiTests.client
    nothing = fixture.PersonalApiTests.nothing
    seed = fixture.PersonalApiTests.seed
    value = fixture.PersonalApiTests.value
    context = fixture.PersonalApiTests.context

    async def question(self, http, *, context=None):
        made = self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex,
            "title": "질문 실행 fixture", "profile": "business"}), 201)
        turn = uuid4().hex
        asked = self.value(await http.post(self.base + "/conversations/" + made["record"]["id"] + "/turns", json={
            "request_id": turn, "expected_revision": made["revision"], "role": "user", "content": "조건은?",
            "profile": "business", "context_request": context or self.context()}))
        return {"conversation_id": made["record"]["id"], "question_turn_id": turn, "expected_conversation_revision": asked["revision"]}

    async def execute(self, http, *, question=None, event_sink=None, **kwargs):
        events = []
        def observe(event):
            events.append(event)
            if event_sink:
                event_sink(event)
        result = await run_question(base_url="http://127.0.0.1:8766", tenant="alpha", token=self.tokens["alice"],
            work_dir=self.root.resolve() / "personal", profile="business", http=http, on_event=observe,
            poll_seconds=0.01, heartbeat_seconds=0.05, **(question or {}), **kwargs)
        return result, events

    async def conversation(self, http, question):
        return self.value(await http.get(self.base + "/conversations/" + question["conversation_id"]))

    async def test_success_live_preview_heartbeat_and_read_only_recovery(self):
        async with self.client() as http:
            question = await self.question(http)
            heartbeat = asyncio.Event()
            adapter = SyntheticAdapter(lambda: asyncio.wait_for(heartbeat.wait(), 5))
            def observe(event):
                if event.get("phase") == "heartbeat":
                    heartbeat.set()
            result, events = await self.execute(http, question=question, adapter=adapter, event_sink=observe)
            self.assertEqual((result["status"], result["saved"]), ("stored", True), result)
            self.assertEqual(adapter.calls, 1)
            self.assertTrue(any(item.get("phase") == "heartbeat" for item in events))
            previews = [item for item in events if item["type"] == "answer_preview"]
            self.assertGreaterEqual(len(previews), 2)
            self.assertEqual(previews[0]["content"], "합성 답변")
            self.assertTrue(all(item["saved"] is False for item in events))
            stored = await self.conversation(http, question)
            self.assertEqual(len(stored["record"]["events"]), 2)
            self.assertEqual(stored["record"]["events"][1]["basis"], stored["record"]["events"][0]["basis"])
            self.assertFalse(result["human_approval"])
            self.assertEqual(result["semantic_validation"], "not_run")
            files = b"".join(path.read_bytes() for path in Path(result["work_dir"]).rglob("*") if path.is_file())
            self.assertNotIn(self.tokens["alice"].encode(), files)
            again, _ = await self.execute(http, question_run_id=result["question_run_id"], adapter=adapter)
            self.assertEqual((again["status"], adapter.calls), ("stored", 1))
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            receipt, _ = await self.execute(http, question_run_id=result["question_run_id"], receipt_request_id=result["request_id"])
            self.assertTrue(receipt["saved"])
            membership = self.config["users"]["alice"]["memberships"]["alpha"]
            membership["profiles"] = ["all"]
            self.save_policy()
            read_after_profile_removal = await run_question(base_url="http://127.0.0.1:8766", tenant="alpha",
                token=self.tokens["alice"], work_dir=self.root.resolve() / "receipt-only", profile="all", http=http,
                question_run_id=result["question_run_id"], receipt_request_id=result["request_id"])
            self.assertTrue(read_after_profile_removal["saved"])

    async def test_response_loss_reconciles_exact_receipt_without_resubmission(self):
        async with self.client() as http:
            question = await self.question(http)
            dropped = DropResponse(http)
            result, _ = await self.execute(dropped, question=question, adapter=SyntheticAdapter())
            self.assertEqual((result["status"], result["saved"], dropped.posts), ("stored", True, 1), result)
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 2)

    async def test_model_completion_waits_for_committed_heartbeat_response(self):
        async with self.client() as http:
            question = await self.question(http)
            committed, release = asyncio.Event(), asyncio.Event()
            class DelayedHeartbeat:
                async def request(inner, method, path, **kwargs):
                    response = await http.request(method, path, **kwargs)
                    if method == "POST" and path.endswith("/heartbeat") and not committed.is_set():
                        committed.set()
                        await release.wait()
                    return response
            async def complete():
                await asyncio.wait_for(committed.wait(), 5)
                asyncio.get_running_loop().call_later(0.05, release.set)
            adapter = SyntheticAdapter(complete)
            result, _ = await self.execute(DelayedHeartbeat(), question=question, adapter=adapter)
            self.assertEqual((result["status"], result["saved"], adapter.calls), ("stored", True, 1), result)
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 2)

    async def test_unknown_submission_preserves_draft_and_does_not_retry(self):
        async with self.client() as http:
            question = await self.question(http)
            dropped = DropResponse(http, hide_receipt=True)
            result, events = await self.execute(dropped, question=question, adapter=SyntheticAdapter())
            self.assertEqual((result["status"], result["saved"], dropped.posts), ("unconfirmed", None, 1), result)
            self.assertTrue((Path(result["work_dir"]) / "answer-draft.json").exists())
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 2)
            recovered, _ = await self.execute(http, question_run_id=result["question_run_id"], receipt_request_id=result["request_id"])
            self.assertTrue(recovered["saved"])

    async def test_partial_save_is_saved_with_reconciliation_warning(self):
        async with self.client() as http:
            question = await self.question(http)
            original = workflow_io.files.write_json
            def fail_final(store, path, value):
                if path.name == "intent.json" and value.get("state") == "complete":
                    raise OSError("fixture final receipt failure")
                return original(store, path, value)
            with patch.object(workflow_io.files, "write_json", fail_final):
                result, _ = await self.execute(http, question=question, adapter=SyntheticAdapter())
            self.assertEqual((result["status"], result["saved"]), ("stored", True), result)
            self.assertTrue(result["reconciliation_required"])
            self.assertEqual(result["receipt"]["state"], "pending_reconcile")

    async def test_cancel_during_submission_and_local_receipt_write_failure_keep_save_evidence(self):
        async with self.client() as http:
            question = await self.question(http)
            cancellation = asyncio.Event()
            class CancelAfterStore:
                async def request(inner, method, path, **kwargs):
                    response = await http.request(method, path, **kwargs)
                    if method == "POST" and path.endswith("/answers"):
                        cancellation.set()
                        await asyncio.sleep(0.01)
                    return response
            original = question_client.write_new
            def local_receipt_failure(path, raw):
                if path.name == "result.json":
                    raise OSError("fixture disk failure after server storage")
                return original(path, raw)
            with patch.object(question_client, "write_new", local_receipt_failure):
                result, _ = await self.execute(CancelAfterStore(), question=question, adapter=SyntheticAdapter(), cancel_event=cancellation)
            self.assertEqual((result["status"], result["saved"]), ("stored", True), result)
            self.assertEqual(result["local_record_error"], "question_local_record_failed")
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 2)

    async def test_source_change_and_permission_revocation_stop_save(self):
        async with self.client() as http:
            for kind in ("source", "permission"):
                with self.subTest(kind=kind):
                    question = await self.question(http)
                    async def change():
                        if kind == "source":
                            before = self.stores["alpha"].read("Guide.md")
                            self.stores["alpha"].save("Guide.md", before.content + "\n추가 조건", expected_revision=before.revision)
                        else:
                            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                            self.save_policy()
                    result, _ = await self.execute(http, question=question, adapter=SyntheticAdapter(change))
                    self.assertEqual((result["status"], result["saved"]), ("failed", False), result)
                    self.assertEqual(result["error"]["code"], "conflict" if kind == "source" else "access_denied")
                    self.assertTrue((Path(result["work_dir"]) / "answer-draft.json").exists())
                    self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 1)

    async def test_conversation_cas_never_rebases_generated_answer(self):
        async with self.client() as http:
            question = await self.question(http)
            async def change():
                self.value(await http.post(self.base + "/conversations/" + question["conversation_id"] + "/turns", json={
                    "request_id": uuid4().hex, "expected_revision": question["expected_conversation_revision"], "role": "user",
                    "content": "새 사용자 질문", "profile": "business", "context_request": self.context()}))
            result, _ = await self.execute(http, question=question, adapter=SyntheticAdapter(change))
            self.assertEqual((result["status"], result["error"]["code"]), ("failed", "conflict"), result)
            stored = await self.conversation(http, question)
            self.assertEqual([item["role"] for item in stored["record"]["events"]], ["user", "user"])
            payload = json.loads((Path(result["work_dir"]) / "answer-request.json").read_text())
            self.assertEqual(payload["expected_conversation_revision"], question["expected_conversation_revision"])

    async def test_local_and_remote_cancel_stop_owned_model_and_preserve_question(self):
        async with self.client() as http:
            for remote in (False, True):
                with self.subTest(remote=remote):
                    question = await self.question(http)
                    prepared, _ = await self.execute(http, question=question)
                    event = asyncio.Event()
                    async def cancel():
                        if remote:
                            url = self.base + "/question-runs/" + prepared["question_run_id"]
                            current = self.value(await http.get(url, params={"profile": "business"}))
                            self.value(await http.post(url + "/cancel", json={"request_id": uuid4().hex, "profile": "business",
                                "expected_state_revision": current["state_revision"]}))
                        else:
                            event.set()
                        await asyncio.sleep(30)
                    adapter = SyntheticAdapter(cancel)
                    result, _ = await self.execute(http, question_run_id=prepared["question_run_id"], adapter=adapter, cancel_event=event)
                    self.assertEqual((result["status"], result["saved"], result["cancellation"]), ("cancelled", False, "confirmed"), result)
                    self.assertTrue(adapter.stopped)
                    self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 1)

    async def test_lease_expiry_and_model_failure_are_not_saved(self):
        async with self.client() as http:
            for kind in ("expiry", "model"):
                with self.subTest(kind=kind):
                    question = await self.question(http)
                    now = question_runs._now()
                    clock = [now]
                    async def fail():
                        if kind == "model":
                            raise AnalysisClientError("ai_execution_failed")
                        clock[0] += timedelta(seconds=301)
                        await asyncio.sleep(30)
                    with patch.object(question_runs, "_now", side_effect=lambda: clock[0]):
                        result, _ = await self.execute(http, question=question, adapter=SyntheticAdapter(fail))
                    self.assertEqual((result["status"], result["saved"]), ("failed", False), result)
                    self.assertEqual(result["error"]["code"], "question_lease_lost" if kind == "expiry" else "ai_execution_failed")
                    self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 1)

    async def test_bad_citation_is_rejected_and_create_claim_lost_responses_are_read(self):
        async with self.client() as http:
            question = await self.question(http)
            result, _ = await self.execute(http, question=question, adapter=SyntheticAdapter(invalid_quote=True))
            self.assertEqual((result["status"], result["saved"]), ("failed", False), result)
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 1)
            for suffix in ("/question-runs", "/claim"):
                question = await self.question(http)
                dropped = DropResponse(http, suffix=suffix)
                result, _ = await self.execute(dropped, question=question, adapter=SyntheticAdapter())
                self.assertEqual((result["status"], dropped.posts), ("stored", 1), result)

    async def test_source_only_question_pins_profile_and_original_reference(self):
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"].append("source_write")
        self.save_policy()
        async with self.client() as http:
            original = self.value(await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
                "title": "source-only", "format": "txt", "content": "원본 조건을 그대로 인용합니다."}), 201)
            reference = {key: original[key] for key in ("source_id", "source_version", "source_sha256")}
            question = await self.question(http, context={"source_refs": [reference], "profile": "business"})
            result = await run_question(base_url="http://127.0.0.1:8766", tenant="alpha", token=self.tokens["alice"],
                work_dir=self.root.resolve() / "source-question", http=http, adapter=SyntheticAdapter(), **question)
            self.assertEqual((result["status"], result["saved"]), ("stored", True), result)
            stored = (await self.conversation(http, question))["record"]["events"][-1]
            self.assertEqual(stored["basis"]["documents"], [])
            self.assertEqual(stored["citations"][0]["source_sha256"], reference["source_sha256"])
            self.assertEqual(stored["citations"][0]["layer"], "original_source")
            self.assertEqual(stored["actor"]["profile_id"], "business")

    async def test_model_schema_blocks_invented_source_and_preserves_raw_result_without_retry(self):
        class BadReferenceAdapter(SyntheticAdapter):
            async def run(inner, *, prompt, schema, directory, on_event=None):
                result = await super().run(prompt=prompt, schema=schema, directory=directory, on_event=on_event)
                self.assertTrue(Draft202012Validator(schema).is_valid(result["value"]))
                quote = result["value"]["citations"][0]["quote"]
                result["value"]["citations"] = [{"kind": "source", "source_id": "1" * 32,
                    "source_version": "2" * 32, "source_sha256": "3" * 64, "quote": quote}]
                self.assertFalse(Draft202012Validator(schema).is_valid(result["value"]))
                return result
        async with self.client() as http:
            question = await self.question(http)
            adapter = BadReferenceAdapter()
            result, _ = await self.execute(http, question=question, adapter=adapter)
            self.assertEqual((result["status"], result["saved"], adapter.calls), ("failed", False, 1))
            self.assertEqual(result["error"]["code"], "ai_invalid_result")
            raw = json.loads((Path(result["work_dir"]) / "answer-result.json").read_text())
            self.assertEqual(raw["value"]["citations"][0]["source_id"], "1" * 32)
            self.assertFalse((Path(result["work_dir"]) / "answer-request.json").exists())
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 1)

    async def test_unconfirmed_receipt_blocks_new_model_and_foreign_owner_is_denied(self):
        async with self.client() as http:
            question = await self.question(http)
            original = workflow_io.files.write_json
            def fail_evidence(store, path, value):
                if path.name == "saved.json":
                    raise OSError("fixture storage evidence failure")
                return original(store, path, value)
            # 실제 대화는 저장되지만 독립 영수증 기록과 HTTP 응답을 둘 다 잃은 경우다.
            with patch.object(workflow_io.files, "write_json", fail_evidence):
                result, _ = await self.execute(DropResponse(http), question=question, adapter=SyntheticAdapter())
            self.assertEqual((result["status"], result["saved"]), ("unconfirmed", None), result)
            adapter = SyntheticAdapter()
            repeated, _ = await self.execute(http, question_run_id=result["question_run_id"], adapter=adapter)
            self.assertEqual((repeated["status"], adapter.calls), ("unconfirmed", 0))
            self.assertEqual(len((await self.conversation(http, question))["record"]["events"]), 2)
            http.headers.update(self.headers("carol"))
            denied, _ = await self.execute(http, question_run_id=result["question_run_id"], adapter=adapter)
            self.assertEqual((denied["status"], denied["error"]["code"], adapter.calls), ("failed", "not_found", 0))

    def test_preview_ignores_reasoning_and_preserves_json_escape_boundaries(self):
        events = []
        preview = AnswerPreview(lambda kind, **fields: events.append((kind, fields)))
        preview({"type": "item.updated", "item": {"type": "reasoning", "text": '{"content":"private"}'}})
        for raw in ('{"content":"line\\nnext\\', '{"citations":[],"content":"한글', '{"content":"\\ud83c', '{"content":"\\ud83c\\udf31"}'):
            preview({"type": "agent_message", "text": raw})
        self.assertEqual([item[1]["content"] for item in events], ["line\nnext", "한글", "🌱"])


if __name__ == "__main__":
    unittest.main()
