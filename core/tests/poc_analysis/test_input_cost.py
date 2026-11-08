"""합성 자료의 전송/보존 계약 검사. 실제 모델 절감률·의미 정확도 평가는 아니다."""
import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from core.client.ai.input_view import project
from core.client.ai.observations import ObservedAdapter, execution_configuration, reported_usage
from core.client.ai.codex import _events
from core.client.ai.claude import _Events
from core.client.analysis_batch import run_selected
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_inputs.capture import documents_locked
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR
from core.tests.poc_analysis import test_registration as registration_fixtures


class InputViewTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        lines = [f'N0 uses N{i} only when open, except during maintenance in 2026.' for i in range(1, 25)]
        self.document(body='\n'.join(lines) + '\n')
        self.entities = [dict(id=f'n{i}', label=f'N{i}', type='system',
                              evidence=lines[max(0, i - 1)]) for i in range(25)]
        self.relations = [dict(subject='n0', predicate='uses', object=f'n{i}', evidence=lines[i - 1],
            qualifiers=dict(polarity='positive', modality='asserted', condition='only when open, except during maintenance',
                            scope='N0', time='2026')) for i in range(1, 25)]
        self.ontology.generate('a.md', self.wiki.read('a.md').revision, self.entities, self.relations)

    def decision(self, index, action):
        current = self.reviews.query('a.md')
        return self.reviews.review('a.md', action=action, claim_id=current['claims'][index]['claim_id'],
            expected_state_revision=current['state_revision'], reason='synthetic reason: preserve exception', actor=ACTOR)

    def captured(self):
        self.document('context.md', body='Never ignore the exception.\n가능성은 사실이 아니다.\n')
        selected = [dict(document='a.md', required=True, reason='target_document'),
                    dict(document='context.md', required=True, reason='explicit exception context')]
        with self.wiki._write_lock():
            rows, dependencies, skipped = documents_locked(self.wiki, selected, ACTOR)
        context = dict(kind='context_data_not_instructions', documents=rows)
        manifest = dict(stage='extract_ontology', selection=selected, dependency=dict(documents=dependencies),
                        completeness=dict(complete=not skipped, truncated=False, skipped=skipped),
                        component_references={'data/context.json': {'context': context}})
        return manifest, {'data/context.json': canonical_json_bytes(context).decode(), 'data/hints.json': '{"items":[]}'}

    def test_full_sources_conditions_graph_and_current_decisions_preserved(self):
        old = self.decision(0, 'accept')
        self.ontology.generate('a.md', self.wiki.read('a.md').revision, self.entities, self.relations,
            force_generation=True, expected_state_revision=old['state_revision'])
        self.decision(1, 'reject')
        self.decision(2, 'defer')
        accepted = self.decision(3, 'accept')
        # 같은 세대에서 대체된 이전 판단을 여러 번 보존한다.
        for action in ('defer', 'accept', 'defer', 'accept'):
            self.decision(3, action)
        manifest, data = self.captured()
        tree, original = self.tree(), deepcopy((manifest, data))
        full_manifest, full_data, full_audit = project(manifest, data, 'full', bundle_revision=canonical_json_hash(manifest))
        self.assertEqual((full_manifest, full_data), original)
        self.assertIsNone(full_audit)
        compact_manifest, compact_data, audit = project(manifest, data, 'current-review-v1', bundle_revision=canonical_json_hash(manifest))
        before = json.loads(data['data/context.json'])['documents']
        after = json.loads(compact_data['data/context.json'])['documents']
        for left, right in zip(before, after):
            self.assertEqual(left['source'], right['source'])
            self.assertEqual(left['review']['effective_graph'], right['review']['effective_graph'])
            self.assertEqual(left['review']['policies'], right['review']['policies'])
            self.assertEqual(left['review']['pending_history'], right['review']['pending_history'])
            for claim in right['review']['claims']:
                if claim['decision'] != 'unreviewed':
                    self.assertIn(claim, left['review']['claims'])
        self.assertIn(old['event_id'], after[0]['review']['input_view']['omitted_history_event_ids'])
        self.assertNotIn(old['event_id'], {event['id'] for event in after[0]['review']['history']})
        self.assertIn(old['event_id'], after[0]['review']['pending_history'])
        self.assertIn(accepted['event_id'], after[0]['review']['input_view']['omitted_history_event_ids'])
        self.assertEqual(after[0]['review']['claims'][0]['decision'], 'unreviewed')
        self.assertFalse(audit['related_documents_exhaustive'])
        for name, content in compact_data.items():
            self.assertEqual(audit['component_descriptors'][name]['sha256'], sha256(content.encode()).hexdigest())
        raw_revision = sha256(json.dumps(manifest, indent=2).encode()).hexdigest()
        _, _, raw_audit = project(manifest, data, 'current-review-v1', bundle_revision=raw_revision)
        self.assertEqual(raw_audit['bundle_revision'], raw_revision)
        self.assertNotEqual(raw_revision, canonical_json_hash(manifest))
        self.assertEqual((manifest, data), original)
        self.assertEqual(self.tree(), tree)
        full_size = len(canonical_json_bytes({'manifest': manifest, 'components': data}))
        compact_size = len(canonical_json_bytes({'manifest': compact_manifest, 'components': compact_data}))
        self.assertLess(compact_size, full_size * .6)
        print(f'INPUT_VIEW_SYNTHETIC_BYTES full={full_size} selected={compact_size}; model_calls=0')

    def test_current_policy_reason_scope_and_full_value_preserved(self):
        current = self.reviews.query('a.md')
        claim = current['claims'][0]
        policy = self.reviews.policy('a.md', claim_id=claim['claim_id'], expected_state_revision=current['state_revision'],
            reason='expert simulation; exception remains', actor=ACTOR,
            replacement=dict(subject='n0', predicate='uses', object='n1',
                qualifiers=dict(polarity='negative', modality='possible', condition='during maintenance',
                                scope='N0', time='2026'), context=dict(domain=None, viewpoints=[])))
        manifest, data = self.captured()
        _, compact, _ = project(manifest, data, 'current-review-v1', bundle_revision=canonical_json_hash(manifest))
        review = json.loads(compact['data/context.json'])['documents'][0]['review']
        event = next(event for event in review['history'] if event['id'] == policy['event_id'])
        self.assertEqual(event, policy['history'][-1])
        self.assertEqual(review['policies'], policy['policies'])
        self.assertEqual(review['effective_graph'], policy['effective_graph'])

    def test_missing_referenced_decision_fails_instead_of_omission(self):
        self.decision(0, 'reject')
        manifest, data = self.captured()
        context = json.loads(data['data/context.json'])
        context['documents'][0]['review']['history'] = []
        data['data/context.json'] = json.dumps(context)
        with self.assertRaises(AnalysisClientError):
            project(manifest, data, 'current-review-v1', bundle_revision=canonical_json_hash(manifest))

    def test_undo_restored_decision_keeps_original_reason(self):
        accepted = self.decision(0, 'accept')
        rejected = self.decision(0, 'reject')
        self.reviews.undo('a.md', event_id=rejected['event_id'], expected_state_revision=rejected['state_revision'],
                          reason='restore previous simulation', actor=ACTOR)
        manifest, data = self.captured()
        _, compact, _ = project(manifest, data, 'current-review-v1', bundle_revision=canonical_json_hash(manifest))
        review = json.loads(compact['data/context.json'])['documents'][0]['review']
        self.assertIn(accepted['history'][-1], review['history'])
        self.assertEqual(review['claims'][0]['decision'], 'accept')


class ObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_bytes_characters_usage_and_failed_calls_are_separate(self):
        class Synthetic:
            async def run(self, **kwargs):
                if kwargs['prompt'] == 'fail':
                    raise AnalysisClientError('synthetic_failure')
                return dict(value={'result': '한'}, execution={'token_usage': reported_usage({'input_tokens': 4})})
        observed = ObservedAdapter(Synthetic())
        args = dict(schema={'type': 'object'}, directory=Path('synthetic-stage'))
        await observed.run(prompt='한글', **args)
        with self.assertRaises(AnalysisClientError):
            await observed.run(prompt='fail', **args)
        result = observed.summary()
        self.assertEqual(result['adapter_call_count'], 2)
        self.assertEqual(result['calls'][0]['prompt_utf8_bytes'], 6)
        self.assertEqual(result['calls'][0]['prompt_characters'], 2)
        self.assertIsNone(result['calls'][1]['token_usage'])
        self.assertIsNone(result['calls'][0]['token_estimate'])

    def test_provider_usage_missing_and_invalid_is_not_zero(self):
        self.assertIsNone(reported_usage(None))
        self.assertIsNone(reported_usage({'input_tokens': True, 'output_tokens': -1}))
        trace, _ = _events(b'{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":3}}', [])
        self.assertEqual(trace[0]['token_usage']['tokens']['cached_input_tokens'], 4)
        events = _Events()
        events(json.dumps(dict(type='result', subtype='success', is_error=False, structured_output={},
                               usage={'input_tokens': 5, 'output_tokens': 7})), lambda _: None)
        self.assertEqual(events.token_usage['tokens']['output_tokens'], 7)

    async def test_actual_codex_reports_and_claude_usage_are_counted_once_per_call(self):
        # CodexAdapter.run과 같은 trace→reports 경로를 사용한다. item usage는
        # 완료 턴의 별도 소비 보고가 아니며 _events도 토큰으로 채택하지 않는다.
        trace, _ = _events(b'\n'.join([
            b'{"type":"turn.started"}',
            b'{"type":"item.updated","item":{"type":"agent_message"},"usage":{"input_tokens":999}}',
            b'{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":3}}',
            b'{"type":"turn.started"}',
            b'{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":3}}']), [])
        codex = {"origin": "provider_reported", "reports": [
            event["token_usage"] for event in trace if "token_usage" in event]}
        events = _Events()
        events(json.dumps(dict(type='result', subtype='success', is_error=False, structured_output={},
            usage={'input_tokens': 5, 'output_tokens': 7, 'cache_read_input_tokens': 2})), lambda _: None)
        reports = [codex, events.token_usage, None, {'origin': 'provider_reported', 'reports': []},
                   {'origin': 'provider_reported', 'reports': [None, {'tokens': {'input_tokens': 100}},
                       {'origin': 'provider_reported', 'tokens': {'input_tokens': True, 'output_tokens': -1}}]}]
        raw = deepcopy(reports)
        class Synthetic:
            async def run(self, **kwargs):
                if kwargs['prompt'] == 'failure':
                    raise AnalysisClientError('synthetic_failure')
                return {'value': {}, 'execution': {'token_usage': reports[int(kwargs['prompt'])]}}
        observed = ObservedAdapter(Synthetic())
        args = {'schema': {'type': 'object'}, 'directory': Path('usage-contract')}
        for index in range(len(reports)):
            await observed.run(prompt=str(index), **args)
        with self.assertRaises(AnalysisClientError):
            await observed.run(prompt='failure', **args)
        summary = observed.summary()
        self.assertEqual(summary['token_usage_totals'], {
            'origin': 'provider_reported', 'tokens': {'input_tokens': 29, 'output_tokens': 13,
                'cached_input_tokens': 8, 'cache_read_input_tokens': 2},
            'reported_call_count': 2, 'unreported_call_count': 4})
        self.assertEqual([call['token_usage'] for call in summary['calls'][:-1]], raw)
        self.assertEqual(reports, raw)
        self.assertEqual(observed.summary(), summary)

    async def test_direct_total_with_reports_is_not_double_counted_and_zero_is_reported(self):
        direct = reported_usage({'input_tokens': 5, 'output_tokens': 0})
        usage = {**direct, 'reports': [deepcopy(direct)]}
        class Synthetic:
            async def run(self, **kwargs):
                return {'value': {}, 'execution': {'token_usage': usage}}
        observed = ObservedAdapter(Synthetic())
        await observed.run(prompt='fixture', schema={}, directory=Path('usage-contract'))
        self.assertEqual(observed.summary()['token_usage_totals'], {
            'origin': 'provider_reported', 'tokens': {'input_tokens': 5, 'output_tokens': 0},
            'reported_call_count': 1, 'unreported_call_count': 0})

    def test_configuration_tracks_view_model_timeout_and_semantic_check(self):
        class Synthetic:
            model, cli, timeout_seconds = 'test-model', 'test-cli', 90
        adapter = Synthetic()
        def key(**kwargs):
            return execution_configuration(adapter, {'provider': 'codex', 'cli_version': 'fixture'},
                                           input_view=kwargs.get('view', 'full'), semantic_check=kwargs.get('check', False))[1]
        first = key()
        self.assertNotEqual(first, key(view='current-review-v1'))
        self.assertNotEqual(first, key(check=True))
        from core.modules.ontology import draft
        for name in ('MAX_SUBMISSION_BYTES', 'MAX_DOCUMENT_BYTES', 'MAX_INPUT_NODES', 'MAX_INPUT_DEPTH',
                     'MAX_ERRORS', 'MAX_SCHEMA_STEPS', 'MAX_CORE_ITEM_VISITS', 'MAX_SOURCE_SCAN_WORK'):
            with self.subTest(limit=name), patch.object(draft, name, getattr(draft, name) + 1):
                self.assertNotEqual(first, key())
        from core.client.ai import draft_validation
        with patch.object(draft.constants, 'MAX_ONTOLOGY_BYTES', draft.constants.MAX_ONTOLOGY_BYTES + 1):
            self.assertNotEqual(first, key())
        original_default = draft_validation.configuration()['max_reported_errors']
        def changed_default(*args, max_errors=original_default + 1, **kwargs):
            pass
        with patch.object(draft_validation, 'validate_draft', changed_default):
            self.assertEqual(draft_validation.configuration()['max_reported_errors'], original_default + 1)
            self.assertNotEqual(first, key())
        adapter.model = 'different'
        self.assertNotEqual(first, key())

    async def test_batch_only_selected_once_partial_failure_and_cancel(self):
        rows = [dict(job_id=char * 32, expected_job_revision=char * 64) for char in 'abc']
        calls = []
        async def execute(**row):
            calls.append(row['job_id'])
            if row == rows[1]:
                raise AnalysisClientError('synthetic_failure')
            return {'stored': True}
        result = await run_selected(rows, execute)
        self.assertEqual(calls, [row['job_id'] for row in rows])
        self.assertEqual(result['status'], 'partial_failure')
        self.assertFalse(result['automatic_retry'])
        calls.clear()
        with self.assertRaises(AnalysisClientError):
            await run_selected([rows[0], rows[0]], execute)
        self.assertEqual(calls, [])
        async def cancel(**row):
            calls.append(row['job_id'])
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await run_selected(rows, cancel)
        self.assertEqual(calls, [rows[0]['job_id']])


