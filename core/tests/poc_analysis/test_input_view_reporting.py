"""격리 MCP 흐름의 이력 생략/실제 미독 구분. 합성 응답이며 모델 정확도 평가가 아니다."""
from copy import deepcopy
from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from core.client.ai import assembly, input_view, observations, workflow
from core.client.inputs import load_input
from core.client.transport import client_error_code
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.runtime.client_platform import private_directory, write_new
from core.tests.poc_analysis import test_draft_workflow as fixtures


class ReportingAdapter(fixtures.DraftAdapter):
    def __init__(self, *, unread=False):
        super().__init__()
        self.unread = unread

    async def run(self, *, prompt, schema, output_schema, directory):
        self.calls += 1
        self.prompts.append(prompt)
        private_directory(directory, exist_ok=False)
        report = empty_report()
        data = json.loads(prompt.split('\nFIXED_INPUT_DATA\n', 1)[1])
        selected = data['manifest']['model_input_view']
        assert any(row['omitted_history_event_ids'] for row in selected['documents'])
        report['warnings'] = ['명시 입력 보기에서 과거 검토 이벤트 일부가 제외됨. 전체 이력을 검토하지 않음.']
        if self.unread:
            report['unread_ranges'] = ['대상 본문 2행 확인 미완료']
        value = dict(submission=dict(schema_version=3, entities=[dict(id='pump', type='physical_object',
            label='pump', evidence='A pump moves water.')], relations=[], relation_candidates=[], attributes=[]),
            diagnostics=report)
        execution = dict(provider='codex', cli_version='synthetic-draft-test',
            prompt_sha256=sha256(prompt.encode()).hexdigest(), schema_sha256=sha256(canonical_json_bytes(schema)).hexdigest(),
            output_sha256=sha256(canonical_json_bytes(value)).hexdigest())
        for name, raw in [('prompt.txt', prompt.encode()), ('schema.json', canonical_json_bytes(output_schema)),
                          ('source-schema.json', canonical_json_bytes(schema)),
                          ('result.json', canonical_json_bytes(value)), ('execution.json', canonical_json_bytes(execution))]:
            write_new(directory / name, raw)
        self.values.append(deepcopy(value))
        return dict(value=value, execution=execution)


