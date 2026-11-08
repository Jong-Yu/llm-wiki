"""SDK 전처리 전의 누락·명시 null·원래 타입·첫 오류 순서를 확인한다."""

import json
from unittest import TestCase

from core.mcp.validation import validate_raw_arguments

REVISION = "a" * 64


class RawValidationTests(TestCase):
    def accepted(self, name, arguments):
        self.assertIsNone(validate_raw_arguments(name, arguments))

    def rejected(self, name, arguments, message):
        result = validate_raw_arguments(name, arguments)
        self.assertIsNotNone(result)
        self.assertEqual(result.structured_content, {"ok": False, "error": {
            "code": "invalid_argument", "message": message, "retryable": False}})
        self.assertEqual(json.loads(result.content[0].text), result.structured_content)
        self.assertTrue(result.is_error)

    def test_wiki_revision_preserves_absent_null_and_literal_string_distinction(self):
        for value in ({}, {"expected_revision": None}, {"expected_revision": REVISION}):
            self.accepted("wiki_write", value)
        for value in ("null", "[]", [], {}, True, "A" * 64, "a" * 63):
            self.rejected("wiki_write", {"expected_revision": value},
                "expected_revision must be JSON null or the 64-character SHA-256 from wiki_read.")

    def test_generation_state_is_nullable_but_source_revision_and_schema_are_strict(self):
        for state in (None, REVISION):
            for version in (3, 4, 5, 6):
                self.accepted("ontology_generate", {"expected_revision": REVISION,
                    "expected_state_revision": state, "schema_version": version})
        for value in (None, "null", True, 3.0, "3", 2, 7):
            self.rejected("ontology_generate", {"expected_revision": REVISION, "schema_version": value},
                "schema_version must be the JSON integer 3, 4, 5 or 6.")
        self.rejected("ontology_generate", {}, "expected_revision must be the 64-character SHA-256 from wiki_read.")

    def test_review_and_policy_keep_different_replacement_null_contracts(self):
        self.accepted("ontology_review", {"expected_state_revision": REVISION, "replacement": None})
        self.accepted("ontology_policy", {"expected_state_revision": REVISION})
        self.accepted("ontology_policy", {"expected_state_revision": REVISION, "replacement": {}, "entities": None})
        self.rejected("ontology_policy", {"expected_state_revision": REVISION, "replacement": None},
            "replacement must be a complete JSON claim object, not encoded JSON text.")
        self.rejected("ontology_review", {"replacement": {}},
            "expected_state_revision must be the SHA-256 from ontology_review_query.")

    def test_collections_check_all_element_types_before_nested_qualifiers(self):
        for field in ("entities", "relations", "relation_candidates", "attributes"):
            for value in (None, "[]", {}, [None], ["{}"]):
                self.rejected("ontology_generate", {"expected_revision": REVISION, field: value},
                    "Ontology collections must be JSON arrays of objects.")
        self.accepted("ontology_generate", {"expected_revision": REVISION, "relations": [{"qualifiers": {}}]})
        self.rejected("ontology_generate", {"expected_revision": REVISION, "relations": [{"qualifiers": None}],
            "attributes": "[]"}, "Ontology collections must be JSON arrays of objects.")
        self.rejected("ontology_generate", {"expected_revision": REVISION, "relations": [{"qualifiers": None}]},
            "qualifiers must be a JSON object, not encoded JSON text or null.")

    def test_filter_strings_remain_literal_and_documents_are_not_encoded_json(self):
        for name in ("ontology_query", "ontology_context", "ontology_review_query", "ontology_impact"):
            self.accepted(name, {"domain": "null", "viewpoint": "[]"})
            self.rejected(name, {"domain": None}, "Ontology filters must be strings; omit a filter to leave it unset.")
        self.accepted("ontology_context", {"documents": []})
        self.rejected("ontology_context", {"documents": "[]"},
            "documents must be a JSON array of relative Markdown paths.")

    def test_impact_baseline_has_exact_fields_and_only_graph_review_can_be_null(self):
        valid = {"source_revision": REVISION, "graph_revision": None,
                 "review_revision": None, "history_revision": REVISION}
        self.accepted("ontology_impact", {"baseline": valid})
        self.accepted("ontology_impact", {"baseline": None})
        for value in ({**valid, "source_revision": None}, {**valid, "history_revision": None},
                      {**valid, "extra": None}, {"source_revision": REVISION}, "{}"):
            self.rejected("ontology_impact", {"baseline": value},
                "baseline must contain exactly source_revision, graph_revision, review_revision and history_revision SHA-256 values; only graph/review revisions may be null.")

    def test_first_error_order_is_response_mode_state_schema_source_then_collections(self):
        self.rejected("ontology_review", {"response_mode": None, "replacement": "{}"},
            "response_mode must be full or compact.")
        self.rejected("ontology_review", {"response_mode": "compact", "replacement": "{}"},
            "expected_state_revision must be the SHA-256 from ontology_review_query.")
        self.rejected("ontology_generate", {"expected_state_revision": "null", "schema_version": True},
            "expected_state_revision must be the SHA-256 from ontology_review_query.")
        self.rejected("ontology_generate", {"schema_version": True},
            "schema_version must be the JSON integer 3, 4, 5 or 6.")
        self.rejected("ontology_generate", {"entities": "[]"},
            "expected_revision must be the 64-character SHA-256 from wiki_read.")

    def test_raw_guard_does_not_apply_other_tools_field_rules(self):
        for name in ("unknown_tool", "wiki_read", "ontology_connections", "access_context"):
            self.accepted(name, {"expected_revision": "null", "schema_version": True, "domain": None,
                                 "documents": "[]", "response_mode": None})
