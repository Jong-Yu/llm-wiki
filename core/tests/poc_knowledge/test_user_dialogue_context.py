"""옵트인 사용자 원문 타임라인의 보존·예산·기존 입력/영수증 경계를 확인한다."""

from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.documents.store import WikiStore
from core.modules.knowledge.aggregation import prepare_question
from core.modules.personal.question_basis import QuestionBasisStore
from core.modules.personal.question_grounding import (
    INSTRUCTIONS, MAX_DIALOGUE_BYTES, MAX_USER_DIALOGUE_BYTES, MAX_USER_DIALOGUE_TOTAL_BYTES,
    USER_DIALOGUE_INSTRUCTIONS, dialogue_context,
)
from core.modules.personal.question_runs import (
    INPUT_INSTRUCTIONS, WEB_INPUT_INSTRUCTIONS, QuestionRunStore,
)
from core.modules.personal.store import PersonalConflictError, PersonalStore
from core.tests.poc_knowledge.test_web_evidence import web_result


def turn(index, role, content=None):
    return {"id": f"turn-{index}", "role": role,
        "content": content if content is not None else f"Original {index}: 한글 🙂\nunchanged\\text",
        "hash": sha256(str(index).encode()).hexdigest(),
        "reply_to": f"user-{index}" if role == "assistant" else None}


def sized_turn(index, role, size):
    value = turn(index, role, "🙂\n")
    used = len(canonical_json_bytes(value))
    assert used <= size
    value["content"] = "x" * (size - used) + value["content"]
    assert len(canonical_json_bytes(value)) == size
    return value


