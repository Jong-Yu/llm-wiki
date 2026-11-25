"""분할 실행의 범위·보존·재개 검증. 합성 어댑터이며 의미 품질 평가가 아니다."""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import tracemalloc
from unittest.mock import patch

from core.client.ai import segmented_input as inputs, segmented_workflow as flow, segmented_diagnostics
from core.client.ai.timings import StageTimings
from core.client.inputs import input_budget, MAX_INPUT_BYTES, MAX_REFERENCE_INPUT_BYTES
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results.diagnostics import empty_report, schema as diagnostic_schema
from core.modules.documents.metadata import parse_document
from core.runtime.client_platform import private_directory
from core.runtime.extraction_schema import build_submission_schema


def captured(source):
    revision = sha256(source.encode()).hexdigest()
    manifest = {"stage": "extract_ontology", "target_document": "target.md", "job_id": "a" * 32,
        "run_id": "b" * 32, "tenant": "test", "actor": {"user_id": "user", "access_revision": "c" * 64},
        "selection": [{"document": "target.md", "required": True}], "dependency_revision": "d" * 64,
        "analysis_basis_revision": "e" * 64, "ruleset_ref": {"ruleset_id": "test", "ruleset_version": "v1"},
        "dependency": {"documents": [{"document": "target.md", "source_revision": revision}]}}
    components = {"data/context.json": json.dumps({"documents": [{"document": "target.md", "source": {
        "document": "target.md", "revision": revision, "content": source,
        "body_start_line": parse_document(source).body_start_line}}]}),
        "rules/submission.schema.json": json.dumps(build_submission_schema()),
        "rules/diagnostics.schema.json": json.dumps(diagnostic_schema())}
    return {"manifest": manifest, "components": components, "ruleset": {"manifest_text": "{}", "components": {
        name.removeprefix("rules/"): {"content": content} for name, content in components.items()
        if name.startswith("rules/")}}}


