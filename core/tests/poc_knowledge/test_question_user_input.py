"""격리 HTTP에서 추가 질문의 보존·사용권 해제·원래 근거 승계·재전송을 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

from core.api.v1.personal.schemas import AppendTurn
from core.api.v1.personal.workflows_schemas import RunCreate, RunAnswer
from core.common.json_codec import canonical_json_bytes
from core.modules.personal.question_basis import QuestionBasisStore
from core.modules.personal.question_interaction import pending_clarification, validate_clarification
from core.modules.personal.store import PersonalStore
from core.modules.templates.store import TemplateStore
from core.tests.poc_knowledge import test_question_grounding as helpers
from core.tests.poc_mcp.test_server_integration import ServerFixture


class QuestionUserInputTests(ServerFixture):
    post = helpers.QuestionGroundingHTTPTests.post
    get = helpers.QuestionGroundingHTTPTests.get
    conversation = helpers.QuestionGroundingHTTPTests.conversation

    def setUp(self):
        super().setUp()
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.store.save("a.md", "# A\nA uses B.\n", expected_revision=None)
        self.context = {"documents": ["a.md"], "required_documents": [], "mode": "on_demand",
                        "retrieval_scope": "selected"}

    def start_run(self, conversation, question_id, *, opt_in=True):
        body = {"request_id": uuid4().hex, "conversation_id": conversation["record"]["id"],
                "question_turn_id": question_id, "expected_conversation_revision": conversation["revision"]}
        if opt_in:
            body["interaction_contract"] = "user-input-v1"
        made = self.post("/question-runs", body, 201)
        run_id = made["record"]["id"]
        active = self.post(f"/question-runs/{run_id}/claim", {"request_id": uuid4().hex,
            "expected_state_revision": made["state_revision"], "reclaim": False})
        handoff = self.get(f"/question-runs/{run_id}/input", run_id=active["runtime"]["run_id"])
        return {"conversation": conversation, "question_id": question_id, "run_id": run_id,
                "active": active, "handoff": handoff}

    def start(self, *, opt_in=True, template_ref=None):
        conversation = self.conversation()
        question_id = uuid4().hex
        body = {"request_id": question_id, "expected_revision": conversation["revision"], "role": "user",
                "content": "A의 자료로 보고서를 작성해 주세요.\n[출력 양식] 전체 근거 보존", "context_request": self.context}
        if template_ref is not None:
            body["template_ref"] = template_ref
        conversation = self.post(f"/conversations/{conversation['record']['id']}/turns", body)
        return self.start_run(conversation, question_id, opt_in=opt_in)

    def answer(self, execution, *, clarification=True, content="어떤 독자를 대상으로 작성할까요?"):
        body = {"request_id": uuid4().hex, "expected_state_revision": execution["active"]["state_revision"],
            "run_id": execution["active"]["runtime"]["run_id"],
            "expected_conversation_revision": execution["conversation"]["revision"],
            "content": content, "citations": [], "evidence_ids": [],
            "execution": {"provider": "isolated-test", "cli_version": "test", "input_sha256": execution["handoff"]["input_sha256"],
                          "prompt_sha256": "0" * 64, "output_sha256": sha256(content.encode()).hexdigest()}}
        if clarification:
            body["clarification"] = {"options": ["개발자", "일반 독자"]}
        return body

    def ask(self, execution, *, content="어떤 독자를 대상으로 작성할까요?"):
        body = self.answer(execution, content=content)
        receipt = self.post(f"/question-runs/{execution['run_id']}/answers", body)
        self.assertTrue(receipt["saved"])
        conversation = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        return conversation, body

    def reply_body(self, conversation, clarification_id, text="개발자"):
        return {"request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
                "content": text, "clarification_turn_id": clarification_id}

    def test_wait_releases_lease_and_resume_keeps_original_question_basis_and_template(self):
        template = TemplateStore(self.scope).save(request_id=uuid4().hex, name="보고서", instructions="조건을 보존하세요",
            filename="form.txt", content=b"Title: {{title}}", before_commit=lambda: None)["template"]
        reference = {key: template[key] for key in ("id", "revision")}
        initial = self.start(template_ref=reference)
        conversation, answer = self.ask(initial)
        assistant = conversation["record"]["events"][-1]
        self.assertEqual(assistant["clarification"], answer["clarification"])
        self.assertFalse(assistant["human_approval"])
        completed = self.get(f"/question-runs/{initial['run_id']}")
        self.assertEqual(completed["runtime"]["status"], "complete")
        self.assertEqual(completed["lease_status"], "none")
        self.assertFalse(completed["server_ai_executed"])
        self.get(f"/question-runs/{initial['run_id']}/input", 409, run_id=initial["active"]["runtime"]["run_id"])
        replay = self.post(f"/question-runs/{initial['run_id']}/answers", answer)
        self.assertTrue(replay["saved"])
        self.assertEqual(self.get(f"/question-runs/{initial['run_id']}/answers/{answer['request_id']}")["receipt"]["answer_turn_id"], assistant["id"])
        response = self.reply_body(conversation, assistant["id"], "  개발자 대상입니다. 전체 조건을 유지해 주세요.  ")
        url = f"/conversations/{conversation['record']['id']}/turns"
        replied = self.post(url, response)
        self.assertTrue(self.post(url, response)["replayed"])
        event = replied["record"]["events"][-1]
        self.assertEqual(event["content"], response["content"])
        self.assertEqual(event["template_ref"], reference)
        self.assertEqual(event["clarification_turn_id"], assistant["id"])
        resumed = self.start_run(replied, response["request_id"])
        handoff, data = resumed["handoff"], resumed["active"]["record"]["data"]
        for key in ("question", "basis", "template_ref", "initial_evidence"):
            self.assertEqual(handoff[key], initial["handoff"][key])
        self.assertEqual(data["question_hash"], event["hash"])
        self.assertEqual(handoff["continuation"], {"root_question_turn_id": initial["question_id"],
            "clarification_turn_id": assistant["id"], "exchanges": [{"question": answer["content"], "answer": response["content"]}]})
        self.assertEqual(handoff["continuation"], data["continuation"])
        full_basis = QuestionBasisStore(self.scope).load(handoff["basis"])
        self.assertEqual(full_basis["retrieval"]["question_sha256"], sha256(handoff["question"].encode()).hexdigest())
        final = self.answer(resumed, clarification=False, content="개발자용 보고서입니다.")
        self.assertTrue(self.post(f"/question-runs/{resumed['run_id']}/answers", final)["saved"])
        final_conversation = self.get(f"/conversations/{conversation['record']['id']}")
        self.assertNotIn("clarification", final_conversation["record"]["events"][-1])
        self.post("/saved-results", {"request_id": uuid4().hex, "title": "보고서", "conversation_id": conversation["record"]["id"],
            "turn_id": final["request_id"]}, 201)

    def test_old_contract_and_optional_null_fields_keep_request_fingerprints(self):
        execution = self.start(opt_in=False)
        self.assertNotIn("interaction_contract", execution["handoff"])
        self.assertNotIn("interaction_contract", execution["active"]["record"]["data"])
        answer = self.answer(execution)
        self.post(f"/question-runs/{execution['run_id']}/answers", answer, 422)
        answer.pop("clarification")
        plain = RunAnswer.model_validate(answer).model_dump()
        self.assertEqual(plain, RunAnswer.model_validate({**answer, "clarification": None}).model_dump())
        self.assertNotIn("clarification", plain)
        create = {"request_id": uuid4().hex, "conversation_id": uuid4().hex,
                  "question_turn_id": uuid4().hex, "expected_conversation_revision": "0" * 64}
        self.assertEqual(RunCreate.model_validate(create).model_dump(),
                         RunCreate.model_validate({**create, "interaction_contract": None}).model_dump())
        append = {"request_id": uuid4().hex, "expected_revision": "0" * 64, "role": "user", "content": "A?", "context_request": self.context}
        self.assertEqual(AppendTurn.model_validate(append).model_dump(),
                         AppendTurn.model_validate({**append, "clarification_turn_id": None}).model_dump())
        self.assertTrue(self.post(f"/question-runs/{execution['run_id']}/answers", answer)["saved"])
        conversation = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertNotIn("clarification", conversation["record"]["events"][-1])
        self.post(f"/conversations/{conversation['record']['id']}/turns", self.reply_body(conversation, answer["request_id"]), 422)

    def test_reply_rejects_cross_conversation_consumed_and_competing_responses(self):
        execution = self.start()
        waiting, question = self.ask(execution)
        foreign = self.conversation()
        self.post(f"/conversations/{foreign['record']['id']}/turns", self.reply_body(foreign, question["request_id"]), 409)
        body = self.reply_body(waiting, question["request_id"])
        url = self.base_url + f"/conversations/{waiting['record']['id']}/turns"
        def submit(payload):
            return self.client.post(url, headers=self.headers(), json=payload)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(submit, [body, {**body, "request_id": uuid4().hex}]))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        after = self.get(f"/conversations/{waiting['record']['id']}")
        self.assertEqual(len(after["record"]["events"]), 3)
        self.post(f"/conversations/{waiting['record']['id']}/turns", self.reply_body(after, question["request_id"]), 409)
        other = self.signup("별도 사용자")
        self.get(f"/conversations/{waiting['record']['id']}", 404, token=other["token"])

    def test_reply_forbids_client_basis_template_context_and_oversized_answers(self):
        execution = self.start()
        waiting, question = self.ask(execution)
        body = self.reply_body(waiting, question["request_id"])
        url = f"/conversations/{waiting['record']['id']}/turns"
        for extra in ({"context_request": self.context}, {"basis": execution["handoff"]["basis"]},
                      {"template_ref": {"id": "0" * 32, "revision": "0" * 64}},
                      {"content": "x" * 16001}, {"content": "  "}):
            with self.subTest(extra=list(extra)):
                self.post(url, {**body, **extra}, 422)
        self.assertEqual(self.get(f"/conversations/{waiting['record']['id']}")["revision"], waiting["revision"])

    def test_clarification_validation_and_saved_result_boundary(self):
        execution = self.start()
        body = self.answer(execution)
        url = f"/question-runs/{execution['run_id']}/answers"
        for extra in ({"clarification": {"options": ["a"] * 4}}, {"clarification": {"options": [" "]}},
                      {"clarification": {"options": ["x" * 201]}}, {"clarification": {"options": [], "approved": True}},
                      {"content": "x" * 4001}, {"content": " "}):
            with self.subTest(extra=extra.keys()):
                self.post(url, {**body, **extra}, 422)
        body["clarification"] = {"options": []}
        self.post(url, body)
        self.post("/saved-results", {"request_id": uuid4().hex, "title": "추가 질문", "conversation_id": execution["conversation"]["record"]["id"],
            "turn_id": body["request_id"]}, 422)

    def test_changed_basis_and_revoked_permission_preserve_waiting_question(self):
        execution = self.start()
        waiting, question = self.ask(execution)
        previous = self.store.read("a.md")
        self.store.save("a.md", previous.content + "Changed.\n", expected_revision=previous.revision)
        url = f"/conversations/{waiting['record']['id']}/turns"
        self.post(url, self.reply_body(waiting, question["request_id"]), 409)
        self.assertEqual(self.get(f"/conversations/{waiting['record']['id']}")["revision"], waiting["revision"])
        def revoke_after_read(*args):
            root = pending_clarification(*args)
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
            return root
        with patch("core.api.v1.personal.router.pending_clarification", side_effect=revoke_after_read):
            # 질문을 읽은 다음 권한이 회수돼도 저장 직전 검사에서 쓰기를 막는다.
            self.post(url, self.reply_body(waiting, question["request_id"]), 403)
        self.assertEqual(self.get(f"/conversations/{waiting['record']['id']}")["revision"], waiting["revision"])

    def test_write_failure_does_not_consume_pending_question(self):
        execution = self.start()
        waiting, question = self.ask(execution)
        body = self.reply_body(waiting, question["request_id"])
        url = f"/conversations/{waiting['record']['id']}/turns"
        with patch.object(PersonalStore, "append", side_effect=OSError("isolated write failure")):
            self.post(url, body, 500)
        self.assertEqual(self.get(f"/conversations/{waiting['record']['id']}")["revision"], waiting["revision"])
        self.assertEqual(self.post(url, body)["record"]["events"][-1]["id"], body["request_id"])

    def test_stale_run_cannot_replace_new_question_with_clarification(self):
        execution = self.start()
        conversation = execution["conversation"]
        newer = self.post(f"/conversations/{conversation['record']['id']}/turns", {
            "request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
            "content": "새 질문입니다.", "context_request": self.context})
        body = self.answer(execution)
        body["expected_conversation_revision"] = newer["revision"]
        self.post(f"/question-runs/{execution['run_id']}/answers", body, 409)
        self.assertEqual(self.get(f"/conversations/{conversation['record']['id']}")["revision"], newer["revision"])

    def test_continuation_requires_capability_and_create_replay_is_unchanged(self):
        execution = self.start()
        waiting, question = self.ask(execution)
        reply = self.reply_body(waiting, question["request_id"])
        conversation = self.post(f"/conversations/{waiting['record']['id']}/turns", reply)
        create = {"request_id": uuid4().hex, "conversation_id": conversation["record"]["id"],
                  "question_turn_id": reply["request_id"], "expected_conversation_revision": conversation["revision"]}
        self.post("/question-runs", create, 422)
        create["interaction_contract"] = "user-input-v1"
        made = self.post("/question-runs", create, 201)
        replay = self.post("/question-runs", create)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["record"]["id"], made["record"]["id"])
        self.post("/question-runs", {**create, "interaction_contract": None}, 409)

    def test_legacy_embedded_basis_does_not_advertise_an_unsupported_interaction(self):
        conversation = self.conversation()
        question_id = uuid4().hex
        conversation = self.post(f"/conversations/{conversation['record']['id']}/turns", {
            "request_id": question_id, "expected_revision": conversation["revision"], "role": "user",
            "content": "A?", "context_request": {"documents": ["a.md"], "required_documents": []}})
        create = {"request_id": uuid4().hex, "conversation_id": conversation["record"]["id"],
            "question_turn_id": question_id, "expected_conversation_revision": conversation["revision"]}
        self.post("/question-runs", {**create, "interaction_contract": "user-input-v1"}, 422)
        made = self.post("/question-runs", create, 201)
        self.assertNotIn("interaction_contract", made["record"]["data"])

    def test_five_exchanges_retain_full_answers_then_require_final_answer(self):
        execution = self.start()
        original = execution["handoff"]["question"]
        expected = []
        for number in range(5):
            waiting, question = self.ask(execution, content=f"추가 확인 {number + 1}?")
            response = self.reply_body(waiting, question["request_id"], f"답변 {number + 1}\n" + "원문 " * 100)
            replied = self.post(f"/conversations/{waiting['record']['id']}/turns", response)
            execution = self.start_run(replied, response["request_id"])
            expected.append({"question": question["content"], "answer": response["content"]})
            self.assertEqual(execution["handoff"]["question"], original)
            self.assertEqual(execution["handoff"]["continuation"]["exchanges"], expected)
        self.post(f"/question-runs/{execution['run_id']}/answers", self.answer(execution), 422)
        final = self.answer(execution, clarification=False, content="다섯 답변을 반영한 최종 문장입니다.")
        self.assertTrue(self.post(f"/question-runs/{execution['run_id']}/answers", final)["saved"])

    def test_option_details_survive_storage_replay_and_continuation_without_leaking_into_final_answer(self):
        execution = self.start()
        answer = self.answer(execution)
        answer["clarification"]["option_details"] = [{"option": "개발자",
            "description": "기술 조건과 예외를 자세히 설명합니다. 현재 요청의 구현 검토에 적합합니다.", "recommended": True}]
        url = f"/question-runs/{execution['run_id']}/answers"
        saved = self.post(url, answer)
        self.assertTrue(saved["saved"])
        replay = self.post(url, answer)
        self.assertEqual(saved["receipt"], replay["receipt"])
        waiting = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual(waiting["record"]["events"][-1]["clarification"], answer["clarification"])
        changed = deepcopy(answer)
        changed["clarification"]["option_details"][0]["description"] = "다른 설명"
        self.post(url, changed, 409)
        response = self.reply_body(waiting, answer["request_id"])
        replied = self.post(f"/conversations/{waiting['record']['id']}/turns", response)
        resumed = self.start_run(replied, response["request_id"])
        expected = {"question": answer["content"], "answer": response["content"],
                    "clarification": answer["clarification"]}
        self.assertEqual(resumed["handoff"]["continuation"]["exchanges"], [expected])
        self.assertEqual(resumed["active"]["record"]["data"]["continuation"]["exchanges"], [expected])
        self.assertEqual(resumed["handoff"]["basis"], execution["handoff"]["basis"])
        final = self.answer(resumed, clarification=False, content="개발자 대상 설명을 적용한 결과입니다.")
        self.post(f"/question-runs/{resumed['run_id']}/answers", final)
        conversation = self.get(f"/conversations/{waiting['record']['id']}")
        self.assertEqual(conversation["record"]["events"][1]["clarification"], answer["clarification"])
        self.assertNotIn("clarification", conversation["record"]["events"][-1])
        self.assertNotIn("option_details", conversation["record"]["events"][-1])

    def test_null_option_details_keep_legacy_bytes_replay_and_exchange_shape(self):
        execution = self.start()
        answer = self.answer(execution)
        legacy = RunAnswer.model_validate(answer).model_dump()
        explicit_null = deepcopy(answer)
        explicit_null["clarification"]["option_details"] = None
        self.assertEqual(canonical_json_bytes(legacy),
                         canonical_json_bytes(RunAnswer.model_validate(explicit_null).model_dump()))
        self.assertEqual(legacy["clarification"], {"options": ["개발자", "일반 독자"]})
        url = f"/question-runs/{execution['run_id']}/answers"
        self.post(url, answer)
        self.assertTrue(self.post(url, explicit_null)["saved"])
        empty = deepcopy(answer)
        empty["clarification"]["option_details"] = []
        self.post(url, empty, 409)
        waiting = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual(waiting["record"]["events"][-1]["clarification"], legacy["clarification"])
        response = self.reply_body(waiting, answer["request_id"])
        replied = self.post(f"/conversations/{waiting['record']['id']}/turns", response)
        resumed = self.start_run(replied, response["request_id"])
        self.assertEqual(resumed["handoff"]["continuation"]["exchanges"], [
            {"question": answer["content"], "answer": response["content"]}])

    def test_malformed_option_details_leave_conversation_and_run_unchanged(self):
        execution = self.start()
        answer = self.answer(execution)
        detail = {"option": "개발자", "description": "조건을 자세히 설명합니다.", "recommended": True}
        malformed = [
            [detail, detail],
            [detail, {**detail, "option": "일반 독자"}],
            [{**detail, "option": "없는 선택지"}],
            [{**detail, "option": " 개발자"}],
            [{**detail, "description": ""}],
            [{**detail, "description": " \n\t"}],
            [{**detail, "description": "x" * 401}],
            [{**detail, "description": "인용 [[d1:1:2]]"}],
            [{**detail, "description": "wiki-template-result 내부 자료"}],
            [{**detail, "recommended": 1}],
            [{**detail, "recommended": "true"}],
            [{"option": "개발자", "description": "추천 여부 누락"}],
            [{**detail, "extra": "unsupported"}],
            [detail] * 4,
            {"option": "개발자"},
        ]
        url = f"/question-runs/{execution['run_id']}/answers"
        for index, details in enumerate(malformed):
            with self.subTest(index=index):
                metadata = {**answer["clarification"], "option_details": details}
                self.post(url, {**answer, "clarification": metadata}, 422)
                with self.assertRaises(ValueError):
                    validate_clarification(answer["content"], metadata)
        self.assertEqual(self.get(f"/conversations/{execution['conversation']['record']['id']}")["revision"],
                         execution["conversation"]["revision"])
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["revision"], execution["active"]["revision"])
        # 설명이 없는 선택지, 추천 없는 설명, 최대 길이는 모두 유효하다.
        answer["clarification"]["option_details"] = [{**detail, "description": "x" * 400, "recommended": False}]
        self.assertTrue(self.post(url, answer)["saved"])

    def test_empty_option_details_are_preserved_as_explicit_metadata(self):
        execution = self.start()
        answer = self.answer(execution)
        answer["clarification"]["option_details"] = []
        self.post(f"/question-runs/{execution['run_id']}/answers", answer)
        waiting = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual(waiting["record"]["events"][-1]["clarification"], answer["clarification"])
        response = self.reply_body(waiting, answer["request_id"])
        replied = self.post(f"/conversations/{waiting['record']['id']}/turns", response)
        resumed = self.start_run(replied, response["request_id"])
        self.assertEqual(resumed["handoff"]["continuation"]["exchanges"][0]["clarification"], answer["clarification"])

    def test_described_option_labels_match_client_validation_without_changing_legacy_acceptance(self):
        for options in (["A", "A"], ["[[d1:1:1]]"], ["wiki-template-result 내부 표기"]):
            with self.subTest(options=options):
                execution = self.start()
                answer = self.answer(execution)
                answer["clarification"] = {"options": options}
                url = f"/question-runs/{execution['run_id']}/answers"
                for details in ([], [{"option": options[0], "description": "설명", "recommended": True}]):
                    metadata = {"options": options, "option_details": details}
                    self.post(url, {**answer, "clarification": metadata}, 422)
                    with self.assertRaises(ValueError):
                        validate_clarification(answer["content"], metadata)
                self.assertEqual(self.get(f"/conversations/{execution['conversation']['record']['id']}")["revision"],
                                 execution["conversation"]["revision"])
                self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["revision"], execution["active"]["revision"])
                # 과거 저장과 요청 지문은 새 metadata의 제약을 소급 적용하지 않는다.
                validate_clarification(answer["content"], answer["clarification"])
                null_metadata = {"options": options, "option_details": None}
                validate_clarification(answer["content"], null_metadata)
                self.assertTrue(self.post(url, answer)["saved"])
                self.assertTrue(self.post(url, {**answer, "clarification": null_metadata})["saved"])
