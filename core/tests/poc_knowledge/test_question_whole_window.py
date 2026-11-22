"""요청한 원문 줄 창을 단락 수가 아니라 응답 한도로만 나눠, 이어읽기용 모델 왕복을 줄인다."""

from copy import deepcopy
from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.question_evidence import (MAX_RESPONSE_BYTES, WHOLE_WINDOW_READ_POLICY,
                                                      read_evidence, resolve_evidence_ids)
from core.modules.personal.question_runs import QuestionRunStore
from core.modules.personal.store import PersonalStore
from core.tests.poc_knowledge import test_question_grounding as grounding
from core.tests.poc_knowledge.test_question_evidence import basis_fixture
from core.tests.poc_mcp.test_server_integration import ServerFixture

import unittest

SHORT = "".join(f"Rule {index} applies.\n\n" for index in range(1, 41))


def source_basis(content):
    basis = basis_fixture()
    basis["documents"][0].update(content=content, source_revision=sha256(content.encode()).hexdigest())
    return basis


def read(basis, **query):
    return {"action": "read", "material_id": "d1", "start_line": 1, "line_count": 79, "limit": 10, **query}


class WholeWindowReadTests(unittest.TestCase):
    def test_requested_window_is_not_cut_at_the_item_limit(self):
        basis = source_basis(SHORT)
        legacy = read_evidence(basis, read(basis))
        whole = read_evidence(basis, read(basis), whole_window=True)
        self.assertEqual(len(legacy["items"]), 10)
        self.assertEqual(legacy["next_offset"], 10)
        self.assertEqual(len(whole["items"]), 40)
        self.assertIsNone(whole["next_offset"])
        self.assertFalse(whole["truncated"])
        self.assertEqual(whole["read_window"]["remaining_ranges"], [])
        self.assertEqual(whole["read_window"]["returned_ranges"],
                         [[item["start_line"], item["start_line"]] for item in whole["items"]])
        # 기존 페이지는 새 응답의 앞부분과 정확히 같고, 인용은 같은 원문 위치로 풀린다.
        self.assertEqual(whole["items"][:10], legacy["items"])
        self.assertEqual(resolve_evidence_ids(basis, whole["evidence_ids"]),
                         [row["citation"] for row in whole["citations"]])

    def test_window_within_limit_and_other_actions_keep_exact_bytes(self):
        basis = source_basis(SHORT)
        queries = [read(basis, line_count=9), {"action": "search", "query": "rule", "limit": 10},
                   {"action": "search", "query": "rule", "material_id": "d1", "limit": 3, "offset": 2}]
        fixture = basis_fixture()
        queries += [{"action": action, "material_id": "d1", "limit": 1} for action in ("claims", "history")]
        for query in queries:
            target = fixture if query["action"] in {"claims", "history"} else basis
            with self.subTest(query=query):
                self.assertEqual(canonical_json_bytes(read_evidence(target, query)),
                                 canonical_json_bytes(read_evidence(target, query, whole_window=True)))
        ranked = {"action": "search", "query": "rule applies", "limit": 2}
        self.assertEqual(read_evidence(basis, ranked, ranked_search=True),
                         read_evidence(basis, ranked, ranked_search=True, whole_window=True))

    def test_byte_budget_still_pages_and_offset_recovers_every_passage_once(self):
        content = "".join(f"Clause {index} " + "x" * 2500 + "\n\n" for index in range(1, 21))
        basis = source_basis(content)
        legacy_ids, offset = [], 0
        while True:
            page = read_evidence(basis, read(basis, offset=offset, limit=20))
            legacy_ids.extend(page["evidence_ids"])
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        ids, offset, pages = [], 0, 0
        while True:
            page = read_evidence(basis, read(basis, offset=offset, limit=1), whole_window=True)
            pages += 1
            self.assertLessEqual(len(canonical_json_bytes(page)), MAX_RESPONSE_BYTES)
            ids.extend(page["evidence_ids"])
            if page["next_offset"] is None:
                self.assertTrue(page["complete"])
                break
            self.assertTrue(page["truncated"])
            self.assertEqual(page["read_window"]["next_start_line"],
                             page["read_window"]["remaining_ranges"][0][0])
            offset = page["next_offset"]
        self.assertGreater(pages, 1)
        self.assertEqual(ids, legacy_ids)
        self.assertEqual(len(ids), len(set(ids)))

    def test_option_is_an_exact_bool(self):
        for value in (None, 0, 1, "true"):
            with self.assertRaisesRegex(ValueError, "whole_window"):
                read_evidence(None, {}, whole_window=value)
            with self.assertRaisesRegex(ValueError, "whole_window_reads"):
                QuestionRunStore(None, whole_window_reads=value)