class WindowTests(unittest.TestCase):
    def test_unicode_long_single_line_coverage_hash_and_byte_bounds(self):
        source = "가나다😀" * 200 + "\r\n끝"
        parts = inputs.plan(source, window_bytes=101, overlap_bytes=20)
        self.assertEqual(parts[0]["start"], 0)
        self.assertEqual(parts[-1]["end"], len(source))
        for index, part in enumerate(parts):
            text = source[part["start"]:part["end"]]
            self.assertLessEqual(len(text.encode()), 101)
            self.assertEqual(part["index"], index)
            self.assertEqual(part["sha256"], sha256(text.encode()).hexdigest())
            if index:
                self.assertLessEqual(part["start"], parts[index - 1]["end"])
                self.assertGreater(part["start"], parts[index - 1]["start"])
        self.assertEqual(parts, inputs.plan(source, window_bytes=101, overlap_bytes=20))

    def test_metadata_is_not_extracted_and_lines_keep_both_coordinates(self):
        source = ('---\nschema_version: 1\ndocument_id: "' + 'a' * 32
                  + '"\ntags: []\ntitle: "title"\n---\n첫째\f둘째\r\n셋째')
        part = inputs.plan(source)[0]
        self.assertEqual(source[part["start"]:], parse_document(source).body)
        lines = inputs._line_view(source, part)
        self.assertEqual(lines[1]["number"], lines[0]["number"] + 1)
        self.assertEqual(lines[1]["source_anchor_line"], lines[0]["source_anchor_line"])

    def test_large_original_assembly_is_bounded_and_preserves_full_revision(self):
        source = "한글 😀 자료\n" * 600000
        full = captured(source)
        fixed = {"bundle_revision": "f" * 64}
        parts = inputs.plan(source)
        before = deepcopy(full)
        assembled = inputs.assemble(full, fixed, document="target.md", segment=parts[5],
                                    input_view="full", rules_view="full")
        self.assertLess(len(assembled["prompt"].encode()), MAX_INPUT_BYTES)
        view = json.loads(assembled["prompt"].split("\nFIXED_INPUT_DATA\n")[1])
        row = json.loads(view["components"]["data/context.json"])["documents"][0]["source"]
        self.assertNotIn("content", row)
        self.assertEqual(row["revision"], sha256(source.encode()).hexdigest())
        self.assertEqual(row["window"]["content"], source[parts[5]["start"]:parts[5]["end"]])
        self.assertEqual(full, before)

    def test_untrusted_budget_or_missing_registration_rejected(self):
        self.assertEqual(input_budget({}), MAX_INPUT_BYTES)
        good = {"input_mode": "registration-reference-v1", "input_budget_bytes": MAX_REFERENCE_INPUT_BYTES,
                "components": {"data/registration.json": {}}}
        self.assertEqual(input_budget(good), MAX_REFERENCE_INPUT_BYTES)
        for invalid in ({**good, "input_budget_bytes": MAX_REFERENCE_INPUT_BYTES + 1},
                        {**good, "components": {}}, {"input_budget_bytes": MAX_REFERENCE_INPUT_BYTES}):
            with self.assertRaises(AnalysisClientError):
                input_budget(invalid)

    def test_cache_key_preserves_access_history_rules_and_execution(self):
        value = captured("Some source.")
        args = dict(source_revision="a" * 64, execution_config_sha256="b" * 64,
                    input_view="full", rules_view="full")
        before = inputs.cache_binding(value["manifest"], **args)
        value["manifest"]["run_id"] = "x" * 32
        self.assertEqual(inputs.cache_binding(value["manifest"], **args), before)
        value["manifest"]["dependency_revision"] = "z" * 64
        self.assertNotEqual(inputs.cache_binding(value["manifest"], **args), before)

    def test_diagnostics_preserves_target_indices_findings_and_merges_ranges(self):
        report = empty_report()
        report.update(reviewer_kind="ai_self_check", reviewed_ranges=[{"start_line": 1, "end_line": 2}],
            findings=[{"rule_id": "R-S01", "verdict": "supported", "source": {
                "quote": "one", "start_line": 1, "end_line": 1}, "target": {"collection": "entities", "index": 0},
                "reason": "Fixture", "recommendation": None, "question": None}])
        second = empty_report()
        second.update(reviewer_kind="ai_self_check", reviewed_ranges=[{"start_line": 2, "end_line": 3}])
        merged = segmented_diagnostics.merge([report, second])
        self.assertEqual(merged["findings"][0]["target"]["index"], 0)
        self.assertEqual(report["findings"][0]["target"]["index"], 0)
        self.assertEqual(merged["reviewed_ranges"], [{"start_line": 1, "end_line": 3}])

    def test_failed_rule_without_findings_cannot_be_published_as_complete(self):
        report = empty_report()
        report.update(schema_version=2, semantic_check=None, rule_results=[{
            "rule_id": f"R-S{number:02d}", "status": "fail" if number == 1 else "not_run",
            "reason": "Synthetic rule status", "finding_indices": []} for number in range(1, 11)])
        self.assertEqual(segmented_diagnostics.concerns(report)[0]["id"], "rule:R-S01")
        with self.assertRaises(AnalysisClientError) as stopped:
            segmented_diagnostics.require_complete(report)
        self.assertEqual(stopped.exception.code, "segmented_review_incomplete")
        report["rule_results"][0]["status"] = "not_run"
        segmented_diagnostics.require_complete(report)

    def test_newline_coordinates_use_compact_arrays_and_reject_before_materializing_lines(self):
        from array import array
        source = "\n" * 100000
        tracemalloc.start()
        try:
            coordinates = inputs.source_coordinates(source)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertIsInstance(coordinates["diagnostics"], array)
        self.assertIsInstance(coordinates["anchors"], array)
        self.assertLess(peak, 3 * 1024 * 1024)
        with patch.object(inputs, "MAX_SOURCE_LINES", 1000), patch.object(
                inputs, "parse_document", side_effect=AssertionError("must reject before line materialization")):
            with self.assertRaises(AnalysisClientError) as stopped:
                inputs.plan(source)
        self.assertEqual(stopped.exception.code, "segmented_source_limit")
        parts = inputs.plan(source)
        for part in parts:
            self.assertLessEqual(len(inputs._line_view(source, part, coordinates)), inputs.MAX_WINDOW_LINES)
        self.assertEqual(parts[-1]["end"], len(source))

    def test_retained_limit_requires_entire_finding_quote_in_the_actual_target_evidence(self):
        quote = "Water must not be used."
        finding = {"verdict": "schema_limit", "source": {"quote": quote, "start_line": 2, "end_line": 2},
                   "target": {"collection": "entities", "index": 0}, "reason": "A retained representation limit."}
        for evidence in ("Pump exists.", "Water", None, {"quote": quote}):
            with self.subTest(evidence=evidence):
                graph = {"entities": [{"evidence": evidence}]}
                self.assertFalse(segmented_diagnostics.retained_schema_limit(finding, graph))
        self.assertFalse(segmented_diagnostics.retained_schema_limit(finding))
        for collection in ("attributes", "relations"):
            target = {**finding, "target": {"collection": collection, "index": 0}}
            graph = {collection: [{"evidence": "Safety rule: " + quote}]}
            self.assertTrue(segmented_diagnostics.retained_schema_limit(target, graph))

    def test_merge_cannot_certify_a_limit_linked_to_unrelated_or_short_entity_evidence(self):
        report = empty_report()
        reason = "The prohibition is retained despite a representation limit."
        report.update(reviewer_kind="ai_self_check", reviewed_ranges=[{"start_line": 1, "end_line": 2}],
            omissions=[reason], findings=[{"rule_id": "R-S10", "verdict": "schema_limit",
                "source": {"quote": "Water must not be used.", "start_line": 2, "end_line": 2},
                "target": {"collection": "entities", "index": 0}, "reason": reason,
                "recommendation": None, "question": None}])
        for evidence in ("Pump exists.", "Water"):
            graph = {"entities": [{"evidence": evidence}]}
            with self.subTest(evidence=evidence):
                with self.assertRaises(AnalysisClientError) as stopped:
                    segmented_diagnostics.merge([report], submission=graph)
                self.assertEqual(stopped.exception.code, "segmented_review_incomplete")

    def test_explicit_initial_error_cannot_be_renamed_as_a_schema_limit(self):
        source = "Pump does not use Water.\n"
        quote = source.rstrip("\n")
        full = captured(source)
        part = inputs.plan(source)[0]
        graph = {"schema_version": 3, "entities": [
            {"id": "pump", "type": "physical_object", "label": "Pump", "evidence": quote},
            {"id": "water", "type": "physical_object", "label": "Water", "evidence": quote}],
            "relations": [{"subject": "pump", "predicate": "uses", "object": "water", "evidence": quote,
                "qualifiers": {"polarity": "positive", "modality": "asserted", "condition": None,
                               "scope": None, "time": None}}], "relation_candidates": [], "attributes": []}
        basis = {"source": source, "document": "target.md", "expected_revision": sha256(source.encode()).hexdigest(),
            "schema": build_submission_schema(), "manifest": full["manifest"], "components": full["components"],
            "segmented_coordinates": inputs.source_coordinates(source), "segmented_body_start": 0}
        for verdict in ("contradicted", "ambiguous", "unsupported", "condition_loss", "omission", "not_run", "undetermined"):
            initial = empty_report()
            initial.update(reviewer_kind="ai_self_check", reviewed_ranges=[{"start_line": 1, "end_line": 1}],
                findings=[{"rule_id": "R-S02", "verdict": verdict,
                    "source": {"quote": quote, "start_line": 1, "end_line": 1},
                    "target": {"collection": "relations", "index": 0}, "reason": "The graph lost the explicit negation.",
                    "recommendation": None, "question": None}])
            assembled = inputs.assemble(full, {"bundle_revision": "f" * 64}, document="target.md", segment=part,
                input_view="full", rules_view="full", graph=graph, phase="reconcile", initial_report=initial)
            final = deepcopy(initial)
            final["findings"][0]["verdict"] = "schema_limit"
            payload = {"segment": assembled["identity"], "submission": deepcopy(graph), "diagnostics": final,
                "resolutions": [{"concern_id": "finding:0", "finding_index": 0,
                                 "reason": "The unchanged positive relation is labelled a representation limit."}],
                "unresolved_concerns": []}
            with self.subTest(verdict=verdict):
                with self.assertRaises(AnalysisClientError) as stopped:
                    flow._inspect(payload, assembled, basis, part, graph, initial)
                self.assertEqual(stopped.exception.code, "segmented_concern_unresolved")


