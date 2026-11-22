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
