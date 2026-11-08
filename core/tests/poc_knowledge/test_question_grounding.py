"""실제 격리 HTTP·Store로 필요한 근거 읽기와 보존·권한 경계를 확인한다."""

from copy import deepcopy
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
from unittest.mock import patch
from uuid import uuid4

from core.api.dependencies import access_value
from core.api.v1.knowledge.schemas import QuestionContextRequest
from core.api.v1.personal.workflows_schemas import RunAnswer, AnswerCitation
from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.aggregation import prepare_question
from core.modules.knowledge.question_evidence import resolve_evidence_ids
from core.modules.ontology.store import OntologyStore
from core.modules.personal import question_grounding
from core.modules.personal.question_basis import QuestionBasisStore, is_basis_reference
from core.modules.personal.question_runs import QuestionRunStore
from core.modules.personal.store import PersonalStore, PersonalCorruptError
from core.modules.personal.workflow_io import observe_basis
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_knowledge.test_web_evidence import web_result
from core.tests.poc_mcp.test_server_integration import ServerFixture


BODY = "# Controller\nA uses B.\nB is a pump.\nShutdown requires approval.\nB depends on A.\n"


class QuestionGroundingHTTPTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.actor = access_value(self.scope)
        source = self.store.save("a.md", BODY, expected_revision=None)
        OntologyStore(self.store).generate("a.md", source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.context = {"documents": ["a.md"], "required_documents": ["a.md"], "mode": "on_demand"}

    def post(self, path, body, status=200, token=None):
        response = self.client.post(self.base_url + path, headers=self.headers(token), json=body)
        self.assertEqual(response.status_code, status, response.text)
        self.assertNotIn(self.token, response.text)
        return response.json()["data"] if status in {200, 201} else response.json()

    def get(self, path, status=200, token=None, **params):
        response = self.client.get(self.base_url + path, headers=self.headers(token), params=params)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()["data"] if status == 200 else response.json()

    def canonical_source_files(self):
        roots = [self.store.wiki_dir, self.store.history_dir, self.store.data_dir / "_knowledge"]
        return {str(p.relative_to(self.store.data_dir)): p.read_bytes()
                for root in roots if root.exists() for p in root.rglob("*") if p.is_file()}

    def conversation(self):
        return self.post("/conversations", {"request_id": uuid4().hex, "title": "근거 읽기 질문"}, 201)

    def append(self, conversation, text="A는 무엇을 사용하는가?", *, context=None):
        qid = uuid4().hex
        body = {"request_id": qid, "expected_revision": conversation["revision"], "role": "user",
                "content": text, "context_request": self.context if context is None else context}
        result = self.post(f"/conversations/{conversation['record']['id']}/turns", body)
        return result, qid

    def start(self, *, context=None, conversation=None, text="A는 무엇을 사용하는가?"):
        conversation, qid = self.append(conversation or self.conversation(), text, context=context)
        made = self.post("/question-runs", {"request_id": uuid4().hex,
            "conversation_id": conversation["record"]["id"], "question_turn_id": qid,
            "expected_conversation_revision": conversation["revision"]}, 201)
        run_id = made["record"]["id"]
        active = self.post(f"/question-runs/{run_id}/claim", {"request_id": uuid4().hex,
            "expected_state_revision": made["state_revision"], "reclaim": False})
        handoff = self.get(f"/question-runs/{run_id}/input", run_id=active["runtime"]["run_id"])
        return {"conversation": conversation, "question_id": qid, "run_id": run_id,
                "active": active, "handoff": handoff}

    def evidence_payload(self, execution, **query):
        return {"request_id": uuid4().hex, "run_id": execution["active"]["runtime"]["run_id"],
            "expected_state_revision": execution["active"]["state_revision"],
            "query": {"action": "read", "query": "", "material_id": "d1", "start_line": 1,
                      "line_count": 4, "offset": 0, "limit": 10, **query}}

    def evidence(self, execution, **query):
        payload = self.evidence_payload(execution, **query)
        result = self.post(f"/question-runs/{execution['run_id']}/evidence", payload)
        execution["active"] = result
        return payload, result

    def answer_payload(self, execution, evidence=None, *, ids=None, citations=None):
        if evidence is None:
            _, evidence = self.evidence(execution)
        values = evidence["evidence"]
        ids = deepcopy(values["evidence_ids"] if ids is None else ids)
        refs = deepcopy([row["citation"] for row in values["citations"]] if citations is None else citations)
        content = "A는 B를 사용한다."
        return {"request_id": uuid4().hex, "expected_state_revision": execution["active"]["state_revision"],
            "run_id": execution["active"]["runtime"]["run_id"],
            "expected_conversation_revision": execution["conversation"]["revision"],
            "content": content, "citations": refs, "evidence_ids": ids,
            "execution": {"provider": "codex", "cli_version": "isolated-grounding-contract", "requested_model": None,
                "reported_model": None, "input_sha256": execution["handoff"]["input_sha256"],
                "prompt_sha256": "0" * 64, "output_sha256": sha256(content.encode()).hexdigest()}}

    def submit(self, execution, payload):
        result = self.post(f"/question-runs/{execution['run_id']}/answers", payload)
        self.assertTrue(result["saved"], result)
        return result

    def test_prepare_is_readonly_and_append_ref_preserves_large_basis(self):
        for name in ("large-a.md", "large-b.md"):
            self.store.save(name, "# Large material\n" + "bounded source data\n" * 30000, expected_revision=None)
        context = {**self.context, "documents": ["large-a.md", "large-b.md"], "required_documents": []}
        before = self.canonical_source_files()
        personal = PersonalStore(self.scope)
        self.assertFalse(personal.root.exists())
        preview = self.post("/question-context/prepare", context)
        self.assertTrue(preview["can_prepare"])
        self.assertTrue(preview["read_only"])
        self.assertFalse(preview["persisted"])
        self.assertFalse(personal.root.exists())
        self.assertFalse({"content", "knowledge"} & preview["documents"][0].keys())
        execution = self.start(context=context)
        ref = execution["conversation"]["record"]["events"][-1]["basis"]
        self.assertTrue(is_basis_reference(ref))
        full = QuestionBasisStore(self.scope).load(ref)
        self.assertGreater(len(canonical_json_bytes(full)), 1024 * 1024)
        self.assertLess(len(canonical_json_bytes(execution["conversation"]["record"])), 30000)
        self.assertEqual(execution["handoff"]["contract_version"], "personal-question-v5")
        self.assertNotIn("citation_references", execution["handoff"]["output"])
        self.assertNotIn("content", execution["handoff"]["basis"]["documents"][0])
        self.assertEqual(self.canonical_source_files(), before)

    def test_read_claim_and_answer_save_exact_served_references(self):
        before = self.canonical_source_files()
        execution = self.start()
        self.evidence(execution, action="claims")
        _, served = self.evidence(execution)
        payload = self.answer_payload(execution, served)
        receipt = self.submit(execution, payload)
        stored = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual(len(stored["record"]["events"]), 2)
        answer = stored["record"]["events"][-1]
        self.assertTrue(is_basis_reference(answer["basis"]))
        self.assertEqual(answer["reply_to"], execution["question_id"])
        self.assertEqual(answer["citations"][0]["quote"], payload["citations"][0]["quote"])
        self.assertEqual(self.post(f"/question-runs/{execution['run_id']}/answers", payload), receipt)
        self.assertEqual(self.canonical_source_files(), before)

    def test_same_profile_definition_change_preserves_old_basis_read(self):
        execution = self.start()
        payload = self.answer_payload(execution)
        self.submit(execution, payload)
        saved = self.post("/saved-results", {"request_id": uuid4().hex, "title": "원래 답변",
            "conversation_id": execution["conversation"]["record"]["id"], "turn_id": payload["request_id"]}, 201)
        draft = self.post("/result-drafts", {"request_id": uuid4().hex, "saved_result_id": saved["record"]["id"]}, 201)
        ref = saved["record"]["data"]["basis"]
        original = QuestionBasisStore(self.scope).load(ref)
        self.change_policy(lambda value: value["tenants"][self.tenant]["profiles"]["default"].update(domain="marine", viewpoint="business"))
        current = self.policy.authorize(self.token, self.tenant, "read")
        self.assertEqual(QuestionBasisStore(current).load(ref), original)
        with self.assertRaises(PersonalCorruptError):
            QuestionBasisStore(current).freeze(original)
        prepared = prepare_question(current.store, access_value(current), documents=["a.md"],
            required_documents=[], claims=[], source_refs=[])
        newest = QuestionBasisStore(current).freeze(prepared)
        self.assertNotEqual(newest["basis_id"], ref["basis_id"])
        self.assertEqual(QuestionBasisStore(current).load(ref), original)
        observed = observe_basis(current.store, ref, access_value(current))
        self.assertEqual(observed["status"], "changed")
        self.assertTrue(observed["profile_changed"])
        read = self.get(f"/result-drafts/{draft['record']['id']}")
        self.assertEqual(read["basis_observation"]["status"], "changed")
        self.assertIn("A uses B.", read["rendered_content"])

    def test_lost_read_response_is_recovered_without_new_read_or_event(self):
        execution = self.start()
        payload, result = self.evidence(execution)
        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        with patch.object(question_grounding, "read_evidence", side_effect=AssertionError("must not read twice")):
            recovered = self.get(f"/question-runs/{execution['run_id']}/evidence/{payload['request_id']}")
            replayed = self.post(f"/question-runs/{execution['run_id']}/evidence", payload)
        self.assertEqual(recovered["evidence"], result["evidence"])
        self.assertEqual(recovered["evidence_sha256"], result["evidence_sha256"])
        self.assertTrue(recovered["replayed"])
        self.assertTrue(replayed["replayed"])
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)
        changed = deepcopy(payload)
        changed["query"]["line_count"] += 1
        self.post(f"/question-runs/{execution['run_id']}/evidence", changed, 409)
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)

    def test_six_read_limit_preserves_previous_receipts(self):
        execution = self.start()
        first = None
        for _ in range(6):
            payload, result = self.evidence(execution, line_count=1)
            first = first or (payload, result)
        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        failed = self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 413)
        self.assertEqual(failed["error"]["code"], "personal_limit")
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)
        recovered = self.get(f"/question-runs/{execution['run_id']}/evidence/{first[0]['request_id']}")
        self.assertEqual(recovered["evidence_sha256"], first[1]["evidence_sha256"])

    def test_reclaim_has_fresh_read_limit_and_cannot_cite_previous_run_reads(self):
        execution = self.start()
        old_runtime_id = execution["active"]["runtime"]["run_id"]
        first = None
        for _ in range(6):
            payload, result = self.evidence(execution, line_count=1)
            first = first or (payload, result)
        future = datetime.now(timezone.utc) + timedelta(seconds=301)
        with patch("core.modules.personal.question_runs._now", return_value=future):
            reclaimed = self.post(f"/question-runs/{execution['run_id']}/claim", {"request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"], "reclaim": True})
        self.assertNotEqual(reclaimed["runtime"]["run_id"], old_runtime_id)
        execution["active"] = reclaimed
        wrong = self.answer_payload(execution, first[1])
        self.post(f"/question-runs/{execution['run_id']}/answers", wrong, 422)
        _, current = self.evidence(execution, start_line=2, line_count=1)
        self.assertEqual(current["evidence_run_id"], reclaimed["runtime"]["run_id"])
        old_receipt = self.get(f"/question-runs/{execution['run_id']}/evidence/{first[0]['request_id']}")
        self.assertEqual(old_receipt["evidence_run_id"], old_runtime_id)
        self.assertEqual(old_receipt["evidence"], first[1]["evidence"])
        self.submit(execution, self.answer_payload(execution, current))

    def test_cancel_blocks_new_reads_and_answers_but_keeps_old_receipt(self):
        execution = self.start()
        payload, result = self.evidence(execution)
        answer = self.answer_payload(execution, result)
        self.post(f"/question-runs/{execution['run_id']}/cancel", {"request_id": uuid4().hex,
            "expected_state_revision": execution["active"]["state_revision"]})
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 409)
        self.post(f"/question-runs/{execution['run_id']}/answers", answer, 409)
        recovered = self.get(f"/question-runs/{execution['run_id']}/evidence/{payload['request_id']}")
        self.assertEqual(recovered["evidence"], result["evidence"])

    def test_write_revocation_blocks_new_reads_but_read_owner_can_recover_receipt(self):
        execution = self.start()
        payload, result = self.evidence(execution)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 403)
        recovered = self.get(f"/question-runs/{execution['run_id']}/evidence/{payload['request_id']}")
        self.assertEqual(recovered["evidence"], result["evidence"])

    def test_revocation_between_compute_and_append_does_not_publish_read(self):
        execution = self.start()
        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        original = question_grounding.read_evidence
        def revoke_after_read(*args, **kwargs):
            result = original(*args, **kwargs)
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
            return result
        with patch.object(question_grounding, "read_evidence", side_effect=revoke_after_read):
            self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 403)
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)

    def stale_read(self, change):
        execution = self.start()
        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        if change == "source":
            source = self.store.read("a.md")
            self.store.save("a.md", source.content + "New condition.\n", expected_revision=source.revision)
        else:
            state = ReviewStore(self.store).query("a.md")
            ReviewStore(self.store).review("a.md", action="defer", claim_id=state["claims"][0]["claim_id"],
                expected_state_revision=state["state_revision"], reason="isolated state change", actor=self.actor)
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 409)
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)

    def test_current_source_change_blocks_stale_reads(self):
        self.stale_read("source")

    def test_current_review_change_blocks_stale_reads(self):
        self.stale_read("review")

    def test_wrong_run_state_and_other_user_cannot_read_or_recover(self):
        execution = self.start()
        payload, result = self.evidence(execution)
        for values in ({"run_id": uuid4().hex}, {"expected_state_revision": "0" * 64}):
            self.post(f"/question-runs/{execution['run_id']}/evidence", {**self.evidence_payload(execution), **values}, 409)
        other = self.signup("다른 질문 사용자")
        self.change_policy(lambda value: value["users"][other["user_id"]]["memberships"].update({
            self.tenant: deepcopy(value["users"][self.user["user_id"]]["memberships"][self.tenant])}))
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 404, token=other["token"])
        self.get(f"/question-runs/{execution['run_id']}/evidence/{payload['request_id']}", 404, token=other["token"])

    def test_answer_cannot_forge_unread_id_mismatched_quote_or_duplicate_id(self):
        execution = self.start()
        _, result = self.evidence(execution, line_count=1)
        full = QuestionBasisStore(self.scope).load(execution["handoff"]["basis"])
        wrong = self.answer_payload(execution, result, ids=["s1:2:2"], citations=resolve_evidence_ids(full, ["s1:2:2"]))
        before = self.get(f"/question-runs/{execution['run_id']}")["record"]
        self.post(f"/question-runs/{execution['run_id']}/answers", wrong, 422)
        wrong = self.answer_payload(execution, result)
        wrong["citations"][0]["quote"] = "A made-up citation"
        self.post(f"/question-runs/{execution['run_id']}/answers", wrong, 422)
        wrong = self.answer_payload(execution, result)
        wrong["evidence_ids"] *= 2
        self.post(f"/question-runs/{execution['run_id']}/answers", wrong, 422)
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["record"], before)
        self.submit(execution, self.answer_payload(execution, result))

    def test_dialogue_reads_only_preceding_turns_and_never_issues_source_citations(self):
        conversation, first = self.append(self.conversation(), "이전 대상의 별명은 Alpha다.")
        conversation = self.post(f"/conversations/{conversation['record']['id']}/turns", {"request_id": uuid4().hex,
            "expected_revision": conversation["revision"], "role": "assistant", "content": "Alpha를 기준으로 대화합니다.",
            "reply_to": first})
        execution = self.start(conversation=conversation, text="그 대상은 무엇인가?")
        self.append(execution["conversation"], "이후 대화이며 앞선 문맥에 섞이면 안 된다.")
        _, served = self.evidence(execution, action="dialogue", material_id=None)
        value = served["evidence"]
        self.assertEqual([t["role"] for t in value["items"]], ["user", "assistant"])
        self.assertIn("Alpha", value["items"][0]["content"])
        self.assertNotIn("이후 대화", json.dumps(value, ensure_ascii=False))
        self.assertEqual(value["evidence_ids"], [])
        self.assertEqual(value["citations"], [])
        self.assertEqual(value["scope"], "preceding_dialogue_only_not_factual_evidence")

    def test_http_new_v5_input_keeps_user_timeline_beyond_recent_eight_messages(self):
        conversation = self.conversation()
        initial = "최초 사용자 조건 원문: 검토 전에는 상태를 바꾸지 않는다.\n기호도 보존: 🙂\tA"
        first = None
        for index in range(6):
            conversation, qid = self.append(conversation, initial if index == 0 else f"후속 사용자 조건 원문 {index}")
            first = first or qid
            conversation = self.post(f"/conversations/{conversation['record']['id']}/turns", {
                "request_id": uuid4().hex, "expected_revision": conversation["revision"],
                "role": "assistant", "content": f"이전 답변 원문 {index}", "reply_to": qid})
        previous = conversation["record"]["events"]
        self.assertNotIn(first, {event["id"] for event in previous[-8:]})
        execution = self.start(conversation=conversation, text="앞선 사용자 조건을 유지해 후속 답변을 준비해 줘.")
        handoff = execution["handoff"]
        context = handoff["conversation_context"]
        expected_users = [{key: deepcopy(event[key]) for key in ("id", "role", "content", "hash", "reply_to") if key in event}
            for event in previous if event["role"] == "user"]
        self.assertEqual([event for event in context["turns"] if event["role"] == "user"], expected_users)
        self.assertEqual(next(event["content"] for event in context["turns"] if event["id"] == first), initial)
        self.assertEqual(context["selection"]["mode"], "user_timeline_v1")
        self.assertEqual(context["selection"]["turn_offsets"], [0, 2, 4, 5, 6, 7, 8, 9, 10, 11])
        self.assertEqual((context["selection"]["user_total"], context["selection"]["user_included"]), (6, 6))
        self.assertTrue(context["selection"]["user_complete"])
        self.assertEqual(handoff["contract_version"], "personal-question-v5")
        self.assertEqual(handoff["instructions"], question_grounding.INSTRUCTIONS + " " + question_grounding.USER_DIALOGUE_INSTRUCTIONS)
        fixed_input = {key: value for key, value in handoff.items() if key != "access"}
        self.assertEqual(fixed_input["input_sha256"], sha256(canonical_json_bytes(
            {key: value for key, value in fixed_input.items() if key != "input_sha256"})).hexdigest())
        self.assertEqual(fixed_input, QuestionRunStore(self.scope)._input(execution["active"]["record"]))
        self.assertFalse(execution["active"]["server_ai_executed"])

    def test_review_and_relation_ledgers_are_distinct_v5_citations(self):
        reviews = ReviewStore(self.store)
        state = reviews.query("a.md")
        reviews.review("a.md", action="defer", claim_id=state["claims"][0]["claim_id"],
            expected_state_revision=state["state_revision"], reason="isolated review", actor=self.actor)
        state = reviews.query("a.md")
        replacement = _input(state["machine_graph"]["relations"][0])
        replacement.update(subject="b", predicate="depends_on", object="a", evidence="B depends on A.")
        RelationStore(self.store, self.actor).create("a.md", kind="source", replacement=replacement,
            request_id=uuid4().hex, expected_state_revision=state["state_revision"], reason="isolated source relation")
        execution = self.start()
        _, served = self.evidence(execution, action="history")
        refs = [row["citation"] for row in served["evidence"]["citations"]]
        self.assertEqual({row["kind"] for row in refs}, {"review"})
        self.assertEqual({row["ledger"] for row in refs}, {"review", "relation"})
        full = QuestionBasisStore(self.scope).load(execution["handoff"]["basis"])
        with self.assertRaises(ValueError):
            QuestionRunStore._validate_citations(full, refs)
        valid = QuestionRunStore._validate_citations(full, refs, allow_review=True)
        self.assertTrue(all(row["human_approval"] is False and row["layer"] == "review_history" for row in valid))
        wrong = self.answer_payload(execution, served)
        next(row for row in wrong["citations"] if row["ledger"] == "relation")["ledger"] = "review"
        self.post(f"/question-runs/{execution['run_id']}/answers", wrong, 422)
        self.submit(execution, self.answer_payload(execution, served))

    def test_legacy_v3_v4_serialization_and_answer_paths_remain_unchanged(self):
        self.assertNotIn("mode", QuestionContextRequest(documents=["a.md"]).model_dump())
        self.assertNotIn("ledger", AnswerCitation(kind="document", document="a.md", source_revision="0" * 64, quote="A").model_dump())
        for web in (None, web_result()):
            context = {"documents": ["a.md"], "required_documents": []}
            if web is not None:
                context["web"] = web
            execution = self.start(context=context)
            handoff = execution["handoff"]
            self.assertEqual(handoff["contract_version"], "personal-question-v4" if web else "personal-question-v3")
            self.assertEqual(handoff["basis"]["documents"][0]["content"], BODY)
            self.assertIn("citation_references", handoff["output"])
            reference = next(r for r in handoff["output"]["citation_references"] if r["kind"] == "document")
            content = "A는 B를 사용한다."
            payload = {"request_id": uuid4().hex, "expected_state_revision": execution["active"]["state_revision"],
                "run_id": execution["active"]["runtime"]["run_id"], "expected_conversation_revision": execution["conversation"]["revision"],
                "content": content, "citations": [{**reference, "quote": "A uses B."}],
                "execution": {"provider": "codex", "cli_version": "isolated-legacy-contract", "requested_model": None,
                    "reported_model": None, "input_sha256": handoff["input_sha256"], "prompt_sha256": "0" * 64,
                    "output_sha256": sha256(content.encode()).hexdigest()}}
            serialized = RunAnswer(**payload).model_dump(exclude={"profile"})
            self.assertNotIn("evidence_ids", serialized)
            self.submit(execution, serialized)
            receipt = self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 422)
            self.assertEqual(receipt["error"]["code"], "invalid_argument")

    def test_thirty_turns_keep_large_basis_once_and_small_conversation_and_input(self):
        for name in ("large-a.md", "large-b.md"):
            self.store.save(name, "# Large material\n" + "bounded source data\n" * 30000, expected_revision=None)
        context = {"documents": ["large-a.md", "large-b.md"], "required_documents": [], "mode": "on_demand"}
        conversation = self.conversation()
        reference_ids = set()
        before = self.canonical_source_files()
        for number in range(30):
            execution = self.start(context=context, conversation=conversation, text=f"질문 {number + 1}: 첫 문서의 표제를 알려 줘.")
            reference_ids.add(execution["handoff"]["basis"]["basis_id"])
            self.assertLess(len(canonical_json_bytes(execution["handoff"])), 20000)
            _, served = self.evidence(execution, line_count=1)
            self.submit(execution, self.answer_payload(execution, served))
            conversation = self.get(f"/conversations/{conversation['record']['id']}")
        self.assertEqual(len(conversation["record"]["events"]), 60)
        self.assertEqual(len(reference_ids), 1)
        self.assertLess(len(canonical_json_bytes(conversation["record"])), 400000)
        self.assertNotIn("bounded source data", json.dumps(conversation["record"]))
        self.assertFalse(execution["handoff"]["conversation_context"]["complete"])
        self.assertEqual(execution["handoff"]["conversation_context"]["preceding_turns"], 58)
        self.assertEqual(self.canonical_source_files(), before)
        saved = self.post("/saved-results", {"request_id": uuid4().hex, "title": "큰 근거 답변",
            "conversation_id": conversation["record"]["id"], "turn_id": conversation["record"]["events"][-1]["id"]}, 201)
        draft = self.post("/result-drafts", {"request_id": uuid4().hex, "saved_result_id": saved["record"]["id"]}, 201)
        rendered = self.get(f"/result-drafts/{draft['record']['id']}")
        self.assertFalse(rendered["can_apply_size"])
        self.assertIn("bounded source data", rendered["rendered_content"])
        self.assertGreater(rendered["rendered_size_bytes"], 1024 * 1024)


if __name__ == "__main__":
    import unittest
    unittest.main()
