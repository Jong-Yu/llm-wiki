"""모델용 판본 표식의 동등성·원문 보존·실제 hash 복원과 실행 경계를 검사한다."""

from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from core.client.ai.contracts import AIAdapterError
from core.client.question_grounding import grounding_prompt, run_grounded_model
from core.client.question_versions import DATA_MARKER, VERSION_GUIDE, VersionAliases
from core.common.json_codec import canonical_json_hash
from core.tests.poc_knowledge.test_question_grounding_client import (
    FakeAdapter, FakeOwner, evidence, handoff_fixture, step,
)
from core.tests.poc_knowledge.test_question_prompt_compaction import expand, reads_for


HASH_A, HASH_B, HASH_C = "a" * 64, "b" * 64, "c" * 64


def handoff():
    value = handoff_fixture()
    value["basis"]["basis_id"] = "e" * 64
    value["basis"]["snapshot_revision"] = HASH_C
    value["basis"]["documents"] = [{"id": f"d{i}", "document": f"doc{i}.md", "line_count": 10,
        "source_revision": HASH_A, "graph_revision": HASH_B,
        "history_revision": HASH_C, "state_revision": HASH_B} for i in range(1, 5)]
    return value


def payload(prompt):
    return json.loads(prompt.split(DATA_MARKER)[1])


def source_response(quote="조건과 예외를 유지합니다."):
    response = evidence(quote=quote)
    response["items"][0]["source_revision"] = HASH_A
    return response


