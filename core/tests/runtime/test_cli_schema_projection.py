"""실제 provider 거부를 재현한 스키마 형태만 투영한다. 의미 프롬프트는 다루지 않는다."""
from copy import deepcopy
import unittest
from jsonschema import Draft202012Validator
from core.client.ai.codex import _strict_schema
from core.client.ai.assembly import _envelope
from core.modules.extraction_rules.content import diagnostics_schema
from core.modules.analysis_results.diagnostics import empty_report
from core.runtime.extraction_schema import build_submission_schema


class CliSchemaProjectionTests(unittest.TestCase):
    def test_diagnostics_union_has_no_empty_object_and_preserves_published_schema(self):
        for stage,value_schema in [('prepare_wiki',{'type':'string'}), ('extract_ontology',build_submission_schema())]:
            published = _envelope(value_schema,diagnostics_schema(),stage)
            before = deepcopy(published)
            projected = _strict_schema(published)
            self.assertEqual(published,before)
            diagnostic=projected['properties']['diagnostics']
            self.assertNotIn('type',diagnostic)
            self.assertEqual(diagnostic['anyOf'],before['properties']['diagnostics']['anyOf'])
            self.assertNotIn('properties',diagnostic)
            Draft202012Validator.check_schema(projected)
            def inspect(node):
                if isinstance(node,dict):
                    if node.get('type')=='object':
                        self.assertIn('properties',node)
                        self.assertFalse(node['additionalProperties'])
                        self.assertEqual(set(node['required']),set(node['properties']))
                    for child in node.values():inspect(child)
                elif isinstance(node,list):
                    for child in node:inspect(child)
            inspect(projected)
            if stage=='prepare_wiki':
                valid={'content':'fixture','diagnostics':empty_report()}
                self.assertTrue(Draft202012Validator(projected).is_valid(valid))
                self.assertFalse(Draft202012Validator(projected).is_valid({'content':'fixture','diagnostics':{}}))

    def test_unknown_or_nonobject_union_does_not_silently_widen(self):
        for branch in [{'type':'string'},{'$ref':'#/missing'},{'$ref':'https://invalid.example/schema'}]:
            original={'type':'object','anyOf':[branch]}
            self.assertEqual(_strict_schema(original),original)


if __name__=='__main__':unittest.main()