class InputViewReportingTests(unittest.IsolatedAsyncioTestCase):
    setup_server = fixtures.DraftWorkflowTests.setup_server
    graph_writes = fixtures.DraftWorkflowTests.graph_writes
    failures = fixtures.DraftWorkflowTests.failures

    async def execute(self, adapter, **kwargs):
        kwargs.setdefault('context_documents', [dict(document='context.md', required=True,
                                                   reason='Explicit context with reviewed history')])
        return await fixtures.DraftWorkflowTests.execute(self, adapter, **kwargs)

    def seed_history_before_capture(self):
        scope = self.policy.authorize(self.user['token'], self.tenant, 'ontology_review')
        self.wiki = scope.store
        self.wiki.save('context.md', 'A pump moves water.\nContext conditions remain complete.\n', expected_revision=None)
        actor = {key: getattr(scope, key) for key in ('user_id', 'tenant', 'profile_id', 'domain',
                                                    'viewpoint', 'policy_revision', 'access_revision')}
        OntologyStore(self.wiki).generate('context.md', self.wiki.read('context.md').revision,
            [dict(id='pump', type='physical_object', label='pump', evidence='A pump moves water.'),
             dict(id='water', type='concept', label='water', evidence='A pump moves water.')],
            [dict(subject='pump', predicate='uses', object='water', evidence='A pump moves water.')], schema_version=3)
        reviews = ReviewStore(self.wiki)
        events = []
        for action in ('accept', 'defer'):
            current = reviews.query('context.md')
            event = reviews.review('context.md', action=action, claim_id=current['claims'][0]['claim_id'],
                expected_state_revision=current['state_revision'], reason='synthetic history test', actor=actor)
            events.append(event['event_id'])
        self.omitted_event, self.current_event = events
        self.graph_before = OntologyStore(self.wiki)._path('context.md').read_bytes()
        self.review_before = reviews._path('context.md').read_bytes()

    def capture_assembly(self):
        original = assembly.assemble_input
        self.assembled = []

        def capture(fixed, directory, **kwargs):
            before = {p.name: p.read_bytes() for p in (directory / 'inputs').iterdir()}
            source = load_input(fixed, directory)
            result = original(fixed, directory, **kwargs)
            full = original(fixed, directory, **{**kwargs, 'input_view': 'full'})
            # Report policy changes must not change default full prompt/configuration.
            with patch.object(input_view, 'REVIEW_HISTORY_REPORTING_INSTRUCTIONS', 'changed test policy'):
                self.assertEqual(full, original(fixed, directory, **{**kwargs, 'input_view': 'full'}))
            self.assertEqual(before, {p.name: p.read_bytes() for p in (directory / 'inputs').iterdir()})
            self.assembled.append((result, full, source))
            return result
        self.stack.enter_context(patch.object(workflow, 'assemble_input', side_effect=capture))

    @fixtures.isolated_server
    async def test_history_warning_roundtrip_preserves_inputs_and_completed_reuse_identity(self):
        self.seed_history_before_capture()
        self.capture_assembly()
        adapter = ReportingAdapter()
        result = await self.execute(adapter, input_view='current-review-v1')
        self.assertEqual(result['ai_execution']['status'], 'stored')
        self.assertEqual(adapter.calls, 1)
        selected, full, captured = self.assembled[0]
        audit = selected['assembly']['view_audit']
        target = next(row for row in audit['documents'] if row['document'] == 'context.md')
        self.assertIn(self.omitted_event, target['omitted_history_event_ids'])
        self.assertIn(self.current_event, target['included_event_ids'])
        self.assertTrue(selected['assembly']['view_warnings'])
        self.assertEqual(selected['assembly']['input_view_reporting'],
                         result['ai_execution']['execution_configuration']['input_view_reporting'])
        self.assertNotIn('input_view_reporting', full['assembly'])
        self.assertNotIn('INPUT_VIEW_REPORTING', full['prompt'])
        self.assertEqual(selected['schema'], full['schema'])
        full_data = json.loads(full['prompt'].split('\nFIXED_INPUT_DATA\n', 1)[1])
        selected_data = json.loads(selected['prompt'].split('\nFIXED_INPUT_DATA\n', 1)[1])
        original_context = json.loads(captured['components']['data/context.json'])
        self.assertEqual(json.loads(full_data['components']['data/context.json']), original_context)
        compact_context = json.loads(selected_data['components']['data/context.json'])
        for old, new in zip(original_context['documents'], compact_context['documents']):
            self.assertEqual(old['source'], new['source'])
            self.assertEqual(old['review']['effective_graph'], new['review']['effective_graph'])
            self.assertEqual(old['review']['policies'], new['review']['policies'])
        self.assertEqual(ReviewStore(self.wiki)._path('context.md').read_bytes(), self.review_before)
        sent = self.graph_writes()[0]
        self.assertTrue(sent['save'])
        self.assertEqual(sent['diagnostics'], adapter.values[0]['diagnostics'])
        receipt = result['ai_execution']['receipts'][-1]['diagnostics']
        self.assertEqual(receipt['report'], adapter.values[0]['diagnostics'])
        self.assertFalse(receipt['human_approval'])
        raw = list((self.root / 'work').rglob('invocation/result.json'))
        self.assertEqual(len(raw), 1)
        self.assertEqual(json.loads(raw[0].read_text()), adapter.values[0])
        again = await self.execute(adapter, input_view='current-review-v1')
        self.assertEqual(again['ai_execution']['usage_observations']['adapter_call_count'], 0)
        self.assertEqual(adapter.calls, 1)
        for key in ('REVIEW_HISTORY_REPORTING_POLICY', 'REVIEW_HISTORY_REPORTING_INSTRUCTIONS'):
            with self.subTest(key=key), patch.object(input_view, key, getattr(input_view, key) + ' changed'):
                with self.assertRaises(Exception) as stopped:
                    await self.execute(adapter, input_view='current-review-v1')
                self.assertEqual(client_error_code(stopped.exception), 'analysis_execution_settings_changed')
        self.assertEqual(adapter.calls, 1)

    @fixtures.isolated_server
    async def test_warning_does_not_hide_actual_unread_or_trigger_repair(self):
        self.seed_history_before_capture()
        self.capture_assembly()
        adapter = ReportingAdapter(unread=True)
        with patch('core.client.semantic_check.run_semantic_check') as checker:
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter, input_view='current-review-v1', semantic_check=True)
        self.assertEqual(client_error_code(stopped.exception), 'analysis_input_incomplete')
        checker.assert_not_called()
        self.assertEqual(adapter.calls, 1)
        self.assertFalse(self.graph_writes()[0]['save'])
        self.assertEqual(self.graph_writes()[0]['diagnostics'], adapter.values[0]['diagnostics'])
        self.assertEqual(self.failures()[0]['receipts'][-1]['state'], 'draft')
        self.assertEqual(self.failures()[0]['receipts'][-1]['diagnostics']['report'], adapter.values[0]['diagnostics'])
        self.assertEqual(OntologyStore(self.wiki)._path('context.md').read_bytes(), self.graph_before)
        self.assertEqual(ReviewStore(self.wiki)._path('context.md').read_bytes(), self.review_before)
        self.assertFalse(OntologyStore(self.wiki)._path('pump.md').exists())
        self.assertEqual(list((self.root / 'work').rglob('draft-validation.json')), [])

    def test_full_configuration_retains_legacy_shape_and_hash(self):
        adapter = ReportingAdapter()
        preflight = dict(provider='codex', cli_version='synthetic-draft-test')
        before = observations.execution_configuration(adapter, preflight, input_view='full', semantic_check=False)
        self.assertNotIn('input_view_reporting', before[0])
        with patch.object(input_view, 'REVIEW_HISTORY_REPORTING_POLICY', 'next-policy'), \
                patch.object(input_view, 'REVIEW_HISTORY_REPORTING_INSTRUCTIONS', 'next instructions'):
            self.assertEqual(before, observations.execution_configuration(adapter, preflight,
                             input_view='full', semantic_check=False))
