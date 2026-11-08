"""모델·네트워크 없이 합성 Alpha/Beta 자료로 계획 전체와 순차 조회를 확인한다."""

from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from jsonschema import Draft202012Validator

from core.client.ai.contracts import AIAdapterError
from core.client.question import QuestionClientError
from core.client.question_batch import batch_grounding_prompt, batch_query_steps, batch_step_schema
from core.client.question_grounding import (
    MAX_CONTEXT_BYTES, STEP_SCHEMA, _evidence_query, grounding_prompt, initial_grounding_prompt,
    run_grounded_model,
)
from core.tests.poc_knowledge.test_question_auto_read import (
    auto_handoff, final_answer, full_read, normalized, source_page,
)
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeOwner, evidence, handoff_fixture, step,
)


QUERY_FIELDS = tuple(name for name in STEP_SCHEMA["required"] if name not in {"content", "evidence_ids"})


def alpha_handoff():
    value = handoff_fixture()
    value["question"] = "Alpha와 Beta의 조건은 무엇인가?"
    value["basis"]["documents"] = [{"id": "d1", "document": "alpha.md", "title": "Alpha", "line_count": 20},
                                    {"id": "d2", "document": "beta.md", "title": "Beta", "line_count": 12}]
    value["basis"]["originals"] = [{"id": "o1", "title": "Alpha", "line_count": 8}]
    value["basis"]["web"] = {"sources": [{"id": "w1", "title": "Beta", "line_count": 6}]}
    return value


def query_step(action="read", **values):
    return {key: value for key, value in step(action, **values).items() if key in QUERY_FIELDS}


def envelope(action, **values):
    return {**step(action), "queries": [], **values}


def batch(*queries):
    return envelope("batch", queries=list(queries))


def alpha_evidence(number=1, text=None):
    value = evidence(f"s1:{number}:{number}", text or f"Alpha condition {number}.")
    value["citations"][0]["citation"]["document"] = "alpha.md"
    return value


def answer(*numbers):
    return envelope("answer", content=" ".join(f"Alpha {number} [[s1:{number}:{number}]]" for number in numbers),
                    evidence_ids=[f"s1:{number}:{number}" for number in reversed(numbers)])