class Lease:
    def check(self):
        pass

    async def guard(self, coroutine):
        return await coroutine


class SyntheticAdapter:
    def __init__(self, *, fail_call=None, rewrite=False, bad_evidence=False, incomplete=False,
                 initial_incomplete=False, resolve_concern=True):
        self.calls = 0
        self.fail_call, self.rewrite = fail_call, rewrite
        self.bad_evidence, self.incomplete = bad_evidence, incomplete
        self.initial_incomplete, self.resolve_concern = initial_incomplete, resolve_concern

    async def run(self, *, prompt, schema, output_schema, directory):
        self.calls += 1
        if self.calls == self.fail_call:
            raise AnalysisClientError("synthetic_failure")
        view = json.loads(prompt.split("\nFIXED_INPUT_DATA\n", 1)[1].split("\nDRAFT_REPAIR\n", 1)[0])
        segment = view["manifest"]["segmented_input"]
        source = json.loads(view["components"]["data/context.json"])["documents"][0]["source"]
        graph = {"schema_version": 3, "entities": [], "relations": [], "relation_candidates": [], "attributes": []}
        if "data/segmented-graph.json" in view["components"]:
            graph = json.loads(view["components"]["data/segmented-graph.json"])
            if self.rewrite and graph["entities"]:
                graph["entities"][0]["label"] = "wrong"
        elif "Pump." in source["window"]["content"]:
            graph["entities"] = [{"id": "pump", "type": "physical_object", "label": "Pump", "evidence": "Pump."}]
        if self.bad_evidence:
            graph["entities"] = [{"id": "bad", "type": "physical_object", "label": "Missing", "evidence": "Missing."}]
        diagnostics = empty_report()
        diagnostics["reviewer_kind"] = "ai_self_check"
        if self.incomplete or self.initial_incomplete and segment["phase"] == "extract" and segment["segment"]["index"] == 0:
            diagnostics["unread_ranges"] = ["Explicit fixture unread content"]
        lines = source["window"]["lines"]
        diagnostics["reviewed_ranges"] = [{"start_line": lines[0]["number"], "end_line": lines[-1]["number"]}]
        resolutions, unresolved = [], []
        if "data/initial-diagnostics.json" in view["components"]:
            initial = json.loads(view["components"]["data/initial-diagnostics.json"])
            for concern in initial["concerns"]:
                if self.resolve_concern:
                    quote = lines[0]["text"].strip()
                    diagnostics["findings"].append({"rule_id": "R-S01", "verdict": "supported", "source": {
                        "quote": quote, "start_line": lines[0]["number"], "end_line": lines[0]["number"]},
                        "target": None, "reason": "The original range was rechecked in this synthetic test.",
                        "recommendation": None, "question": None})
                    resolutions.append({"concern_id": concern["id"], "finding_index": len(diagnostics["findings"]) - 1,
                                        "reason": "Rechecked the previously incomplete literal source range."})
                else:
                    unresolved.append(concern["id"])
                    diagnostics["unread_ranges"].append("The initial concern remains unresolved in this fixture.")
        value = {"segment": {"index": segment["segment"]["index"], "sha256": segment["segment"]["sha256"],
                             "source_revision": segment["source_revision"]},
                 "submission": graph, "diagnostics": diagnostics, "resolutions": resolutions,
                 "unresolved_concerns": unresolved}
        return {"value": value, "execution": {"provider": "codex", "cli_version": "synthetic-test",
            "prompt_sha256": sha256(prompt.encode()).hexdigest(), "schema_sha256": sha256(canonical_json_bytes(schema)).hexdigest(),
            "output_sha256": sha256(canonical_json_bytes(value)).hexdigest()}}


