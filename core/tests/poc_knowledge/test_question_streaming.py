"""부분 답변은 공개 content만 표시하고 최종 검증·저장 경계를 유지한다."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution, QuestionClientError
from core.client.question_grounding import run_grounded_model
from core.client.question_streaming import GroundedAnswerPreview, MAX_STREAM_CHARACTERS
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeOwner, evidence, handoff_fixture, step,
)


def snapshot(text, **metadata):
    return {"type": "agent_message", "kind": "structured_output", "text": text,
            "event": "item.updated", "item_id": "answer-1", **metadata}


class AnswerStreamParserTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.now = 0.0
        self.preview = GroundedAnswerPreview(lambda kind, **value: self.events.append((kind, value)),
                                            clock=lambda: self.now)

    def test_incremental_unicode_escapes_and_citations_never_expose_json_or_ids(self):
        content = '서명 검증은 "키"가 필요합니다. [[s1:2:2]]\n추가 확인 😀'
        raw = json.dumps({"action": "answer", "content": content}, ensure_ascii=True)
        for index in range(len(raw) + 1):
            self.now += 0.21
            self.preview(snapshot(raw[:index]))
        values = [value["content"] for _, value in self.events]
        self.assertGreater(len(values), 10)
        self.assertEqual(values[-1], '서명 검증은 "키"가 필요합니다. \n추가 확인 😀')
        self.assertTrue(all(values[-1].startswith(value) for value in values))
        self.assertTrue(all("[[" not in value and "s1:" not in value and "\\u" not in value for value in values))
        self.assertTrue(all(value["saved"] is False and value["origin"] == "client_reported"
                            for _, value in self.events))
        before = len(self.events)
        self.preview(snapshot(raw, event="item.completed"))
        self.assertEqual(len(self.events), before)

    def test_action_after_content_waits_until_answer_is_known(self):
        self.preview(snapshot('{"content":"완성된 본문"'))
        self.preview(snapshot('{"content":"완성된 본문","action":"ans'))
        self.assertEqual(self.events, [])
        self.preview(snapshot('{"content":"완성된 본문","action":"answer"}'))
        self.assertEqual(self.events[-1][1]["content"], "완성된 본문")

    def test_query_nested_content_reasoning_and_public_work_updates_are_ignored(self):
        raw = '{"action":"answer","content":"표시되면 안 되는 내용"}'
        sources = [
            snapshot(raw, kind="reasoning"), snapshot(raw, channel="analysis"),
            snapshot(raw, phase="commentary"), {"type": "reasoning", "text": raw},
            {"type": "item.updated", "item": {"type": "agent_message", "text": raw}},
            snapshot('{"action":"read","content":"내부 조회 초안"}'),
            snapshot('{"nested":{"action":"answer","content":"내부 결과"}}'),
            snapshot('{"action":"answer","nested":{"content":"내부 결과"}}'),
            snapshot('[[wiki-work-update]]자료를 확인하고 있습니다.[[/wiki-work-update]]', kind="public_text"),
            snapshot('{"action":"fill","replacements":[{"text":"문서 수정 계획"}]}'),
            None, [], "raw",
        ]
        for source in sources:
            with self.subTest(source=source):
                self.preview(source)
                self.assertEqual(self.events, [])

    def test_invalid_and_oversize_prefixes_do_not_emit(self):
        for raw in (
            '{"action":"answer" "content":"missing comma"}',
            '{"action":"read","action":"answer","content":"duplicate"}',
            '{"action":"answer","content":123}',
            '{"action":"answer","content":"bad\\qescape"}',
            '{"action":"answer","content":"\\ud800"}',
            '{"action":"answer","content":"' + 'x' * MAX_STREAM_CHARACTERS,
        ):
            with self.subTest(raw=raw[:100]):
                self.preview(snapshot(raw))
                self.assertEqual(self.events, [])

    def test_each_call_has_independent_deduplication(self):
        raw = '{"action":"answer","content":"같은 본문"}'
        self.preview(snapshot(raw))
        another = GroundedAnswerPreview(lambda kind, **value: self.events.append((kind, value)))
        another(snapshot(raw))
        self.assertEqual(len(self.events), 2)

    def test_fast_updates_are_coalesced_but_first_and_completed_body_are_immediate(self):
        prefix = '{"action":"answer","content":"'
        self.preview(snapshot(prefix + "첫"))
        self.assertEqual(self.events[-1][1]["content"], "첫")
        for index in range(1, 101):
            self.now = index / 1000
            self.preview(snapshot(prefix + "첫" + "본" * index))
        self.assertEqual(len(self.events), 1)
        self.preview(snapshot(prefix + '첫 최종 본문"}', event="item.completed"))
        self.assertEqual(self.events[-1][1]["content"], "첫 최종 본문")
        self.assertEqual(len(self.events), 2)
        self.preview(snapshot(prefix + '첫 최종 본문"}', event="item.completed"))
        self.assertEqual(len(self.events), 2)

    def test_long_body_updates_keep_the_existing_character_limit(self):
        prefix = '{"action":"answer","content":"'
        self.preview(snapshot(prefix + "가"))
        self.now = 0.19
        self.preview(snapshot(prefix + "가" * 65536))
        self.assertEqual(len(self.events), 1)
        self.now = 0.21
        self.preview(snapshot(prefix + "가" * 70000))
        self.assertEqual(len(self.events), 2)
        self.assertEqual(len(self.events[-1][1]["content"]), 65536)
        self.preview(snapshot(prefix + "가" * 70000 + '"}', event="item.completed"))
        self.assertEqual(len(self.events), 2)


class AnswerStreamLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.events = []

    def owner(self, contract="personal-question-v5"):
        owner = _QuestionExecution(None, base="http://127.0.0.1:8766", tenant="test", directory=self.root,
            profile=None, on_event=self.events.append, cancel_event=asyncio.Event(),
            poll_seconds=1, heartbeat_seconds=60)
        owner.provider = "claude"
        owner.state = {"record": {"data": {"input_contract_version": contract}}}
        async def monitor():
            await asyncio.Event().wait()
        owner.monitor = monitor
        return owner

    async def test_body_precedes_completion_with_commentary_and_callback_restoration(self):
        for contract in ("personal-question-v5", "personal-question-v6"):
            self.events.clear()
            owner, observed, finish = self.owner(contract), asyncio.Event(), asyncio.Event()
            old = object()
            result = {"value": step("answer", content="답변 본문입니다.")}
            class Adapter:
                on_event = old
                async def run(self, *, prompt, schema, directory, on_event=None,
                              question_profile=False, stream_answer=False):
                    self.options = question_profile, stream_answer
                    on_event(snapshot('[[wiki-work-update]]근거를 확인합니다.[[/wiki-work-update]]', kind="public_text"))
                    on_event(snapshot('{"action":"read","content":"숨길 조회 계획"}'))
                    on_event(snapshot('{"action":"answer","content":"답변'))
                    observed.set()
                    await finish.wait()
                    on_event(snapshot('{"action":"answer","content":"답변 본문입니다."}', event="item.completed"))
                    return result
            adapter = Adapter()
            running = asyncio.create_task(owner.guarded_model(adapter, "frozen", {}, allow_preview=False,
                                                               stream_answer=True))
            try:
                await asyncio.wait_for(observed.wait(), 2)
                self.assertFalse(running.done())
                self.assertEqual([event["type"] for event in self.events], ["commentary", "answer_preview"])
                self.assertEqual(self.events[-1]["content"], "답변")
                self.assertEqual(adapter.options, (True, True))
            finally:
                finish.set()
            self.assertIs(await running, result)
            self.assertIs(adapter.on_event, old)
            self.assertEqual(self.events[-1]["content"], "답변 본문입니다.")

    async def test_cancel_after_prefix_restores_callback_and_keeps_preview_unconfirmed(self):
        owner, observed = self.owner(), asyncio.Event()
        old, finished = object(), asyncio.Event()
        class Adapter:
            on_event = old
            async def run(self, *, prompt, schema, directory, on_event=None, **options):
                try:
                    on_event(snapshot('{"action":"answer","content":"부분 본문'))
                    observed.set()
                    await asyncio.Event().wait()
                finally:
                    finished.set()
        adapter = Adapter()
        running = asyncio.create_task(owner.guarded_model(adapter, "frozen", {}, allow_preview=False,
                                                           stream_answer=True))
        await asyncio.wait_for(observed.wait(), 2)
        owner.cancel_event.set()
        with self.assertRaises(QuestionClientError):
            await running
        self.assertTrue(finished.is_set())
        self.assertIs(adapter.on_event, old)
        self.assertEqual(len(self.events), 1)
        self.assertIs(self.events[0]["saved"], False)

    async def test_legacy_contract_does_not_opt_in_to_grounded_streaming(self):
        owner = self.owner("personal-question-v4")
        class Adapter:
            async def run(self, *, prompt, schema, directory, on_event=None, **options):
                self.options = options
                self.callback = on_event
                return {}
        adapter = Adapter()
        await owner.guarded_model(adapter, "frozen", {}, allow_preview=False, stream_answer=True)
        self.assertNotIn("stream_answer", adapter.options)
        self.assertIsNone(adapter.callback)

    async def test_adapter_without_stream_option_keeps_completed_reply_path(self):
        owner = self.owner()
        class Adapter:
            async def run(self, *, prompt, schema, directory, on_event=None):
                on_event(snapshot('{"action":"answer","content":"완성 답변"}', event="item.completed"))
                return {"value": "unchanged"}
        result = await owner.guarded_model(Adapter(), "frozen", {}, allow_preview=False, stream_answer=True)
        self.assertEqual(result, {"value": "unchanged"})
        self.assertEqual(self.events[-1]["content"], "완성 답변")

    async def test_registered_template_keeps_internal_plans_out_of_partial_previews(self):
        for provider in ("codex", "claude"):
            with self.subTest(provider=provider):
                self.events.clear()
                owner = self.owner()
                owner.provider = provider
                owner.state["record"]["data"]["template_ref"] = {"id": "a" * 32, "revision": "b" * 64}
                content = '```wiki-template-result\n{"replacements":[{"id":"f1","text":"내부 계획"}]}\n```'
                result = {"value": step("answer", content=content)}
                class Adapter:
                    async def run(self, *, prompt, schema, directory, on_event=None, **options):
                        self.options = options
                        on_event(snapshot('[[wiki-work-update]]양식의 항목을 확인합니다.[[/wiki-work-update]]',
                                          kind="public_text"))
                        raw = json.dumps(result["value"], ensure_ascii=False)
                        on_event(snapshot(raw[:-8]))
                        on_event(snapshot(raw, event="item.completed"))
                        return result
                adapter = Adapter()
                actual = await owner.guarded_model(adapter, "frozen", {}, allow_preview=False, stream_answer=True)
                self.assertIs(actual, result)
                self.assertFalse(adapter.options.get("stream_answer", False))
                self.assertEqual(adapter.options.get("template_profile", False), provider == "codex")
                self.assertEqual([event["type"] for event in self.events], ["commentary"])

    async def test_registered_template_handoff_does_not_request_provider_streaming(self):
        handoff = handoff_fixture()
        handoff["template_ref"] = {"id": "a" * 32, "revision": "b" * 64}
        handoff["source_prefetch"] = {"mode": "all_source_passages_v1", "status": "ready", "reasons": []}
        handoff["output"]["max_evidence_reads"] = 16
        handoff["basis"]["documents"] = []
        owner = FakeOwner(self.root / "template")
        adapter = FakeAdapter([step("answer", content="양식에 채울 자료가 없습니다.")])
        result, _ = await run_grounded_model(owner, adapter, handoff)
        self.assertTrue(all(call["options"]["stream_answer"] is False for call in adapter.calls))
        previews = [event for event in owner.events if event[0] == "answer_preview"]
        self.assertEqual(len(previews), 1)
        self.assertEqual(previews[0][1]["content"], result["value"]["content"])

    async def test_grounded_final_still_validates_and_renders_evidence(self):
        handoff = handoff_fixture()
        owner = self.owner()
        fake = FakeOwner(self.root, [evidence()])
        owner.query_evidence = fake.query_evidence
        class Adapter(FakeAdapter):
            async def run(self, *, on_event=None, **options):
                value = self.values[len(self.calls)]
                raw = json.dumps(value, ensure_ascii=False)
                if on_event:
                    for index in range(1, len(raw), 3):
                        on_event(snapshot(raw[:index]))
                return await super().run(**options)
        adapter = Adapter([step("read", material_id="d1"),
                           step("answer", content="키가 필요합니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])])
        result, _ = await run_grounded_model(owner, adapter, handoff)
        self.assertEqual(result["value"]["content"], "키가 필요합니다. [1]")
        previews = [event["content"] for event in self.events if event["type"] == "answer_preview"]
        self.assertGreaterEqual(len(previews), 2)
        self.assertEqual(previews[-1], result["value"]["content"])
        self.assertTrue(all("s1:2:2" not in value for value in previews))
        self.assertEqual(len(adapter.calls), 2)
        self.assertTrue(all(call["options"]["stream_answer"] for call in adapter.calls))

    async def test_experimental_draft_path_keeps_previous_no_stream_boundary(self):
        owner = FakeOwner(self.root / "experimental", [evidence()])
        answer = step("answer", content="검증 본문 [[s1:2:2]]", evidence_ids=["s1:2:2"])
        adapter = FakeAdapter([step("read", material_id="d1"), answer, deepcopy(answer)])
        await run_grounded_model(owner, adapter, handoff_fixture(), check_draft=True)
        self.assertTrue(all(call["options"]["stream_answer"] is False for call in adapter.calls))

    async def test_partial_body_does_not_bypass_final_evidence_validation(self):
        owner = self.owner()
        fake = FakeOwner(self.root, [evidence()])
        owner.query_evidence = fake.query_evidence
        class Adapter(FakeAdapter):
            async def run(self, *, on_event=None, **options):
                value = self.values[len(self.calls)]
                if on_event:
                    on_event(snapshot(json.dumps(value, ensure_ascii=False)))
                return await super().run(**options)
        adapter = Adapter([step("read", material_id="d1"),
                           step("answer", content="검증 전 본문 [[s9:1:2]]", evidence_ids=["s9:1:2"])])
        with self.assertRaisesRegex(AIAdapterError, "ai_invalid_result"):
            await run_grounded_model(owner, adapter, handoff_fixture())
        previews = [event for event in self.events if event["type"] == "answer_preview"]
        self.assertEqual(len(previews), 1)
        self.assertEqual(previews[0]["content"], "검증 전 본문 ")
        self.assertIs(previews[0]["saved"], False)


if __name__ == "__main__":
    unittest.main()
