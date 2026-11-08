"""근거 추가 조회 클라이언트의 범위·인용·사용량·실패 수명을 합성 실행으로 확인한다."""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from jsonschema import Draft202012Validator

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution, QuestionClientError
from core.client.question_ai import assemble_question, answer_payload, question_answer_schema
from core.client.question_grounding import grounding_prompt, initial_grounding_prompt, run_grounded_model, _draft_max_characters, MAX_CONTEXT_BYTES, MAX_READS
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.personal.question_grounding import INSTRUCTIONS
from core.runtime.client_platform import write_new


def handoff_fixture():
    """실제 입력처럼 자료 안내만 주며 정답·원문·그래프를 미리 주지 않는다."""
    value = {"question_run_id": "1" * 32, "contract_version": "personal-question-v5",
        "question": "이 장치의 서명 검증 조건은 무엇인가?", "instructions": INSTRUCTIONS,
        "basis": {"kind": "question_basis_ref_v1", "basis_id": "b" * 64,
            "documents": [{"id": "d1", "document": "signing.md", "title": "Signing", "line_count": 10}],
            "originals": []}, "output": {"citations": "Only actually served evidence IDs"},
        "conversation_context": {"purpose": "dialogue_context_only", "turn_count": 0}}
    value["input_sha256"] = canonical_json_hash(value)
    return value


def record_for(handoff):
    return {"id": handoff["question_run_id"], "data": {"question": handoff["question"], "basis": handoff["basis"],
        "input_contract_version": handoff["contract_version"], "input_instructions": handoff["instructions"],
        "output_contract": handoff["output"], "conversation_context": handoff["conversation_context"]}}


def step(action, **values):
    result = {"action": action, "query": None, "material_id": None, "start_line": None,
              "line_count": None, "start_character": None, "character_count": None,
              "offset": None, "limit": None, "content": None, "evidence_ids": []}
    return {**result, **values}


def covered(action, *, parts=(), covers=(), answers=(), **values):
    return {**step(action, **values), "parts": list(parts), "covers": list(covers), "answers": list(answers)}


def part_answer(number, text, ids=(), status="supported", source_context=()):
    return {"part": number, "status": status, "text": text, "evidence_ids": list(ids),
            "source_context": list(source_context)}


def evidence(identifier="s1:2:2", quote="Verification is enabled only when a key is configured."):
    citation = {"kind": "document", "document": "signing.md", "source_revision": "a" * 64, "quote": quote}
    return {"kind": "question_evidence", "action": "read",
        "items": [{"kind": "source", "material_id": "d1", "evidence_id": identifier, "text": quote}],
        "evidence_ids": [identifier], "citations": [{"evidence_id": identifier, "citation": citation}],
        "scope": {"coverage": "query_result_only", "absence_proven": False}, "total_matches": 1,
        "complete": True, "truncated": False, "skipped": [], "next_offset": None}


class FakeAdapter:
    """모델 없이 지문과 원시 step 산출물을 남기는 작은 어댑터다."""
    def __init__(self, values, *, fail_at=None, usage_missing_at=()):
        self.values, self.calls, self.fail_at = list(values), [], fail_at
        self.usage_missing_at = set(usage_missing_at)
        self.persist_session = True

    async def run(self, *, prompt, schema, directory, **kwargs):
        number = len(self.calls) + 1
        directory = Path(directory)
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.calls.append({"prompt": prompt, "schema": deepcopy(schema), "directory": directory,
                           "options": kwargs, "persist_session": self.persist_session})
        write_new(directory / "prompt.txt", prompt.encode())
        write_new(directory / "source-schema.json", canonical_json_bytes(schema))
        if self.fail_at == number:
            write_new(directory / "execution.json", canonical_json_bytes({"status": "failed", "error_code": "ai_timeout"}))
            raise AIAdapterError("ai_timeout")
        value = deepcopy(self.values[number - 1])
        raw = canonical_json_bytes(value)
        write_new(directory / "result.json", raw)
        metadata = {"provider": "codex", "cli_version": "test-cli", "requested_model": None, "reported_model": "test-model",
            "status": "completed", "prompt_sha256": sha256(prompt.encode()).hexdigest(),
            "output_sha256": sha256(raw).hexdigest(),
            "token_usage": None if number in self.usage_missing_at else {"origin": "provider_reported", "reports": [
                {"origin": "provider_reported", "tokens": {"input_tokens": number * 10, "output_tokens": number,
                                                           "cached_input_tokens": number - 1}}]}}
        write_new(directory / "execution.json", canonical_json_bytes(metadata))
        return {"value": value, "execution": metadata}


class FakeOwner:
    """서버 쓰기 없이 질의 순서·취소·로컬 기록을 관측한다."""
    def __init__(self, directory, responses=(), *, fail_query=None, cancel_after_query=False):
        self.directory, self.responses = Path(directory), list(responses)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.queries, self.events = [], []
        self.cancelled = False
        self.fail_query, self.cancel_after_query = fail_query, cancel_after_query

    def check_cancel(self):
        if self.cancelled:
            raise QuestionClientError("question_cancelled")

    def record(self, name, value):
        write_new(self.directory / name, canonical_json_bytes(value))

    def emit(self, kind, **values):
        self.events.append((kind, values))

    async def guarded_model(self, adapter, prompt, schema, *, allow_preview=True, **options):
        self.events.append(("model_preview_setting", {"allow_preview": allow_preview}))
        return await adapter.run(prompt=prompt, schema=schema, **options)

    async def query_evidence(self, query):
        self.queries.append(deepcopy(query))
        if self.fail_query is not None:
            raise self.fail_query
        result = deepcopy(self.responses[len(self.queries) - 1])
        if self.cancel_after_query:
            self.cancelled = True
        return result


class GroundedQuestionClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.handoff = handoff_fixture()

    async def test_initial_prompt_has_catalog_only_not_full_graph_history_or_answer_key(self):
        self.handoff["not_model_input"] = {"machine_graph": "FULL_GRAPH_SENTINEL", "history": "FULL_HISTORY_SENTINEL"}
        prompt = grounding_prompt(self.handoff, [])
        self.assertIn("Signing", prompt)
        self.assertIn("d1", prompt)
        self.assertNotIn("FULL_GRAPH_SENTINEL", prompt)
        self.assertNotIn("FULL_HISTORY_SENTINEL", prompt)
        self.assertIn("catalog is not source text", prompt)
        self.assertIn("read the neighboring passages/definitions/exceptions", prompt)
        self.assertIn("not human approval", prompt)
        self.assertIn("Earlier dialogue helps interpret the question but is not current factual evidence", prompt)
        self.assertLess(len(prompt.encode()), 8192)

    async def test_search_read_answer_accumulates_all_actual_usage_and_exact_citations(self):
        first, second = evidence("s1:2:2"), evidence("s1:3:3", "Unsigned artifacts abort under that configuration.")
        owner = FakeOwner(self.root / "run", [first, second])
        adapter = FakeAdapter([step("search", query="ArtifactVerifyKey"),
            step("read", material_id="d1", start_line=3, line_count=1),
            step("answer", content="검증키 설정이 필요합니다. [[s1:2:2]]", evidence_ids=["s1:2:2"]),
            step("answer", content="검증키 설정이 필요합니다. [[s1:2:2]] 미서명 파일은 중단합니다. [[s1:3:3]]",
                 evidence_ids=["s1:3:3", "s1:2:2"])])
        result, prompt = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(len(adapter.calls), 4)
        self.assertEqual([q["action"] for q in owner.queries], ["search", "read"])
        self.assertEqual(result["value"]["citations"], [first["citations"][0]["citation"], second["citations"][0]["citation"]])
        self.assertEqual(result["execution"]["question_evidence_reads"], 2)
        reports = result["execution"]["token_usage"]["reports"]
        self.assertEqual(sum(r["tokens"]["input_tokens"] for r in reports), 100)
        self.assertEqual(sum(r["tokens"]["output_tokens"] for r in reports), 10)
        self.assertEqual(sum(r["tokens"]["cached_input_tokens"] for r in reports), 6)
        self.assertEqual(len(result["execution"]["question_invocations"]), 4)
        self.assertNotIn("a" * 64, adapter.calls[1]["prompt"])
        self.assertIn(first["items"][0]["text"], adapter.calls[1]["prompt"])
        self.assertIn(second["items"][0]["text"], prompt)
        payload = answer_payload(result, handoff=self.handoff, prompt=prompt)
        self.assertEqual(payload["execution"]["prompt_sha256"], sha256(prompt.encode()).hexdigest())
        self.assertEqual(payload["execution"]["output_sha256"], sha256(payload["content"].encode()).hexdigest())
        self.assertEqual(payload["evidence_ids"], ["s1:2:2", "s1:3:3"])
        self.assertEqual(payload["content"], "검증키 설정이 필요합니다. [1] 미서명 파일은 중단합니다. [2]")
        self.assertIn("proposed_draft_not_evidence", prompt)
        self.assertEqual(result["execution"]["question_answer_check"]["draft_step"], 2)
        self.assertTrue(all(not value["allow_preview"] for kind, value in owner.events if kind == "model_preview_setting"))
        previews = [value["content"] for kind, value in owner.events if kind == "answer_preview"]
        self.assertEqual(previews, [payload["content"]])

    async def test_each_step_has_its_own_prompt_raw_output_and_metadata_artifact(self):
        owner = FakeOwner(self.root / "run", [evidence()])
        answer = step("answer", content="확인했습니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])
        values = [step("read", material_id="d1"), answer, deepcopy(answer)]
        adapter = FakeAdapter(values)
        await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        for index, call in enumerate(adapter.calls):
            raw = json.loads((owner.directory / f"evidence-model-{index:02d}.json").read_bytes())
            self.assertEqual(raw["value"], values[index])
            self.assertEqual(json.loads((call["directory"] / "result.json").read_bytes()), values[index])
            metadata = json.loads((call["directory"] / "execution.json").read_bytes())
            self.assertEqual(metadata["prompt_sha256"], sha256((call["directory"] / "prompt.txt").read_bytes()).hexdigest())
            self.assertEqual(metadata["output_sha256"], sha256((call["directory"] / "result.json").read_bytes()).hexdigest())

    async def test_draft_check_can_read_a_missing_condition_before_final_answer(self):
        first = evidence("s1:2:2", "The gate opens after inspection.")
        second = evidence("s1:8:8", "The gate stays closed if temperature exceeds its limit.")
        first["read_window"] = {"returned_ranges": [[2, 2]], "remaining_ranges": [[8, 8]],
                                "unavailable_ranges": [], "next_start_line": 8}
        owner = FakeOwner(self.root / "check-read", [first, second])
        draft = step("answer", content="점검 후 열립니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])
        final = step("answer", content="점검 후 열리지만 [[s1:2:2]] 온도 한도 초과 시에는 닫힙니다. [[s1:8:8]]",
                     evidence_ids=["s1:8:8", "s1:2:2"])
        adapter = FakeAdapter([step("read", material_id="d1", start_line=2), draft,
                               step("read", material_id="d1", start_line=8), final])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual([q["start_line"] for q in owner.queries], [2, 8])
        self.assertIn("proposed_draft_not_evidence", adapter.calls[2]["prompt"])
        self.assertIn("remaining_ranges", adapter.calls[2]["prompt"])
        self.assertIn(second["items"][0]["text"], adapter.calls[3]["prompt"])
        self.assertNotIn('"content":"점검 후 열립니다.', adapter.calls[3]["prompt"])
        self.assertIn("superseded_after_additional_read", adapter.calls[3]["prompt"])
        self.assertEqual(result["value"]["content"], "점검 후 열리지만 [1] 온도 한도 초과 시에는 닫힙니다. [2]")
        self.assertEqual(result["evidence_ids"], ["s1:2:2", "s1:8:8"])
        self.assertEqual(result["execution"]["question_answer_check"],
                         {"draft_step": 1, "final_step": 3, "independent_expert_validation": False})
        self.assertEqual(sum(value.get("phase") == "answer_checking" for _, value in owner.events), 1)

    async def test_default_keeps_adopted_renderer_without_experimental_model_contract(self):
        owner = FakeOwner(self.root / "default", [evidence()])
        adapter = FakeAdapter([step("read", material_id="d1"),
            step("answer", content="확인 [[s1:2:2]]", evidence_ids=["s1:2:2"])])
        result, prompt = await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(result["value"]["content"], "확인 [1]")
        self.assertEqual(result["evidence_ids"], ["s1:2:2"])
        self.assertIsNone(result["execution"]["question_answer_check"]["draft_step"])
        self.assertFalse(any(value.get("phase") == "answer_checking" for _, value in owner.events))
        self.assertNotIn("Your first answer is a proposed draft", prompt)
        self.assertNotIn("question_coverage", result["execution"])
        self.assertEqual(adapter.calls[0]["prompt"], assemble_question(self.handoff, record_for(self.handoff)))
        self.assertNotIn("parts", adapter.calls[0]["schema"]["properties"])

    async def test_final_check_cannot_add_an_unread_citation_or_manual_number(self):
        for index, final in enumerate((
            step("answer", content="근거 없는 조건 [[s1:8:8]]", evidence_ids=["s1:8:8"]),
            step("answer", content="수동 번호 [1]", evidence_ids=["s1:2:2"]),
        )):
            owner = FakeOwner(self.root / f"invalid-check-{index}", [evidence()])
            draft = step("answer", content="확인 [[s1:2:2]]", evidence_ids=["s1:2:2"])
            adapter = FakeAdapter([step("read", material_id="d1"), draft, final])
            with self.subTest(index=index), self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
            self.assertEqual(len(adapter.calls), 3)
            self.assertEqual(len(owner.queries), 1)

    async def test_draft_limit_reserves_whole_utf8_and_json_escape_review_context(self):
        maximum = _draft_max_characters(self.handoff, [], {})
        self.assertGreater(maximum, 1000)
        self.assertLess(maximum, 65000)
        # 가장 비싼 JSON 제어문자와 한글/비BMP도 생성 후 자르지 않고 그대로 검사한다.
        for character in ("\x00", "한", "\U0001f680"):
            draft = {"content": character * maximum, "evidence_ids": []}
            self.assertLessEqual(len(grounding_prompt(self.handoff, [], draft, check_draft=True).encode()), MAX_CONTEXT_BYTES)
        answer = step("answer", content="한" * maximum)
        owner = FakeOwner(self.root / "bounded-draft")
        adapter = FakeAdapter([answer, deepcopy(answer)])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(result["value"]["content"], answer["content"])
        self.assertEqual(adapter.calls[0]["schema"]["properties"]["content"]["maxLength"], maximum)
        self.assertTrue(all(len(call["prompt"].encode()) <= MAX_CONTEXT_BYTES for call in adapter.calls))

    async def test_guarded_model_suppresses_step_preview_and_restores_existing_callback(self):
        events, callbacks = [], []
        owner = _QuestionExecution(None, base="http://127.0.0.1:8766", tenant="team", directory=self.root,
            profile="default", on_event=events.append, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=60)
        async def monitor():
            await asyncio.Event().wait()
        owner.monitor = monitor
        old = callbacks.append
        class StreamingAdapter:
            on_event = old
            async def run(self, *, prompt, schema, directory, on_event=None):
                callback = on_event or self.on_event
                if callback is not None:
                    callback({"type": "agent_message", "text": '{"content":"Draft [[s1:2:2]]"}'})
                return {"value": {"content": "raw draft"}}
        adapter = StreamingAdapter()
        await owner.guarded_model(adapter, "prompt", {}, allow_preview=False)
        self.assertEqual(events, [])
        self.assertEqual(callbacks, [])
        self.assertIs(adapter.on_event, old)

    async def test_missing_usage_is_kept_unknown_in_individual_invocation(self):
        owner = FakeOwner(self.root / "run", [evidence()])
        answer = step("answer", content="범위 내 확인. [[s1:2:2]]", evidence_ids=["s1:2:2"])
        adapter = FakeAdapter([step("search", query="key"), answer, deepcopy(answer)],
                              usage_missing_at={2})
        result, _ = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertIsNone(result["execution"]["question_invocations"][1]["token_usage"])
        self.assertEqual(len(result["execution"]["token_usage"]["reports"]), 2)

    async def test_unknown_final_id_and_duplicate_ids_are_rejected_without_retry(self):
        for index, ids in enumerate((["s1:9:9"], ["s1:2:2", "s1:2:2"])):
            owner = FakeOwner(self.root / str(index), [evidence()])
            adapter = FakeAdapter([step("read", material_id="d1"), step("answer", content="답변", evidence_ids=ids)])
            with self.subTest(ids=ids), self.assertRaises(AIAdapterError) as caught:
                await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
            self.assertEqual(caught.exception.code, "ai_invalid_result")
            self.assertEqual(len(adapter.calls), 2)
            self.assertEqual(len(owner.queries), 1)

    async def test_served_id_and_citation_mapping_mismatch_is_rejected(self):
        for index, change in enumerate(("foreign", "missing", "duplicate")):
            response = evidence()
            if change == "foreign":
                response["citations"][0]["evidence_id"] = "s1:9:9"
            elif change == "missing":
                response["citations"] = []
            else:
                response["citations"].append(deepcopy(response["citations"][0]))
            owner = FakeOwner(self.root / change, [response])
            adapter = FakeAdapter([step("read", material_id="d1"), step("answer", content="답변", evidence_ids=["s1:2:2"])])
            with self.subTest(change=change):
                with self.assertRaises(AIAdapterError) as caught:
                    await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
                self.assertEqual(caught.exception.code, "ai_invalid_result")
                self.assertEqual(len(adapter.calls), 1)

    async def test_same_short_id_cannot_change_to_another_full_citation(self):
        changed = evidence(quote="Different retained text.")
        owner = FakeOwner(self.root / "run", [evidence(), changed])
        adapter = FakeAdapter([step("search", query="key"), step("read", material_id="d1")])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(caught.exception.code, "ai_invalid_result")
        self.assertEqual(len(adapter.calls), 2)

    async def test_invalid_step_is_preserved_and_not_executed_or_retried(self):
        invalid = [step("invented"), step("read", material_id="d1", content="not a final answer"),
                   step("read", material_id="d1", evidence_ids=["s1:2:2"])]
        for index, value in enumerate(invalid):
            owner = FakeOwner(self.root / str(index))
            adapter = FakeAdapter([value])
            with self.subTest(index=index), self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
            self.assertEqual(len(adapter.calls), 1)
            self.assertEqual(owner.queries, [])
            self.assertTrue((owner.directory / "evidence-model-00.json").exists())

    async def test_six_queries_force_draft_and_check_to_answer_with_no_extra_query(self):
        response = {**evidence(), "evidence_ids": [], "citations": [], "items": []}
        owner = FakeOwner(self.root / "run", [response] * MAX_READS)
        adapter = FakeAdapter([step("search", query="condition")] * MAX_READS +
                              [step("answer", content="근거를 확인하지 못했습니다.")] * 2)
        result, _ = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(len(owner.queries), MAX_READS)
        self.assertEqual(len(adapter.calls), MAX_READS + 2)
        self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])
        self.assertIn("next step must be answer", adapter.calls[-1]["prompt"])
        self.assertEqual(result["value"]["citations"], [])

    async def test_seventh_query_is_rejected_and_never_sent_to_server(self):
        response = {**evidence(), "evidence_ids": [], "citations": [], "items": []}
        owner = FakeOwner(self.root / "run", [response] * MAX_READS)
        adapter = FakeAdapter([step("search", query="condition")] * (MAX_READS + 1))
        with self.assertRaises(AIAdapterError):
            await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(len(owner.queries), MAX_READS)
        self.assertEqual(len(adapter.calls), MAX_READS + 1)

    async def test_v5_never_uses_native_session_resume(self):
        owner = FakeOwner(self.root / "run", [evidence()])
        answer = step("answer", content="확인 [[s1:2:2]]", evidence_ids=["s1:2:2"])
        adapter = FakeAdapter([step("read", material_id="d1"), answer, deepcopy(answer)])
        await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertFalse(adapter.persist_session)
        self.assertTrue(all(call["persist_session"] is False for call in adapter.calls))
        self.assertTrue(all("session_id" not in call["options"] for call in adapter.calls))
        self.assertNotEqual(adapter.calls[0]["directory"], adapter.calls[1]["directory"])

    async def test_question_execution_dispatches_v5_without_legacy_session_lookup(self):
        fake = FakeOwner(self.root / "actual-route", [evidence()])
        owner = _QuestionExecution(None, base="http://127.0.0.1:8766", tenant="team", directory=fake.directory,
            profile="default", on_event=None, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=60)
        class ForbiddenSessions:
            def lookup(self, *args, **kwargs):
                raise AssertionError("v5 must not resume an old native session")
        owner.sessions = ForbiddenSessions()
        owner.guarded_model, owner.query_evidence = fake.guarded_model, fake.query_evidence
        adapter = FakeAdapter([step("read", material_id="d1"),
            step("answer", content="확인 [[s1:2:2]]", evidence_ids=["s1:2:2"])])
        result, prompt = await owner.run_model(adapter, self.handoff, "LEGACY_FULL_PROMPT_SENTINEL", {}, record_for(self.handoff))
        self.assertEqual(result["evidence_ids"], ["s1:2:2"])
        self.assertNotIn("LEGACY_FULL_PROMPT_SENTINEL", prompt)
        self.assertFalse(adapter.persist_session)
        self.assertEqual(len(adapter.calls), 2)

    async def test_dialogue_is_fetched_explicitly_and_does_not_create_factual_citations(self):
        dialogue = {"kind": "question_evidence", "action": "dialogue", "items": [
            {"role": "assistant", "content": "OLD_ASSISTANT_UNVERIFIED_STATEMENT"}],
            "evidence_ids": [], "citations": [], "scope": {"purpose": "dialogue_context_only"},
            "complete": True, "truncated": False, "skipped": [], "next_offset": None}
        owner = FakeOwner(self.root / "dialogue", [dialogue, evidence()])
        answer = step("answer", content="현재 근거로 확인했습니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])
        adapter = FakeAdapter([step("dialogue", offset=0, limit=2), step("read", material_id="d1"),
            answer, deepcopy(answer)])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertNotIn("OLD_ASSISTANT_UNVERIFIED_STATEMENT", adapter.calls[0]["prompt"])
        self.assertIn("OLD_ASSISTANT_UNVERIFIED_STATEMENT", adapter.calls[1]["prompt"])
        self.assertEqual(len(result["value"]["citations"]), 1)
        self.assertEqual([q["action"] for q in owner.queries], ["dialogue", "read"])

    async def test_cancel_before_start_and_between_steps_stops_without_extra_calls(self):
        first = FakeOwner(self.root / "first")
        first.cancelled = True
        adapter = FakeAdapter([])
        with self.assertRaises(QuestionClientError) as caught:
            await run_grounded_model(first, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(caught.exception.code, "question_cancelled")
        self.assertEqual(adapter.calls, [])
        second = FakeOwner(self.root / "second", [evidence()], cancel_after_query=True)
        adapter = FakeAdapter([step("read", material_id="d1")])
        with self.assertRaises(QuestionClientError):
            await run_grounded_model(second, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(len(second.queries), 1)

    async def test_model_and_query_failures_do_not_trigger_automatic_model_retry(self):
        owner = FakeOwner(self.root / "model")
        adapter = FakeAdapter([step("answer", content="unused")], fail_at=1)
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(caught.exception.code, "ai_timeout")
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(owner.queries, [])
        self.assertTrue((owner.directory / "evidence-step-00/execution.json").exists())
        owner = FakeOwner(self.root / "query", fail_query=QuestionClientError("conflict"))
        adapter = FakeAdapter([step("read", material_id="d1")])
        with self.assertRaises(QuestionClientError):
            await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(len(adapter.calls), 1)
        self.assertTrue((owner.directory / "evidence-model-00.json").exists())

    async def test_context_byte_limit_rejects_before_first_and_next_model_call(self):
        self.handoff["question"] = "한" * MAX_CONTEXT_BYTES
        owner, adapter = FakeOwner(self.root / "too-big"), FakeAdapter([])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, check_draft=True, cover_question=False)
        self.assertEqual(caught.exception.code, "ai_input_limit")
        self.assertEqual(adapter.calls, [])
        small = handoff_fixture()
        fixed = len(grounding_prompt(small, []).encode()) - len(small["question"].encode())
        small["question"] = "x" * (MAX_CONTEXT_BYTES - fixed - 1024)
        response = evidence(quote="retrieved " * 512)
        owner, adapter = FakeOwner(self.root / "next", [response]), FakeAdapter([step("read", material_id="d1")])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, small, check_draft=True, cover_question=False)
        self.assertEqual(caught.exception.code, "ai_input_limit")
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(len(owner.queries), 1)

    async def test_v5_answer_schema_keeps_web_and_review_distinct_and_validates_prompt_hash(self):
        self.handoff["basis"]["web"] = {"status": "complete", "sources": []}
        schema = question_answer_schema(self.handoff)
        web = {"kind": "web", "url": "https://example.org/a", "title": "A", "content_sha256": "a" * 64,
               "retrieved_at": "2026-11-06T00:00:00Z", "quote": "Reported capability."}
        review = {"kind": "review", "ledger": "relation", "document": "a.md", "state_revision": "a" * 64,
                  "event_id": "1" * 32}
        self.assertTrue(Draft202012Validator(schema).is_valid({"content": "문맥", "citations": [web, review]}))
        self.assertFalse(Draft202012Validator(schema).is_valid({"content": "문맥", "citations": [{**review, "ledger": "invented"}]}))
        value = handoff_fixture()
        self.assertEqual(assemble_question(value, record_for(value)), initial_grounding_prompt(value))
        changed = deepcopy(value)
        changed["question"] = "changed"
        with self.assertRaises(AnalysisClientError):
            assemble_question(changed, record_for(value))
        owner, adapter = FakeOwner(self.root / "hash"), FakeAdapter([step("answer", content="확인 불가")] * 2)
        result, prompt = await run_grounded_model(owner, adapter, value, check_draft=True, cover_question=False)
        result["execution"]["prompt_sha256"] = "0" * 64
        with self.assertRaises(AnalysisClientError):
            answer_payload(result, handoff=value, prompt=prompt)


class CoveredGroundingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.handoff = handoff_fixture()

    async def test_opt_in_keeps_every_requested_part_without_an_extra_model_call(self):
        owner = FakeOwner(self.root / "parts", [evidence()])
        labels = ["적용 조건", "적용하지 않는 경우"]
        adapter = FakeAdapter([
            covered("read", parts=labels, covers=[1, 2], material_id="d1"),
            covered("answer", answers=[
                part_answer(2, "예외도 확인합니다. [[s1:2:2]]", ["s1:2:2"]),
                part_answer(1, "설정이 조건입니다. [[s1:2:2]]", ["s1:2:2"]),
            ]),
        ])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(len(owner.queries), 1)
        self.assertNotIn("parts", owner.queries[0])
        self.assertNotIn("covers", owner.queries[0])
        self.assertLess(result["value"]["content"].index(labels[0]), result["value"]["content"].index(labels[1]))
        self.assertIn("설정이 조건입니다. [1]", result["value"]["content"])
        self.assertIn("예외도 확인합니다. [1]", result["value"]["content"])
        self.assertEqual(result["evidence_ids"], ["s1:2:2"])
        self.assertEqual(adapter.calls[0]["prompt"], initial_grounding_prompt(self.handoff, cover_question=True))
        payload = answer_payload(result, handoff=self.handoff, prompt=adapter.calls[-1]["prompt"])
        self.assertEqual(payload["execution"]["output_sha256"], sha256(payload["content"].encode()).hexdigest())
        self.assertIn("question_coverage", result["execution"])

    async def test_source_conditions_and_attribution_survive_final_assembly_without_extra_model(self):
        first = evidence("s1:2:2", "The service can start after inspection.")
        second = evidence("s1:3:3", "The manufacturer claims it stays available only under the stated load.")
        response = {**first, "items": first["items"] + second["items"],
                    "evidence_ids": first["evidence_ids"] + second["evidence_ids"],
                    "citations": first["citations"] + second["citations"]}
        owner = FakeOwner(self.root / "scope-preservation", [response])
        context = [
            {"kind": "condition", "text": "점검을 마쳐야 합니다. [[s1:2:2]]", "evidence_ids": ["s1:2:2"]},
            {"kind": "source_claim", "text": "가용성은 지정 부하에서의 제조사 주장입니다. [[s1:3:3]]", "evidence_ids": ["s1:3:3"]},
        ]
        adapter = FakeAdapter([
            covered("read", parts=["작동 범위"], covers=[1], material_id="d1"),
            covered("answer", answers=[part_answer(1, "점검 이후 시작할 수 있습니다. [[s1:2:2]]", ["s1:2:2"], source_context=context)]),
        ])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), 2)
        self.assertIn("점검을 마쳐야 합니다. [1]", result["value"]["content"])
        self.assertIn("가용성은 지정 부하에서의 제조사 주장입니다. [2]", result["value"]["content"])
        self.assertEqual(result["evidence_ids"], ["s1:2:2", "s1:3:3"])
        self.assertIn("source_scope_preservation", result["execution"]["question_coverage"])

    async def test_mutating_the_plan_is_rejected_before_another_source_request(self):
        owner = FakeOwner(self.root / "mutation", [evidence()])
        adapter = FakeAdapter([
            covered("read", parts=["요청 하나", "요청 둘"], covers=[1], material_id="d1"),
            covered("read", parts=["요청 하나"], covers=[1], material_id="d1"),
        ])
        with self.assertRaises(AIAdapterError):
            await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(owner.queries), 1)
        self.assertEqual(len(adapter.calls), 2)
        self.assertTrue((owner.directory / "evidence-model-01.json").exists())

    async def test_a_final_answer_cannot_silently_drop_a_frozen_request(self):
        owner = FakeOwner(self.root / "missing", [evidence()])
        adapter = FakeAdapter([
            covered("read", parts=["요청 하나", "요청 둘"], covers=[1, 2], material_id="d1"),
            covered("answer", answers=[part_answer(1, "하나만 답함 [[s1:2:2]]", ["s1:2:2"])]),
        ])
        with self.assertRaises(AIAdapterError):
            await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), 2)
        self.assertFalse(any(kind == "answer_preview" for kind, _ in owner.events))

    async def test_unchecked_request_is_visible_only_when_reads_are_exhausted(self):
        owner = FakeOwner(self.root / "limit", [evidence()] * MAX_READS)
        first = covered("read", parts=["해결된 요청", "아직 안 읽은 요청"], covers=[1], material_id="d1")
        more = covered("read", covers=[1], material_id="d1")
        final = covered("answer", answers=[
            part_answer(1, "근거가 있습니다. [[s1:2:2]]", ["s1:2:2"]),
            part_answer(2, "허용된 조회 안에서 이 항목은 확인하지 못했습니다.", status="not_checked"),
        ])
        adapter = FakeAdapter([first] + [more] * (MAX_READS - 1) + [final])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), MAX_READS + 1)
        self.assertEqual(len(owner.queries), MAX_READS)
        self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])
        self.assertIn("미확인", result["value"]["content"])
        self.assertIn("아직 안 읽은 요청", result["value"]["content"])

    async def test_early_unchecked_or_unqueried_not_found_is_rejected(self):
        for status in ("not_checked", "not_found"):
            owner = FakeOwner(self.root / status, [evidence()])
            adapter = FakeAdapter([
                covered("read", parts=["첫 요청", "둘째 요청"], covers=[1], material_id="d1"),
                covered("answer", answers=[
                    part_answer(1, "확인 [[s1:2:2]]", ["s1:2:2"]),
                    part_answer(2, "확인 불가", status=status),
                ]),
            ])
            with self.subTest(status=status), self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
            self.assertEqual(len(owner.queries), 1)

    async def test_successful_empty_search_reports_a_limited_unknown_without_fake_citations(self):
        response = {**evidence(), "items": [], "evidence_ids": [], "citations": [], "total_matches": 0}
        owner = FakeOwner(self.root / "empty-search", [response])
        adapter = FakeAdapter([
            covered("search", parts=["질문 조건"], covers=[1], query="unknown condition"),
            covered("answer", answers=[part_answer(1, "이 검색 결과에서 필요한 조건을 확인하지 못했습니다.", status="not_found")]),
        ])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertIn("확인 불가", result["value"]["content"])
        self.assertEqual(result["value"]["citations"], [])

    async def test_no_materials_can_return_a_scoped_unchecked_answer_without_queries(self):
        self.handoff["basis"]["documents"] = []
        self.handoff.pop("input_sha256")
        self.handoff["input_sha256"] = canonical_json_hash(self.handoff)
        owner = FakeOwner(self.root / "no-material")
        adapter = FakeAdapter([covered("answer", parts=["요청 조건"],
            answers=[part_answer(1, "선택된 자료가 없어 확인하지 못했습니다.", status="not_checked")])])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(owner.queries, [])
        self.assertIn("미확인", result["value"]["content"])

    async def test_initial_dialogue_answer_is_scoped_without_inventing_source_citations(self):
        self.handoff["conversation_context"]["turns"] = [{"role": "assistant", "content": "앞서 점검을 먼저 하자고 했습니다."}]
        self.handoff.pop("input_sha256")
        self.handoff["input_sha256"] = canonical_json_hash(self.handoff)
        owner = FakeOwner(self.root / "prior-turn")
        adapter = FakeAdapter([covered("answer", parts=["앞서 한 제안"],
            answers=[part_answer(1, "앞서 점검을 먼저 하자고 했습니다.", status="context_only")])])
        result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(adapter.calls[0]["prompt"], initial_grounding_prompt(self.handoff, cover_question=True))
        self.assertIn("이전 대화", result["value"]["content"])
        self.assertEqual(result["value"]["citations"], [])

    async def test_fetched_dialogue_is_not_a_factual_search_or_an_automatic_absence_proof(self):
        response = {"items": [{"role": "user", "content": "점검 결과를 비교해 주세요."}],
                    "citations": [], "evidence_ids": [], "complete": True, "truncated": False, "skipped": []}
        for status, accepted in (("context_only", True), ("not_found", False)):
            owner = FakeOwner(self.root / f"dialogue-{status}", [response])
            adapter = FakeAdapter([
                covered("dialogue", parts=["앞선 요청"], covers=[1], offset=0),
                covered("answer", answers=[part_answer(1, "앞서 점검 결과 비교를 요청했습니다.", status=status)]),
            ])
            if accepted:
                result, _ = await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
                self.assertIn("이전 대화", result["value"]["content"])
            else:
                with self.assertRaises(AIAdapterError):
                    await run_grounded_model(owner, adapter, self.handoff, cover_question=True)

    async def test_cancel_and_failed_queries_never_produce_an_answer_or_retry(self):
        for cancelled in (True, False):
            owner = FakeOwner(self.root / str(cancelled), [evidence()], cancel_after_query=cancelled,
                              fail_query=None if cancelled else QuestionClientError("conflict"))
            adapter = FakeAdapter([covered("read", parts=["질문"], covers=[1], material_id="d1")])
            with self.subTest(cancelled=cancelled), self.assertRaises(QuestionClientError):
                await run_grounded_model(owner, adapter, self.handoff, cover_question=True)
            self.assertEqual(len(adapter.calls), 1)
            self.assertFalse(any(kind == "answer_preview" for kind, _ in owner.events))


