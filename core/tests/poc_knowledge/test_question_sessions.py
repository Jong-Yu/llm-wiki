"""질문 대화의 AI 세션 이어 가기: 조건이 맞을 때만 resume하고 어긋나면 전체 대화로 새 세션을 연다."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from uuid import uuid4
import unittest

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution
from core.client.question_ai import assemble_question
from core.client.question_sessions import QuestionSessions, pointer_name
from core.common.json_codec import canonical_json_hash
from core.runtime.client_platform import private_directory

CONVERSATION = uuid4().hex
IDENTITY = dict(server="http://127.0.0.1:8766", tenant="team", user_id="alice", profile="default",
                conversation_id=CONVERSATION)
BASIS = {"scope": {"profile": {"profile_id": "default"}}, "documents": []}


class FakeAdapter:
    """실제 AI 없이 resume 호출 여부와 입력만 관측한다."""
    def __init__(self, fail_resume=False):
        self.persist_session, self.calls, self.fail_resume = False, [], fail_resume

    async def run(self, *, prompt, schema, directory, on_event=None, session_id=None):
        self.calls.append({"prompt": prompt, "session_id": session_id, "directory": Path(directory)})
        if session_id is not None and self.fail_resume:
            raise AIAdapterError("ai_login_or_execution_failed")
        if session_id is None:
            private_directory(Path(directory), exist_ok=False)  # 실제 어댑터처럼 0700 폴더를 만든다.
        return {"value": {}, "execution": {"provider": "claude", "session_id": session_id or str(uuid4()),
                "session_persisted": True, "session_directory": str(self.calls[0]["directory"]), "status": "completed"}}


def execution(root):
    value = _QuestionExecution(None, base="http://127.0.0.1:8766", tenant="team", directory=root / "run",
        profile="default", on_event=None, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=1,
        session_root=root / "sessions")
    value.provider = "claude"
    (root / "run").mkdir(parents=True, exist_ok=True)
    value.events = []
    value.emit = lambda kind, **fields: value.events.append((kind, fields))

    async def plain(adapter, prompt, schema, *, directory=None, session_id=None):
        return await adapter.run(prompt=prompt, schema=schema, directory=directory or root / "run" / "invocation",
                                 session_id=session_id)
    value.guarded_model = plain
    return value


def handoff(preceding):
    turns = [{"role": "user" if index % 2 == 0 else "assistant", "content": f"턴 {index}"} for index in range(preceding)]
    return {"conversation_context": {"turns": turns}, "question": "다음 질문", "basis": BASIS}


class QuestionSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # macOS 임시 폴더는 심볼릭 링크 아래라 실제 경로로 바꿔 보호 폴더 검사를 통과시킨다.
        self.root = Path(self.temp.name).resolve()
        self.access = {"user_id": "alice"}
        self.record = {"data": {"conversation_id": CONVERSATION, "basis": BASIS}}
        import core.client.question as module
        self.patch = module.question_answer_schema
        module.question_answer_schema = lambda handoff: {}
        self.addCleanup(lambda: setattr(module, "question_answer_schema", self.patch))

    def run_model(self, run, adapter, preceding, prompt="전체 프롬프트"):
        import core.client.question as module
        original = module.assemble_question
        module.assemble_question = (lambda handoff, record, resumed=False, seen_turns=None:
            f"이어 가기 프롬프트 seen={seen_turns}" if resumed else prompt)
        try:
            return asyncio.run(run.run_model(adapter, handoff(preceding), prompt, self.access, self.record))
        finally:
            module.assemble_question = original

    def test_first_question_has_no_session_and_is_run_once_without_persisting(self):
        run, adapter = execution(self.root), FakeAdapter()
        _, prompt = self.run_model(run, adapter, 0)
        self.assertEqual(len(adapter.calls), 1)
        self.assertFalse(adapter.persist_session)
        self.assertNotIn("session_history_replay", [event.get("phase") for _, event in run.events])
        self.assertFalse((self.root / "sessions" / "pointers").exists())

    def test_follow_up_without_saved_session_starts_new_session_then_next_resumes(self):
        run, adapter = execution(self.root), FakeAdapter()
        self.run_model(run, adapter, 2)
        self.assertIsNone(adapter.calls[0]["session_id"])
        self.assertIn("session_history_replay", [event.get("phase") for _, event in run.events])
        self.assertEqual(adapter.calls[0]["prompt"], "전체 프롬프트")
        self.assertTrue((self.root / "sessions" / "pointers" / pointer_name(CONVERSATION, "claude")).is_file())
        # 질문·답변이 2턴 늘었으므로 다음 질문은 앞선 4턴을 가진 세션을 이어 간다.
        second = FakeAdapter()
        resumed = execution(self.root)
        self.run_model(resumed, second, 4)
        self.assertNotIn("session_history_replay", [event.get("phase") for _, event in resumed.events])
        self.assertEqual(len(second.calls), 1)
        self.assertIsNotNone(second.calls[0]["session_id"])
        self.assertEqual(second.calls[0]["prompt"], "이어 가기 프롬프트 seen=4")

    def test_unseen_turns_are_appended_instead_of_restarting(self):
        self.run_model(execution(self.root), FakeAdapter(), 2)
        # 다른 PC나 다른 AI로 대화가 더 진행되어 세션이 모르는 턴이 있어도 새 세션을 열지 않고 이어 붙인다.
        other = FakeAdapter()
        self.run_model(execution(self.root), other, 6)
        self.assertEqual(len(other.calls), 1)
        self.assertIsNotNone(other.calls[0]["session_id"])
        self.assertEqual(other.calls[0]["prompt"], "이어 가기 프롬프트 seen=4")

    def test_session_that_saw_more_than_the_conversation_does_not_resume(self):
        self.run_model(execution(self.root), FakeAdapter(), 6)
        # 기록보다 세션이 더 많이 봤다면(기록이 바뀌었거나 다른 대화) 이어 가지 않는다.
        fewer = FakeAdapter()
        self.run_model(execution(self.root), fewer, 2)
        self.assertIsNone(fewer.calls[0]["session_id"])

    def test_changed_basis_does_not_resume(self):
        run, adapter = execution(self.root), FakeAdapter()
        self.run_model(run, adapter, 2)
        # 근거가 바뀌면 이어 가지 않는다.
        self.record["data"]["basis"] = {**BASIS, "documents": [{"document": "a.md", "revision": "x"}]}
        changed = FakeAdapter()
        self.run_model(execution(self.root), changed, 4)
        self.assertIsNone(changed.calls[0]["session_id"])

    def test_changed_web_query_source_and_opt_out_do_not_resume_external_session(self):
        # 세션 지문은 내부 문서뿐 아니라 basis 전체를 포함해야 외부 근거가 다음 모드로 새지 않는다.
        web = {"query": "public A", "status": "complete", "warnings": [], "sources": [
            {"url": "https://example.com/a", "content_sha256": "a" * 64}]}
        self.record["data"]["basis"] = {**BASIS, "web": web}
        self.run_model(execution(self.root), FakeAdapter(), 2)
        variants = [
            {**BASIS, "web": {**web, "query": "public B"}},
            {**BASIS, "web": {**web, "sources": [{"url": "https://example.com/b", "content_sha256": "b" * 64}]}},
            BASIS,
        ]
        for index, basis in enumerate(variants):
            with self.subTest(index=index):
                self.record["data"]["basis"] = basis
                adapter = FakeAdapter()
                self.run_model(execution(self.root), adapter, 4 + index * 2)
                self.assertIsNone(adapter.calls[0]["session_id"])

    def test_resume_failure_falls_back_to_full_conversation_in_new_session(self):
        self.run_model(execution(self.root), FakeAdapter(), 2)
        broken, run = FakeAdapter(fail_resume=True), execution(self.root)
        self.run_model(run, broken, 4)
        self.assertEqual([call["session_id"] is not None for call in broken.calls], [True, False])
        self.assertEqual(broken.calls[1]["prompt"], "전체 프롬프트")
        self.assertIn("session_resume_failed", [kind_phase[1].get("phase") for kind_phase in run.events])

    def test_resumed_prompt_omits_earlier_turns_but_keeps_new_question_and_basis(self):
        record = {"id": uuid4().hex, "data": {"question": "다음 질문", "basis": BASIS, "input_contract_version": "personal-question-v3",
            "input_instructions": "지침", "output_contract": {"fields": []}}}
        value = {"question_run_id": record["id"], "question": "다음 질문", "basis": BASIS, "contract_version": "personal-question-v3",
            "instructions": "지침", "output": {"fields": []},
            "conversation_context": {"turns": [{"role": "user", "content": "첫 질문 본문"}], "purpose": "dialogue_context_only"}}
        record["data"]["conversation_context"] = value["conversation_context"]
        value["input_sha256"] = canonical_json_hash({key: item for key, item in value.items()})
        import core.client.question_ai as ai
        original = ai.question_answer_schema
        ai.question_answer_schema = lambda handoff: {}
        try:
            full = assemble_question(value, record)
            resumed = assemble_question(value, record, resumed=True)
            seen_one = assemble_question(value, record, resumed=True, seen_turns=1)
        finally:
            ai.question_answer_schema = original
        self.assertIn("첫 질문 본문", full)
        self.assertNotIn("첫 질문 본문", resumed)
        self.assertIn("다음 질문", resumed)
        self.assertIn("already part of this AI session", resumed)
        self.assertIn('"unseen_turns": []', resumed)
        self.assertEqual(seen_one.count("첫 질문 본문"), 0)


if __name__ == "__main__":
    unittest.main()