class WholeDocumentTests(unittest.TestCase):
    def test_selected_document_complete_graph_and_unselected_document_preserved(self):
        from uuid import uuid4
        from core.modules.ontology.store import OntologyStore
        f = registration_fixtures.RegistrationTest()
        f.setUp()
        self.addCleanup(f.doCleanups)
        ontology = OntologyStore(f.store)
        body = 'A uses B.\nA uses C only in 2026.\n'
        entities = [dict(id=letter.lower(), label=letter, type='system',
                         evidence=body.splitlines()[letter == 'C']) for letter in 'ABC']
        relations = [dict(subject='a', predicate='uses', object=letter.lower(), evidence=line,
            qualifiers=dict(polarity='positive', modality='asserted', condition=None, scope=None,
                            time='2026' if letter == 'C' else None))
                     for letter, line in zip('BC', body.splitlines())]
        for name in ('pump.md', 'unselected.md'):
            f.store.save(name, body, expected_revision=None)
            ontology.generate(name, f.store.read(name).revision, entities, relations)
        other_graph = ontology._path('unselected.md').read_bytes()
        created = f.jobs.create(**f.scope, request_id=uuid4().hex, **{key: f.source[key] for key in
            ('source_id', 'source_version', 'source_sha256')}, expected_registration_revision=f.source['registration_revision'],
            targets=['pump.md'], outputs=['ontology'], authorize=f.auth)
        f.job_id = created['job_id']
        f.claim()
        args, manifest, components = f.prepare('extract_ontology')
        _, projected, _ = project(manifest, components, 'current-review-v1', bundle_revision=args['bundle_revision'])
        context = json.loads(projected['data/context.json'])['documents']
        self.assertEqual([row['document'] for row in context], ['pump.md'])
        self.assertEqual(len(context[0]['review']['effective_graph']['relations']), 2)
        target = manifest['dependency']['documents'][0]
        saved = f.results.generate_ontology(f.job_id, **args, expected_revision=target['source_revision'],
            expected_state_revision=target['state_revision'], submission=dict(schema_version=3, entities=entities,
                relations=relations, relation_candidates=[], attributes=[]))
        self.assertTrue(saved['saved'])
        self.assertEqual(len(ontology.query('pump.md')['relations']), 2)
        self.assertEqual(ontology._path('unselected.md').read_bytes(), other_graph)
        self.assertEqual(f.store.read('pump.md').content, body)