class UserDialogueSelectionTests(unittest.TestCase):
    def context(self, preceding, *, user_dialogue=True):
        return dialogue_context({"id": "conversation"}, {"id": "current", "hash": "question-hash"},
            preceding, "revision", user_dialogue=user_dialogue)

    def test_default_and_explicit_false_keep_legacy_bytes(self):
        previous = [turn(i, "user" if i % 2 == 0 else "assistant") for i in range(12)]
        expected = {"conversation_id": "conversation", "revision": "revision", "turns": previous[4:],
            "purpose": "dialogue_context_only", "complete": False, "preceding_turns": 12,
            "omitted_turns": 4, "question_turn_id": "current", "question_hash": "question-hash"}
        default = dialogue_context({"id": "conversation"}, {"id": "current", "hash": "question-hash"},
            previous, "revision")
        self.assertEqual(canonical_json_bytes(default), canonical_json_bytes(expected))
        self.assertEqual(canonical_json_bytes(self.context(previous, user_dialogue=False)), canonical_json_bytes(expected))
        self.assertNotIn("selection", default)

    def test_default_byte_boundary_remains_unchanged(self):
        exact = sized_turn(1, "assistant", MAX_DIALOGUE_BYTES)
        self.assertEqual(self.context([exact], user_dialogue=False)["turns"], [exact])
        oversized = sized_turn(1, "assistant", MAX_DIALOGUE_BYTES + 1)
        self.assertEqual(self.context([turn(0, "user"), oversized], user_dialogue=False)["turns"], [])

    def test_user_priority_keeps_original_sparse_chronology_and_content(self):
        previous = [turn(i, "user" if i % 2 == 0 else "assistant") for i in range(12)]
        original = deepcopy(previous)
        result = self.context(previous)
        expected_positions = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11]
        self.assertEqual(result["turns"], [original[i] for i in expected_positions])
        self.assertEqual(result["selection"], {"mode": "user_timeline_v1", "turn_offsets": expected_positions, "user_total": 6,
            "user_included": 6, "user_complete": True, "user_omitted": 0,
            "assistant_total": 6, "assistant_included": 4, "assistant_omitted": 2,
            "omitted_user_offsets": [], "omitted_user_offsets_complete": True})
        self.assertFalse(result["complete"])
        self.assertEqual((result["preceding_turns"], result["omitted_turns"]), (12, 2))
        self.assertEqual(previous, original)
        result["turns"][0]["content"] = "Changed result copy"
        self.assertEqual(previous, original)

    def test_user_budget_exact_boundary_and_oversized_newest_stop(self):
        exact = sized_turn(1, "user", MAX_USER_DIALOGUE_BYTES)
        result = self.context([exact])
        self.assertEqual(result["turns"], [exact])
        self.assertTrue(result["complete"])
        oversized = sized_turn(1, "user", MAX_USER_DIALOGUE_BYTES + 1)
        result = self.context([turn(0, "user"), oversized])
        self.assertEqual(result["turns"], [])
        self.assertEqual(result["selection"]["omitted_user_offsets"], [0, 1])
        self.assertEqual(result["selection"]["user_omitted"], 2)
        self.assertFalse(result["selection"]["user_complete"])

    def test_total_turn_budget_exact_boundary_excludes_header_and_selection(self):
        user = sized_turn(0, "user", MAX_USER_DIALOGUE_BYTES)
        assistant = sized_turn(1, "assistant", MAX_USER_DIALOGUE_TOTAL_BYTES - MAX_USER_DIALOGUE_BYTES)
        result = self.context([user, assistant])
        self.assertEqual(result["turns"], [user, assistant])
        self.assertEqual(sum(len(canonical_json_bytes(t)) for t in result["turns"]), MAX_USER_DIALOGUE_TOTAL_BYTES)
        self.assertGreater(len(canonical_json_bytes(result)), MAX_USER_DIALOGUE_TOTAL_BYTES)
        self.assertTrue(result["complete"])

    def test_oversized_latest_assistant_does_not_backfill_older_assistant(self):
        user = sized_turn(0, "user", MAX_USER_DIALOGUE_BYTES)
        latest = sized_turn(2, "assistant", MAX_USER_DIALOGUE_TOTAL_BYTES - MAX_USER_DIALOGUE_BYTES + 1)
        result = self.context([user, turn(1, "assistant"), latest])
        self.assertEqual(result["turns"], [user])
        self.assertEqual(result["selection"]["assistant_included"], 0)
        self.assertEqual(result["selection"]["assistant_omitted"], 2)
        self.assertTrue(result["selection"]["user_complete"])

    def test_earlier_oversized_user_stops_prefix_and_offsets_use_full_stream(self):
        previous = [turn(0, "user"), turn(1, "assistant"),
            sized_turn(2, "user", MAX_USER_DIALOGUE_BYTES + 1), turn(3, "assistant"),
            turn(4, "user"), turn(5, "assistant"), turn(6, "user")]
        result = self.context(previous)
        self.assertEqual(result["turns"], [previous[i] for i in [1, 3, 4, 5, 6]])
        self.assertEqual(result["selection"]["omitted_user_offsets"], [0, 2])
        self.assertEqual(result["selection"]["turn_offsets"], [1, 3, 4, 5, 6])
        self.assertEqual(result["selection"]["user_included"], 2)
        self.assertEqual(result["omitted_turns"], 2)

    def test_omitted_offset_cap_reports_incomplete_list_and_actual_totals(self):
        previous = [turn(i, "user") for i in range(59)]
        previous.append(sized_turn(59, "user", MAX_USER_DIALOGUE_BYTES + 1))
        previous.extend(turn(i, "assistant") for i in range(60, 100))
        result = self.context(previous)
        selected = result["selection"]
        self.assertEqual(result["turns"], previous[96:])
        self.assertEqual(selected["turn_offsets"], [96, 97, 98, 99])
        self.assertEqual(selected["omitted_user_offsets"], list(range(50)))
        self.assertFalse(selected["omitted_user_offsets_complete"])
        self.assertEqual((selected["user_total"], selected["user_included"], selected["user_omitted"]), (60, 0, 60))
        self.assertEqual((selected["assistant_total"], selected["assistant_included"]), (40, 4))
        self.assertEqual((result["preceding_turns"], result["omitted_turns"]), (100, 96))

    def test_empty_history_and_exact_boolean_option(self):
        result = self.context([])
        self.assertTrue(result["complete"])
        self.assertEqual(result["omitted_turns"], 0)
        self.assertEqual(result["selection"]["omitted_user_offsets"], [])
        self.assertEqual(result["selection"]["turn_offsets"], [])
        self.assertTrue(result["selection"]["user_complete"])
        for invalid in (None, 0, 1, "false", [], {}):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                self.context([], user_dialogue=invalid)


class UserDialogueStoreTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.wiki = WikiStore(Path(temp.name).resolve())
        self.wiki.save("a.md", "# Fixture\nOriginal source.\n", expected_revision=None)
        self.actor = dict(user_id="eval", tenant="team", profile_id="default", domain=None, viewpoint=None,
            policy_revision="0" * 64, access_revision="1" * 64)
        self.scope = SimpleNamespace(store=self.wiki, **self.actor)
        self.personal = PersonalStore(self.scope)
        self.full = prepare_question(self.wiki, self.actor, documents=["a.md"], required_documents=[], claims=[], source_refs=[])
        self.reference = QuestionBasisStore(self.scope).freeze(self.full)

    def append(self, conversation, role, content, basis):
        request_id = uuid4().hex
        event = {"role": role, "content": content, "status": "complete", "reply_to": None,
            "basis": basis, "origin": "client_reported", "human_approval": False}
        made = self.personal.append("conversations", conversation["record"]["id"], request_id,
            conversation["revision"], event, event, self.actor, before_commit=lambda: None)
        return made, request_id

    def conversation(self, basis, pairs=6):
        made = self.personal.create("conversations", uuid4().hex, {"title": "Fixture"},
            {"title": "Fixture", "sharing": "personal"}, self.actor, before_commit=lambda: None)
        for index in range(pairs):
            made, _ = self.append(made, "user", f"Original user {index}", basis)
            made, _ = self.append(made, "assistant", f"Original assistant {index}", basis)
        return self.append(made, "user", "Current question", basis)

    def create(self, store, conversation, question_id, request_id=None, before_commit=None):
        return store.create(request_id=request_id or uuid4().hex, conversation_id=conversation["record"]["id"],
            question_turn_id=question_id, expected_conversation_revision=conversation["revision"],
            before_commit=before_commit or (lambda: None))

    def test_constructor_rejects_non_boolean_before_accessing_store(self):
        with patch("core.modules.personal.question_runs.PersonalStore") as personal:
            for invalid in (None, 0, 1, "true", [], {}):
                with self.subTest(value=invalid), self.assertRaises(ValueError):
                    QuestionRunStore(object(), user_dialogue=invalid)
            personal.assert_not_called()

    def test_default_v5_instruction_fingerprint_and_context_bytes_are_unchanged(self):
        conversation, qid = self.conversation(self.reference)
        store = QuestionRunStore(self.scope)
        made = self.create(store, conversation, qid)
        handoff = store._input(made["record"])
        previous = [{k: deepcopy(e[k]) for k in ("id", "role", "content", "hash", "reply_to") if k in e}
            for e in conversation["record"]["events"][:-1]]
        question = conversation["record"]["events"][-1]
        expected = {"conversation_id": conversation["record"]["id"], "revision": conversation["revision"],
            "turns": previous[-8:], "purpose": "dialogue_context_only", "complete": False,
            "preceding_turns": 12, "omitted_turns": 4, "question_turn_id": qid, "question_hash": question["hash"]}
        self.assertEqual(canonical_json_bytes(handoff["conversation_context"]), canonical_json_bytes(expected))
        self.assertEqual(sha256(handoff["instructions"].encode()).hexdigest(),
            "73ea8d48965a941d2af3488b6eb09aef5a630ec7b3122996f3a8b4fb44f2e87b")
        self.assertEqual(handoff["instructions"], INSTRUCTIONS)
        self.assertFalse(store.user_dialogue)

    def test_only_opted_in_v5_adds_fixed_guidance_and_keeps_frozen_basis(self):
        conversation, qid = self.conversation(self.reference)
        original = deepcopy(conversation["record"])
        store = QuestionRunStore(self.scope, user_dialogue=True)
        made = self.create(store, conversation, qid)
        handoff = store._input(made["record"])
        self.assertEqual(handoff["contract_version"], "personal-question-v5")
        self.assertEqual(handoff["instructions"], INSTRUCTIONS + " " + USER_DIALOGUE_INSTRUCTIONS)
        self.assertGreaterEqual(len(USER_DIALOGUE_INSTRUCTIONS.split()), 150)
        self.assertLessEqual(len(USER_DIALOGUE_INSTRUCTIONS.split()), 200)
        self.assertEqual(handoff["basis"], self.reference)
        self.assertEqual(QuestionBasisStore(self.scope).load(self.reference), self.full)
        self.assertEqual(handoff["conversation_context"]["selection"]["user_included"], 6)
        self.assertEqual(self.personal.read("conversations", conversation["record"]["id"])["record"], original)

    def test_opt_in_leaves_v3_and_v4_input_and_full_context_unchanged(self):
        for web, version, instructions, fingerprint in (
            (None, "personal-question-v3", INPUT_INSTRUCTIONS,
             "c9904bb65c5e5344bb83ead3acb586791b8b435277a1cfe9c2979af2f9536e56"),
            (web_result(), "personal-question-v4", WEB_INPUT_INSTRUCTIONS,
             "c1822d73d88bd4776ba5c7c79fe4e4e32b3e3778691fd37dc1f0d7517c67e957"),
        ):
            with self.subTest(version=version):
                basis = prepare_question(self.wiki, self.actor, documents=["a.md"], required_documents=[],
                    claims=[], source_refs=[], web=web)
                conversation, qid = self.conversation(basis)
                store = QuestionRunStore(self.scope, user_dialogue=True)
                made = self.create(store, conversation, qid)
                handoff = store._input(made["record"])
                self.assertEqual(handoff["contract_version"], version)
                self.assertEqual(handoff["instructions"], instructions)
                self.assertEqual(sha256(handoff["instructions"].encode()).hexdigest(), fingerprint)
                self.assertEqual(len(handoff["conversation_context"]["turns"]), 12)
                self.assertTrue(handoff["conversation_context"]["complete"])
                self.assertNotIn("selection", handoff["conversation_context"])

    def test_receipt_toggle_never_rewrites_input_or_adds_option_to_request_hash(self):
        for first_flag in (False, True):
            with self.subTest(first_flag=first_flag):
                conversation, qid = self.conversation(self.reference)
                request_id = uuid4().hex
                store = QuestionRunStore(self.scope, user_dialogue=first_flag)
                made = self.create(store, conversation, qid, request_id)
                original = canonical_json_bytes(made["record"])
                input_bytes = canonical_json_bytes(store._input(made["record"]))
                payload = {"conversation_id": conversation["record"]["id"], "question_turn_id": qid,
                    "expected_conversation_revision": conversation["revision"]}
                self.assertEqual(made["record"]["requests"][request_id], canonical_json_hash(payload))
                self.append(conversation, "user", "Later recorded question", self.reference)
                other = QuestionRunStore(self.scope, user_dialogue=not first_flag)
                guard = Mock(side_effect=AssertionError("Replay must return the original receipt first"))
                with patch.object(other.personal, "_publish", side_effect=AssertionError("No rewrite")):
                    replayed = self.create(other, conversation, qid, request_id, guard)
                self.assertTrue(replayed["replayed"])
                self.assertEqual(canonical_json_bytes(replayed["record"]), original)
                self.assertEqual(canonical_json_bytes(other._input(replayed["record"])), input_bytes)
                guard.assert_not_called()

    def test_current_and_future_are_excluded_with_original_archive_offsets(self):
        conversation, qid = self.conversation(self.reference)
        current = conversation["record"]["events"][-1]
        future, future_id = self.append(conversation, "user", "Future question must stay outside", self.reference)
        store = QuestionRunStore(self.scope, user_dialogue=True)
        made = self.create(store, future, qid)
        context = made["record"]["data"]["conversation_context"]
        self.assertEqual(context["preceding_turns"], 12)
        self.assertEqual(context["selection"]["user_total"], 6)
        self.assertEqual(context["selection"]["turn_offsets"], [0, 2, 4, 5, 6, 7, 8, 9, 10, 11])
        self.assertTrue(all(t["id"] not in {qid, future_id} for t in context["turns"]))
        query = {"action": "dialogue", "offset": 0, "limit": 3, "start_character": 0, "character_count": 4000}
        served = store._dialogue(made["record"], query)
        self.assertEqual([t["id"] for t in served["items"]], [t["id"] for t in conversation["record"]["events"][:3]])
        self.assertEqual((served["total"], served["next_offset"]), (12, 3))
        self.assertNotIn(current["id"], [t["id"] for t in served["items"]])
        changed = deepcopy(made["record"])
        changed["data"]["question_hash"] = "0" * 64
        with self.assertRaises(PersonalConflictError):
            store._dialogue(changed, query)

    def test_new_request_still_rejects_stale_conversation_revision(self):
        conversation, qid = self.conversation(self.reference)
        self.append(conversation, "user", "Later event", self.reference)
        request_id = uuid4().hex
        with self.assertRaises(PersonalConflictError):
            self.create(QuestionRunStore(self.scope, user_dialogue=True), conversation, qid, request_id)
        with self.assertRaises(FileNotFoundError):
            self.personal.receipt("question-runs", request_id)


if __name__ == "__main__":
    unittest.main()
