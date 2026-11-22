"""정식 템플릿 선택의 전 원문 조회·실제 저장과 불완전 차단을 격리 검증한다."""

import asyncio
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import json
from tempfile import TemporaryDirectory
from uuid import uuid4

from core.api.v1.personal.schemas import AppendTurn
from core.client.ai.contracts import AIAdapterError
from core.client.question import QuestionClientError
from core.client.question_ai import assemble_question, answer_payload
from core.client.transport import AnalysisClientError
from core.client.question_grounding import run_grounded_model, grounding_prompt, MAX_CONTEXT_BYTES
from core.client.question_source_prefetch import source_answer_budget, EVIDENCE_PAGE_BYTES, EVIDENCE_ENVELOPE_BYTES
from core.common.json_codec import canonical_json_hash
from core.modules.knowledge.question_evidence import read_evidence, MAX_RESPONSE_BYTES
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.personal.question_basis import QuestionBasisStore
from core.modules.personal.template_grounding import source_prefetch_contract
from core.modules.reviews.store import ReviewStore
from core.modules.templates.store import TemplateStore
from core.tests.poc_knowledge import test_question_grounding as grounding_helpers
from core.tests.poc_knowledge.test_question_grounding_client import FakeOwner, FakeAdapter, step
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class TemplateQuestionSourcesTests(ServerFixture):
    post = grounding_helpers.QuestionGroundingHTTPTests.post
    get = grounding_helpers.QuestionGroundingHTTPTests.get
    conversation = grounding_helpers.QuestionGroundingHTTPTests.conversation
    start = grounding_helpers.QuestionGroundingHTTPTests.start
    evidence_payload = grounding_helpers.QuestionGroundingHTTPTests.evidence_payload
    evidence = grounding_helpers.QuestionGroundingHTTPTests.evidence
    submit = grounding_helpers.QuestionGroundingHTTPTests.submit

    def setUp(self):
        super().setUp()
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.context = {"documents": [f"source-{i}.md" for i in range(5)], "required_documents": [],
                        "mode": "on_demand", "retrieval_scope": "selected"}
        for index, document in enumerate(self.context["documents"]):
            content = "A uses B.\nB is a pump.\n\n" + "\n\n".join(
                f"Material {index} passage {number}: preserve this distinct requirement and its exception."
                for number in range(1, 40)) + "\n"
            source = self.store.save(document, content, expected_revision=None)
            OntologyStore(self.store).generate(document, source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        saved = TemplateStore(self.scope).save(request_id=uuid4().hex, name="시험 양식", instructions="원문 전체 사용",
            filename="form.txt", content=b"Title: {{title}}", before_commit=lambda: None)
        self.template_ref = {key: saved["template"][key] for key in ("id", "revision")}

    def append(self, conversation, text="모든 자료로 양식을 작성하세요.", *, context=None):
        qid = uuid4().hex
        body = {"request_id": qid, "expected_revision": conversation["revision"], "role": "user",
                "content": text, "context_request": self.context if context is None else context}
        if self.template_ref is not None:
            body["template_ref"] = self.template_ref
        return self.post(f"/conversations/{conversation['record']['id']}/turns", body), qid

    def owner(self, directory, execution, mutate=None):
        fixture = self
        class HttpOwner(FakeOwner):
            async def query_evidence(owner, query):
                owner.queries.append(deepcopy(query))
                _, served = fixture.evidence(execution, **query)
                result = served["evidence"]
                return mutate(query, result) if mutate else result
        return HttpOwner(directory)

    def final_id(self, execution):
        basis = QuestionBasisStore(self.scope).load(execution["handoff"]["basis"])
        result = read_evidence(basis, {"action": "search", "material_id": "d5", "query": "", "offset": 20, "limit": 20})
        return result["evidence_ids"][-1]

    def test_ten_source_pages_and_initial_precede_one_model_answer_and_actual_storage(self):
        execution = self.start()
        handoff = execution["handoff"]
        self.assertEqual(handoff["template_ref"], self.template_ref)
        self.assertEqual(handoff["output"]["max_evidence_reads"], 16)
        self.assertEqual(handoff["source_prefetch"]["status"], "ready")
        planned_prompt = assemble_question(handoff, execution["active"]["record"])
        self.assertNotIn("source_prefetch_result", planned_prompt)
        self.assertNotIn("The source prefetch completed", planned_prompt)
        tampered = deepcopy(handoff)
        tampered["template_ref"]["revision"] = "0" * 64
        with self.assertRaisesRegex(AnalysisClientError, "question_input_mismatch"):
            assemble_question(tampered, execution["active"]["record"])
        identifier = self.final_id(execution)
        before = grounding_helpers.QuestionGroundingHTTPTests.canonical_source_files(self)
        with TemporaryDirectory() as directory:
            owner = self.owner(directory, execution)
            adapter = FakeAdapter([step("answer", content=f"마지막 조건까지 반영합니다 [[{identifier}]].", evidence_ids=[identifier])])
            result, prompt = asyncio.run(run_grounded_model(owner, adapter, handoff, select_tools=True))
            self.assertEqual(len(adapter.calls), 1)
            self.assertEqual(len(owner.queries), 11)
            self.assertEqual([q["action"] for q in owner.queries], ["initial"] + ["search"] * 10)
            self.assertEqual([(q["material_id"], q["offset"]) for q in owner.queries[1:]],
                [(f"d{i}", offset) for i in range(1, 6) for offset in (0, 20)])
            self.assertIn("Material 4 passage 39", prompt)
            self.assertIn("not a complete graph", prompt)
            self.assertIn("The source prefetch completed every meaningful source passage", prompt)
            self.assertIn("Fill all required blank fields", prompt)
            self.assertIn("not facts", prompt)
            self.assertEqual(adapter.calls[0]["schema"]["properties"]["content"]["maxLength"], 32000)
            self.assertEqual(result["execution"]["question_template_output_budget"], {
                "version": 1, "max_content_characters": 32000,
                "target_content_characters": 20000, "truncation_allowed": False})
            self.assertLessEqual(len(prompt.encode()), 192 * 1024)
            coverage = result["execution"]["question_automatic_reads"][-1]
            for material in coverage["materials"]:
                document = handoff["basis"]["documents"][int(material["material_id"][1:]) - 1]
                nonempty = {i for i, line in enumerate(self.store.read(document["document"]).content.splitlines(), 1)
                            if line.strip()}
                returned = {i for first, last in material["returned_ranges"] for i in range(first, last + 1)}
                self.assertTrue(nonempty <= returned)
            answer = answer_payload(result, handoff=handoff, prompt=prompt)
            payload = {**answer, "request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"],
                "run_id": execution["active"]["runtime"]["run_id"],
                "expected_conversation_revision": execution["conversation"]["revision"]}
            self.submit(execution, payload)
        stored = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual(len(stored["record"]["events"]), 2)
        self.assertEqual(stored["record"]["events"][-1]["content"], answer["content"])
        self.assertEqual(grounding_helpers.QuestionGroundingHTTPTests.canonical_source_files(self), before)

    def test_normal_and_marker_only_questions_keep_six_read_contract(self):
        self.template_ref = None
        for text in ("A uses B?", "A uses B?\n\n[등록 템플릿 v1]\n{\"id\":\"not-selected\"}"):
            execution = self.start(text=text)
            self.assertNotIn("template_ref", execution["handoff"])
            self.assertNotIn("source_prefetch", execution["handoff"])
            self.assertEqual(execution["handoff"]["output"]["max_evidence_reads"], 6)
            initial = execution["active"]["record"]["data"]["initial_evidence"]
            with TemporaryDirectory() as directory:
                owner = self.owner(directory, execution)
                identifier = initial["evidence_ids"][0]
                adapter = FakeAdapter([step("answer", content=f"확인 [[{identifier}]].", evidence_ids=[identifier])])
                asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
                self.assertEqual([q["action"] for q in owner.queries], ["initial"])
                self.assertNotIn("source_prefetch_result", adapter.calls[0]["prompt"])
                self.assertNotIn("The source prefetch completed", adapter.calls[0]["prompt"])
                self.assertNotIn("template_output_budget", adapter.calls[0]["prompt"])
                self.assertEqual(adapter.calls[0]["schema"]["properties"]["content"]["maxLength"], 65536)

    def test_template_overlong_answer_is_rejected_without_truncating_or_saving(self):
        execution = self.start()
        identifier = self.final_id(execution)
        before = grounding_helpers.QuestionGroundingHTTPTests.canonical_source_files(self)
        content = "가" * 32001 + f" [[{identifier}]]"
        with TemporaryDirectory() as directory:
            owner = self.owner(directory, execution)
            adapter = FakeAdapter([step("answer", content=content, evidence_ids=[identifier])])
            with self.assertRaisesRegex(AIAdapterError, "ai_invalid_result"):
                asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True))
            raw = json.loads((owner.directory / "evidence-model-00.json").read_text())
            self.assertEqual(raw["value"]["content"], content)
        stored = self.get(f"/conversations/{execution['conversation']['record']['id']}")
        self.assertEqual([row["role"] for row in stored["record"]["events"]], ["user"])
        self.assertEqual(grounding_helpers.QuestionGroundingHTTPTests.canonical_source_files(self), before)

    def test_model_global_claim_request_uses_frozen_wiki_scope_and_can_save_answer(self):
        execution = self.start()
        identifier = self.final_id(execution)
        with TemporaryDirectory() as directory:
            owner = self.owner(directory, execution)
            adapter = FakeAdapter([step("claims", material_id=None, query="", offset=0, limit=20),
                step("answer", content=f"모든 원문을 확인했습니다 [[{identifier}]].", evidence_ids=[identifier])])
            result, prompt = asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True))
            self.assertEqual(len(adapter.calls), 2)
            self.assertEqual(owner.queries[-1]["action"], "claims")
            self.assertIsNone(owner.queries[-1]["material_id"])
            event = execution["active"]["record"]["events"][-1]
            self.assertEqual(event["evidence"]["scope"]["material_ids"], [f"d{i}" for i in range(1, 6)])
            self.assertEqual(event["evidence"]["scope"]["completion_scope"], "matching_records")
            answer = answer_payload(result, handoff=execution["handoff"], prompt=prompt)
            self.submit(execution, {**answer, "request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"],
                "run_id": execution["active"]["runtime"]["run_id"],
                "expected_conversation_revision": execution["conversation"]["revision"]})

    def test_completed_sources_with_little_prompt_space_answer_once_with_unmodified_hashes(self):
        execution = self.start(text="가" * 30000)
        identifier = self.final_id(execution)
        with TemporaryDirectory() as directory:
            owner = self.owner(directory, execution)
            adapter = FakeAdapter([step("answer", content=f"추가 판단은 확인되지 않았습니다 [[{identifier}]].",
                                        evidence_ids=[identifier])])
            result, prompt = asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True))
            self.assertEqual(len(adapter.calls), 1)
            self.assertEqual(len(owner.queries), 11)
            self.assertEqual(adapter.calls[0]["schema"]["properties"]["action"]["enum"], ["answer"])
            self.assertIn("This step permits answer only", prompt)
            self.assertIn("clarification question", prompt)
            self.assertIn("0 further evidence queries available", prompt)
            self.assertLessEqual(len(prompt.encode()), MAX_CONTEXT_BYTES)
            boundary = result["execution"]["question_context_limits"][0]
            self.assertEqual(boundary["completed_material_ids"], [f"d{i}" for i in range(1, 6)])
            self.assertEqual(boundary["graph_coverage"], "initial_and_explicit_reads_only")
            self.assertLess(boundary["remaining_prompt_bytes"], EVIDENCE_PAGE_BYTES + EVIDENCE_ENVELOPE_BYTES)
            self.assertEqual(boundary["prompt_sha256"], sha256(prompt.encode()).hexdigest())
            self.assertEqual(boundary["prompt_sha256"], result["execution"]["prompt_sha256"])
            self.assertEqual(boundary["schema_sha256"], canonical_json_hash(adapter.calls[0]["schema"]))
            self.assertEqual(json.loads((owner.directory / "evidence-context-00.json").read_text()), boundary)
            self.assertEqual((adapter.calls[0]["directory"] / "prompt.txt").read_text(), prompt)
            answer = answer_payload(result, handoff=execution["handoff"], prompt=prompt)
            self.submit(execution, {**answer, "request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"],
                "run_id": execution["active"]["runtime"]["run_id"],
                "expected_conversation_revision": execution["conversation"]["revision"]})

    def test_context_answer_boundary_requires_actual_complete_sources_and_exact_reserve(self):
        execution = self.start()
        handoff = deepcopy(execution["handoff"])
        maximum, reserve = MAX_CONTEXT_BYTES, EVIDENCE_PAGE_BYTES + EVIDENCE_ENVELOPE_BYTES
        self.assertEqual(EVIDENCE_PAGE_BYTES, MAX_RESPONSE_BYTES)
        self.assertIsNone(source_answer_budget(handoff, maximum - 1, maximum, 11))
        handoff["source_prefetch_result"] = {"mode": "all_source_passages_v1", "complete": True,
            "scope": "all_selected_meaningful_source_passages",
            "materials": [{"material_id": f"d{i}", "complete": True} for i in range(1, 6)]}
        self.assertIsNone(source_answer_budget(handoff, maximum - reserve, maximum, 11))
        boundary = source_answer_budget(handoff, maximum - reserve + 1, maximum, 11)
        self.assertEqual(boundary["remaining_prompt_bytes"], reserve - 1)
        for kind in ("ordinary", "incomplete", "missing_material"):
            changed = deepcopy(handoff)
            if kind == "ordinary":
                changed.pop("template_ref")
            elif kind == "incomplete":
                changed["source_prefetch_result"]["complete"] = False
            else:
                changed["source_prefetch_result"]["materials"].pop()
            self.assertIsNone(source_answer_budget(changed, maximum - 1, maximum, 11))
        # 경계 안내도 입력 제한에 포함하며 원문·지문을 자르지 않는다.
        handoff["instructions"] = "x" * maximum
        with self.assertRaisesRegex(AIAdapterError, "ai_input_limit"):
            grounding_prompt(handoff, [], source_budget=boundary)

    def test_context_answer_boundary_rejects_a_query_without_serving_more_evidence(self):
        execution = self.start(text="가" * 30000)
        with TemporaryDirectory() as directory:
            owner, adapter = self.owner(directory, execution), FakeAdapter([step("claims", material_id=None)])
            with self.assertRaisesRegex(AIAdapterError, "ai_invalid_result"):
                asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True))
            self.assertEqual(len(adapter.calls), 1)
            self.assertEqual(len(owner.queries), 11)

    def test_failed_run_cannot_be_reclaimed_but_same_saved_question_can_start_new_run(self):
        execution = self.start()
        failed = self.post(f"/question-runs/{execution['run_id']}/progress", {"request_id": uuid4().hex,
            "run_id": execution["active"]["runtime"]["run_id"],
            "expected_state_revision": execution["active"]["state_revision"], "progress": "failed", "message": "isolated failure"})
        self.post(f"/question-runs/{execution['run_id']}/claim", {"request_id": uuid4().hex,
            "expected_state_revision": failed["state_revision"], "reclaim": True}, 409)
        made = self.post("/question-runs", {"request_id": uuid4().hex,
            "conversation_id": execution["conversation"]["record"]["id"],
            "question_turn_id": execution["question_id"],
            "expected_conversation_revision": execution["conversation"]["revision"]}, 201)
        self.assertNotEqual(made["record"]["id"], execution["run_id"])
        self.assertEqual(made["record"]["data"]["basis"], execution["handoff"]["basis"])
        self.assertEqual(made["record"]["data"]["template_ref"], execution["handoff"]["template_ref"])
        claimed = self.post(f"/question-runs/{made['record']['id']}/claim", {"request_id": uuid4().hex,
            "expected_state_revision": made["state_revision"], "reclaim": False})
        self.assertEqual(claimed["runtime"]["status"], "running")
        self.assertEqual(self.get(f"/question-runs/{execution['run_id']}")["runtime"]["status"], "failed")

    def test_optional_null_preserves_old_request_hash_and_replay(self):
        conversation = self.conversation()
        raw = {"request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
               "content": "A?", "context_request": self.context}
        omitted, explicit = AppendTurn.model_validate(raw), AppendTurn.model_validate({**raw, "template_ref": None})
        old = omitted.model_dump()
        self.assertNotIn("template_ref", old)
        self.assertEqual(old, {**raw, "profile": None, "status": "complete", "reply_to": None,
                              "context_request": omitted.context_request.model_dump()})
        self.assertEqual(canonical_json_hash(old), canonical_json_hash(explicit.model_dump()))
        url = f"/conversations/{conversation['record']['id']}/turns"
        first = self.post(url, raw)
        replay = self.post(url, {**raw, "template_ref": None})
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["revision"], replay["revision"])

    def test_invalid_template_and_assistant_selection_rejected_without_turn(self):
        conversation = self.conversation()
        url = f"/conversations/{conversation['record']['id']}/turns"
        raw = {"request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
               "content": "A?", "context_request": self.context, "template_ref": self.template_ref}
        self.post(url, {**raw, "template_ref": {**self.template_ref, "revision": "0" * 64}}, 404)
        self.post(url, {**raw, "template_ref": {**self.template_ref, "id": "0" * 32}}, 404)
        self.post(url, {**raw, "role": "assistant", "context_request": None, "reply_to": uuid4().hex}, 422)
        other_root = self.root / "other-tenant"
        (other_root / "wiki").mkdir(parents=True)
        other_scope = replace(self.scope, tenant="other-tenant", store=WikiStore(other_root))
        foreign = TemplateStore(other_scope).save(request_id=uuid4().hex, name="별도", instructions="",
            filename="other.txt", content=b"other", before_commit=lambda: None)["template"]
        self.post(url, {**raw, "template_ref": {key: foreign[key] for key in ("id", "revision")}}, 404)
        self.assertEqual(self.get(f"/conversations/{conversation['record']['id']}")["record"]["events"], [])

    def test_judgments_block_before_query_or_model(self):
        state = ReviewStore(self.store).query("source-0.md")
        ReviewStore(self.store).review("source-0.md", action="reject", claim_id=state["claims"][0]["claim_id"],
            expected_state_revision=state["state_revision"], reason="격리 검토", actor={
                key: getattr(self.scope, key) for key in ("user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")})
        execution = self.start()
        self.assertEqual(execution["handoff"]["source_prefetch"]["status"], "blocked")
        with TemporaryDirectory() as directory:
            owner, adapter = self.owner(directory, execution), FakeAdapter([])
            with self.assertRaisesRegex(AIAdapterError, "question_source_judgments_unread"):
                asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
            self.assertEqual(owner.queries, [])
            self.assertEqual(adapter.calls, [])
        empty = {"complete": True, "documents": [{"knowledge": {"claims": []}}]}
        for key in ("policies", "history", "relation_history", "authored_relations", "pending_history", "current_pending_history"):
            basis = deepcopy(empty)
            basis["documents"][0]["knowledge"][key] = [{"status": "pending"}]
            self.assertEqual(source_prefetch_contract(basis)["status"], "blocked", key)

    def test_revoked_permissions_block_template_replay(self):
        conversation = self.conversation()
        raw = {"request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
               "content": "A?", "context_request": self.context, "template_ref": self.template_ref}
        url = f"/conversations/{conversation['record']['id']}/turns"
        self.post(url, raw)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(
            permissions=[]))
        self.post(url, raw, 403)

    def test_page_stall_skipped_and_missing_page_stop_with_no_model(self):
        for mode in ("stall", "skipped", "missing"):
            execution = self.start()
            def mutate(query, response):
                if query["action"] == "search":
                    if mode == "stall":
                        response["next_offset"] = query["offset"]
                    elif mode == "skipped":
                        response["skipped"] = [{"code": "source_line_quote_limit"}]
                    else:
                        response.update(next_offset=None, complete=True, truncated=False)
                return response
            with TemporaryDirectory() as directory:
                owner, adapter = self.owner(directory, execution, mutate), FakeAdapter([])
                with self.assertRaisesRegex(AIAdapterError, "question_source_incomplete"):
                    asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
                self.assertEqual(adapter.calls, [])

    def test_read_budget_is_sixteen_but_model_budget_remains_seven(self):
        execution = self.start(context={**self.context, "documents": ["source-0.md"]})
        initial = execution["active"]["record"]["data"]["initial_evidence"]
        identifier = initial["evidence_ids"][0]
        with TemporaryDirectory() as directory:
            owner = self.owner(directory, execution)
            adapter = FakeAdapter([step("claims", material_id="d1", limit=1)] * 6 + [
                step("answer", content=f"확인했습니다 [[{identifier}]].", evidence_ids=[identifier])])
            result, _ = asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
            self.assertEqual(len(adapter.calls), 7)
            self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])
            self.assertEqual(result["execution"]["question_evidence_reads"], 9)
        for _ in range(7):
            self.evidence(execution, action="claims", material_id="d1", limit=1)
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 413)

    def test_cancel_after_first_source_receipt_prevents_model(self):
        execution = self.start()
        with TemporaryDirectory() as directory:
            def mutate(query, response):
                if query["action"] == "search":
                    owner.cancelled = True
                return response
            owner, adapter = self.owner(directory, execution, mutate), FakeAdapter([])
            with self.assertRaises(QuestionClientError):
                asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
            self.assertEqual([q["action"] for q in owner.queries], ["initial", "search"])
            self.assertEqual(adapter.calls, [])

    def test_actual_large_prompt_and_sixteen_read_budget_stop_before_model(self):
        for mode in ("prompt", "reads"):
            if mode == "reads":
                for document in self.context["documents"]:
                    old = self.store.read(document)
                    content = "A uses B.\nB is a pump.\n\n" + "\n\n".join(
                        f"Material passage {i}: preserve this requirement." for i in range(79)) + "\n"
                    saved = self.store.save(document, content, expected_revision=old.revision)
                    OntologyStore(self.store).generate(document, saved.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
            execution = self.start(text="조건 " * 20000 if mode == "prompt" else "자료 전체를 작성하세요.")
            with TemporaryDirectory() as directory:
                owner, adapter = self.owner(directory, execution), FakeAdapter([])
                with self.assertRaises(AIAdapterError) as failed:
                    asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
                self.assertEqual(failed.exception.code, "ai_input_limit" if mode == "prompt" else "question_source_incomplete")
                self.assertEqual(adapter.calls, [])
                self.assertEqual(len(owner.queries), 11 if mode == "prompt" else 16)

    def test_cancel_and_changed_basis_stop_before_model(self):
        for mode in ("cancel", "changed"):
            execution = self.start()
            with TemporaryDirectory() as directory:
                owner, adapter = self.owner(directory, execution), FakeAdapter([])
                if mode == "cancel":
                    owner.cancelled = True
                    expected = QuestionClientError
                else:
                    old = self.store.read("source-0.md")
                    self.store.save("source-0.md", old.content + "Changed.\n", expected_revision=old.revision)
                    # 직접 HTTP 409를 실제 클라이언트 경계의 예외로 전달한다.
                    async def changed_query(query):
                        response = self.client.post(self.base_url + f"/question-runs/{execution['run_id']}/evidence",
                            headers=self.headers(), json=self.evidence_payload(execution, **query))
                        self.assertEqual(response.status_code, 409)
                        raise QuestionClientError("question_basis_changed")
                    owner.query_evidence = changed_query
                    expected = QuestionClientError
                with self.assertRaises(expected):
                    asyncio.run(run_grounded_model(owner, adapter, execution["handoff"]))
                self.assertEqual(adapter.calls, [])
