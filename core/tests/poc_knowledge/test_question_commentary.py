"""명시한 공개 작업 설명만 채팅의 임시 진행 목록으로 전달되는지 검사한다."""

from copy import deepcopy
import unittest

from core.client.question_commentary import (
    END_MARKER, MAX_COMMENTARY_CHARACTERS, MAX_COMMENTARY_MESSAGES,
    QuestionCommentary, START_MARKER,
)


def event(content="두 문서의 적용 조건을 확인하고 있습니다.", **metadata):
    return {"type": "agent_message", "kind": "public_text",
            "text": START_MARKER + content + END_MARKER, **metadata}


class QuestionCommentaryTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.callback = QuestionCommentary(lambda kind, **values: self.events.append((kind, values)))

    def test_complete_marker_emits_trimmed_public_content_without_mutating_event(self):
        source = event("  두 문서의 예외 조항을 확인하고 있습니다.  ", item_id="item-1")
        original = deepcopy(source)
        self.callback(source)
        self.assertEqual(source, original)
        kind, value = self.events[0]
        self.assertEqual(kind, "commentary")
        self.assertEqual(value["content"], "두 문서의 예외 조항을 확인하고 있습니다.")
        self.assertEqual(value["origin"], "client_reported")
        self.assertIs(value["saved"], False)
        self.assertRegex(value["message_id"], r"^work-[a-f0-9]{32}-1$")
        self.assertLessEqual(len(value["message_id"]), 100)

    def test_partial_marker_waits_for_complete_snapshot(self):
        source = event(item_id="item-1", event="item.updated")
        for length in (1, len(START_MARKER), len(source["text"]) - 1):
            self.callback({**source, "text": source["text"][:length]})
        self.assertEqual(self.events, [])
        self.callback(source)
        self.callback({**source, "event": "item.completed"})
        self.assertEqual(len(self.events), 1)

    def test_surrounding_whitespace_and_multiline_public_text_are_allowed(self):
        content = "두 문서의 적용 조건을 확인하고 있습니다.\r\n\t예외 조항도 함께 비교합니다."
        source = event("\n" + content + "\n", item_id="item-1")
        source["text"] = " \t\r\n" + source["text"] + "\n\t "
        self.callback(source)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0][1]["content"], content)

    def test_raw_events_reasoning_final_json_and_unmarked_text_never_emit(self):
        for source in (
            {"type": "reasoning", "text": event()["text"]},
            {"type": "item.updated", "item": event()},
            {"type": "item.completed", "item": event()},
            {"type": "agent_message", "text": "임의의 모델 설명"},
            {"type": "agent_message", "text": '{"content":"최종 답변","citations":[]}'},
            event('{"content":"최종 답변","citations":[]}'),
            event("[1, 2]"), event('"JSON 문자열"'), event("true"),
            event("```json {} ```"),
            event(kind="structured_output"), event(kind="reasoning"),
            event(channel="analysis"), event(phase="final"),
            event(channel="reasoning"), event(phase="analysis"),
            None, [], "raw",
        ):
            with self.subTest(source=source):
                self.callback(source)
                self.assertEqual(self.events, [])

    def test_malformed_oversize_control_surrogate_and_nested_markers_never_emit(self):
        for raw in (
            START_MARKER, END_MARKER, START_MARKER + END_MARKER,
            START_MARKER + "   " + END_MARKER,
            "prefix " + event()["text"], event()["text"] + " suffix",
            event()["text"] + event()["text"],
            event("본문" + START_MARKER + "중첩")["text"],
            event("본문" + END_MARKER + "중첩")["text"],
            event("가" * (MAX_COMMENTARY_CHARACTERS + 1))["text"],
            *[event("진행" + character + "설명")["text"]
              for character in ("\0", "\x0b", "\x7f", "\x85", "\u202e", "\ud800", "\udfff")],
            "\x0b" + event()["text"], event()["text"] + "\x85",
        ):
            with self.subTest(raw=repr(raw)):
                self.callback({"type": "agent_message", "text": raw})
                self.assertEqual(self.events, [])
        self.callback(event("가" * MAX_COMMENTARY_CHARACTERS))
        self.assertEqual(len(self.events[0][1]["content"]), MAX_COMMENTARY_CHARACTERS)

    def test_same_item_updates_same_id_and_duplicate_content_is_suppressed(self):
        self.callback(event("첫 번째 조건을 확인하고 있습니다.", item_id="item-1"))
        self.callback(event("첫 번째 조건을 확인하고 있습니다.", item_id="item-1"))
        self.callback(event("첫 번째 조건을 확인하고 있습니다.", item_id="item-2"))
        self.callback(event("예외 조항을 추가로 확인하고 있습니다.", item_id="item-1"))
        self.assertEqual(len(self.events), 2)
        self.assertEqual(self.events[0][1]["message_id"], self.events[1][1]["message_id"])

    def test_missing_kind_and_item_id_use_exact_text_deduplication(self):
        source = event()
        del source["kind"]
        self.callback(source)
        self.callback(source)
        self.callback(event("확인한 조건을 답변에 정리하고 있습니다."))
        self.assertEqual(len(self.events), 2)
        self.assertNotEqual(self.events[0][1]["message_id"], self.events[1][1]["message_id"])

    def test_item_ids_and_invocations_do_not_collide(self):
        self.callback(event("첫 문서를 확인하고 있습니다.", item_id="a/b"))
        self.callback(event("다음 문서를 확인하고 있습니다.", item_id="a?b"))
        other = QuestionCommentary(lambda kind, **values: self.events.append((kind, values)))
        other(event("첫 문서를 확인하고 있습니다.", item_id="a/b"))
        identifiers = [value["message_id"] for _, value in self.events]
        self.assertEqual(len(set(identifiers)), 3)

    def test_message_limit_does_not_prevent_existing_item_updates(self):
        for index in range(MAX_COMMENTARY_MESSAGES + 2):
            self.callback(event(f"문서 {index}의 조건을 확인하고 있습니다.", item_id=str(index)))
        self.assertEqual(len(self.events), MAX_COMMENTARY_MESSAGES)
        self.callback(event("확인한 첫 문서의 예외를 정리하고 있습니다.", item_id="0"))
        self.assertEqual(len(self.events), MAX_COMMENTARY_MESSAGES + 1)
        self.assertEqual(self.events[0][1]["message_id"], self.events[-1][1]["message_id"])


if __name__ == "__main__":
    unittest.main()
