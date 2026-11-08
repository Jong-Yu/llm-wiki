import json
import unittest

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
            self.assertEqual(events.trace, [{"type": "system"}])

    def test_hook_and_unknown_system_events_are_still_rejected(self):
        for subtype in ("hook_started", "hook_response", "task_started", None):
            with self.subTest(subtype=subtype):
                with self.assertRaises(AIAdapterError) as caught:
                    _Events()(system(subtype), None)
                self.assertEqual(caught.exception.code, "ai_unexpected_tool_activity")


if __name__ == "__main__":
    unittest.main()
