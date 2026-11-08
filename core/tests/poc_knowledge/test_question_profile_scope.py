"""검증한 질문 전용 CLI 옵션이 Codex v5 경계 안에서만 활성화되는지 확인한다."""

import asyncio
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution
from core.client.question_ai import question_answer_schema
from core.common.json_codec import canonical_json_bytes
from core.tests.poc_knowledge.test_question_grounding_client import handoff_fixture, record_for, step


class KeywordAdapter:
    def __init__(self, failure=None):
        self.calls = []
        self.on_event = object()
        self.failure = failure

    async def run(self, *, prompt, schema, directory, **kwargs):
        self.calls.append(kwargs)
        if self.failure:
            raise self.failure
        value = step("answer", content="제공된 근거를 추가로 확인해야 합니다.")
        return {"value": value, "execution": {"provider": "codex", "status": "completed",
            "prompt_sha256": sha256(prompt.encode()).hexdigest(),
            "output_sha256": sha256(canonical_json_bytes(value)).hexdigest()}}


class ExplicitAdapter:
    def __init__(self):
        self.flags = []

    async def run(self, *, prompt, schema, directory, question_profile=False):
        self.flags.append(question_profile)
        return {}


class LegacyAdapter:
    def __init__(self):
        self.called = False

    async def run(self, *, prompt, schema, directory):
        self.called = True
        return {}


class ScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def owner(self, provider="codex", contract="personal-question-v5"):
        result = _QuestionExecution(None, base="http://127.0.0.1:8766", tenant="eval", directory=self.root,
            profile=None, on_event=None, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=1)
        result.provider = provider
        result.state = {"record": {"data": {"input_contract_version": contract}}}

        async def monitor():
            await asyncio.Event().wait()

        result.monitor = monitor
        return result

    async def call(self, owner, adapter):
        return await owner.guarded_model(adapter, "prompt", {}, allow_preview=False)

    async def test_codex_v5_forwards_call_option_through_kwargs(self):
        adapter = KeywordAdapter()
        await self.call(self.owner(), adapter)
        self.assertIs(adapter.calls[0]["question_profile"], True)

    async def test_explicit_run_keyword_is_supported(self):
        adapter = ExplicitAdapter()
        await self.call(self.owner(), adapter)
        self.assertEqual(adapter.flags, [True])

    async def test_claude_is_unchanged_even_though_its_class_inherits_codex(self):
        adapter = KeywordAdapter()
        await self.call(self.owner(provider="claude"), adapter)
        self.assertNotIn("question_profile", adapter.calls[0])

    async def test_legacy_contract_has_no_new_option(self):
        adapter = KeywordAdapter()
        await self.call(self.owner(contract="personal-question-v3"), adapter)
        self.assertNotIn("question_profile", adapter.calls[0])

    async def test_unverified_provider_has_no_profile(self):
        adapter = KeywordAdapter()
        await self.call(self.owner(provider=None), adapter)
        self.assertNotIn("question_profile", adapter.calls[0])

    async def test_missing_state_or_contract_has_no_profile(self):
        for state in [None, {}, {"record": {"data": {}}}]:
            adapter, owner = KeywordAdapter(), self.owner()
            owner.state = state
            await self.call(owner, adapter)
            self.assertNotIn("question_profile", adapter.calls[0])

    async def test_injected_old_adapter_without_optional_capability_still_runs(self):
        adapter = LegacyAdapter()
        await self.call(self.owner(), adapter)
        self.assertTrue(adapter.called)

    async def test_shared_adapter_does_not_keep_profile_mode_between_question_types(self):
        adapter = KeywordAdapter()
        original_callback = adapter.on_event
        await self.call(self.owner(), adapter)
        await self.call(self.owner(contract="personal-question-v4"), adapter)
        self.assertIs(adapter.calls[0]["question_profile"], True)
        self.assertNotIn("question_profile", adapter.calls[1])
        self.assertIs(adapter.on_event, original_callback)
        self.assertFalse(hasattr(adapter, "question_profile"))

    async def test_adapter_failure_restores_callback_without_retry(self):
        adapter = KeywordAdapter(AIAdapterError("ai_cli_incompatible"))
        original_callback = adapter.on_event
        with self.assertRaises(AIAdapterError):
            await self.call(self.owner(), adapter)
        self.assertEqual(len(adapter.calls), 1)
        self.assertIs(adapter.on_event, original_callback)

    async def test_actual_v5_dispatch_reaches_profiled_guard(self):
        owner, adapter = self.owner(), KeywordAdapter()
        handoff = handoff_fixture()
        owner.state["record"] = record_for(handoff)
        result, _ = await owner.run_model(adapter, handoff, "unused full prompt", {}, record_for(handoff))
        self.assertEqual(len(adapter.calls), 1)
        self.assertIs(adapter.calls[0]["question_profile"], True)
        self.assertEqual(result["value"]["citations"], [])

    async def test_tool_selection_is_enabled_only_for_codex_v5(self):
        adapter = KeywordAdapter()
        original_callback = adapter.on_event
        for provider in ("codex", "claude", None, "unverified"):
            owner = self.owner(provider=provider)
            handoff = handoff_fixture()
            record = record_for(handoff)
            expected = ({"value": "unchanged result"}, "unchanged prompt")
            with self.subTest(provider=provider), patch(
                    "core.client.question_grounding.run_grounded_model", new_callable=AsyncMock,
                    return_value=expected) as grounded:
                result = await owner.run_model(adapter, handoff, "unused full prompt", {}, record)
                self.assertIs(result, expected)
                if provider == "codex":
                    grounded.assert_awaited_once_with(owner, adapter, handoff, select_tools=True)
                else:
                    grounded.assert_awaited_once_with(owner, adapter, handoff)
            self.assertEqual(adapter.calls, [])
            self.assertIs(adapter.on_event, original_callback)
            self.assertFalse(hasattr(adapter, "select_tools"))

    async def test_legacy_v3_v4_keep_full_prompt_and_schema_for_every_provider(self):
        adapter = KeywordAdapter()
        prompt = "Existing full prompt\n원문 전체"
        for contract in ("personal-question-v3", "personal-question-v4"):
            for provider in ("codex", "claude", None, "unverified"):
                owner = self.owner(provider=provider, contract=contract)
                handoff = handoff_fixture()
                handoff["contract_version"] = contract
                handoff["output"]["citation_references"] = []
                record = record_for(handoff)
                expected = {"value": "legacy result"}
                with self.subTest(contract=contract, provider=provider), patch(
                        "core.client.question_grounding.run_grounded_model", new_callable=AsyncMock) as grounded, patch.object(
                        owner, "guarded_model", new_callable=AsyncMock, return_value=expected) as guarded:
                    result, returned_prompt = await owner.run_model(adapter, handoff, prompt, {}, record)
                    self.assertIs(result, expected)
                    self.assertEqual(returned_prompt.encode(), prompt.encode())
                    guarded.assert_awaited_once_with(adapter, prompt, question_answer_schema(handoff))
                    grounded.assert_not_awaited()
        self.assertEqual(adapter.calls, [])
        self.assertFalse(hasattr(adapter, "select_tools"))


if __name__ == "__main__":
    unittest.main()
