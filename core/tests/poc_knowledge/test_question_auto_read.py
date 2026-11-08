"""명시한 짧은 전문의 자동 후속 읽기를 합성 자료로 검증한다."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution, QuestionClientError
from core.client.question_grounding import MAX_READS, _automatic_completion_query, run_grounded_model
from core.common.json_codec import canonical_json_hash
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeHttp, FakeOwner, FakeResponse, covered, handoff_fixture, part_answer, step,
)


REVISION = "a" * 64
SNAPSHOT = "c" * 64


def auto_handoff():
    value = handoff_fixture()
    value["question"] = "Alpha의 개방 조건과 닫힘 조건은 무엇인가?"
    value["basis"]["snapshot_revision"] = SNAPSHOT
    value["basis"]["documents"] = [{"id": "d1", "document": "doc.md", "title": "Alpha",
        "line_count": 20, "source_revision": REVISION}]
    value["input_sha256"] = canonical_json_hash({key: item for key, item in value.items() if key != "input_sha256"})
    return value


def full_read():
    return step("read", material_id="d1", query="Alpha", start_line=1, line_count=20,
                offset=0, limit=2, start_character=3, character_count=500)


def normalized(raw):
    return {"action": raw["action"], "query": raw["query"] or "", "material_id": raw["material_id"],
        "start_line": raw["start_line"] or 1, "line_count": raw["line_count"] or 60,
        "offset": raw["offset"] or 0, "limit": raw["limit"] or 10,
        "start_character": raw["start_character"] or 0, "character_count": raw["character_count"] or 4000}


def source_page(query=None, *, partial=True):
    query = normalized(full_read()) if query is None else query
    spans = [(1, 2, "Alpha opens only after inspection."), (3, 4, "An operator records the inspection.")] if query["start_line"] == 1 else [
        (11, 15, "Alpha stays closed until inspection completes."),
        (16, 20, "Alpha closes above the temperature limit.")]
    items, citations = [], []
    for first, last, text in spans:
        identifier = f"s1:{first}:{last}"
        items.append({"kind": "source", "material_id": "d1", "evidence_id": identifier,
            "start_line": first, "end_line": last, "text": text, "context_limited": False,
            "material_line_count": 20, "document": "doc.md", "source_revision": REVISION})
        citations.append({"evidence_id": identifier, "citation": {"kind": "document", "document": "doc.md",
            "source_revision": REVISION, "quote": text}})
    return {"kind": "question_evidence", "action": "read", "items": items,
        "evidence_ids": [item["evidence_id"] for item in items], "citations": citations,
        "scope": {"coverage": "query_result_only", "absence_proven": False, "material_ids": ["d1"],
            "query": query["query"], "completion_scope": "requested_source_window", "basis_snapshot_revision": SNAPSHOT},
        "total_matches": 4 if partial else 2, "complete": not partial, "truncated": partial,
        "skipped": [], "next_offset": 2 if partial else None,
        "read_window": {"material_id": "d1", "total_lines": 20,
            "requested_range": [query["start_line"], query["start_line"] + query["line_count"] - 1],
            "available_range": [query["start_line"], 20], "returned_ranges": [[spans[0][0], spans[-1][1]]],
            "remaining_ranges": [[11, 20]] if partial else [], "unavailable_ranges": [],
            "next_start_line": 11 if partial else None}}


def final_answer():
    return step("answer", content="점검 후 열리고 [[s1:1:2]] 온도 한도 초과 시 닫힙니다. [[s1:16:20]]",
                evidence_ids=["s1:16:20", "s1:1:2"])


class AutomaticReadPolicyTests(unittest.TestCase):
    def setUp(self):
        self.catalog = auto_handoff()["basis"]
        self.raw = full_read()
        self.query = normalized(self.raw)
        self.response = source_page(self.query)

    def candidate(self, *, reads=1):
        return _automatic_completion_query(self.catalog, self.query, self.response, reads, self.raw)

    def test_one_suffix_preserves_query_fields_and_all_inputs(self):
        self.raw["line_count"] = self.query["line_count"] = 30
        self.response["read_window"]["requested_range"] = [1, 30]
        before = deepcopy((self.catalog, self.query, self.response, self.raw))
        result = self.candidate()
        self.assertEqual(result, {**self.query, "start_line": 11, "line_count": 10, "offset": 0})
        self.assertEqual((self.catalog, self.query, self.response, self.raw), before)
        self.assertIsNot(result, self.query)
        self.assertEqual(result["query"], "Alpha")
        self.assertEqual(result["limit"], 2)
        self.assertEqual(result["material_id"], "d1")

    def test_raw_entire_window_must_be_explicit_integers(self):
        for field, value in (("start_line", None), ("start_line", True), ("start_line", 2),
                             ("line_count", None), ("line_count", True), ("line_count", 19),
                             ("line_count", 21)):
            with self.subTest(field=field, value=value):
                raw = {**self.raw, field: value}
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, self.response, 1, raw))
        raw = {**self.raw, "offset": None, "limit": None}
        query = {**self.query, "limit": 10}
        self.assertEqual(_automatic_completion_query(self.catalog, query, self.response, 1, raw),
                         {**query, "start_line": 11, "line_count": 10, "offset": 0})

    def test_source_size_and_query_budget_are_bounded(self):
        for reads in (0, 5, 6, True, None):
            with self.subTest(reads=reads):
                self.assertIsNone(self.candidate(reads=reads))
        self.assertIsNotNone(self.candidate(reads=MAX_READS - 2))
        for total in (0, 101, True, None):
            with self.subTest(total=total):
                catalog = deepcopy(self.catalog)
                catalog["documents"][0]["line_count"] = total
                self.assertIsNone(_automatic_completion_query(catalog, self.query, self.response, 1, self.raw))

    def test_material_snapshot_source_revision_and_query_must_match(self):
        mutations = (
            ("scope", "material_ids", ["d2"]), ("scope", "basis_snapshot_revision", "changed"),
            ("scope", "query", "changed"), ("read_window", "material_id", "d2"),
            ("items", "source_revision", "changed"), ("items", "material_id", "d2"),
        )
        for group, key, value in mutations:
            response = deepcopy(self.response)
            (response[group][0] if group == "items" else response[group])[key] = value
            with self.subTest(group=group, key=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, response, 1, self.raw))
        for key in ("source_revision", "line_count"):
            catalog = deepcopy(self.catalog)
            del catalog["documents"][0][key]
            with self.subTest(missing_catalog=key):
                self.assertIsNone(_automatic_completion_query(catalog, self.query, self.response, 1, self.raw))
        catalog = deepcopy(self.catalog)
        catalog["documents"].append(deepcopy(catalog["documents"][0]))
        self.assertIsNone(_automatic_completion_query(catalog, self.query, self.response, 1, self.raw))

    def test_window_completeness_and_missing_ranges_prevent_completion(self):
        for group, key, value in (
            (None, "skipped", [{"code": "unavailable"}]), (None, "complete", True),
            (None, "truncated", False), ("read_window", "unavailable_ranges", [[5, 6]]),
            ("read_window", "requested_range", [1, 19]), ("read_window", "available_range", [1, 19]),
            ("read_window", "total_lines", 19), ("scope", "completion_scope", "relation_view"),
        ):
            response = deepcopy(self.response)
            (response if group is None else response[group])[key] = value
            with self.subTest(group=group, key=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, response, 1, self.raw))
        for group, key in ((None, "read_window"), (None, "skipped"), ("read_window", "unavailable_ranges"),
                           ("scope", "basis_snapshot_revision")):
            response = deepcopy(self.response)
            del (response if group is None else response[group])[key]
            with self.subTest(missing=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, response, 1, self.raw))

    def test_only_actual_source_items_are_eligible(self):
        for key, value in (("kind", "claim"), ("material_line_count", 19), ("source_revision", None)):
            response = deepcopy(self.response)
            response["items"][0][key] = value
            with self.subTest(key=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, response, 1, self.raw))
        for items in ([], None):
            with self.subTest(items=items):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, {**self.response, "items": items}, 1, self.raw))

    def test_remaining_page_requires_valid_coordinates_and_count(self):
        changes = ((None, "next_offset", 0), (None, "next_offset", True), (None, "next_offset", None),
            (None, "total_matches", 2), (None, "total_matches", 5), (None, "total_matches", True),
            ("read_window", "remaining_ranges", []), ("read_window", "remaining_ranges", [[12, 20]]),
            ("read_window", "remaining_ranges", [[11, 21]]), ("read_window", "remaining_ranges", [[11, True]]),
            ("read_window", "next_start_line", 1), ("read_window", "next_start_line", 21),
            ("read_window", "next_start_line", True))
        for group, key, value in changes:
            response = deepcopy(self.response)
            (response if group is None else response[group])[key] = value
            with self.subTest(group=group, key=key, value=value):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, response, 1, self.raw))

    def test_nonfirst_partial_or_changed_query_is_not_promoted(self):
        for key, value in (("action", "claims"), ("start_line", 2), ("line_count", 19),
                           ("offset", 1), ("offset", True), ("limit", True), ("material_id", "d2")):
            with self.subTest(key=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, {**self.query, key: value}, self.response, 1, self.raw))
        for key, value in (("offset", 1), ("offset", True), ("limit", 3), ("limit", True)):
            with self.subTest(raw_key=key):
                self.assertIsNone(_automatic_completion_query(self.catalog, self.query, self.response, 1, {**self.raw, key: value}))


class AutomaticReadLoopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.handoff = auto_handoff()
        self.query = normalized(full_read())
        self.following = {**self.query, "start_line": 11, "line_count": 10, "offset": 0}

    def pages(self):
        return [source_page(self.query), source_page(self.following, partial=False)]

    def assert_no_preview(self, owner):
        self.assertFalse(any(kind == "answer_preview" for kind, _ in owner.events))

    async def test_two_queries_need_only_read_and_answer_model_calls(self):
        pages = self.pages()
        owner = FakeOwner(self.root / "automatic", pages)
        adapter = FakeAdapter([full_read(), final_answer()])
        result, prompt = await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(owner.queries, [self.query, self.following])
        self.assertEqual(result["value"]["content"], "점검 후 열리고 [1] 온도 한도 초과 시 닫힙니다. [2]")
        self.assertEqual(result["evidence_ids"], ["s1:1:2", "s1:16:20"])
        self.assertEqual(result["value"]["citations"], [pages[0]["citations"][0]["citation"], pages[1]["citations"][1]["citation"]])
        self.assertEqual(result["execution"]["question_evidence_reads"], 2)
        self.assertEqual(len(result["execution"]["question_invocations"]), 2)
        self.assertEqual(result["execution"]["question_automatic_reads"], [{"after_model_step": 0, "evidence_read": 2,
            "query": self.following, "reason": "continue_explicit_whole_source_read"}])
        for page in pages:
            for item in page["items"]:
                self.assertIn(item["text"], prompt)
                self.assertIn(item["evidence_id"], prompt)
        self.assertEqual(json.loads((owner.directory / "evidence-model-01.json").read_bytes())["value"], final_answer())
        baseline = FakeOwner(self.root / "model-selected", pages)
        baseline_adapter = FakeAdapter([full_read(), step("read", **{key: value for key, value in self.following.items() if key != "action"}), final_answer()])
        changed = deepcopy(self.handoff)
        del changed["basis"]["snapshot_revision"]
        previous, _ = await run_grounded_model(baseline, baseline_adapter, changed)
        self.assertEqual(len(baseline_adapter.calls), 3)
        self.assertEqual(previous["value"], result["value"])
        self.assertEqual(previous["evidence_ids"], result["evidence_ids"])

    async def test_partial_automatic_response_returns_control_to_model_without_chain(self):
        first, second = self.pages()
        second.update(complete=False, truncated=True, total_matches=4, next_offset=2)
        second["read_window"].update(remaining_ranges=[[18, 20]], next_start_line=18)
        selected = step("read", material_id="d1", start_line=18, line_count=3, query="Alpha", limit=2)
        third = source_page(normalized(selected), partial=False)
        owner = FakeOwner(self.root / "still-partial", [first, second, third])
        adapter = FakeAdapter([full_read(), selected, final_answer()])
        result, _ = await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(len(adapter.calls), 3)
        self.assertEqual(owner.queries, [self.query, self.following, normalized(selected)])
        self.assertIn('"remaining_ranges":[[18,20]]', adapter.calls[1]["prompt"])
        self.assertEqual(len(result["execution"]["question_automatic_reads"]), 1)

    async def test_cancellation_after_first_page_prevents_automatic_query(self):
        owner = FakeOwner(self.root / "cancelled", self.pages(), cancel_after_query=True)
        adapter = FakeAdapter([full_read(), final_answer()])
        with self.assertRaises(QuestionClientError) as caught:
            await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(caught.exception.code, "question_cancelled")
        self.assertEqual(owner.queries, [self.query])
        self.assertEqual(len(adapter.calls), 1)
        self.assert_no_preview(owner)

    async def test_second_query_conflict_stops_without_retry_or_answer(self):
        class ConflictOwner(FakeOwner):
            async def query_evidence(inner, query):
                if len(inner.queries) == 1:
                    inner.queries.append(deepcopy(query))
                    raise QuestionClientError("conflict")
                return await super().query_evidence(query)
        owner = ConflictOwner(self.root / "conflict", self.pages())
        adapter = FakeAdapter([full_read(), final_answer()])
        with self.assertRaises(QuestionClientError) as caught:
            await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(owner.queries, [self.query, self.following])
        self.assertEqual(len(adapter.calls), 1)
        self.assert_no_preview(owner)

    async def test_automatic_response_uses_existing_citation_registry_guards(self):
        for problem in ("foreign", "missing", "duplicate", "changed"):
            pages = self.pages()
            if problem == "foreign":
                pages[1]["citations"][0]["evidence_id"] = "s1:9:9"
            elif problem == "missing":
                pages[1]["citations"] = []
            elif problem == "duplicate":
                pages[1]["evidence_ids"].append(pages[1]["evidence_ids"][0])
                pages[1]["citations"].append(deepcopy(pages[1]["citations"][0]))
            else:
                pages[1]["evidence_ids"][0] = pages[0]["evidence_ids"][0]
                pages[1]["citations"][0]["evidence_id"] = pages[0]["evidence_ids"][0]
            owner = FakeOwner(self.root / problem, pages)
            adapter = FakeAdapter([full_read(), final_answer()])
            with self.subTest(problem=problem), self.assertRaises(AIAdapterError) as caught:
                await run_grounded_model(owner, adapter, self.handoff)
            self.assertEqual(caught.exception.code, "ai_invalid_result")
            self.assertEqual(len(owner.queries), 2)
            self.assertEqual(len(adapter.calls), 1)
            self.assert_no_preview(owner)

    async def test_unserved_final_citation_is_rejected_after_automatic_read(self):
        owner = FakeOwner(self.root / "forged-answer", self.pages())
        adapter = FakeAdapter([full_read(), step("answer", content="알 수 없는 근거 [[s1:9:9]]", evidence_ids=["s1:9:9"])])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff)
        self.assertEqual(caught.exception.code, "ai_invalid_result")
        self.assertEqual(len(owner.queries), 2)
        self.assertEqual(len(adapter.calls), 2)
        self.assert_no_preview(owner)

    async def test_development_options_keep_automatic_read_disabled(self):
        for option in ("check_draft", "cover_question"):
            owner = FakeOwner(self.root / option, self.pages())
            if option == "check_draft":
                answer = step("answer", content="점검 후 열립니다. [[s1:1:2]]", evidence_ids=["s1:1:2"])
                values = [full_read(), answer, deepcopy(answer)]
            else:
                values = [covered("read", parts=["개방 조건"], covers=[1],
                    **{key: value for key, value in full_read().items() if key != "action"}),
                    covered("answer", answers=[part_answer(1, "점검 후 열립니다. [[s1:1:2]]", ["s1:1:2"])])]
            adapter = FakeAdapter(values)
            with self.subTest(option=option):
                result, _ = await run_grounded_model(owner, adapter, self.handoff, **{option: True})
            self.assertEqual(owner.queries, [self.query])
            self.assertNotIn("question_automatic_reads", result["execution"])
            self.assertEqual(len(adapter.calls), 3 if option == "check_draft" else 2)

    async def test_automatic_read_consumes_the_existing_six_query_budget(self):
        for excessive in (False, True):
            owner = FakeOwner(self.root / str(excessive), self.pages() + [source_page(self.following, partial=False)] * 4)
            search = step("search", query="Alpha")
            adapter = FakeAdapter([full_read()] + [deepcopy(search)] * 4 + [search if excessive else final_answer()])
            with self.subTest(excessive=excessive):
                if excessive:
                    with self.assertRaises(AIAdapterError):
                        await run_grounded_model(owner, adapter, self.handoff)
                    self.assert_no_preview(owner)
                else:
                    result, _ = await run_grounded_model(owner, adapter, self.handoff)
                    self.assertEqual(result["execution"]["question_evidence_reads"], MAX_READS)
            self.assertEqual(len(owner.queries), MAX_READS)
            self.assertEqual(len(adapter.calls), 6)
            self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])

    async def test_automatic_read_rechecks_remote_state_and_receipt(self):
        initial = {"state_revision": "e" * 64, "lease_status": "active", "runtime": {"status": "running", "run_id": "2" * 32},
            "access": {"user_id": "alice", "tenant": "team", "profile_id": "default", "domain": None, "viewpoint": None}}
        failures = {"state": "question_run_changed", "profile": "question_profile_changed",
                    "cancel": "question_cancelled", "fingerprint": "question_evidence_mismatch"}
        for problem, code in failures.items():
            fake = FakeOwner(self.root / f"remote-{problem}")
            pages = self.pages()
            def handler(method, path, body):
                self.assertEqual(method, "POST")
                index = len(http.calls) - 1
                payload = {key: value for key, value in body.items() if key != "profile"}
                data = {**deepcopy(initial), "record": {"requests": {body["request_id"]: canonical_json_hash(payload)}},
                    "evidence_run_id": body["run_id"], "evidence": pages[index], "evidence_sha256": canonical_json_hash(pages[index])}
                if index == 1:
                    if problem == "state":
                        data["state_revision"] = "f" * 64
                    elif problem == "profile":
                        data["access"]["profile_id"] = "other"
                    elif problem == "cancel":
                        data["runtime"]["status"] = "cancelled"
                    else:
                        data["record"]["requests"][body["request_id"]] = "0" * 64
                return FakeResponse(200, {"data": data})
            http = FakeHttp(handler)
            owner = _QuestionExecution(http, base="http://127.0.0.1:8766", tenant="team", directory=fake.directory,
                profile="default", on_event=None, cancel_event=asyncio.Event(), poll_seconds=1, heartbeat_seconds=60)
            owner.question_run_id, owner.run_id, owner.state = "1" * 32, "2" * 32, deepcopy(initial)
            owner.guarded_model, owner.emit = fake.guarded_model, fake.emit
            adapter = FakeAdapter([full_read(), final_answer()])
            with self.subTest(problem=problem), self.assertRaises(QuestionClientError) as caught:
                await run_grounded_model(owner, adapter, self.handoff)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(len(http.calls), 2)
            self.assertEqual([call["body"]["query"] for call in http.calls], [self.query, self.following])
            self.assertEqual(len(list(fake.directory.glob("evidence-response-*.json"))), 1)
            self.assertEqual(len(adapter.calls), 1)
            self.assert_no_preview(fake)


if __name__ == "__main__":
    unittest.main()