class FakeResponse:
    def __init__(self, status, value):
        self.status_code, self.value = status, value
        self.content = canonical_json_bytes(value)

    def json(self):
        return deepcopy(self.value)


class FakeHttp:
    def __init__(self, handler):
        self.handler, self.calls = handler, []

    async def request(self, method, path, *, json=None):
        self.calls.append({"method": method, "path": path, "body": deepcopy(json)})
        return self.handler(method, path, json)


class EvidenceTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.initial = {"state_revision": "a" * 64, "lease_status": "active",
            "runtime": {"status": "running", "run_id": "2" * 32},
            "access": {"user_id": "alice", "tenant": "team", "profile_id": "default", "domain": None, "viewpoint": None}}

    def owner(self, http):
        result = _QuestionExecution(http, base="http://127.0.0.1:8766", tenant="team", directory=self.directory,
            profile="default", on_event=None, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=60)
        result.question_run_id, result.run_id, result.state = "1" * 32, "2" * 32, deepcopy(self.initial)
        return result

    def response(self, body, **changes):
        payload = {key: value for key, value in body.items() if key != "profile"}
        data = {**deepcopy(self.initial), "record": {"requests": {body["request_id"]: canonical_json_hash(payload)}},
                "evidence_run_id": body["run_id"],
                "evidence": evidence(), "evidence_sha256": canonical_json_hash(evidence())}
        data.update(changes)
        return FakeResponse(200, {"data": data})

    async def test_post_profile_is_body_only_and_exact_intent_precedes_send(self):
        def handler(method, path, body):
            self.assertEqual(method, "POST")
            self.assertNotIn("?", path)
            self.assertEqual(body["profile"], "default")
            intent = json.loads((self.directory / f"evidence-request-{body['request_id']}.json").read_bytes())
            self.assertEqual(intent, {key: value for key, value in body.items() if key != "profile"})
            return self.response(body)
        http = FakeHttp(handler)
        value = await self.owner(http).query_evidence({"action": "read", "material_id": "d1"})
        self.assertEqual(value, evidence())
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(len(list(self.directory.glob("evidence-response-*.json"))), 1)

    async def test_lost_post_response_uses_exact_receipt_get_without_resending(self):
        posted = []
        def handler(method, path, body):
            if method == "POST":
                posted.append(deepcopy(body))
                raise OSError("simulated lost response")
            self.assertIn("/evidence/" + posted[0]["request_id"], path)
            self.assertTrue(path.endswith("?profile=default"))
            self.assertIsNone(body)
            return self.response(posted[0])
        http = FakeHttp(handler)
        value = await self.owner(http).query_evidence({"action": "search", "query": "key"})
        self.assertEqual(value, evidence())
        self.assertEqual([call["method"] for call in http.calls], ["POST", "GET"])

    async def test_different_request_fingerprint_and_response_hash_are_rejected(self):
        for index, corruption in enumerate(("fingerprint", "response", "run")):
            directory = self.directory / str(index)
            directory.mkdir()
            def handler(method, path, body):
                result = self.response(body)
                if corruption == "fingerprint":
                    result.value["data"]["record"]["requests"][body["request_id"]] = "0" * 64
                elif corruption == "response":
                    result.value["data"]["evidence_sha256"] = "0" * 64
                else:
                    result.value["data"]["evidence_run_id"] = "9" * 32
                return result
            http = FakeHttp(handler)
            owner = self.owner(http)
            owner.directory = directory
            with self.subTest(corruption=corruption):
                with self.assertRaises(QuestionClientError) as caught:
                    await owner.query_evidence({"action": "read", "material_id": "d1"})
                self.assertEqual(caught.exception.code, "question_evidence_mismatch")
                self.assertEqual(len(http.calls), 1)

    async def test_failed_receipt_recovery_preserves_original_error_without_retry(self):
        def handler(method, path, body):
            if method == "POST":
                return FakeResponse(400, {"error": {"code": "personal_limit"}})
            return FakeResponse(404, {"error": {"code": "not_found"}})
        http = FakeHttp(handler)
        with self.assertRaises(QuestionClientError) as caught:
            await self.owner(http).query_evidence({"action": "read", "material_id": "d1"})
        self.assertEqual(caught.exception.code, "personal_limit")
        self.assertEqual([call["method"] for call in http.calls], ["POST", "GET"])

    async def test_remote_cancel_or_changed_profile_does_not_accept_evidence(self):
        for index, change in enumerate(("cancel", "profile")):
            directory = self.directory / str(index)
            directory.mkdir()
            def handler(method, path, body):
                result = self.response(body)
                if change == "cancel":
                    result.value["data"]["runtime"]["status"] = "cancelled"
                else:
                    result.value["data"]["access"]["profile_id"] = "other"
                return result
            http = FakeHttp(handler)
            owner = self.owner(http)
            owner.directory = directory
            with self.subTest(change=change):
                with self.assertRaises(QuestionClientError) as caught:
                    await owner.query_evidence({"action": "read", "material_id": "d1"})
                self.assertEqual(caught.exception.code, "question_cancelled" if change == "cancel" else "question_profile_changed")
                self.assertFalse(list(directory.glob("evidence-response-*.json")))


if __name__ == "__main__":
    unittest.main()