class WholeWindowRunTests(ServerFixture):
    """접수 때 고정한 정책만 조회 방식을 정한다. 기존 작업과 기본 생성자는 이전 페이지를 유지한다."""

    # 기존 질문 실행 검사의 HTTP 도우미만 빌리고 그 검사들은 다시 실행하지 않는다.
    post, get, conversation, append = (grounding.QuestionGroundingHTTPTests.post, grounding.QuestionGroundingHTTPTests.get,
                                       grounding.QuestionGroundingHTTPTests.conversation,
                                       grounding.QuestionGroundingHTTPTests.append)
    evidence_payload = grounding.QuestionGroundingHTTPTests.evidence_payload
    evidence = grounding.QuestionGroundingHTTPTests.evidence
    start = grounding.QuestionGroundingHTTPTests.start

    def setUp(self):
        super().setUp()
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.store.save("a.md", SHORT, expected_revision=None)
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.context = {"documents": ["a.md"], "required_documents": ["a.md"], "mode": "on_demand"}

    def created(self, store):
        conversation, qid = self.append(self.conversation())
        made = store.create(request_id=uuid4().hex, conversation_id=conversation["record"]["id"],
                            question_turn_id=qid, expected_conversation_revision=conversation["revision"],
                            before_commit=lambda: None)
        run_id = made["record"]["id"]
        active = self.post(f"/question-runs/{run_id}/claim", {"request_id": uuid4().hex,
            "expected_state_revision": made["state_revision"], "reclaim": False})
        return made, {"run_id": run_id, "active": active}

    def test_frozen_policy_serves_the_whole_window_and_legacy_runs_keep_pages(self):
        made, execution = self.created(QuestionRunStore(self.scope, user_dialogue=True, whole_window_reads=True))
        self.assertEqual(made["record"]["data"]["evidence_read_policy"], WHOLE_WINDOW_READ_POLICY)
        _, whole = self.evidence(execution, line_count=79)
        self.assertEqual(len(whole["evidence"]["items"]), 40)
        self.assertIsNone(whole["evidence"]["next_offset"])
        _, search = self.evidence(execution, action="search", query="rule", material_id=None)
        self.assertEqual(len(search["evidence"]["items"]), 10)

        made, execution = self.created(QuestionRunStore(self.scope, user_dialogue=True))
        self.assertNotIn("evidence_read_policy", made["record"]["data"])
        _, legacy = self.evidence(execution, line_count=79)
        self.assertEqual(len(legacy["evidence"]["items"]), 10)
        self.assertEqual(legacy["evidence"]["next_offset"], 10)
        self.assertEqual(legacy["evidence"]["items"], whole["evidence"]["items"][:10])

    def test_app_create_route_freezes_the_whole_window_policy(self):
        # 앱의 질문 접수 경로는 새 작업에 정책을 고정하고, 고정된 작업은 요청 창을 한 번에 받는다.
        execution = self.start()
        record = self.get(f"/question-runs/{execution['run_id']}")["record"]
        self.assertEqual(record["data"]["evidence_read_policy"], WHOLE_WINDOW_READ_POLICY)
        _, whole = self.evidence(execution, line_count=79)
        self.assertEqual(len(whole["evidence"]["items"]), 40)
        self.assertIsNone(whole["evidence"]["next_offset"])

    def test_unknown_frozen_read_policy_is_rejected_before_serving(self):
        _, execution = self.created(QuestionRunStore(self.scope, user_dialogue=True, whole_window_reads=True))
        original = PersonalStore._read

        def future(instance, collection, record_id):
            value = original(instance, collection, record_id)
            if collection == "question-runs":
                value = deepcopy(value)
                value["data"]["evidence_read_policy"] = "future-policy"
            return value

        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        with patch.object(PersonalStore, "_read", future):
            with self.assertRaisesRegex(ValueError, "read policy"):
                QuestionRunStore(self.scope).evidence(execution["run_id"], self.evidence_payload(execution),
                                                      authorize=lambda: None)
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)


if __name__ == "__main__":
    unittest.main()
