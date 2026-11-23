import json
import os
import unittest
from unittest.mock import patch

from core.client.ai import claude
from core.client.ai.claude import _Events
from core.client.ai.contracts import AIAdapterError

SESSION = "11111111-1111-4111-8111-111111111111"


def system(subtype, **extra):
    return json.dumps({"type": "system", "subtype": subtype, "session_id": SESSION, **extra})


class ClaudeSystemEventTests(unittest.TestCase):
    def test_progress_notices_are_not_tool_activity(self):
        # 설치된 Claude CLI가 추론 중에 보내는 토큰 수 추정 알림은 답변도 도구 출력도 아니다.
        for subtype in ("init", "status", "api_retry", "compact_boundary", "thinking_tokens"):
            events = _Events()
            events(system(subtype, estimated_tokens=12, estimated_tokens_delta=3), None)
            self.assertEqual(events.trace, [{"type": "system", "subtype": subtype}])

    def test_notices_and_new_kinds_pass_and_only_their_names_are_recorded(self):
        # D-143: 안내 메시지는 답·도구 실행이 아니므로 새 종류도 통과시키고 이름만 남긴다.
        for subtype in ("notification", "informational", "model_refusal_fallback", "session_state_changed",
                        "brand_new_notice"):
            with self.subTest(subtype=subtype):
                events = _Events()
                events(system(subtype, message="본문은 기록하지 않음", key="config-two-files"), None)
                self.assertEqual(events.trace, [{"type": "system", "subtype": subtype}])

    def test_isolation_breaking_and_malformed_system_events_are_rejected_with_their_name(self):
        cases = {"hook_started": "system:hook_started", "hook_response": "system:hook_response",
                 "hook_new_kind": "system:hook_new_kind", "task_started": "system:task_started",
                 "local_command_output": "system:local_command_output", "memory_recall": "system:memory_recall",
                 "permission_denied": "system:permission_denied", None: "system:other",
                 "Bad Name": "system:other"}
        for subtype, label in cases.items():
            with self.subTest(subtype=subtype):
                with self.assertRaises(AIAdapterError) as caught:
                    _Events()(system(subtype), None)
                self.assertEqual(caught.exception.code, "ai_cli_event_rejected")
                self.assertEqual(caught.exception.event, label)

    def test_notice_that_asks_to_stop_is_rejected(self):
        with self.assertRaises(AIAdapterError) as caught:
            _Events()(system("informational", prevent_continuation=True), None)
        self.assertEqual((caught.exception.code, caught.exception.event),
                         ("ai_cli_event_rejected", "system:informational"))

    def test_unknown_message_types_are_rejected_with_a_safe_name(self):
        for kind, label in (("tool_progress", "type:tool_progress"), ("Strange Type", "type:other")):
            with self.subTest(kind=kind):
                with self.assertRaises(AIAdapterError) as caught:
                    _Events()(json.dumps({"type": kind}), None)
                self.assertEqual((caught.exception.code, caught.exception.event), ("ai_cli_event_rejected", label))

    def test_tool_use_is_still_rejected_after_notices(self):
        events = _Events()
        events(system("notification"), None)
        tool = {"type": "assistant", "session_id": SESSION,
                "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}
        with self.assertRaises(AIAdapterError) as caught:
            events(json.dumps(tool), None)
        self.assertEqual(caught.exception.code, "ai_unexpected_tool_activity")

    def test_public_text_and_structured_output_are_distinct_and_thinking_is_not_forwarded(self):
        received = []
        update = "[[wiki-work-update]]두 규칙의 예외를 확인하겠습니다.[[/wiki-work-update]]"
        event = {"type": "assistant", "session_id": SESSION, "message": {"content": [
            {"type": "thinking", "thinking": "private reasoning"},
            {"type": "redacted_thinking", "data": "private data"},
            {"type": "text", "text": update},
            {"type": "tool_use", "id": "output-1", "name": "StructuredOutput", "input": {"content": "최종 답변"}}]}}
        _Events()(json.dumps(event), received.append)
        self.assertEqual([item["kind"] for item in received], ["public_text", "structured_output"])
        self.assertEqual(received[0]["text"], update)
        self.assertEqual(json.loads(received[1]["text"]), {"content": "최종 답변"})
        self.assertNotIn("private", json.dumps(received))


class ClaudePartialEventTests(unittest.TestCase):
    def setUp(self):
        self.events = _Events(stream_answer=True)
        self.received = []

    def partial(self, kind, **values):
        self.events(json.dumps({"type": "stream_event", "session_id": SESSION,
                                "event": {"type": kind, **values}}), self.received.append)

    def start(self):
        self.partial("message_start", message={"id": "message-1", "role": "assistant"})

    def test_structured_json_deltas_are_snapshots_before_complete_result(self):
        self.start()
        self.partial("content_block_start", index=0,
                     content_block={"type": "tool_use", "id": "output-1", "name": "StructuredOutput", "input": {}})
        self.partial("content_block_delta", index=0,
                     delta={"type": "input_json_delta", "partial_json": '{"action":"answer","content":"첫'})
        self.partial("content_block_delta", index=0,
                     delta={"type": "input_json_delta", "partial_json": ' 문장"}'})
        self.assertEqual([item["text"] for item in self.received],
                         ['{"action":"answer","content":"첫', '{"action":"answer","content":"첫 문장"}'])
        self.assertTrue(all(item["kind"] == "structured_output" and item["event"] == "item.updated"
                            and item["item_id"] == "output-1" for item in self.received))
        self.assertIsNone(self.events.result)
        self.partial("content_block_stop", index=0)
        self.partial("message_delta", delta={"stop_reason": "tool_use"})
        self.partial("message_stop")
        self.events(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                                "structured_output": {"action": "answer", "content": "첫 문장"}}), self.received.append)
        self.assertEqual(self.events.result["content"], "첫 문장")

    def test_public_text_is_separate_and_private_thinking_is_never_forwarded(self):
        self.start()
        self.partial("content_block_start", index=0, content_block={"type": "thinking", "thinking": "private"})
        self.partial("content_block_delta", index=0, delta={"type": "thinking_delta", "thinking": "private"})
        self.partial("content_block_delta", index=0, delta={"type": "signature_delta", "signature": "private"})
        self.partial("content_block_stop", index=0)
        self.partial("content_block_start", index=1, content_block={"type": "text", "text": ""})
        self.partial("content_block_delta", index=1, delta={"type": "text_delta", "text": "공개"})
        self.partial("content_block_delta", index=1, delta={"type": "text_delta", "text": " 설명"})
        self.assertEqual([item["text"] for item in self.received], ["공개", "공개 설명"])
        self.assertTrue(all(item["kind"] == "public_text" for item in self.received))
        self.assertNotIn("private", json.dumps(self.received) + json.dumps(self.events.stream_blocks))

    def test_non_output_tool_is_rejected_before_input_is_received(self):
        self.start()
        with self.assertRaises(AIAdapterError) as caught:
            self.partial("content_block_start", index=0,
                         content_block={"type": "tool_use", "id": "bad", "name": "Bash", "input": {}})
        self.assertEqual(caught.exception.code, "ai_unexpected_tool_activity")
        self.assertEqual(self.received, [])

    def test_partial_events_require_explicit_opt_in(self):
        with self.assertRaises(AIAdapterError) as caught:
            _Events()(json.dumps({"type": "stream_event", "event": {"type": "message_start"}}), self.received.append)
        self.assertEqual(caught.exception.code, "ai_cli_event_rejected")

    def test_missing_or_wrong_block_types_fail_closed(self):
        self.start()
        with self.assertRaises(AIAdapterError):
            self.partial("content_block_delta", index=0, delta={"type": "text_delta", "text": "orphan"})
        self.partial("content_block_start", index=0, content_block={"type": "text", "text": ""})
        with self.assertRaises(AIAdapterError):
            self.partial("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": "private"})
        self.assertEqual(self.received, [])

    def test_stream_output_limit_is_enforced_before_forwarding(self):
        self.start()
        self.partial("content_block_start", index=0, content_block={"type": "text", "text": ""})
        with patch.object(claude, "MAX_RESULT_BYTES", 4), self.assertRaises(AIAdapterError) as caught:
            self.partial("content_block_delta", index=0, delta={"type": "text_delta", "text": "한글"})
        self.assertEqual(caught.exception.code, "ai_output_limit")
        self.assertEqual(self.received, [])

    def test_result_does_not_accept_an_unfinished_message(self):
        self.start()
        with self.assertRaises(AIAdapterError) as caught:
            self.events(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                                    "structured_output": {"content": "unfinished"}}), self.received.append)
        self.assertEqual(caught.exception.code, "ai_incomplete_turn")


