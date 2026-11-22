"""Derived line numbers preserve exact fixed input and disappear wholly at the budget."""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from core.client.ai import assembly, draft_validation
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results import diagnostics
from core.modules.analysis_results.contracts import ResultError
from core.modules.documents.metadata import parse_document
from core.modules.ontology.anchors import normalize_anchor


class SourceLineReferenceTests(unittest.TestCase):
    def setUp(self):
        self.source = '---\r\n한국어 😀\n\n마지막 줄'
        revision = sha256(self.source.encode()).hexdigest()
        self.fixed = {'bundle_id': 'a' * 32, 'bundle_revision': 'b' * 64, 'ruleset_ref': {'ruleset_id': 'test'}}
        self.manifest = {'stage': 'extract_ontology', 'target_document': 'target.md',
            'dependency': {'documents': [{'document': 'target.md', 'source_revision': revision}]}}
        components = {'data/context.json': json.dumps({'documents': [
            {'document': 'target.md', 'source': {'document': 'target.md', 'revision': revision,
                'content': self.source, 'body_start_line': 2}},
            {'document': 'other.md', 'source': {'content': 'Other context must not become target line data.'}}]}),
            'rules/submission.schema.json': '{"type":"object"}',
            'rules/diagnostics.schema.json': '{"type":"object"}'}
        self.captured = {'manifest': self.manifest, 'components': components, 'ruleset': {
            'manifest_text': '{}', 'components': {name.removeprefix('rules/'): {'content': value}
                for name, value in components.items() if name.startswith('rules/')}}}

    def assemble(self):
        with patch.object(assembly, 'load_input', return_value=self.captured):
            return assembly.assemble_input(self.fixed, Path('.'), stage='extract_ontology', target_document='target.md')

    def set_source(self, content, body_start=1):
        self.source = content
        revision = sha256(content.encode()).hexdigest()
        self.manifest['dependency']['documents'][0]['source_revision'] = revision
        context = json.loads(self.captured['components']['data/context.json'])
        context['documents'][0]['source'].update(content=content, revision=revision, body_start_line=body_start)
        self.captured['components']['data/context.json'] = json.dumps(context)

    def reference(self):
        prompt = self.assemble()['prompt']
        return json.loads(prompt.split('\nSOURCE_LINE_REFERENCE\n', 1)[1].split('\nPUBLISHED_RULES\n', 1)[0])

    def check_quote(self, quote, start, end, diagnostic_start, diagnostic_end):
        anchor = {'kind': 'source_anchor', 'document': 'target.md',
            'source_revision': sha256(self.source.encode()).hexdigest(), 'quote': quote,
            'start_line': start, 'end_line': end, 'occurrence': 0}
        self.assertEqual(normalize_anchor(anchor, source=self.source, evidence=quote), anchor)
        report = diagnostics.empty_report()
        report.update(reviewer_kind='ai_self_check', reviewed_ranges=[{
            'start_line': diagnostic_start, 'end_line': diagnostic_end}], findings=[{
                'rule_id': 'R-S01', 'verdict': 'supported', 'source': {
                    'start_line': diagnostic_start, 'end_line': diagnostic_end, 'quote': quote},
                'target': None, 'reason': 'Exact fixture quote.', 'recommendation': None, 'question': None}])
        diagnostics.validate(report, self.manifest, self.captured['components'], {'document': 'target.md'})
        return anchor, report

    def test_exact_reconstruction_source_only_and_original_bundle_unchanged(self):
        before = deepcopy(self.captured)
        result = self.assemble()
        view = json.loads(result['prompt'].split('\nSOURCE_LINE_REFERENCE\n', 1)[1].split('\nPUBLISHED_RULES\n', 1)[0])
        self.assertEqual(view['document'], 'target.md')
        self.assertEqual([row['number'] for row in view['lines']], [1, 2, 3, 4])
        self.assertEqual([row['text'] for row in view['lines']], ['---\r\n', '한국어 😀\n', '\n', '마지막 줄'])
        self.assertEqual(''.join(row['text'] for row in view['lines']), self.source)
        self.assertEqual(sha256(self.source.encode()).hexdigest(), view['source_revision'])
        self.assertEqual(view['body_start_line'], 2)
        self.assertNotIn('source_anchor_body_start_line', view)
        self.assertTrue(all('source_anchor_line' not in row for row in view['lines']))
        self.assertEqual(result['assembly']['source_line_reference']['sha256'], sha256(canonical_json_bytes(view)).hexdigest())
        self.assertEqual(self.captured, before)
        fixed_raw = result['prompt'].split('\nFIXED_INPUT_DATA\n', 1)[1]
        expected = {'manifest': self.manifest, 'components': {'data/context.json': self.captured['components']['data/context.json']}}
        self.assertEqual(fixed_raw, canonical_json_bytes(expected).decode())

    def test_each_line_separator_preserves_both_existing_validator_contracts(self):
        for separator in ('\r\n', '\r', '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029'):
            with self.subTest(separator=repr(separator)):
                self.set_source('first' + separator + 'second')
                before = deepcopy(self.captured)
                view = self.reference()
                row = view['lines'][1]
                expected = 2 if separator in ('\r\n', '\r', '\n') else 1
                self.assertEqual(row.get('source_anchor_line', row['number']), expected)
                self.assertEqual(row['number'], 2)
                self.assertEqual(''.join(item['text'] for item in view['lines']), self.source)
                anchor, report = self.check_quote('second', expected, expected, 2, 2)
                if expected != 2:
                    with self.assertRaises(ValueError):
                        normalize_anchor({**anchor, 'start_line': 2, 'end_line': 2}, source=self.source, evidence='second')
                    report['findings'][0]['source'].update(start_line=1, end_line=1)
                    with self.assertRaises(ResultError):
                        diagnostics.validate(report, self.manifest, self.captured['components'], {'document': 'target.md'})
                self.assertEqual(self.captured, before)

    def test_multiline_quote_uses_first_and_last_character_coordinates(self):
        self.set_source('head\fsecond\r\nthird\vend')
        view = self.reference()
        self.assertEqual([row.get('source_anchor_line', row['number']) for row in view['lines']], [1, 1, 2, 2])
        self.check_quote('second\r\nthird\v', 1, 2, 2, 3)

    def test_front_matter_body_coordinate_is_derived_from_its_character_offset(self):
        for body in ('본문', ''):
            with self.subTest(body=body):
                source = ('---\nschema_version: 1\ndocument_id: "' + 'a' * 32
                          + '"\ntags: []\ntitle: "first\u2028second"\n---\n' + body)
                parsed = parse_document(source)
                self.set_source(source, parsed.body_start_line)
                view = self.reference()
                self.assertEqual(view['body_start_line'], 8)
                self.assertEqual(view['source_anchor_body_start_line'], 7)
                if body:
                    self.check_quote(body, 7, 7, 8, 8)

    def test_empty_source_is_preserved(self):
        self.set_source('')
        view = self.reference()
        self.assertEqual(view['lines'], [])
        self.assertEqual(view['body_start_line'], 1)
        self.assertNotIn('source_anchor_body_start_line', view)

    def test_whole_reference_is_omitted_when_only_base_prompt_fits(self):
        included = self.assemble()
        start = included['prompt'].index('\nSOURCE_LINE_REFERENCE\n')
        end = included['prompt'].index('\nPUBLISHED_RULES\n')
        base = included['prompt'][:start] + included['prompt'][end:]
        with patch.object(assembly, 'MAX_INPUT_BYTES', len(base.encode())):
            omitted = self.assemble()
        self.assertEqual(omitted['prompt'], base)
        self.assertNotIn('\nSOURCE_LINE_REFERENCE\n', omitted['prompt'])
        metadata = omitted['assembly']['source_line_reference']
        self.assertEqual(metadata['status'], 'omitted_prompt_budget')
        self.assertTrue(metadata['full_source_preserved'])
        self.assertEqual(metadata['sha256'], included['assembly']['source_line_reference']['sha256'])
        self.assertEqual(omitted['prompt'].split('\nFIXED_INPUT_DATA\n', 1)[1],
                         included['prompt'].split('\nFIXED_INPUT_DATA\n', 1)[1])

    def test_base_prompt_over_budget_still_stops_without_truncation(self):
        included = self.assemble()
        limit = included['assembly']['source_line_reference']['base_prompt_utf8_bytes'] - 1
        with patch.object(assembly, 'MAX_INPUT_BYTES', limit):
            with self.assertRaises(AnalysisClientError) as caught:
                self.assemble()
        self.assertEqual(caught.exception.code, 'analysis_prompt_limit')

    def test_configuration_changes_when_reference_policy_changes(self):
        before = draft_validation.configuration()
        with patch.object(assembly, 'SOURCE_LINE_REFERENCE_POLICY', 'changed-line-policy'):
            after = draft_validation.configuration()
        self.assertNotEqual(before['source_line_reference'], after['source_line_reference'])


if __name__ == '__main__':
    unittest.main()
