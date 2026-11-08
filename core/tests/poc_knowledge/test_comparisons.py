"""대조의 실제 검색·개인 보관·5회·충돌·응답 유실 경계를 격리 자료에서 검증한다."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from threading import Barrier
import json
import unittest
from uuid import uuid4
from unittest.mock import patch

import httpx2
from core.client.comparison import run_comparison, comparison_schema
from core.common.json_codec import canonical_json_hash
from core.modules.personal.comparisons import ComparisonStore, KIND
from core.modules.personal.store import PersonalStore, PersonalConflictError, PersonalLimitError
from core.modules.access.policy import AccessDenied, AccessPolicy
from core.modules.access.auth import initialize_auth
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES, RELATIONS
from core.runtime.application import create_application


class ComparisonStoreTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        for document in ("a.md", "b.md"):
            self.document(document)
            self.generate(document)
        self.scope = SimpleNamespace(**ACTOR, store=self.wiki)
        self.comparisons = ComparisonStore(self.scope)

    def create(self, **changes):
        state = self.reviews.query("a.md")
        return self.comparisons.create(**{**dict(request_id=uuid4().hex, document="a.md",
            source_revision=state["source_revision"], graph_revision=state["graph_revision"],
            session_id="actual-session-id", provider="codex", before_commit=lambda: None), **changes})

    def step(self, state, **changes):
        return self.comparisons.step(state["record"]["id"], **{**dict(request_id=uuid4().hex,
            expected_revision=state["revision"], operation="search", terms=["A", "uses"],
            reference_id=None, before_commit=lambda: None), **changes})

    def finish(self, state, **changes):
        return self.comparisons.finish(state["record"]["id"], **{**dict(request_id=uuid4().hex,
            expected_revision=state["revision"], status="complete", candidates=[], excluded=[],
            unconfirmed=["Semantic identity has not been confirmed"], failure=None, before_commit=lambda: None), **changes})

    def test_batch_search_deduplicates_exact_item_and_preserves_review_status(self):
        before = {p: raw for p, raw in self.tree().items() if not p.startswith("_personal/")}
        initial = self.create()
        state = self.step(initial)
        self.assertEqual(state["lookup_count"], 1)
        refs = state["references"]
        self.assertTrue(refs)
        self.assertEqual(len({item["reference_id"] for item in refs}), len(refs))
        self.assertTrue(all(item["document"] != "a.md" for item in refs))
        claims = [item for item in refs if item["target_ref"]["kind"] == "document_claim"]
        self.assertTrue(claims)
        self.assertEqual(claims[0]["review_status"], "unreviewed")
        self.assertIn("uses", claims[0]["matched_terms"])
        after = self.tree()
        self.assertTrue(all(after[path] == raw for path, raw in before.items()))

    def test_five_steps_and_replay_do_not_create_sixth_lookup(self):
        state = self.create()
        first = None
        for index in range(5):
            request_id = uuid4().hex
            old = state
            state = self.step(state, request_id=request_id)
            if index == 0:
                first = (request_id, old["revision"])
        with self.assertRaises(PersonalLimitError):
            self.step(state)
        again = self.step(state, request_id=first[0], expected_revision=first[1])
        self.assertTrue(again["replayed"])
        self.assertEqual(again["lookup_count"], 5)
        self.assertEqual(again["revision"], state["revision"])
        with self.assertRaises(PersonalConflictError):
            self.step(state, request_id=first[0], terms=["different"])

    def test_reference_read_and_exact_document_history_preserve_context(self):
        state = self.step(self.create())
        ref = next(item for item in state["references"] if item["target_ref"]["kind"] == "document_claim")
        detail = self.step(state, operation="read", terms=None, reference_id=ref["reference_id"])
        self.assertTrue(detail["lookup_result"]["unread_context"])
        self.assertIn("evidence", detail["lookup_result"]["snapshot"])
        whole = self.step(detail, operation="document", terms=None, reference_id=ref["reference_id"])
        original = self.wiki.read("b.md")
        self.assertEqual(whole["lookup_result"]["documents"][0]["content"], original.content)
        stored = whole["step"]["result"]["documents"][0]
        self.assertNotIn("content", stored)
        self.wiki.save("b.md", original.content + "New exception.\n", expected_revision=original.revision)
        replay = self.comparisons.read(whole["record"]["id"], step_id=whole["step"]["id"])
        self.assertEqual(replay["lookup_result"]["documents"][0]["content"], original.content)
        self.assertEqual(replay["currentness"]["status"], "needs_recheck")
        self.assertIn("b.md", replay["currentness"]["changed"])
        self.assertEqual(replay["revision"], whole["revision"])

    def test_unobserved_reference_and_duplicate_candidate_are_rejected(self):
        state = self.step(self.create())
        with self.assertRaises(ValueError):
            self.step(state, operation="read", terms=None, reference_id="f" * 64)
        with self.assertRaises(ValueError):
            self.finish(state, candidates=[dict(reference_id="f" * 64, reason="invented", unconfirmed=[])])
        candidate = dict(reference_id=state["references"][0]["reference_id"], reason="Related, unconfirmed", unconfirmed=["Scope"])
        with self.assertRaises(ValueError):
            self.finish(state, candidates=[candidate], excluded=[candidate])
        result = self.finish(state, candidates=[candidate])
        self.assertFalse(result["human_approval"])
        self.assertFalse(result["result"]["semantic_identity_confirmed"])
        self.assertEqual(result["result"]["candidates"], [candidate])

    def test_failed_attempt_and_previous_runs_are_preserved_new_run_resets_budget(self):
        first = self.step(self.create())
        failed = self.finish(first, status="incomplete", failure="model_failed")
        second = self.create()
        self.assertEqual(second["lookup_count"], 0)
        page = self.comparisons.list(document="a.md")
        self.assertEqual(page["latest_id"], second["record"]["id"])
        self.assertEqual(len(page["items"]), 2)
        self.assertEqual(self.comparisons.read(first["record"]["id"])["revision"], failed["revision"])
        self.assertEqual(failed["lookup_count"], 1)

    def test_listing_continues_with_cursor_without_gaps_or_duplicates(self):
        # 진행 중인 실행이 있으면 새 실행을 만들 수 없으므로 하나씩 끝낸 뒤 만든다.
        made = [self.finish(self.create(), status="incomplete", failure="model_failed")["record"]["id"]
                for _ in range(3)]
        first = self.comparisons.list(document="a.md", limit=2)
        self.assertEqual(len(first["items"]), 2)
        self.assertTrue(first["truncated"])
        self.assertIsNotNone(first["next_cursor"])
        # 이어 읽는 사이에 새 기록이 생겨도 이미 본 항목이 다시 나오지 않는다.
        self.finish(self.create(), status="incomplete", failure="model_failed")
        rest = self.comparisons.list(document="a.md", limit=2, cursor=first["next_cursor"])
        seen = [item["id"] for item in first["items"]] + [item["id"] for item in rest["items"]]
        self.assertEqual(len(seen), len(set(seen)))
        self.assertTrue(set(made) <= set(seen))
        self.assertIsNone(rest["next_cursor"])
        with self.assertRaises(ValueError):
            self.comparisons.list(document="a.md", cursor="not-a-cursor")

    def test_owner_scope_and_concurrent_cas(self):
        state = self.create()
        other = ComparisonStore(SimpleNamespace(**{**ACTOR, "user_id": "bob"}, store=self.wiki))
        with self.assertRaises(FileNotFoundError):
            other.read(state["record"]["id"])
        changed = ComparisonStore(SimpleNamespace(**{**ACTOR, "access_revision": "2" * 64}, store=self.wiki))
        with self.assertRaises(AccessDenied):
            changed.step(state["record"]["id"], request_id=uuid4().hex, expected_revision=state["revision"],
                operation="search", terms=["A"], before_commit=lambda: None)
        barrier = Barrier(2)
        def attempt():
            barrier.wait()
            try:
                return self.step(state)["lookup_count"]
            except PersonalConflictError:
                return "conflict"
        with ThreadPoolExecutor(2) as pool:
            outcomes = list(pool.map(lambda _: attempt(), range(2)))
        self.assertCountEqual(outcomes, [1, "conflict"])

    def test_source_change_blocks_lookup_but_can_record_incomplete(self):
        state = self.create()
        source = self.wiki.read("a.md")
        self.wiki.save("a.md", source.content + "changed\n", expected_revision=source.revision)
        with self.assertRaises(PersonalConflictError):
            self.step(state)
        failed = self.finish(state, status="incomplete", failure="basis_changed")
        self.assertEqual(failed["status"], "incomplete")
        self.assertEqual(failed["currentness"]["status"], "needs_recheck")

    def test_commit_denial_and_storage_failure_do_not_erase_old_state(self):
        state = self.create()
        def denied():
            raise AccessDenied()
        with self.assertRaises(AccessDenied):
            self.step(state, before_commit=denied)
        with patch("core.modules.personal.store.files.write_json", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.step(state)
        self.assertEqual(self.comparisons.read(state["record"]["id"])["revision"], state["revision"])

    def test_automatic_and_manual_resume_share_one_atomic_session_guard(self):
        barrier = Barrier(2)
        def create_one():
            barrier.wait()
            try:
                return self.create()
            except PersonalConflictError:
                return "conflict"
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: create_one(), range(2)))
        self.assertEqual(results.count("conflict"), 1)
        running = next(item for item in results if isinstance(item, dict))
        with self.assertRaises(PersonalConflictError):
            self.create()
        self.finish(running, status="incomplete", failure="explicit_stop")
        next_run = self.create()
        self.assertEqual(next_run["lookup_count"], 0)
        self.assertNotEqual(next_run["record"]["id"], running["record"]["id"])

    def test_new_attempt_target_input_has_latest_source_and_expert_decision(self):
        state = self.step(self.create())
        self.finish(state)
        old = self.wiki.read("a.md")
        self.wiki.save("a.md", old.content + "A new exception is pending.\n", expected_revision=old.revision)
        with self.assertRaises(PersonalConflictError):
            self.create()
        self.generate("a.md", expected_state_revision=self.reviews.query("a.md")["state_revision"])
        self.accept("a.md")
        current = self.create()
        target = current["target_input"]
        self.assertIn("A new exception", target["source"]["content"])
        self.assertEqual(target["claims"][0]["decision"], "accept")
        self.assertTrue(target["replaces_prior_session_memory"])


class ComparisonHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "data").mkdir()
        (self.root / "tenancy").mkdir()
        config = self.root / "tenancy/policy.json"
        config.write_text(json.dumps(dict(version=1, tenants={}, users={})))
        self.policy = AccessPolicy(config, self.root / "data")
        self.auth = initialize_auth(self.policy)
        self.user = self.auth.signup("comparison test")
        self.tenant = self.user["default_tenant"]
        self.scope = self.policy.authorize(self.user["token"], self.tenant, "read")
        for name in ("a.md", "b.md"):
            self.scope.store.save(name, "A uses B.\n", expected_revision=None)
            OntologyStore(self.scope.store).generate(name, self.scope.store.read(name).revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.state = ReviewStore(self.scope.store).query("a.md")
        self.app = create_application(self.policy, auth=self.auth)
        self.base = "http://127.0.0.1:8766"

    def arguments(self):
        return dict(base_url=self.base, tenant=self.tenant, profile=self.scope.profile_id, document="a.md",
                    source_revision=self.state["source_revision"], graph_revision=self.state["graph_revision"],
                    session_id="same-stored-id", provider="codex", directory=self.root / uuid4().hex)

    async def exercise(self, adapter, *, lose=None, refresh_target=False):
        async with self.app.router.lifespan_context(self.app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app), base_url=self.base,
                headers={"Authorization": "Bearer " + self.user["token"]}) as http:
                if lose:
                    original = http.request
                    async def request(method, path, **kwargs):
                        response = await original(method, path, **kwargs)
                        if method == "POST" and path.endswith(lose) and response.status_code in {200, 201}:
                            raise OSError("response loss after actual commit")
                        return response
                    http.request = request
                return await run_comparison(http, adapter, **self.arguments(), refresh_target=refresh_target)

    async def test_real_http_loop_search_read_research_finish_and_references(self):
        calls = []
        async def adapter(*, prompt, output_schema, directory):
            calls.append(json.loads(prompt.split("\n", 1)[1]))
            refs = output_schema["properties"]["reference_id"]["anyOf"][0]["enum"]
            value = dict(action="finish", terms=[], reference_id=None, status="complete",
                candidates=[dict(reference_id=refs[0], reason="A shared expression, meaning unresolved", unconfirmed=["Scope and exceptions"])],
                excluded=[], unconfirmed=["Not every document was read"])
            if len(calls) == 1:
                value.update(action="read", reference_id=refs[0], candidates=[])
            elif len(calls) == 2:
                value.update(action="search", terms=["B"], candidates=[])
            return {"value": value, "execution": {"session_id": "same-stored-id"}}
        result = await self.exercise(adapter)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["lookup_count"], 3)
        self.assertEqual(len(calls), 3)
        self.assertEqual(result["record"]["data"]["provider"], "codex")
        self.assertEqual(len(result["result"]["candidates"]), 1)

    async def test_invalid_model_output_and_failure_are_preserved_without_retry(self):
        calls = []
        async def adapter(**kwargs):
            calls.append(1)
            return {"invented": True}
        result = await self.exercise(adapter)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["lookup_count"], 1)
        self.assertEqual(result["result"]["failure"], "comparison_invalid_model_result")
        self.assertTrue(result["references"])

    async def test_lost_step_response_recovers_by_receipt_and_read_only(self):
        async def adapter(**kwargs):
            return dict(action="finish", terms=[], reference_id=None, status="complete", candidates=[], excluded=[], unconfirmed=[])
        result = await self.exercise(adapter, lose="/steps")
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["lookup_count"], 1)
        self.assertEqual(len(result["record"]["events"]), 2)

    async def test_fifth_lookup_forces_final_response(self):
        calls = []
        async def adapter(*, output_schema, **kwargs):
            actions = output_schema["properties"]["action"]["enum"]
            calls.append(actions)
            return dict(action="finish" if actions == ["finish"] else "search", terms=[] if actions == ["finish"] else ["A"],
                reference_id=None, status="incomplete", candidates=[], excluded=[], unconfirmed=["Lookup limit reached"])
        result = await self.exercise(adapter)
        self.assertEqual(result["lookup_count"], 5)
        self.assertEqual(len(calls), 5)
        self.assertEqual(calls[-1], ["finish"])
        self.assertEqual(result["status"], "incomplete")
        self.assertTrue(result["coverage"]["lookup_limit_reached"])

    async def test_http_owner_boundary_invalid_contract_and_missing_read_permission(self):
        other = self.auth.signup("other comparison owner")
        async with self.app.router.lifespan_context(self.app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app), base_url=self.base,
                headers={"Authorization": "Bearer " + self.user["token"]}) as http:
                root = f"/api/v1/tenants/{self.tenant}"
                payload = dict(request_id=uuid4().hex, document="a.md", source_revision=self.state["source_revision"],
                    graph_revision=self.state["graph_revision"], session_id="actual-session-id", provider="codex")
                invalid = await http.post(root + "/knowledge-comparisons", json={**payload, "user_id": other["user_id"]})
                self.assertEqual(invalid.status_code, 422)
                made = await http.post(root + "/knowledge-comparisons", json=payload)
                self.assertEqual(made.status_code, 201, made.text)
                record_id = made.json()["data"]["record"]["id"]
                hidden = await http.get(root + "/knowledge-comparisons/" + record_id,
                    headers={"Authorization": "Bearer " + other["token"]})
                self.assertEqual(hidden.status_code, 404)
                bad = await http.post(root + "/knowledge-comparisons/" + record_id + "/steps",
                    json=dict(request_id=uuid4().hex, expected_revision=made.json()["data"]["revision"],
                              operation="document", reference_id="f" * 64))
                self.assertEqual(bad.status_code, 422, bad.text)

    async def test_manual_recomparison_delivers_current_target_once(self):
        values = []
        async def adapter(*, prompt, **kwargs):
            value = json.loads(prompt.split("\n", 1)[1])
            values.append(value)
            return dict(action="search" if len(values) == 1 else "finish", terms=["B"] if len(values) == 1 else [],
                reference_id=None, status="complete", candidates=[], excluded=[], unconfirmed=[])
        result = await self.exercise(adapter, refresh_target=True)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(values[0]["current_target_input"]["basis"]["source_revision"], self.state["source_revision"])
        self.assertIn("A uses B.", values[0]["current_target_input"]["source"]["content"])
        self.assertIsNone(values[1]["current_target_input"])


if __name__ == "__main__":
    unittest.main()