class ClaudeEnvironmentTests(unittest.TestCase):
    def test_network_settings_are_forwarded_but_api_keys_are_not(self):
        values = {"HTTPS_PROXY": "http://proxy.example:8080", "no_proxy": "localhost",
                  "NODE_EXTRA_CA_CERTS": "/certs/company.pem", "CLAUDE_CODE_GIT_BASH_PATH": "C:/Git/bin/bash.exe",
                  "ANTHROPIC_API_KEY": "secret", "WIKI_TOKEN": "secret", "ALL_PROXY": "socks://x"}
        with patch.dict(os.environ, values, clear=True):
            environment = claude.environment()
        for name in ("HTTPS_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_GIT_BASH_PATH"):
            self.assertEqual(environment[name], values[name])
        for name in ("ANTHROPIC_API_KEY", "WIKI_TOKEN", "ALL_PROXY"):
            self.assertNotIn(name, environment)


class SearchTermsFailureTests(unittest.TestCase):
    def test_rejected_event_label_is_reported_next_to_the_code(self):
        from tools import search_terms_cli
        rejected = AIAdapterError("ai_cli_event_rejected", event="system:hook_started")
        self.assertEqual(search_terms_cli._failure(rejected),
                         {"code": "ai_cli_event_rejected", "event": "system:hook_started"})
        grouped = ExceptionGroup("cleanup", [rejected])
        self.assertEqual(search_terms_cli._failure(grouped)["event"], "system:hook_started")
        self.assertEqual(search_terms_cli._failure(AIAdapterError("ai_timeout")), {"code": "ai_timeout"})
        forged = AIAdapterError("ai_cli_event_rejected", event="system:hook\nC:/Users/secret")
        self.assertNotIn("event", search_terms_cli._failure(forged))


if __name__ == "__main__":
    unittest.main()