class BatchContractTests(unittest.TestCase):
    def setUp(self):
        self.catalog = alpha_handoff()["basis"]
        self.schema = batch_step_schema(STEP_SCHEMA, 6)

    def invalid(self, value, *, remaining=6, schema=None, catalog=None):
        with self.assertRaises(AIAdapterError) as caught:
            batch_query_steps(value, remaining, self.catalog if catalog is None else catalog,
                              self.schema if schema is None else schema)
        self.assertEqual(caught.exception.code, "ai_invalid_result")

    def test_schema_is_strict_shallow_envelope_with_independent_copy(self):
        before = deepcopy(STEP_SCHEMA)
        schema = batch_step_schema(STEP_SCHEMA, 6)
        Draft202012Validator.check_schema(schema)
        item = schema["properties"]["queries"]["items"]
        self.assertEqual(set(item["properties"]), set(QUERY_FIELDS))
        self.assertEqual(set(item["required"]), set(QUERY_FIELDS))
        self.assertFalse(schema["additionalProperties"])
        self.assertFalse(item["additionalProperties"])
        self.assertEqual(item["properties"]["action"]["enum"], ["search", "read", "claims", "history", "dialogue"])
        self.assertEqual(set(schema["properties"]), set(STEP_SCHEMA["properties"]) | {"queries"})
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        self.assertNotIn('"if"', json.dumps(schema))
        self.assertNotIn('"then"', json.dumps(schema))
        schema["properties"]["query"]["maxLength"] = 1
        item["properties"]["query"]["maxLength"] = 2
        self.assertEqual(STEP_SCHEMA, before)

    def test_schema_remaining_quota_and_bad_arguments(self):
        for remaining in range(7):
            schema = batch_step_schema(STEP_SCHEMA, remaining)
            self.assertEqual(schema["properties"]["queries"]["maxItems"], remaining)
            if remaining == 0:
                self.assertEqual(schema["properties"]["action"]["enum"], ["answer"])
        for remaining in (True, -1, 7, None):
            with self.subTest(remaining=remaining), self.assertRaises(AIAdapterError) as caught:
                batch_step_schema(STEP_SCHEMA, remaining)
            self.assertEqual(caught.exception.code, "ai_invalid_result")
        for schema in (None, {}, {**STEP_SCHEMA, "required": []}):
            with self.subTest(schema=schema), self.assertRaises(AIAdapterError):
                batch_step_schema(schema, 6)

    def test_prompt_preserves_original_bytes_and_counts_guide_utf8_bytes(self):
        base = 'Trusted rules\n{"question":"Alpha 한글", "evidence_reads":[]}'
        prompt = batch_grounding_prompt(base, MAX_CONTEXT_BYTES)
        self.assertTrue(prompt.endswith(base))
        self.assertEqual(prompt[-len(base):].encode(), base.encode())
        self.assertIn("currently provided context", prompt)
        self.assertIn("another planning round", prompt)
        self.assertIn("queries must be []", prompt)
        size = len(prompt.encode())
        self.assertEqual(batch_grounding_prompt(base, size), prompt)
        with self.assertRaises(AIAdapterError) as caught:
            batch_grounding_prompt(base, size - 1)
        self.assertEqual(caught.exception.code, "ai_input_limit")
        for bad_base, maximum in ((None, 1000), (base, True), (base, 0)):
            with self.subTest(maximum=maximum), self.assertRaises(AIAdapterError):
                batch_grounding_prompt(bad_base, maximum)

    def test_all_query_actions_material_kinds_and_null_defaults_remain_raw(self):
        queries = [query_step("read", material_id="d1"), query_step("read", material_id="o1", start_line=8),
                   query_step("read", material_id="w1", start_line=6), query_step("claims", material_id="d2"),
                   query_step("history", material_id="d1"), query_step("dialogue")]
        plan = batch(*queries)
        before = deepcopy((plan, self.catalog, self.schema))
        self.assertEqual(batch_query_steps(plan, 6, self.catalog, self.schema), queries)
        self.assertEqual((plan, self.catalog, self.schema), before)
        self.assertEqual(_evidence_query(queries[0]), {"action": "read", "query": "", "material_id": "d1",
            "start_line": 1, "line_count": 60, "offset": 0, "limit": 10,
            "start_character": 0, "character_count": 4000})
        single = envelope("search", material_id="w1", query="Beta", offset=0, limit=1)
        self.assertEqual(batch_query_steps(single, 6, self.catalog, self.schema), [single])

    def test_catalog_bindings_and_start_line_are_checked_for_every_query(self):
        invalid = [query_step("read"), query_step("read", material_id="d3"),
                   query_step("read", material_id="d1", start_line=21),
                   query_step("claims", material_id="o1"), query_step("history", material_id="w1"),
                   query_step("history", material_id="d3"), query_step("search", material_id="o2"),
                   query_step("dialogue", material_id="d1")]
        for query in invalid:
            with self.subTest(query=query):
                self.invalid(batch(query_step("read", material_id="d1"), query))
                self.invalid({**step(**query), "queries": []})
        for line_count in (None, True, 0):
            catalog = deepcopy(self.catalog)
            catalog["documents"][0]["line_count"] = line_count
            with self.subTest(line_count=line_count):
                self.invalid(batch(query_step("read", material_id="d1")), catalog=catalog)
        duplicate = deepcopy(self.catalog)
        duplicate["documents"].append(deepcopy(duplicate["documents"][0]))
        self.invalid(batch(query_step("read", material_id="d1")), catalog=duplicate)

    def test_batch_mixed_fields_single_payload_and_answer_queries_are_rejected(self):
        good = batch(query_step("read", material_id="d1"))
        for name in QUERY_FIELDS:
            if name == "action":
                continue
            value = "Alpha" if name == "query" else "d1" if name == "material_id" else 1
            with self.subTest(field=name):
                self.invalid({**good, name: value})
        for changed in ({"content": "Alpha"}, {"evidence_ids": ["s1:1:1"]}, {"queries": []}):
            self.invalid({**good, **changed})
        self.invalid(envelope("read", material_id="d1", content="Alpha"))
        self.invalid(envelope("read", material_id="d1", evidence_ids=["s1:1:1"]))
        self.invalid(envelope("read", material_id="d1", queries=[query_step("read", material_id="d2")]))
        self.invalid(envelope("answer", content="Alpha", queries=[query_step("read", material_id="d1")]))

    def test_child_schema_rejects_recursive_answer_unknown_and_missing_fields(self):
        query = query_step("read", material_id="d1")
        invalid = [{**query, "action": "batch"}, {**query, "action": "answer"},
                   {**query, "content": None}, {**query, "evidence_ids": []},
                   {**query, "queries": []}, {**query, "offset": True},
                   {**query, "line_count": 101}, {**query, "limit": 21}]
        missing = deepcopy(query)
        del missing["query"]
        invalid.append(missing)
        for child in invalid:
            with self.subTest(child=child):
                self.invalid(batch(child))

    def test_remaining_quota_and_answer_only_step_require_empty_queries(self):
        queries = [query_step("read", material_id="d1")] * 3
        self.invalid(batch(*queries), remaining=2, schema=batch_step_schema(STEP_SCHEMA, 2))
        self.invalid(batch(*queries), remaining=2)  # Even a looser supplied schema cannot bypass quota.
        zero = batch_step_schema(STEP_SCHEMA, 0)
        final = envelope("answer", content="Alpha evidence was not checked.")
        self.assertEqual(batch_query_steps(final, 0, self.catalog, zero), [])
        self.invalid(envelope("read", material_id="d1"), remaining=0, schema=zero)
        self.invalid(batch(query_step("read", material_id="d1")), remaining=0, schema=zero)


class BatchGroundedClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.handoff = alpha_handoff()

    def assert_no_preview(self, owner):
        self.assertFalse(any(kind == "answer_preview" for kind, _ in owner.events))

    async def test_six_source_queries_keep_order_results_usage_citations_and_raw_plan(self):
        queries = [query_step("read", material_id="d1", start_line=number, line_count=1) for number in range(1, 7)]
        responses = [alpha_evidence(number) for number in range(1, 7)]
        plan, final = batch(*queries), answer(*range(1, 7))
        before = deepcopy((self.handoff, plan, responses))
        owner, adapter = FakeOwner(self.root / "six", responses), FakeAdapter([plan, final])
        result, prompt = await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
        self.assertEqual(owner.queries, [_evidence_query(query) for query in queries])
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(adapter.calls[0]["prompt"], initial_grounding_prompt(self.handoff, batch_queries=True))
        self.assertEqual(adapter.calls[1]["schema"]["properties"]["action"]["enum"], ["answer"])
        self.assertEqual(adapter.calls[1]["schema"]["properties"]["queries"]["maxItems"], 0)
        for response in responses:
            self.assertIn(response["items"][0]["text"], prompt)
            self.assertIn(response["evidence_ids"][0], prompt)
        self.assertEqual(result["value"]["content"], " ".join(f"Alpha {n} [{n}]" for n in range(1, 7)))
        self.assertEqual(result["value"]["citations"], [row["citations"][0]["citation"] for row in responses])
        self.assertEqual(result["evidence_ids"], [row["evidence_ids"][0] for row in responses])
        self.assertEqual(result["execution"]["question_evidence_reads"], 6)
        self.assertEqual(sum(row["tokens"]["input_tokens"] for row in result["execution"]["token_usage"]["reports"]), 30)
        record = result["execution"]["question_batches"][0]
        self.assertEqual((record["model_step"], record["explicit_batch"], record["planned_queries"],
                          record["first_evidence_read"], record["last_evidence_read"]), (0, True, 6, 1, 6))
        self.assertEqual(record["physical_queries"], 6)
        self.assertFalse(result["execution"]["batch_plan_semantics_verified"])
        self.assertEqual(json.loads((owner.directory / "evidence-model-00.json").read_bytes())["value"], plan)
        self.assertEqual((self.handoff, plan, responses), before)

    async def test_invalid_later_query_rejects_entire_plan_before_first_rpc(self):
        mutations = [query_step("read", material_id="d3"), query_step("read", material_id="d1", start_line=21),
                     {**query_step("read", material_id="d1"), "action": "answer"}]
        for index, query in enumerate(mutations):
            with self.subTest(query=query):
                owner = FakeOwner(self.root / f"invalid-{index}", [alpha_evidence()])
                adapter = FakeAdapter([batch(query_step("read", material_id="d1"), query), answer(1)])
                with self.assertRaises(AIAdapterError) as caught:
                    await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
                self.assertEqual(caught.exception.code, "ai_invalid_result")
                self.assertEqual(owner.queries, [])
                self.assertEqual(len(adapter.calls), 1)
                self.assert_no_preview(owner)

    async def test_later_plan_cannot_spend_more_than_remaining_total_budget(self):
        first = batch(*(query_step("read", material_id="d1", start_line=n) for n in range(1, 6)))
        second = batch(query_step("read", material_id="d1", start_line=6), query_step("read", material_id="d2"))
        owner, adapter = FakeOwner(self.root / "quota", [alpha_evidence(n) for n in range(1, 6)]), FakeAdapter([first, second])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
        self.assertEqual(caught.exception.code, "ai_invalid_result")
        self.assertEqual(len(owner.queries), 5)
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(adapter.calls[1]["schema"]["properties"]["queries"]["maxItems"], 1)
        self.assert_no_preview(owner)

    async def test_second_rpc_failure_stops_without_retry_later_query_or_answer(self):
        class FailingOwner(FakeOwner):
            async def query_evidence(inner, query):
                if len(inner.queries) == 1:
                    inner.queries.append(deepcopy(query))
                    raise QuestionClientError("conflict")
                return await super().query_evidence(query)
        owner = FailingOwner(self.root / "failed", [alpha_evidence()])
        adapter = FakeAdapter([batch(*(query_step("read", material_id="d1", start_line=n) for n in range(1, 4))), answer(1)])
        with self.assertRaises(QuestionClientError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(len(owner.queries), 2)
        self.assertEqual(len(adapter.calls), 1)
        self.assert_no_preview(owner)

    async def test_cancel_after_first_rpc_stops_remaining_queries_and_answer(self):
        owner = FakeOwner(self.root / "cancelled", [alpha_evidence()], cancel_after_query=True)
        adapter = FakeAdapter([batch(query_step("read", material_id="d1"), query_step("read", material_id="d2")), answer(1)])
        with self.assertRaises(QuestionClientError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
        self.assertEqual(caught.exception.code, "question_cancelled")
        self.assertEqual(len(owner.queries), 1)
        self.assertEqual(len(adapter.calls), 1)
        self.assert_no_preview(owner)

    async def test_second_response_registry_validation_stops_unserved_queries(self):
        for problem in ("foreign", "missing", "duplicate", "changed"):
            responses = [alpha_evidence(), alpha_evidence(2)]
            if problem == "foreign":
                responses[1]["citations"][0]["evidence_id"] = "s1:3:3"
            elif problem == "missing":
                responses[1]["citations"] = []
            elif problem == "duplicate":
                responses[1]["evidence_ids"] *= 2
                responses[1]["citations"] *= 2
            else:
                responses[1] = alpha_evidence(1, "Changed Alpha.")
            owner = FakeOwner(self.root / problem, responses)
            adapter = FakeAdapter([batch(*(query_step("read", material_id="d1", start_line=n) for n in range(1, 4))), answer(1)])
            with self.subTest(problem=problem), self.assertRaises(AIAdapterError) as caught:
                await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
            self.assertEqual(caught.exception.code, "ai_invalid_result")
            self.assertEqual(len(owner.queries), 2)
            self.assertEqual(len(adapter.calls), 1)
            self.assert_no_preview(owner)

    async def test_answer_cannot_cite_an_id_not_returned_in_batch(self):
        owner = FakeOwner(self.root / "forged-answer", [alpha_evidence()])
        adapter = FakeAdapter([batch(query_step("read", material_id="d1")), answer(2)])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, self.handoff, batch_queries=True)
        self.assertEqual(caught.exception.code, "ai_invalid_result")
        self.assertEqual(len(owner.queries), 1)
        self.assertEqual(len(adapter.calls), 2)
        self.assert_no_preview(owner)

    async def test_explicit_batch_never_runs_automatic_suffix_even_when_eligible(self):
        handoff = auto_handoff()
        plan = batch({key: value for key, value in full_read().items() if key in QUERY_FIELDS})
        owner = FakeOwner(self.root / "no-auto", [source_page()])
        adapter = FakeAdapter([plan, answer(1)])
        # The served source's first ID is a range, so use its exact ID in the final step.
        adapter.values[1] = envelope("answer", content="Alpha [[s1:1:2]]", evidence_ids=["s1:1:2"])
        result, prompt = await run_grounded_model(owner, adapter, handoff, batch_queries=True)
        self.assertEqual(owner.queries, [normalized(full_read())])
        self.assertNotIn("question_automatic_reads", result["execution"])
        self.assertIn('"remaining_ranges":[[11,20]]', prompt)
        self.assertEqual(result["execution"]["question_evidence_reads"], 1)

    async def test_single_action_fallback_keeps_d112_automatic_completion(self):
        handoff = auto_handoff()
        first = normalized(full_read())
        second = {**first, "start_line": 11, "line_count": 10, "offset": 0}
        owner = FakeOwner(self.root / "single-auto", [source_page(first), source_page(second, partial=False)])
        adapter = FakeAdapter([{**full_read(), "queries": []}, {**final_answer(), "queries": []}])
        result, _ = await run_grounded_model(owner, adapter, handoff, batch_queries=True)
        self.assertEqual(owner.queries, [first, second])
        self.assertEqual(len(adapter.calls), 2)
        self.assertEqual(len(result["execution"]["question_automatic_reads"]), 1)
        row = result["execution"]["question_batches"][0]
        self.assertFalse(row["explicit_batch"])
        self.assertEqual((row["planned_queries"], row["first_evidence_read"], row["last_evidence_read"]), (1, 1, 2))
        self.assertEqual(row["physical_queries"], 2)

    async def test_default_and_explicit_false_keep_existing_prompt_schema_and_result(self):
        values = [step("read", material_id="d1"), step("answer", content="Alpha [[s1:1:1]]", evidence_ids=["s1:1:1"])]
        results, adapters = [], []
        for name, options in (("default", {}), ("false", {"batch_queries": False})):
            owner, adapter = FakeOwner(self.root / name, [alpha_evidence()]), FakeAdapter(values)
            results.append(await run_grounded_model(owner, adapter, self.handoff, **options))
            adapters.append(adapter)
        self.assertEqual(results[0], results[1])
        self.assertEqual(initial_grounding_prompt(self.handoff), initial_grounding_prompt(self.handoff, batch_queries=False))
        for before, after in zip(adapters[0].calls, adapters[1].calls):
            self.assertEqual(before["prompt"], after["prompt"])
            self.assertEqual(before["schema"], STEP_SCHEMA)
            self.assertEqual(before["schema"], after["schema"])
            self.assertNotIn("queries", after["schema"]["properties"])
        self.assertNotIn("question_batches", results[0][0]["execution"])

    async def test_other_experiments_and_nonboolean_flag_are_rejected_before_model(self):
        for index, options in enumerate(({"batch_queries": True, "check_draft": True},
                                         {"batch_queries": True, "cover_question": True}, {"batch_queries": 1})):
            owner, adapter = FakeOwner(self.root / f"flags-{index}"), FakeAdapter([])
            with self.subTest(options=options), self.assertRaises(AIAdapterError) as caught:
                await run_grounded_model(owner, adapter, self.handoff, **options)
            self.assertEqual(caught.exception.code, "ai_invalid_result")
            self.assertEqual(adapter.calls, [])
            self.assertEqual(owner.queries, [])
        for options in ({"batch_queries": True, "cover_question": True}, {"batch_queries": 1}):
            with self.assertRaises(AIAdapterError):
                initial_grounding_prompt(self.handoff, **options)

    async def test_cumulative_evidence_and_guide_enforce_192kib_without_truncation(self):
        handoff = deepcopy(self.handoff)
        base = batch_grounding_prompt(grounding_prompt(handoff, []), MAX_CONTEXT_BYTES)
        handoff["question"] += "x" * (MAX_CONTEXT_BYTES - len(base.encode()) - 1024)
        responses = [alpha_evidence(n, f"Alpha {n}: " + "evidence " * 256) for n in (1, 2)]
        owner = FakeOwner(self.root / "context-limit", responses)
        adapter = FakeAdapter([batch(query_step("read", material_id="d1"), query_step("read", material_id="d2")), answer(1, 2)])
        with self.assertRaises(AIAdapterError) as caught:
            await run_grounded_model(owner, adapter, handoff, batch_queries=True)
        self.assertEqual(caught.exception.code, "ai_input_limit")
        self.assertEqual(len(owner.queries), 2)
        self.assertEqual(len(adapter.calls), 1)
        self.assertLessEqual(len(adapter.calls[0]["prompt"].encode()), MAX_CONTEXT_BYTES)
        self.assert_no_preview(owner)
