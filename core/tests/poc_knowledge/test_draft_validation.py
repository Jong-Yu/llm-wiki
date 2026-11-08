"""Pure draft checks and publication guards against isolated documents only."""

from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.metadata import parse_document, render_document
from core.modules.documents.store import WikiStore, RevisionConflictError
from core.modules.ontology import constants, draft
from core.modules.ontology.store import OntologyStore
from core.modules.ontology.validation import _graph
from core.modules.reviews.contracts import ReviewConflictError
from core.modules.reviews.store import ReviewStore
from core.runtime.extraction_schema import build_submission_schema
from core.tests.poc_knowledge.test_storage import ACTOR


BODY = "A uses B.\n"


def submission(version=3):
    return {"schema_version": version,
            "entities": [{"id": char.lower(), "type": "system", "label": char, "evidence": BODY.strip()} for char in "AB"],
            "relations": [{"subject": "a", "predicate": "uses", "object": "b", "evidence": BODY.strip(),
                           "qualifiers": dict(constants._QUALIFIER_DEFAULTS)}],
            "relation_candidates": [], "attributes": []}


class DraftValidationTests(unittest.TestCase):
    def check(self, value=None, source=BODY, **kwargs):
        return draft.validate_draft(source, submission() if value is None else value, document="a.md",
            expected_revision=kwargs.pop("expected_revision", sha256(source.encode()).hexdigest()),
            schema=kwargs.pop("schema", build_submission_schema()), **kwargs)

    def test_versions_pass_original_schema_and_graph_without_mutating_inputs(self):
        for version in (3, 4, 5, 6):
            with self.subTest(version=version):
                value, schema = submission(version), build_submission_schema()
                before = (deepcopy(value), deepcopy(schema))
                result = self.check(value, schema=schema)
                self.assertTrue(result["passed"], result)
                self.assertFalse(result["repairable"])
                self.assertFalse(result["save_authorized"])
                self.assertEqual(result["semantic_validation"], "not_performed")
                self.assertEqual(result["version"], draft.DRAFT_VALIDATION_VERSION)
                self.assertEqual((value, schema), before)

    def test_source_binding_failure_is_not_repairable(self):
        result = self.check(expected_revision="0" * 64)
        self.assertFalse(result["passed"])
        self.assertFalse(result["repairable"])
        self.assertEqual(result["source_revision"], sha256(BODY.encode()).hexdigest())
        self.assertEqual(result["errors"][0]["code"], "source_revision_mismatch")

    def test_invalid_evidence_and_dependent_references_are_distinct(self):
        value = submission()
        value["entities"][0]["evidence"] = "A is missing."
        result = self.check(value)
        self.assertTrue(result["repairable"], result)
        by_path = {error["path"]: error for error in result["errors"]}
        self.assertEqual(by_path["/entities/0"]["kind"], "first_failure")
        self.assertEqual(by_path["/relations/0"]["kind"], "dependent")
        self.assertEqual(by_path["/relations/0"]["blocked_by"], ["/entities/0"])
        self.assertEqual(result["item_diagnostics"]["uninspected_items"], 0)

    def test_missing_endpoint_is_independent_error(self):
        value = submission()
        value["relations"][0]["object"] = "missing"
        result = self.check(value)
        self.assertTrue(result["repairable"])
        self.assertEqual(result["errors"][0]["path"], "/relations/0")
        self.assertEqual(result["errors"][0]["code"], "item_validation")

    def test_schema_failure_cannot_be_overridden_by_successful_core_items(self):
        value = submission()
        del value["relations"][0]["qualifiers"]  # Core defaults this; original schema requires it.
        result = self.check(value)
        self.assertFalse(result["passed"])
        self.assertTrue(result["repairable"], result)
        self.assertEqual(result["full_validation"]["core_graph"]["status"], "passed")
        self.assertEqual(result["full_validation"]["schema"]["status"], "failed")
        self.assertEqual(result["errors"][0]["path"], "/relations/0")
        schema = build_submission_schema()
        schema["required"].append("extra_constraint")
        self.assertFalse(self.check(schema=schema)["passed"])

    def test_bounded_schema_details_point_to_bad_predicate(self):
        value = submission()
        value["relations"][0]["predicate"] = "unsupported"
        result = self.check(value)
        self.assertTrue(result["repairable"], result)
        self.assertIn("/relations/0/predicate", [error["path"] for error in result["errors"]])

    def test_duplicate_relation_and_candidate_share_claim_validation(self):
        value = submission()
        value["relation_candidates"] = [{**deepcopy(value["relations"][0]), "id": "c", "reason": "Check", "question": "Is this so?"}]
        result = self.check(value)
        self.assertTrue(result["repairable"], result)
        self.assertEqual(result["errors"][0]["path"], "/relation_candidates/0")
        self.assertIn("duplicate", result["errors"][0]["message"])

    def test_metadata_evidence_is_rejected_and_full_file_anchor_lines_preserved(self):
        source = render_document(BODY, title="MetadataOnly")
        value = submission(4)
        parsed = parse_document(source)
        value["relations"][0]["object"] = {
            "kind": "source_anchor", "document": "a.md", "source_revision": sha256(source.encode()).hexdigest(),
            "quote": "B", "start_line": parsed.body_start_line, "end_line": parsed.body_start_line, "occurrence": 0,
        }
        result = self.check(value, source)
        self.assertTrue(result["passed"], result)
        self.assertEqual(result["full_validation"]["core_graph"]["body_start_line"], parsed.body_start_line)
        value["relations"][0]["object"]["start_line"] = 1
        value["relations"][0]["object"]["end_line"] = 1
        self.assertFalse(self.check(value, source)["passed"])
        value = submission()
        value["entities"][0].update(label="MetadataOnly", evidence="MetadataOnly")
        self.assertFalse(self.check(value, source)["passed"])

    def test_final_bytes_include_metadata_and_generation_identity(self):
        source = render_document(BODY, title="A")
        value = submission()
        revision = sha256(source.encode()).hexdigest()
        graph = _graph("a.md", revision, value["entities"], value["relations"], source,
                       value["relation_candidates"], attributes=value["attributes"], schema_version=3, body_only=True)
        parsed = parse_document(source)
        graph.update(document_id=parsed.document_id, body_revision=parsed.body_revision,
                     body_start_line=parsed.body_start_line, evidence_coordinates="full_file", generation_id="0" * 32)
        expected_size = len(canonical_json_bytes(graph, allow_nan=True))
        self.assertEqual(self.check(value, source)["full_validation"]["core_graph"]["graph_bytes_with_generation_id"], expected_size)
        with patch.object(constants, "MAX_ONTOLOGY_BYTES", expected_size - 1):
            result = self.check(value, source)
        self.assertFalse(result["passed"])
        self.assertIn("1 MiB", result["errors"][0]["message"])

    def test_error_limit_preserves_uninspected_count_and_disables_repair(self):
        value = submission()
        for entity in value["entities"]:
            entity["evidence"] += " missing"
        result = self.check(value, max_errors=1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["repairable"])
        self.assertEqual(result["item_diagnostics"]["uninspected_items"], 2)

    def test_json_depth_nodes_size_cycles_and_non_json_are_rejected(self):
        cycle = {}; cycle["self"] = cycle
        deep = {}; cursor = deep
        for _ in range(draft.MAX_INPUT_DEPTH + 1):
            cursor["child"] = {}; cursor = cursor["child"]
        for value in (cycle, deep, {"x": [None] * (draft.MAX_INPUT_NODES + 1)},
                      {"x": "x" * (draft.MAX_SUBMISSION_BYTES + 1)}, {"x": object()}, {"x": float("nan")}):
            with self.subTest(kind=str(type(value))):
                result = self.check(value)
                self.assertFalse(result["passed"])
                self.assertFalse(result["repairable"])

    def test_source_and_work_limits_do_not_promise_complete_validation(self):
        result = self.check(source="x" * (draft.MAX_DOCUMENT_BYTES + 1))
        self.assertFalse(result["repairable"])
        with patch.object(draft, "MAX_SOURCE_SCAN_WORK", 1):
            result = self.check()
        self.assertEqual(result["full_validation"]["status"], "incomplete")
        self.assertTrue(result["truncated"])
        self.assertFalse(result["repairable"])
        with patch.object(draft, "MAX_SCHEMA_STEPS", 1):
            result = self.check()
        self.assertFalse(result["repairable"])
        self.assertEqual(result["errors"][0]["code"], "work_limit")

    def test_collection_resource_limit_is_not_an_automatic_repair(self):
        value = submission()
        value["entities"] = [deepcopy(value["entities"][0]) for _ in range(constants.MAX_ENTITIES + 1)]
        result = self.check(value)
        self.assertFalse(result["repairable"])
        self.assertEqual(result["errors"][0]["code"], "input_limit")
        self.assertEqual(result["item_diagnostics"]["uninspected_items"], constants.MAX_ENTITIES + 2)

    def test_schema_contract_cannot_fetch_remote_or_recurse_unbounded(self):
        overrides = ({"$ref": "https://example.invalid/schema"},
                     {"$dynamicRef": "https://example.invalid/schema"},
                     {"$ref": "#/$defs/loop", "$defs": {"loop": {"$ref": "#/$defs/loop"}}},
                     {"$ref": "#/$defs/missing"})
        for override in overrides:
            schema = build_submission_schema()
            schema.update(override)
            result = self.check(schema=schema)
            self.assertFalse(result["passed"])
            self.assertFalse(result["repairable"])


class DraftStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.wiki = WikiStore(self.root)
        # Raw isolated source avoids creating a write lock before the read check.
        self.wiki.wiki_dir.mkdir(parents=True, exist_ok=True)
        (self.wiki.wiki_dir / "a.md").write_text(render_document(BODY, title="A"))
        self.ontology = OntologyStore(self.wiki)
        self.source = self.wiki.read("a.md")

    def tree(self):
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def validate(self, **kwargs):
        return self.ontology.validate_draft("a.md", self.source.revision, submission(), schema=build_submission_schema(), **kwargs)

    def generate(self, revision=None, **kwargs):
        value = submission()
        return self.ontology.generate("a.md", revision or self.source.revision, value["entities"], value["relations"], **kwargs)

    def test_validation_pass_failure_and_revision_mismatch_never_write_or_lock(self):
        before = self.tree()
        with patch.object(self.wiki, "_write_lock", side_effect=AssertionError("draft must not lock")):
            self.assertTrue(self.validate()["passed"])
            value = submission(); value["relations"][0]["object"] = "missing"
            self.assertFalse(self.ontology.validate_draft("a.md", self.source.revision, value, schema=build_submission_schema())["passed"])
            self.assertFalse(self.ontology.validate_draft("a.md", "0" * 64, submission(), schema=build_submission_schema())["repairable"])
        self.assertEqual(self.tree(), before)
        self.assertFalse(any(".lock" in path.name for path in self.root.rglob("*")))

    def test_pass_then_body_or_metadata_edit_still_fails_source_cas(self):
        for changed in (self.source.content + "Later.\n", self.source.content.replace('title: "A"', 'title: "Renamed"')):
            with self.subTest(change=changed[-20:]):
                self.assertTrue(self.validate()["passed"])
                self.wiki.save("a.md", changed, expected_revision=self.source.revision)
                before = self.tree()
                with self.assertRaises(RevisionConflictError):
                    self.generate()
                self.assertEqual(self.tree(), before)
                self.source = self.wiki.read("a.md")

    def test_pass_then_review_change_still_fails_review_cas(self):
        self.generate()
        reviews = ReviewStore(self.wiki)
        snapshot = reviews.query("a.md")
        self.assertTrue(self.validate()["passed"])
        reviews.review("a.md", action="accept", claim_id=snapshot["claims"][0]["claim_id"],
                       expected_state_revision=snapshot["state_revision"], reason="isolated test", actor=ACTOR)
        before = self.tree()
        with self.assertRaises(ReviewConflictError):
            self.generate(expected_state_revision=snapshot["state_revision"])
        self.assertEqual(self.tree(), before)
