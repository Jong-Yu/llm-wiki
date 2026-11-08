"""Exact locked impact captures retain validation, isolation and public results."""

from contextlib import contextmanager, nullcontext
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.store import DocumentSnapshot
from core.modules.knowledge import contracts
from core.modules.knowledge.impact import ImpactStore
from core.modules.ontology import connections, constants
from core.modules.ontology.validation import _graph
from core.modules.reviews import capture, render
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR, ENTITIES, RELATIONS


@contextmanager
def original_captures():
    def parsed(owner, document, source, graph_raw, ledger_raw, history_revision, *, machine=None):
        return owner._ledger(ledger_raw, document), None

    with patch.object(connections._ValidatedGraph, "capture", return_value=None), \
            patch.object(ReviewStore, "_captured_ledger", parsed):
        yield


class ImpactCaptureReuseTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document("a.md", body="A uses B.\nB depends on A.\n[Other](b.md)\n")
        self.document("b.md", body="A uses B.\nB depends on A.\n")
        for name in ("a.md", "b.md"):
            self.generate(name)
            self.accept(name)
        self.impact = ImpactStore(self.wiki)

    def baseline(self, name="a.md"):
        current = self.reviews.query(name)
        return {key: current[key] for key in contracts._BASELINE_FIELDS}

    def compare_original(self, **options):
        before = self.tree()
        with original_captures():
            expected = self.impact.query("a.md", **options)
        actual = self.impact.query("a.md", **options)
        self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))
        self.assertEqual(self.tree(), before)
        return actual

    def captured(self, name="a.md"):
        with self.wiki._write_lock():
            _, values = self.ontology._connections_snapshot_locked(name, capture_validated=True)
            source, raw = values["sources"][name], values["raw_graphs"][name]
            ledger_raw = self.reviews._read_bytes(name)
            history = self.reviews._history_revision(name)
            ledger, proof = self.reviews._captured_ledger(name, source, raw, ledger_raw, history,
                machine=values["validated_graphs"][name])
        return source, raw, ledger_raw, history, ledger, proof, values

    def test_same_dto_and_budgets_with_one_machine_and_ledger_validation_per_document(self):
        expected = self.compare_original()
        with patch.object(connections, "_query_snapshot", wraps=connections._query_snapshot) as machine, \
                patch.object(render, "_query_snapshot", wraps=render._query_snapshot) as repeated, \
                patch.object(self.impact.reviews, "_ledger", wraps=self.impact.reviews._ledger) as ledger, \
                patch.object(self.impact.reviews, "_render", wraps=self.impact.reviews._render) as renders, \
                patch.object(self.impact.reviews, "_validate_effective", wraps=self.impact.reviews._validate_effective) as effective:
            actual = self.impact.query("a.md")
        self.assertEqual(actual, expected)
        self.assertEqual(machine.call_count, 2)
        self.assertEqual(repeated.call_count, 0)
        self.assertEqual(ledger.call_count, 2)
        self.assertEqual(renders.call_count, 2)
        self.assertEqual(effective.call_count, 4)
        self.assertEqual(sum(call.kwargs.get("policies") is False for call in renders.call_args_list), 0)

    def test_policy_on_off_and_captured_graphs_do_not_share_mutable_results(self):
        current = self.reviews.query("a.md")
        replacement = _input(current["claims"][0]["value"])
        replacement.update(predicate="depends_on")
        replacement.pop("evidence"); replacement.pop("provenance")
        self.reviews.policy("a.md", claim_id=current["claims"][0]["claim_id"], replacement=replacement,
                            expected_state_revision=current["state_revision"], reason="isolated policy", actor=ACTOR)
        source, raw, ledger_raw, history, ledger, proof, captured = self.captured()
        with self.wiki._write_lock():
            first = self.reviews._query_captured("a.md", source, raw, ledger_raw, history, validated_capture=proof)
            expected = deepcopy(first)
            _, tokens = self.reviews._captured_state("a.md", source, raw, ledger_raw, history, validated_capture=proof)
            plain = self.reviews._render(source, raw, ledger, tokens, policies=False, machine_capture=proof.machine)
            self.assertEqual(first["effective_graph"]["relations"][0]["predicate"], "depends_on")
            self.assertEqual(plain["effective_graph"]["relations"][0]["predicate"], "uses")
            first["machine_graph"]["entities"][0]["label"] = "caller mutation"
            first["effective_graph"]["relations"][0]["predicate"] = "caller mutation"
            first["history"][0]["reason"] = "caller mutation"
            ledger["events"].clear()
            captured["graphs"]["a.md"]["entities"][0]["label"] = "captured mutation"
            second = self.reviews._query_captured("a.md", source, raw, ledger_raw, history, validated_capture=proof)
        self.assertEqual(second, expected)
        self.assertEqual(plain["machine_graph"]["entities"][0]["label"], "A")

    def test_each_exact_source_graph_ledger_history_root_and_document_key_is_required(self):
        source, raw, ledger_raw, history, _, proof, _ = self.captured()
        changes = [
            (DocumentSnapshot(source.content + "\n", source.revision), raw, ledger_raw, history),
            (DocumentSnapshot(source.content, "e" * 64), raw, ledger_raw, history),
            (source, raw + b"\n", ledger_raw, history),
            (source, raw, ledger_raw + b"\n", history),
            (source, raw, ledger_raw, "e" * 64),
        ]
        with self.wiki._write_lock():
            for changed_source, changed_raw, changed_ledger, changed_history in changes:
                with self.subTest(revision=changed_source.revision):
                    expected = self.reviews._query_captured("a.md", changed_source, changed_raw, changed_ledger, changed_history)
                    with patch.object(self.reviews, "_ledger", wraps=self.reviews._ledger) as checked, \
                            patch.object(render, "_query_snapshot", wraps=render._query_snapshot) as machine:
                        actual = self.reviews._query_captured("a.md", changed_source, changed_raw, changed_ledger,
                                                              changed_history, validated_capture=proof)
                    self.assertEqual(actual, expected)
                    self.assertEqual(checked.call_count, 1)
                    self.assertGreater(machine.call_count, 0)
        other_store = SimpleNamespace(data_dir=self.root / "another-root")
        self.assertIsNone(proof.machine.read(other_store, "a.md", source, raw))
        self.assertIsNone(proof.machine.read(self.wiki, "b.md", source, raw))
        self.assertFalse(proof.matches(SimpleNamespace(store=other_store), "a.md", source, raw, ledger_raw, history))

    def test_untrusted_missing_or_corrupt_proofs_use_the_original_validation(self):
        source, raw, ledger_raw, history, _, proof, _ = self.captured()
        with self.wiki._write_lock():
            expected = self.reviews._query_captured("a.md", source, raw, ledger_raw, history)
            malformed = replace(proof, encoded=b"{", digest="0" * 64)
            empty = replace(proof, encoded=b"{}", digest=sha256(b"{}").hexdigest())
            for candidate in ({"ledger": "unvalidated"}, object(), malformed, empty):
                with self.subTest(kind=type(candidate)), patch.object(self.reviews, "_ledger", wraps=self.reviews._ledger) as checked:
                    actual = self.reviews._query_captured("a.md", source, raw, ledger_raw, history, validated_capture=candidate)
                    self.assertEqual(actual, expected)
                self.assertEqual(checked.call_count, 1)
            invalid_graph = replace(proof.machine, encoded=b"{}", digest=sha256(b"{}").hexdigest())
            for machine in ({"status": "ready"}, invalid_graph):
                with patch.object(render, "_query_snapshot", wraps=render._query_snapshot) as checked:
                    actual = self.reviews._query_captured("a.md", source, raw, ledger_raw, history,
                                                          validated_capture=replace(proof, machine=machine))
                self.assertEqual(actual, expected)
            self.assertEqual(checked.call_count, 1)

    def test_proof_encoding_failure_does_not_change_a_successful_query(self):
        expected = self.impact.query("a.md")
        with patch.object(connections, "canonical_json_bytes", side_effect=UnicodeError("optional proof encoding")), \
                patch.object(capture, "canonical_json_bytes", side_effect=UnicodeError("optional proof encoding")):
            self.assertEqual(self.impact.query("a.md"), expected)

    def test_baseline_source_and_review_restoration_keep_full_refs_and_four_revisions(self):
        baseline = self.baseline()
        self.compare_original(baseline=baseline)
        old = self.wiki.read("a.md")
        saved = self.wiki.save("a.md", old.content.replace("[Other](b.md)\n", "Changed text.\n"), expected_revision=old.revision)
        result = self.compare_original(baseline=baseline)
        self.assertTrue(result["changes"]["source"])
        self.assertEqual(result["restoration"]["source"], "matching_archive")
        self.assertEqual(result["restoration"]["graph"], "validated_matching_cache")
        self.assertTrue(any(link["change"] == "removed" for link in result["explicit_links"]))
        self.assertEqual(saved.history_path.read_text(), old.content)

    def test_authored_relation_and_other_document_latest_source_are_revalidated(self):
        current = self.reviews.query("b.md")
        value = _input(current["machine_graph"]["relations"][0])
        value.update(subject="b", predicate="depends_on", object="a", evidence="B depends on A.")
        RelationStore(self.wiki, ACTOR).create("b.md", kind="source", replacement=value, request_id=uuid4().hex,
            expected_state_revision=current["state_revision"], reason="isolated authored source")
        with patch.object(self.impact.reviews, "_normalize", wraps=self.impact.reviews._normalize) as normalize:
            self.compare_original()
        # Both reference and optimized runs still check the current authored
        # source relation once in each policy-on/off projection.
        self.assertEqual(normalize.call_count, 2)
        baseline = self.baseline()
        old = self.wiki.read("b.md")
        latest = self.wiki.save("b.md", old.content + "Changed related source.\n", expected_revision=old.revision)
        result = self.compare_original(baseline=baseline)
        related = next(row for row in result["documents"] if row["document"] == "b.md")
        self.assertEqual(related["source_revision"], latest.revision)
        self.assertEqual(related["ontology_status"], "stale")
        self.assertTrue(related["needs_review"])

    def test_current_policy_and_other_scope_are_not_cached_between_queries(self):
        before = self.impact.query("a.md")
        current = self.reviews.query("b.md")
        value = _input(current["claims"][0]["value"])
        value["predicate"] = "depends_on"
        value.pop("evidence"); value.pop("provenance")
        self.reviews.policy("b.md", claim_id=current["claims"][0]["claim_id"], replacement=value,
            expected_state_revision=current["state_revision"], reason="new related policy", actor=ACTOR)
        own = self.compare_original()
        other = self.compare_original(viewpoint="business")
        old_state = next(row for row in before["documents"] if row["document"] == "b.md")
        own_state = next(row for row in own["documents"] if row["document"] == "b.md")
        self.assertNotEqual(old_state["review_revision"], own_state["review_revision"])
        self.assertEqual(other["selection"]["viewpoint"], "business")

    def test_missing_stale_and_corrupt_components_keep_status_errors_and_counters(self):
        path = self.ontology._path("b.md")
        held = self.root / "held-graph.json"
        path.rename(held)
        self.compare_original()
        held.rename(path)
        source = self.wiki.read("b.md")
        self.wiki.save("b.md", source.content + "new source\n", expected_revision=source.revision)
        self.compare_original()
        raw = path.read_bytes()
        path.write_bytes(b"{")
        self.compare_original()
        path.write_bytes(raw)
        ledger = self.reviews._path("b.md")
        ledger.write_bytes(b"{")
        self.compare_original()

    def test_legacy_v1_and_current_v6_keep_their_original_status_and_evidence(self):
        source = self.document("legacy.md", body="A uses B.\n[Root](a.md)\n", plain=True)
        graph = _graph("legacy.md", source.revision, ENTITIES, RELATIONS, source.content, schema_version=1)
        old = self.root / "_ontology" / (sha256(b"legacy.md").hexdigest() + ".json")
        old.parent.mkdir(exist_ok=True)
        old.write_bytes(canonical_json_bytes(graph))
        self.document("v6.md", body="A uses B.\n[Root](a.md)\n")
        self.generate("v6.md", schema_version=6)
        result = self.compare_original()
        self.assertEqual(result["scanned"], 4)
        self.assertTrue(any(row["document"] == "legacy.md" for row in result["documents"]))
        self.assertEqual(self.ontology.query("v6.md")["schema_version"], 6)

    def test_document_byte_entry_and_output_budgets_match_the_original_exactly(self):
        for name, value in (("MAX_CONNECTION_DOCUMENTS", 1), ("MAX_CONNECTION_BYTES", 4000),
                            ("MAX_CONNECTION_SCAN_ENTRIES", 2)):
            with self.subTest(limit=name), patch.object(constants, name, value), patch.object(contracts, name, value):
                self.compare_original(limit=1)
        with patch.object(contracts, "MAX_IMPACT_OUTPUT_BYTES", 2500):
            before = self.tree()
            errors = []
            for original in (True, False):
                context = original_captures() if original else nullcontext()
                with context:
                    try:
                        result = self.impact.query("a.md", limit=1)
                    except ValueError as error:
                        errors.append((type(error), str(error)))
                    else:
                        errors.append(canonical_json_bytes(result))
            self.assertEqual(errors[0], errors[1])
            self.assertEqual(self.tree(), before)

    def test_original_ledger_failure_is_not_hidden_by_a_captured_graph(self):
        original = self.impact.reviews._ledger

        def fail(raw, document):
            if document == "b.md":
                raise ReviewCorruptError("isolated ledger failure")
            return original(raw, document)

        with patch.object(self.impact.reviews, "_ledger", side_effect=fail):
            result = self.compare_original()
        self.assertTrue(any(item["document"] == "b.md" and item["component"] == "review" for item in result["skipped"]))


if __name__ == "__main__":
    unittest.main()