class RetainedLimitAdapter(SyntheticAdapter):
    """전용 술어가 없는 방향을 실제 텍스트 속성으로 보존하는 구조 시험이다."""
    reason = "Direction is retained as a text attribute; no dedicated spatial predicate is available."

    def __init__(self, mode="retained"):
        super().__init__()
        self.mode = mode

    async def run(self, **kwargs):
        result = await super().run(**kwargs)
        data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1].split("\nDRAFT_REPAIR\n", 1)[0])
        info = data["manifest"]["segmented_input"]
        value = result["value"]
        if info["segment"]["index"] == 0:
            graph = value["submission"]
            quote = "Pump direction is toward."
            if not graph["attributes"]:
                graph["attributes"].append({"id": "direction", "subject": "pump", "property": "direction",
                    "datatype": "text", "value": "toward", "unit": None, "evidence": quote,
                    "qualifiers": {"polarity": "positive", "modality": "asserted", "condition": None,
                                   "scope": None, "time": None}})
            source = json.loads(data["components"]["data/context.json"])["documents"][0]["source"]
            line = next(item["number"] for item in source["window"]["lines"] if quote in item["text"])
            report = value["diagnostics"]
            report.update(omissions=[self.reason], unread_ranges=[], findings=[{
                "rule_id": "R-S10", "verdict": "schema_limit", "source": {
                    "quote": quote, "start_line": line, "end_line": line},
                "target": {"collection": "attributes", "index": 0}, "reason": self.reason,
                "recommendation": None, "question": None}])
            if self.mode == "unread_resolution" and info["phase"] == "extract":
                report["unread_ranges"] = ["A source range was not read."]
            if info["phase"] == "reconcile":
                initial = json.loads(data["components"]["data/initial-diagnostics.json"])
                value["resolutions"] = [{"concern_id": item["id"], "finding_index": 0,
                    "reason": "The actual direction text remains in the attribute; the representation limit remains reported."}
                    for item in initial["concerns"]]
                value["unresolved_concerns"] = []
                if self.mode == "unmatched":
                    report["omissions"].append("Some actual source content is missing.")
                elif self.mode == "null_target":
                    report["findings"][0]["target"] = None
                elif self.mode == "unread":
                    report["unread_ranges"] = ["The final pass did not read this range."]
                elif self.mode == "failed_rule":
                    report.update(schema_version=2, semantic_check=None, rule_results=[{
                        "rule_id": f"R-S{number:02d}", "status": "fail" if number == 10 else "not_run",
                        "reason": "Synthetic rule result retained without promotion.",
                        "finding_indices": [0] if number == 10 else []} for number in range(1, 11)])
        result["execution"]["output_sha256"] = sha256(canonical_json_bytes(value)).hexdigest()
        return result


class SegmentedWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = private_directory(Path(self.temp.name).resolve() / "job")
        self.source = "Pump.\n" + "Unrelated fixture words.\n" * 12
        self.captured = captured(self.source)
        self.fixed = {"bundle_revision": "f" * 64}
        self.executions, self.checks = [], 0
        original = inputs.plan
        self.patches = [patch.object(flow, "load_input", return_value=self.captured),
            patch("core.client.ai.draft_validation.load_input", return_value=self.captured),
            patch.object(inputs, "plan", side_effect=lambda source, **kwargs: original(source, window_bytes=100,
                                                                                      overlap_bytes=10, **kwargs))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def current(self):
        self.checks += 1

    async def execute(self, adapter, name="run1", **kwargs):
        run = private_directory(self.root / name)
        directory = private_directory(run / "extract_ontology")
        return await flow.run(fixed=self.fixed, directory=directory, job_directory=self.root, document="target.md",
            adapter=adapter, lease=Lease(), current=self.current, executions=self.executions,
            execution_config_sha256="a" * 64, input_view="full", rules_view="full",
            semantic_check=kwargs.get("semantic_check", False), timings=StageTimings())

    async def test_all_windows_reconcile_before_one_final_result_and_fresh_run_reuses(self):
        adapter = SyntheticAdapter()
        result = await self.execute(adapter)
        count = len(inputs.plan(self.source))
        self.assertEqual(adapter.calls, count * 2)
        self.assertEqual(len(result["payload"]["submission"]["entities"]), 1)
        self.assertGreaterEqual(self.checks, count * 4)
        self.captured["manifest"]["run_id"] = "c" * 32
        second = SyntheticAdapter()
        resumed = await self.execute(second, "run2")
        self.assertEqual(second.calls, 0)
        self.assertEqual(result, resumed)

    async def test_failure_retains_successful_segments_and_resumes_only_unfinished(self):
        first = SyntheticAdapter(fail_call=2)
        with self.assertRaises(AnalysisClientError):
            await self.execute(first)
        self.assertEqual(len(list((self.root / "segmented").rglob("extract-*.json"))), 1)
        second = SyntheticAdapter()
        await self.execute(second, "run2")
        self.assertEqual(second.calls, len(inputs.plan(self.source)) * 2 - 1)

    async def test_cancellation_retains_previously_completed_segment(self):
        class CancelAdapter(SyntheticAdapter):
            async def run(inner, **kwargs):
                if inner.calls == 1:
                    raise asyncio.CancelledError()
                return await super(CancelAdapter, inner).run(**kwargs)
        with self.assertRaises(asyncio.CancelledError):
            await self.execute(CancelAdapter())
        self.assertEqual(len(list((self.root / "segmented").rglob("extract-*.json"))), 1)
        resumed = SyntheticAdapter()
        await self.execute(resumed, "run2")
        self.assertEqual(resumed.calls, len(inputs.plan(self.source)) * 2 - 1)

    async def test_changed_access_invalidates_cache(self):
        await self.execute(SyntheticAdapter())
        self.captured["manifest"]["actor"]["access_revision"] = "d" * 64
        second = SyntheticAdapter()
        await self.execute(second, "run2")
        self.assertEqual(second.calls, len(inputs.plan(self.source)) * 2)

    async def test_reconciliation_cannot_rewrite_an_existing_fact(self):
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(SyntheticAdapter(rewrite=True))
        self.assertEqual(stopped.exception.code, "analysis_draft_repair_exhausted")
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))
        rejected = next((self.root / "segmented").rglob("rejected"))
        preserved = next(rejected.parent.glob("extract-*.json")).read_bytes()
        next_adapter = SyntheticAdapter()
        await self.execute(next_adapter, "run2")
        self.assertEqual(next_adapter.calls, len(inputs.plan(self.source)) * 2)
        self.assertEqual(next(rejected.parent.glob("extract-*.json")).read_bytes(), preserved)
        self.assertEqual(len(list((self.root / "segmented").rglob("generation-*"))), 2)

    async def test_cumulative_pass_reuses_existing_identity_without_automatic_label_merge(self):
        seen = []
        class IdentityAdapter(SyntheticAdapter):
            async def run(inner, **kwargs):
                data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1])
                info = data["manifest"]["segmented_input"]
                if info["phase"] == "extract" and info["segment"]["index"] > 0:
                    previous = json.loads(data["components"]["data/segmented-graph.json"])
                    seen.append(deepcopy(previous["entities"][0]))
                return await super(IdentityAdapter, inner).run(**kwargs)
        result = await self.execute(IdentityAdapter())
        self.assertTrue(seen)
        self.assertTrue(all(entity == result["payload"]["submission"]["entities"][0] for entity in seen))
        self.assertEqual(result["payload"]["submission"]["entities"][0]["id"], "pump")

    async def test_distinct_same_label_is_never_silently_merged_to_pass_existing_schema(self):
        class ConflictingAdapter(SyntheticAdapter):
            async def run(inner, **kwargs):
                result = await super(ConflictingAdapter, inner).run(**kwargs)
                data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1].split("\nDRAFT_REPAIR\n", 1)[0])
                info = data["manifest"]["segmented_input"]
                if info["phase"] == "extract" and info["segment"]["index"] == 0:
                    result["value"]["submission"]["entities"].append({"id": "another", "type": "physical_object",
                        "label": "Pump", "evidence": "Pump."})
                return result
        with self.assertRaises(AnalysisClientError):
            await self.execute(ConflictingAdapter())
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_global_graph_cap_does_not_truncate_a_large_model_result(self):
        class TooManyAdapter(SyntheticAdapter):
            async def run(inner, **kwargs):
                result = await super(TooManyAdapter, inner).run(**kwargs)
                result["value"]["submission"]["entities"] = [{"id": f"p{index}", "type": "physical_object",
                    "label": "Pump", "evidence": "Pump."} for index in range(101)]
                return result
        adapter = TooManyAdapter()
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(adapter)
        self.assertEqual(stopped.exception.code, "analysis_draft_repair_exhausted")
        self.assertEqual(adapter.calls, 3)
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_outside_evidence_fails_after_bounded_repair(self):
        adapter = SyntheticAdapter(bad_evidence=True)
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(adapter)
        self.assertEqual(stopped.exception.code, "analysis_draft_repair_exhausted")
        self.assertEqual(adapter.calls, 3)
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_incomplete_output_or_requested_separate_check_never_publishes(self):
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(SyntheticAdapter(incomplete=True))
        self.assertEqual(stopped.exception.code, "segmented_review_incomplete")
        adapter = SyntheticAdapter()
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(adapter, "run2", semantic_check=True)
        self.assertEqual(stopped.exception.code, "segmented_semantic_check_unavailable")
        self.assertEqual(adapter.calls, 0)

    async def test_initial_uncertainty_is_retained_and_explicitly_rechecked(self):
        result = await self.execute(SyntheticAdapter(initial_incomplete=True))
        self.assertEqual(result["payload"]["diagnostics"]["unread_ranges"], [])
        first = json.loads(next((self.root / "segmented").rglob("extract-000.json")).read_text())
        self.assertEqual(first["payload"]["diagnostics"]["unread_ranges"], ["Explicit fixture unread content"])
        second = json.loads(next((self.root / "segmented").rglob("reconcile-000.json")).read_text())
        self.assertEqual(second["payload"]["resolutions"][0]["concern_id"], "unread:0")
        self.assertEqual(second["payload"]["diagnostics"]["findings"][0]["verdict"], "supported")

    async def test_initial_concern_cannot_disappear_without_a_source_backed_resolution(self):
        adapter = SyntheticAdapter(initial_incomplete=True, resolve_concern=False)
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(adapter)
        self.assertEqual(stopped.exception.code, "segmented_review_incomplete")
        self.assertEqual(adapter.calls, len(inputs.plan(self.source)) + 1)
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_empty_or_gapped_final_review_stops_without_repair_coercion(self):
        for index, mode in enumerate(("empty", "gapped")):
            class UnreviewedAdapter(SyntheticAdapter):
                async def run(inner, **kwargs):
                    result = await super(UnreviewedAdapter, inner).run(**kwargs)
                    data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1])
                    if data["manifest"]["segmented_input"]["phase"] == "reconcile":
                        if mode == "empty":
                            result["value"]["diagnostics"] = empty_report()
                        else:
                            reviewed = result["value"]["diagnostics"]["reviewed_ranges"][0]
                            reviewed["end_line"] = reviewed["start_line"]
                    return result
            adapter = UnreviewedAdapter()
            with self.assertRaises(AnalysisClientError) as stopped:
                await self.execute(adapter, f"unreviewed{index}")
            self.assertEqual(stopped.exception.code, "segmented_review_incomplete")
            self.assertEqual(adapter.calls, len(inputs.plan(self.source)) + 1)
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    def use_retained_limit_source(self):
        self.source = "Pump.\nPump direction is toward.\n" + "Unrelated fixture words.\n" * 12
        self.captured.clear()
        self.captured.update(captured(self.source))

    async def test_retained_representation_limit_preserves_omission_finding_target_and_audit(self):
        self.use_retained_limit_source()
        result = await self.execute(RetainedLimitAdapter())
        report = result["payload"]["diagnostics"]
        self.assertEqual(report["omissions"], [RetainedLimitAdapter.reason])
        self.assertEqual(report["findings"][0]["reason"], report["omissions"][0])
        self.assertEqual(report["findings"][0]["verdict"], "schema_limit")
        self.assertEqual(report["findings"][0]["target"], {"collection": "attributes", "index": 0})
        self.assertEqual(result["payload"]["submission"]["attributes"][0]["value"], "toward")
        audit = json.loads(next(self.root.rglob("segmented-complete.json")).read_text())
        self.assertEqual(audit["schema_limit_count"], 1)
        self.assertEqual(audit["semantic_completeness"], "not_certified")
        self.assertFalse(audit["human_approval"])

    async def test_representation_limit_cannot_hide_unmatched_omission_null_target_unread_or_failed_rule(self):
        self.use_retained_limit_source()
        for mode in ("unmatched", "null_target", "unread", "failed_rule"):
            with self.subTest(mode=mode):
                with self.assertRaises(AnalysisClientError):
                    await self.execute(RetainedLimitAdapter(mode), mode)
                self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_unread_concern_cannot_be_resolved_by_a_representation_limit(self):
        self.use_retained_limit_source()
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(RetainedLimitAdapter("unread_resolution"))
        self.assertEqual(stopped.exception.code, "analysis_draft_repair_exhausted")
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_final_review_rejects_unrelated_entity_as_retained_omission(self):
        self.source = "Pump.\nWater must not be used.\n" + "Unrelated fixture words.\n" * 12
        self.captured.clear()
        self.captured.update(captured(self.source))
        class UnrelatedTargetAdapter(SyntheticAdapter):
            async def run(inner, **kwargs):
                result = await super(UnrelatedTargetAdapter, inner).run(**kwargs)
                data = json.loads(kwargs["prompt"].split("\nFIXED_INPUT_DATA\n", 1)[1].split("\nDRAFT_REPAIR\n", 1)[0])
                info = data["manifest"]["segmented_input"]
                if info["phase"] == "reconcile" and info["segment"]["index"] == 0:
                    report = result["value"]["diagnostics"]
                    reason = "The Water prohibition is purportedly retained on the Pump entity."
                    report.update(omissions=[reason], findings=[{"rule_id": "R-S10", "verdict": "schema_limit",
                        "source": {"quote": "Water must not be used.", "start_line": 2, "end_line": 2},
                        "target": {"collection": "entities", "index": 0}, "reason": reason,
                        "recommendation": None, "question": None}])
                return result
        adapter = UnrelatedTargetAdapter()
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(adapter)
        self.assertEqual(stopped.exception.code, "segmented_review_incomplete")
        self.assertEqual(adapter.calls, len(inputs.plan(self.source)) + 1)
        self.assertFalse(list(self.root.rglob("segmented-complete.json")))

    async def test_tampered_completed_payload_is_not_reused(self):
        await self.execute(SyntheticAdapter())
        path = next((self.root / "segmented").rglob("extract-000.json"))
        record = json.loads(path.read_text())
        record["payload"]["submission"]["entities"] = []
        path.write_text(json.dumps(record))
        second = SyntheticAdapter()
        with self.assertRaises(AnalysisClientError) as stopped:
            await self.execute(second, "run2")
        self.assertEqual(stopped.exception.code, "segmented_cache_mismatch")
        self.assertEqual(second.calls, 0)
        third = SyntheticAdapter()
        await self.execute(third, "run3")
        self.assertEqual(third.calls, len(inputs.plan(self.source)) * 2)


if __name__ == "__main__":
    unittest.main()