class VersionPromptTests(unittest.TestCase):
    def setUp(self):
        self.handoff = handoff()

    def test_equal_distinct_event_provenance_and_semantic_values(self):
        item = {"kind": "review", "evidence_id": "h1:1", "source_revision": HASH_A,
                "state_revision": HASH_B, "event": {"source_revision": HASH_A, "graph_revision": HASH_B,
                    "reason": "보류 조건은 미확정🙂", "value": {"source_revision": "not-a-provenance-value"}},
                "source_reviewed_value": {"source_revision": "user-defined"}}
        reads = reads_for([[item]])
        original = deepcopy((self.handoff, reads))
        versions = VersionAliases()
        result = grounding_prompt(self.handoff, reads, versions=versions)
        view = payload(result)
        projected = view["evidence_reads"][0]["result"]["items"][0]
        self.assertTrue(result.startswith(VERSION_GUIDE))
        self.assertEqual(projected["source_revision"], view["materials"]["documents"][0]["source_revision"])
        self.assertEqual(projected["event"]["source_revision"], projected["source_revision"])
        self.assertNotEqual(projected["source_revision"], projected["state_revision"])
        self.assertEqual(projected["source_reviewed_value"], item["source_reviewed_value"])
        self.assertEqual(projected["event"]["value"], item["event"]["value"])
        self.assertEqual(projected["event"]["reason"], item["event"]["reason"])
        self.assertEqual((self.handoff, reads), original)

    def test_review_actor_authority_revisions_share_only_known_provenance_aliases(self):
        self.handoff["basis"]["scope"] = {"profile": {"access_revision": HASH_A, "policy_revision": HASH_B}}
        item = {"kind": "review", "evidence_id": "h1:1", "event": {
            "actor": {"access_revision": HASH_A, "policy_revision": HASH_B, "user_id": "reviewer"},
            "value": {"actor": {"access_revision": "a semantic attribute"}}}}
        reads = reads_for([[item]])
        view = payload(grounding_prompt(self.handoff, reads, versions=VersionAliases()))
        event = view["evidence_reads"][0]["result"]["items"][0]["event"]
        self.assertEqual(event["actor"]["access_revision"], view["materials"]["scope"]["profile"]["access_revision"])
        self.assertEqual(event["actor"]["policy_revision"], view["materials"]["scope"]["profile"]["policy_revision"])
        self.assertEqual(event["value"], item["event"]["value"])

    def test_new_read_never_renumbers_previous_aliases(self):
        versions = VersionAliases()
        first = payload(grounding_prompt(self.handoff, [], versions=versions))
        reads = reads_for([[{"evidence_id": "s1:1:1", "source_revision": "d" * 64, "text": "새 문서"}]])
        second = payload(grounding_prompt(self.handoff, reads, versions=versions))
        self.assertEqual(first["materials"], second["materials"])
        self.assertNotIn(second["evidence_reads"][0]["result"]["items"][0]["source_revision"],
                         {first["materials"]["documents"][0][key] for key in ("source_revision", "state_revision", "history_revision")})

    def test_existing_source_value_hash_comparison_uses_original_prompt(self):
        for key in ("text", "source_value", "source_reviewed_value"):
            item = {"evidence_id": "c1:1", "source_revision": HASH_A, key: HASH_A}
            reads = reads_for([[item]])
            self.assertEqual(grounding_prompt(self.handoff, reads, versions=VersionAliases()),
                             grounding_prompt(self.handoff, reads))

    def test_literal_hash_in_question_falls_back_without_language_heuristics(self):
        for literal in (HASH_A, HASH_A.upper()):
            self.handoff["question"] = "Is this exactly the current version: " + literal
            self.assertEqual(grounding_prompt(self.handoff, [], versions=VersionAliases()),
                             grounding_prompt(self.handoff, []))

    def test_literal_marker_collision_in_later_evidence_disables_only_current_expansion(self):
        versions = VersionAliases()
        first = grounding_prompt(self.handoff, [], versions=versions)
        self.assertTrue(first.startswith(VERSION_GUIDE))
        reads = reads_for([[{"evidence_id": "s1:1:1", "text": "문자 그대로 {{rv:1}} 값"}]])
        second = grounding_prompt(self.handoff, reads, versions=versions)
        self.assertEqual(second, grounding_prompt(self.handoff, reads))
        answer = step("answer", content="문자 그대로 {{rv:1}}", evidence_ids=[])
        self.assertEqual(versions.expand_step(answer), answer)

    def test_unsupported_original_or_web_sources_keep_original_view(self):
        for field, value in (("originals", [{"id": "o1"}]), ("web", {"sources": [{"id": "w1"}]})):
            with self.subTest(field=field):
                source = handoff()
                source["basis"][field] = value
                self.assertEqual(grounding_prompt(source, [], versions=VersionAliases()), grounding_prompt(source, []))

    def test_unknown_literal_equality_location_keeps_full_original_hashes(self):
        self.handoff["basis"]["new_provenance"] = HASH_A
        self.assertEqual(grounding_prompt(self.handoff, [], versions=VersionAliases()),
                         grounding_prompt(self.handoff, []))

    def test_short_input_and_guide_overhead_do_not_enlarge_prompt(self):
        original = grounding_prompt(handoff_fixture(), [])
        self.assertEqual(VersionAliases().prompt(original, len(original.encode())), original)

    def test_failed_prompt_limit_does_not_change_mapping_or_active_set(self):
        versions = VersionAliases()
        original = grounding_prompt(self.handoff, [])
        compact = versions.prompt(original, len(original.encode()))
        state = versions.metadata()
        with self.assertRaises(AIAdapterError) as caught:
            versions.prompt(original, len(compact.encode()) - 1)
        self.assertEqual(caught.exception.code, "ai_input_limit")
        self.assertEqual(versions.metadata(), state)
        label = payload(compact)["materials"]["documents"][0]["source_revision"]
        self.assertEqual(versions.expand_step(step("answer", content=label))["content"], HASH_A)

    def test_forced_final_model_view_exposes_original_hashes_without_another_call(self):
        versions = VersionAliases()
        original = grounding_prompt(self.handoff, [])
        first = versions.prompt(original, len(original.encode()))
        self.assertTrue(first.startswith(VERSION_GUIDE))
        final = versions.prompt(original, len(original.encode()), allow_disclosure=False)
        self.assertEqual(final, original)
        self.assertEqual(payload(final)["materials"], self.handoff["basis"])
        self.assertFalse(versions.can_disclose)
        self.assertEqual(versions.metadata()["compacted_steps"], 1)
        self.assertEqual(versions.metadata()["original_steps"], 1)
        self.assertFalse(versions.metadata()["original_revisions_disclosed"])
        with self.assertRaises(AIAdapterError):
            versions.expand_step(step("answer", content="{{rv:1}}"))

    def test_alias_expansion_preserves_raw_step_and_unknown_labels_fail(self):
        versions = VersionAliases()
        view = payload(grounding_prompt(self.handoff, [], versions=versions))
        label = view["materials"]["documents"][0]["source_revision"]
        raw = step("answer", content=f"정확한 값 `{label}`. [[s1:2:2]]", evidence_ids=["s1:2:2"])
        before = deepcopy(raw)
        result = versions.expand_step(raw)
        self.assertEqual(result["content"], f"정확한 값 `{HASH_A}`. [[s1:2:2]]")
        self.assertEqual(raw, before)
        for text in ("{{rv:999}}", "{{rv:01}}", "{{rv:broken}}", "{{rv:1", "{{RV:1}}", "{{Rv:1}}"):
            with self.subTest(text=text), self.assertRaises(AIAdapterError):
                versions.expand_step(step("answer", content=text))
        with self.assertRaises(AIAdapterError):
            versions.expand_step(step("answer", content="text", evidence_ids=[label]))

    def test_same_item_compaction_still_resolves_to_original_citation_ranges(self):
        item = {"evidence_id": "s1:1:5", "kind": "source", "source_revision": HASH_A, "text": "조건·부정🙂\n" * 80}
        reads = reads_for([[item], [deepcopy(item)]])
        versions = VersionAliases()
        result = grounding_prompt(self.handoff, reads, versions=versions)
        view = payload(result)
        expanded = expand(view["evidence_reads"])
        self.assertEqual(expanded[0]["result"]["items"][0], expanded[1]["result"]["items"][0])
        self.assertEqual(expanded[0]["result"]["items"][0]["text"], item["text"])
        self.assertEqual(expanded[0]["result"]["items"][0]["evidence_id"], item["evidence_id"])


class VersionLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_exhausted_evidence_budget_exposes_hashes_even_before_final_model_call(self):
        source = handoff()
        initial = source_response()
        source["contract_version"] = "personal-question-v6"
        source["initial_evidence"] = {"sha256": canonical_json_hash(initial)}
        values = [*[step("search", query=f"term{i}") for i in range(5)],
                  step("answer", content="원문 판본 첫8자리는 AAAAAAAA입니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])]
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory), [initial, *[source_response() for _ in range(5)]])
            adapter = FakeAdapter(values)
            result, _ = await run_grounded_model(owner, adapter, source, compact_versions=True)
            self.assertEqual(len(adapter.calls), 6)
            self.assertEqual(len(owner.queries), 6)
            self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])
            self.assertNotIn("{{rv:", adapter.calls[-1]["prompt"])
            self.assertEqual(payload(adapter.calls[-1]["prompt"])["materials"], source["basis"])
            self.assertIn("AAAAAAAA", result["value"]["content"])
            self.assertEqual(result["execution"]["question_version_aliases"]["compacted_steps"], 5)
            self.assertEqual(result["execution"]["question_version_aliases"]["original_steps"], 1)
            self.assertEqual(len(result["execution"]["question_invocations"]), 6)

    async def test_local_revision_disclosure_supports_character_operations_without_server_lookup(self):
        source = handoff()
        source["question"] = "원문 판본 첫8자리를 대문자로 표시하고 aaaa 접두사인지 확인하세요."
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory))
            adapter = FakeAdapter([step("revisions"), step("answer", content="AAAAAAAA이며 aaaa로 시작합니다.")])
            original = deepcopy(source)
            result, _ = await run_grounded_model(owner, adapter, source, compact_versions=True)
            first, second = adapter.calls
            self.assertIn("revisions", first["schema"]["properties"]["action"]["enum"])
            self.assertNotIn("revisions", second["schema"]["properties"]["action"]["enum"])
            self.assertIn("{{rv:", first["prompt"])
            self.assertEqual(payload(second["prompt"])["materials"], source["basis"])
            self.assertEqual(second["prompt"], grounding_prompt(source, []))
            self.assertEqual(owner.queries, [])
            self.assertEqual(source, original)
            self.assertEqual(result["value"]["content"], "AAAAAAAA이며 aaaa로 시작합니다.")
            self.assertEqual(len(result["execution"]["question_invocations"]), 2)
            self.assertEqual(sum(r["tokens"]["input_tokens"] for r in result["execution"]["token_usage"]["reports"]), 30)
            self.assertTrue(result["execution"]["question_version_aliases"]["original_revisions_disclosed"])
            self.assertEqual(json.loads((Path(directory) / "evidence-model-00.json").read_text())["value"]["action"], "revisions")
            disclosure = json.loads((Path(directory) / "evidence-revisions-00.json").read_text())
            self.assertFalse(disclosure["server_query"])
            self.assertEqual(disclosure["evidence_reads"], 0)

    async def test_revision_disclosure_rejects_arguments_repetition_and_unoffered_action(self):
        cases = [([step("revisions", query="value")], handoff(), 1),
                 ([step("revisions", content="value")], handoff(), 1),
                 ([step("revisions", evidence_ids=["s1:2:2"])], handoff(), 1),
                 ([step("revisions"), step("revisions")], handoff(), 2),
                 ([step("revisions")], handoff_fixture(), 1)]
        for values, source, count in cases:
            with self.subTest(values=values), TemporaryDirectory() as directory:
                owner = FakeOwner(Path(directory))
                adapter = FakeAdapter(values)
                with self.assertRaises(AIAdapterError):
                    await run_grounded_model(owner, adapter, source, compact_versions=True)
                self.assertEqual(owner.queries, [])
                self.assertEqual(len(adapter.calls), count)
                self.assertTrue((Path(directory) / f"evidence-model-{count - 1:02d}.json").exists())

    async def test_local_disclosure_uses_existing_seven_call_limit_and_forces_final_answer(self):
        for final in (step("answer", content="조건이 있습니다. [[s1:2:2]]", evidence_ids=["s1:2:2"]), step("revisions")):
            with self.subTest(final=final["action"]), TemporaryDirectory() as directory:
                owner = FakeOwner(Path(directory), [source_response() for _ in range(5)])
                adapter = FakeAdapter([step("revisions"), *[step("search", query=f"term{i}") for i in range(5)], final])
                if final["action"] == "answer":
                    result, _ = await run_grounded_model(owner, adapter, handoff(), compact_versions=True)
                    self.assertEqual(result["execution"]["question_evidence_reads"], 5)
                    self.assertEqual(len(result["execution"]["question_invocations"]), 7)
                    self.assertEqual(sum(r["tokens"]["input_tokens"] for r in result["execution"]["token_usage"]["reports"]), 280)
                else:
                    with self.assertRaises(AIAdapterError):
                        await run_grounded_model(owner, adapter, handoff(), compact_versions=True)
                self.assertEqual(len(adapter.calls), 7)
                self.assertEqual(len(owner.queries), 5)
                self.assertEqual(adapter.calls[-1]["schema"]["properties"]["action"]["enum"], ["answer"])
                self.assertIn("model-call budget is exhausted", adapter.calls[-1]["prompt"])

    async def test_actual_hash_answer_and_query_restore_before_validation_and_keep_raw_record(self):
        source = handoff()
        source["question"] = "현재 원문 판본의 정확한 hash와 조건을 알려 주세요."
        probe = VersionAliases()
        label = payload(grounding_prompt(source, [], versions=probe))["materials"]["documents"][0]["source_revision"]
        response = source_response()
        original = deepcopy((source, response))
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory), [response])
            adapter = FakeAdapter([step("search", query=label),
                step("answer", content=f"판본 `{HASH_A}`이며 조건이 있습니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])])
            result, _ = await run_grounded_model(owner, adapter, source, compact_versions=True)
            self.assertEqual(owner.queries[0]["query"], HASH_A)
            self.assertIn(HASH_A, result["value"]["content"])
            self.assertNotIn("{{rv:", result["value"]["content"])
            self.assertEqual(result["value"]["citations"], [response["citations"][0]["citation"]])
            raw = json.loads((Path(directory) / "evidence-model-00.json").read_text())
            self.assertEqual(label, raw["value"]["query"])
            self.assertEqual(len(adapter.calls), 2)
            self.assertTrue(all(not call["persist_session"] for call in adapter.calls))
            # The original hash in the recorded search query is now visible as
            # literal data, so that complete later prompt uses original hashes.
            self.assertEqual(result["execution"]["question_version_aliases"]["compacted_steps"], 1)
            self.assertEqual(result["execution"]["question_version_aliases"]["original_steps"], 1)
        self.assertEqual((source, response), original)

    async def test_default_false_preserves_identical_prompt_schema_output(self):
        results = []
        for options in ({}, {"compact_versions": False}):
            with TemporaryDirectory() as directory:
                owner = FakeOwner(Path(directory))
                adapter = FakeAdapter([step("answer", content="근거 미확인")])
                result, prompt = await run_grounded_model(owner, adapter, handoff(), **options)
                results.append((result, prompt, adapter.calls[0]["schema"]))
        self.assertEqual(results[0], results[1])

    async def test_expanded_query_limit_rejected_before_any_lookup(self):
        source = handoff()
        label = payload(grounding_prompt(source, [], versions=VersionAliases()))["materials"]["documents"][0]["source_revision"]
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory))
            adapter = FakeAdapter([step("search", query=" ".join([label] * 4))])
            with self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, source, compact_versions=True)
            self.assertEqual(owner.queries, [])
            self.assertEqual(len(adapter.calls), 1)
            self.assertTrue((Path(directory) / "evidence-model-00.json").exists())

    async def test_expanded_answer_limit_is_rejected_without_truncation(self):
        source = handoff()
        label = payload(grounding_prompt(source, [], versions=VersionAliases()))["materials"]["documents"][0]["source_revision"]
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory))
            adapter = FakeAdapter([step("answer", content=label * 1025)])
            with self.assertRaises(AIAdapterError):
                await run_grounded_model(owner, adapter, source, compact_versions=True)
            self.assertEqual(len(adapter.calls), 1)

    async def test_v6_initial_receipt_hash_and_registry_use_original_values(self):
        source = handoff()
        response = source_response()
        source["contract_version"] = "personal-question-v6"
        source["initial_evidence"] = {"sha256": canonical_json_hash(response)}
        with TemporaryDirectory() as directory:
            owner = FakeOwner(Path(directory), [response])
            # Initial evidence sorts before the material catalog, assigning its
            # source hash the first label rather than the catalog's graph hash.
            adapter = FakeAdapter([step("answer", content="원문 판본 {{rv:1}}이며 조건을 유지합니다. [[s1:2:2]]", evidence_ids=["s1:2:2"])])
            result, _ = await run_grounded_model(owner, adapter, source, select_tools=True, compact_versions=True)
            self.assertEqual(result["value"]["citations"][0]["source_revision"], HASH_A)
            self.assertIn(HASH_A, result["value"]["content"])
            self.assertIn("{{rv:1}}", json.loads((Path(directory) / "evidence-model-00.json").read_text())["value"]["content"])
            self.assertEqual(result["execution"]["question_automatic_reads"][0]["evidence_sha256"], canonical_json_hash(response))
            self.assertEqual(len(owner.queries), 1)

    async def test_invalid_option_values_and_unverified_feature_combinations_reject_before_calls(self):
        for options in ({"compact_versions": 1}, {"compact_versions": None},
                        {"compact_versions": True, "check_draft": True},
                        {"compact_versions": True, "cover_question": True},
                        {"compact_versions": True, "batch_queries": True}):
            with self.subTest(options=options), TemporaryDirectory() as directory:
                owner = FakeOwner(Path(directory))
                adapter = FakeAdapter([])
                with self.assertRaises(AIAdapterError):
                    await run_grounded_model(owner, adapter, handoff(), **options)
                self.assertEqual(adapter.calls, [])
                self.assertEqual(owner.queries, [])
