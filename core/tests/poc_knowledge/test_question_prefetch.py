"""실제 격리 저장/HTTP와 합성 어댑터로 질문 전 조회를 검사한다. AI는 호출하지 않는다."""

from copy import deepcopy
import json
import asyncio
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.question_ai import assemble_question
from core.client.question_grounding import run_grounded_model
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.common.read_index import read_index, CanonicalIndexUnavailable
from core.modules.documents.store import WikiStore
from core.modules.knowledge.aggregation import prepare_question
from core.modules.knowledge.question_evidence import initial_evidence, resolve_evidence_ids, MAX_RESPONSE_BYTES
from core.modules.knowledge.question_index import discover, NAMESPACE, _scope
from core.modules.ontology.store import OntologyStore
from core.modules.personal.workflow_io import observe_basis
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES, RELATIONS
from core.tests.poc_knowledge import test_question_grounding as grounding_tests
from core.tests.poc_knowledge.test_question_grounding_client import FakeAdapter, FakeOwner, step
from core.tests.poc_mcp.test_server_integration import ServerFixture


class QuestionIndexTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document()
        self.generate()
        self.wiki = WikiStore(self.root, tracked_reads=True)
        self.reviews = ReviewStore(self.wiki)

    def basis(self, question="Does A use B?", documents=None):
        return prepare_question(self.wiki, ACTOR, documents=documents or ["a.md"], required_documents=[],
            claims=[], source_refs=[], retrieval_scope="workspace", lookup_question=question)

    def exception(self):
        quote = "A does not use B during drydock."
        source = self.document("exception.md", body=quote + "\n")
        entities = [{**e, "evidence": quote} for e in ENTITIES]
        OntologyStore(self.wiki).generate("exception.md", source.revision, entities,
            [{**RELATIONS[0], "evidence": quote, "qualifiers": {"polarity": "negative", "condition": "during drydock"}}])

    def test_other_document_negative_and_condition_are_served_with_exact_citations(self):
        self.exception()
        before = self.tree()
        basis = self.basis()
        self.assertEqual({d["document"] for d in basis["documents"]}, {"a.md", "exception.md"})
        self.assertGreater(basis["retrieval"]["relation_lookup_rows"], 0)
        result = initial_evidence(basis, "Does A use B?")
        negative = [i for i in result["items"] if i["kind"] == "claim" and
                    i["source_value"].get("qualifiers", {}).get("polarity") == "negative"]
        self.assertEqual(len(negative), 1)
        self.assertEqual(negative[0]["source_value"]["qualifiers"]["condition"], "during drydock")
        self.assertTrue(any("does not use" in i.get("text", "") for i in result["items"]))
        self.assertEqual([i["citation"] for i in result["citations"]], resolve_evidence_ids(basis, result["evidence_ids"]))
        self.assertEqual(self.tree(), before)
        self.assertLessEqual(len(canonical_json_bytes(result)), MAX_RESPONSE_BYTES)

    def test_rejection_remains_a_judgment_not_negative_and_refreshes_only_changed_document(self):
        self.exception()
        self.basis()
        state = self.reviews.query("a.md")
        self.reviews.review("a.md", action="reject", claim_id=state["claims"][0]["claim_id"],
            expected_state_revision=state["state_revision"], reason="Source direction requires review", actor=ACTOR)
        from core.modules.knowledge import question_index
        with patch.object(question_index, "_project", wraps=question_index._project) as projected:
            basis = self.basis()
        self.assertEqual([c.args[1] for c in projected.call_args_list], ["a.md"])
        result = initial_evidence(basis, "Does A use B?")
        rejected = next(i for i in result["items"] if i["kind"] == "claim" and i.get("decision") == "reject")
        self.assertEqual(rejected["source_value"]["qualifiers"]["polarity"], "positive")
        self.assertTrue(any(i.get("event", {}).get("reason") == "Source direction requires review" for i in result["items"]))
        with self.wiki._write_lock(), read_index(self.wiki) as index:
            rows = index.lookup(NAMESPACE, _scope(ACTOR), filters={"state": "claim"})
        self.assertTrue(any(v[1]["item"].get("decision") == "reject" for v in rows.values()))

    def test_warm_query_does_not_recapture_and_projection_does_not_copy_source_quotes(self):
        self.exception()
        self.basis()
        before = self.tree()
        with patch("core.modules.knowledge.question_index._project", side_effect=AssertionError("warm capture")):
            self.basis()
        with self.wiki._write_lock(), read_index(self.wiki) as index:
            rows = index.lookup(NAMESPACE, _scope(ACTOR))
        self.assertNotIn("A does not use B during drydock.", json.dumps(rows))
        self.assertEqual(before, self.tree())

    def test_source_only_document_is_found_and_not_claimed_as_extracted(self):
        self.document("unanalysed.md", body="The drydock exception disables B for A.\n")
        basis = self.basis("drydock exception")
        result = initial_evidence(basis, "drydock exception")
        self.assertIn("unanalysed.md", [d["document"] for d in basis["documents"]])
        self.assertTrue(any("disables" in i.get("text", "") for i in result["items"]))
        self.assertFalse(result["scope"]["absence_proven"])
        self.assertFalse(result["scope"]["retrieval"]["complete"])

    def test_selected_scope_preserved_and_workspace_limit_is_explicit(self):
        self.exception()
        basis = prepare_question(self.wiki, ACTOR, documents=["a.md"], required_documents=[], claims=[],
            source_refs=[], retrieval_scope="selected", lookup_question="A B")
        self.assertEqual([d["document"] for d in basis["documents"]], ["a.md"])
        for n in range(9):
            self.document(f"extra-{n}.md", body="A uses B.\n")
        result = discover(self.wiki, ACTOR, "A B", ["a.md"], [])
        self.assertEqual(len(result["documents"]), 8)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])

    def test_index_failure_is_not_empty_success_and_actor_scopes_are_separate(self):
        self.basis()
        with self.wiki._write_lock(), read_index(self.wiki) as index:
            self.assertFalse(index.lookup(NAMESPACE, _scope({**ACTOR, "profile_id": "other"})))
        with patch("core.modules.knowledge.question_index.read_index", side_effect=CanonicalIndexUnavailable("isolated")):
            with self.assertRaises(CanonicalIndexUnavailable):
                self.basis()

    def test_oversize_conflict_group_is_not_partially_served(self):
        self.exception()
        basis = self.basis()
        with patch("core.modules.knowledge.question_evidence.MAX_RESPONSE_BYTES", 5000):
            result = initial_evidence(basis, "Does A use B?")
        claims = [i for i in result["items"] if i["kind"] == "claim"]
        self.assertEqual(claims, [])
        self.assertTrue(result["truncated"])
        self.assertTrue(any(s["code"] == "initial_group_byte_limit" for s in result["skipped"]))

    def test_archived_rejection_and_reason_remain_searchable(self):
        from core.modules.reviews.cleanup import CleanupStore
        state = self.reviews.query("a.md")
        self.reviews.review("a.md", action="reject", claim_id=state["claims"][0]["claim_id"],
            expected_state_revision=state["state_revision"], reason="simulation archived judgment", actor=ACTOR)
        cleanup = CleanupStore(self.wiki, ACTOR)
        preview = cleanup.preview("a.md")
        cleanup.apply("a.md", request_id=uuid4().hex, preview_revision=preview["preview_revision"],
            item_ids=[i["item_id"] for i in preview["items"]], reason="simulation cleanup")
        self.assertEqual(self.reviews.query("a.md")["current_claims"], [])
        result = initial_evidence(self.basis(), "Does A use B?")
        self.assertTrue(any(i.get("archived") and i.get("decision") == "reject" for i in result["items"]))
        self.assertTrue(any(i.get("event", {}).get("reason") == "simulation archived judgment" for i in result["items"]))

    def test_policy_event_and_undo_are_not_source_negation(self):
        state = self.reviews.query("a.md")
        claim = state["claims"][0]
        replacement = {k: deepcopy(v) for k, v in claim["value"].items() if k not in {"evidence", "provenance"}}
        replacement["predicate"] = "depends_on"
        policy = self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=state["state_revision"], reason="simulation policy", actor=ACTOR)
        result = initial_evidence(self.basis(), "Does A use B?")
        self.assertTrue(any(c["citation"]["kind"] == "policy" and "quote" not in c["citation"] for c in result["citations"]))
        self.reviews.policy_undo("a.md", event_id=policy["policies"][0]["event_id"],
            expected_state_revision=policy["state_revision"], reason="simulation undo", actor=ACTOR)
        result = initial_evidence(self.basis(), "Does A use B?")
        self.assertFalse(any(c["citation"]["kind"] == "policy" for c in result["citations"]))
        self.assertTrue(any(i.get("value", {}).get("status") == "inactive" for i in result["items"]))

    def test_source_anchor_quotes_are_not_copied_into_index(self):
        from core.tests.poc_knowledge import test_ontology_exploration as exploration_tests
        _, _, quote = exploration_tests.OntologyExplorationTests.anchor_graph(self)
        discover(self.wiki, ACTOR, "A B", [], [])
        with self.wiki._write_lock(), read_index(self.wiki) as index:
            rows = index.lookup(NAMESPACE, _scope(ACTOR), filters={"owner": "anchors.md"})
        data = json.dumps(rows)
        self.assertNotIn('"quote"', data)
        self.assertNotIn(quote, data)

    def test_old_generation_policy_is_pending_not_an_active_policy_citation(self):
        state = self.reviews.query("a.md")
        claim = state["claims"][0]
        replacement = {k: deepcopy(v) for k, v in claim["value"].items() if k not in {"evidence", "provenance"}}
        replacement["predicate"] = "depends_on"
        policy = self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=state["state_revision"], reason="simulation prior generation", actor=ACTOR)
        self.generate(force_generation=True, expected_state_revision=policy["state_revision"])
        result = initial_evidence(self.basis(), "Does A use B?")
        self.assertTrue(any(i.get("value", {}).get("status") == "pending" for i in result["items"]))
        self.assertFalse(any(c["citation"]["kind"] == "policy" for c in result["citations"]))

    def test_independent_source_relation_and_undo_keep_ledger_and_applicability(self):
        from core.modules.reviews.relations import RelationStore
        from core.modules.reviews.values import _input
        self.document("independent.md", body="A uses B.\nB depends on A.\n")
        self.generate("independent.md")
        state = self.reviews.query("independent.md")
        replacement = _input(state["machine_graph"]["relations"][0])
        replacement.update(subject="b", object="a", predicate="depends_on", evidence="B depends on A.")
        relations = RelationStore(self.wiki, ACTOR)
        created = relations.create("independent.md", kind="source", replacement=replacement,
            request_id=uuid4().hex, expected_state_revision=state["state_revision"], reason="simulation independent")
        result = initial_evidence(self.basis(documents=["independent.md"]), "Does A use B?")
        self.assertTrue(any(c["citation"].get("ledger") == "relation" for c in result["citations"]))
        state = self.reviews.query("independent.md")
        relations.undo("independent.md", kind="source", event_id=created["event_id"], request_id=uuid4().hex,
            expected_state_revision=state["state_revision"], reason="simulation undo")
        result = initial_evidence(self.basis(documents=["independent.md"]), "Does A use B?")
        self.assertTrue(any(i.get("value", {}).get("status") == "inactive" for i in result["items"]))
        self.assertTrue(any(i.get("event", {}).get("action") == "relation_undo" for i in result["items"]))


class QuestionPrefetchHTTPTests(ServerFixture):
    # 공용 HTTP 보조만 사용하며 기존 test 메서드를 상속해 반복 실행하지 않는다.
    def setUp(self):
        super().setUp()
        from core.api.dependencies import access_value
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.actor = access_value(self.scope)
        source = self.store.save("a.md", "A uses B.\nB is a pump.\n", expected_revision=None)
        OntologyStore(self.store).generate("a.md", source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.context = {"documents": ["a.md"], "required_documents": ["a.md"], "mode": "on_demand"}

    post = grounding_tests.QuestionGroundingHTTPTests.post
    get = grounding_tests.QuestionGroundingHTTPTests.get
    conversation = grounding_tests.QuestionGroundingHTTPTests.conversation
    append = grounding_tests.QuestionGroundingHTTPTests.append
    start = grounding_tests.QuestionGroundingHTTPTests.start
    evidence_payload = grounding_tests.QuestionGroundingHTTPTests.evidence_payload
    evidence = grounding_tests.QuestionGroundingHTTPTests.evidence
    answer_payload = grounding_tests.QuestionGroundingHTTPTests.answer_payload
    submit = grounding_tests.QuestionGroundingHTTPTests.submit

    def context_for(self, scope="workspace"):
        return {**self.context, "retrieval_scope": scope, "lookup_question": "preview is not authoritative"}

    def test_v6_handoff_prefetch_receipt_and_citation_submission(self):
        execution = self.start(context=self.context_for())
        self.assertEqual(execution["handoff"]["contract_version"], "personal-question-v6")
        record = execution["active"]["record"]
        assemble_question(execution["handoff"], record)
        payload, response = self.evidence(execution, action="initial")
        self.assertEqual(canonical_json_hash(response["evidence"]), execution["handoff"]["initial_evidence"]["sha256"])
        self.assertTrue(response["evidence"]["evidence_ids"])
        replay = self.post(f"/question-runs/{execution['run_id']}/evidence", payload)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["evidence"], response["evidence"])
        self.submit(execution, self.answer_payload(execution, response))

    def test_unselected_new_document_invalidates_workspace_snapshot_but_not_selected_snapshot(self):
        execution = self.start(context=self.context_for())
        self.store.save("new-exception.md", "A no longer uses B.\n", expected_revision=None)
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution, action="initial"), 409)
        observation = observe_basis(self.store, execution["active"]["record"]["data"]["basis"], self.actor)
        self.assertTrue(observation["discovery_changed"])
        selected = self.start(context=self.context_for("selected"))
        self.store.save("unrelated.md", "Separate material.\n", expected_revision=None)
        self.evidence(selected, action="initial")

    def test_initial_query_is_v6_only_and_unserved_ids_are_rejected(self):
        from core.api.v1.knowledge.schemas import QuestionContextRequest
        context = QuestionContextRequest(documents=["a.md"], mode="on_demand")
        self.assertEqual(context.model_dump(exclude_unset=True), {"documents": ["a.md"], "mode": "on_demand"})
        old = self.start()
        self.assertEqual(old["handoff"]["contract_version"], "personal-question-v5")
        self.post(f"/question-runs/{old['run_id']}/evidence", self.evidence_payload(old, action="initial"), 422)
        execution = self.start(context=self.context_for())
        initial = execution["active"]["record"]["data"]["initial_evidence"]
        fake_response = {"evidence": initial}
        payload = self.answer_payload(execution, fake_response)
        self.post(f"/question-runs/{execution['run_id']}/answers", payload, 422)

    def test_prefetch_debits_one_of_six_reads(self):
        execution = self.start(context=self.context_for())
        self.evidence(execution, action="initial")
        for _ in range(5):
            self.evidence(execution)
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 413)

    def test_reclaim_requires_new_delivery_and_revoked_write_permission_blocks_prefetch(self):
        execution = self.start(context=self.context_for())
        _, first = self.evidence(execution, action="initial")
        future = datetime.now(timezone.utc) + timedelta(seconds=301)
        with patch("core.modules.personal.question_runs._now", return_value=future):
            reclaimed = self.post(f"/question-runs/{execution['run_id']}/claim", {"request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"], "reclaim": True})
        execution["active"] = reclaimed
        self.post(f"/question-runs/{execution['run_id']}/answers", self.answer_payload(execution, first), 422)
        self.evidence(execution, action="initial")
        self.change_policy(lambda p: p["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution, action="initial"), 403)

    def test_real_http_prefetch_reaches_first_stubbed_answer_and_validated_submission(self):
        quote = "A does not use B during drydock."
        source = self.store.save("exception.md", quote + "\n", expected_revision=None)
        OntologyStore(self.store).generate("exception.md", source.revision,
            [{**e, "evidence": quote} for e in ENTITIES],
            [{**RELATIONS[0], "evidence": quote, "qualifiers": {"polarity": "negative", "condition": "during drydock"}}])
        execution = self.start(context=self.context_for(), text="Does A use B?")
        initial = execution["active"]["record"]["data"]["initial_evidence"]
        citation_id = next(c["evidence_id"] for c in initial["citations"]
            if c["citation"].get("document") == "exception.md" and c["citation"]["kind"] == "document")
        fixture = self
        class HttpOwner(FakeOwner):
            async def query_evidence(owner, query):
                owner.queries.append(deepcopy(query))
                _, served = fixture.evidence(execution, **query)
                return served["evidence"]
        with TemporaryDirectory() as directory:
            owner = HttpOwner(directory)
            adapter = FakeAdapter([step("answer", content=f"During drydock A does not use B [[{citation_id}]].",
                                        evidence_ids=[citation_id])])
            result, _ = asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True))
            self.assertEqual(len(adapter.calls), 1)
            self.assertIn('"polarity":"negative"', adapter.calls[0]["prompt"])
            self.assertIn('"condition":"during drydock"', adapter.calls[0]["prompt"])
            payload = self.answer_payload(execution, {"evidence": initial},
                ids=result["evidence_ids"], citations=result["value"]["citations"])
            payload["content"] = result["value"]["content"]
            payload["execution"]["output_sha256"] = sha256(payload["content"].encode()).hexdigest()
            self.submit(execution, payload)

    def test_raw_question_prefix_excludes_app_format_instructions_from_discovery(self):
        text = "Does A use B?\n\n[format instructions about unrelatedkeyword]"
        context = {**self.context_for(), "lookup_question": "Does A use B?"}
        self.store.save("unrelated.md", "unrelatedkeyword\n", expected_revision=None)
        execution = self.start(context=context, text=text)
        basis = execution["handoff"]["basis"]
        self.assertNotIn("unrelated.md", [d["document"] for d in basis["documents"]])
        self.assertEqual(basis["retrieval"]["query_prefix_length"], len("Does A use B?"))


class QuestionPrefetchClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_model_input_already_has_served_evidence_and_one_answer_step_is_enough(self):
        from core.tests.poc_knowledge.test_question_grounding_client import handoff_fixture, evidence
        handoff = handoff_fixture()
        response = evidence()
        handoff["contract_version"] = "personal-question-v6"
        handoff["initial_evidence"] = {"action": "initial", "sha256": canonical_json_hash(response)}
        handoff["input_sha256"] = canonical_json_hash({k: v for k, v in handoff.items() if k != "input_sha256"})
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory) / "owner", [response])
            adapter = FakeAdapter([step("answer", content="It requires a configured key [[s1:2:2]].", evidence_ids=["s1:2:2"])])
            result, _ = await run_grounded_model(owner, adapter, handoff, select_tools=True)
            self.assertEqual(len(adapter.calls), 1)
            self.assertIn("Verification is enabled", adapter.calls[0]["prompt"])
            self.assertIn("5 further evidence queries", adapter.calls[0]["prompt"])
            self.assertEqual([q["action"] for q in owner.queries], ["initial"])
            self.assertEqual(result["evidence_ids"], ["s1:2:2"])

    async def test_mismatched_prefetch_stops_before_any_adapter_call(self):
        from core.tests.poc_knowledge.test_question_grounding_client import handoff_fixture, evidence
        from core.client.ai.contracts import AIAdapterError
        handoff = handoff_fixture()
        handoff.update(contract_version="personal-question-v6", initial_evidence={"action": "initial", "sha256": "0" * 64})
        with TemporaryDirectory() as directory:
            owner = FakeOwner(directory, [evidence()])
            adapter = FakeAdapter([])
            with self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, handoff)
            self.assertFalse(adapter.calls)

    async def test_cancelled_question_does_not_fetch_or_call_adapter(self):
        from core.client.question import QuestionClientError
        from core.tests.poc_knowledge.test_question_grounding_client import handoff_fixture
        handoff = handoff_fixture()
        handoff.update(contract_version="personal-question-v6", initial_evidence={"action": "initial", "sha256": "0" * 64})
        with TemporaryDirectory() as directory:
            owner = FakeOwner(directory)
            owner.cancelled = True
            adapter = FakeAdapter([])
            with self.assertRaises(QuestionClientError):
                await run_grounded_model(owner, adapter, handoff)
            self.assertFalse(owner.queries)
            self.assertFalse(adapter.calls)
