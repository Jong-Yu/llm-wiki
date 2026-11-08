"""Completed-result reuse is a checked read, not an independent model run."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.resume import completed_results
from core.client.transport import AnalysisClientError
from core.modules.analysis_results.validation import execution_report
from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_jobs.contracts import JobCorruptError
from core.modules.access.policy import AccessDenied
from core.modules.reviews.store import ReviewStore
from core.tests.poc_analysis import test_registration as fixtures


CONFIG = 'e' * 64


def execution(config=CONFIG):
    return dict(provider='codex', cli_version='synthetic-contract-test', requested_model='synthetic-model',
                prompt_sha256='1' * 64, schema_sha256='2' * 64, output_sha256='3' * 64,
                execution_config_sha256=config)


class ReuseGuard(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Reuse the existing isolated registration fixture without inheriting its tests.
        self.f = fixtures.RegistrationTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        f.store.save('context.md', 'Keep the exception and the exact time condition.\n', expected_revision=None)
        f.new(); claimed = f.claim()
        f.inputs.prepare(f.job_id, **f.scope, run_id=claimed['run_id'],
            expected_job_revision=claimed['job_revision'], stage='read_source', authorize=f.auth,
            context_documents=[dict(document='context.md', required=True, reason='Explicit exception context')])
        _, self.wiki = f.save_markdown()
        args, manifest = f.graph_args()
        target = next(row for row in manifest['dependency']['documents'] if row['document'] == 'pump.md')
        args.update(expected_revision=target['source_revision'], expected_state_revision=target['state_revision'])
        args['submission']['entities'].append(dict(id='water', type='substance', label='water', evidence='A pump moves water.'))
        args['submission']['relations'] = [dict(subject='pump', predicate='related_to', object='water',
            evidence='A pump moves water.', qualifiers=dict(polarity='positive', modality='asserted',
                                                          condition=None, scope=None, time=None))]
        args['execution'] = execution()
        self.graph = f.results.generate_ontology(f.job_id, **args)
        self.assertEqual(self.graph['state'], 'complete')

    async def reuse(self, config=CONFIG, *, tool=None):
        f = self.f
        async def query(_client, name, arguments):
            self.assertEqual(name, 'analysis_job_result_query')
            self.assertEqual(arguments['tenant'], 'team')
            return f.results.query(arguments['job_id'], **f.scope, request_id=arguments['request_id'], authorize=f.auth)
        with patch('core.client.ai.resume.tool_call', side_effect=tool or query):
            return await completed_results(None, tenant='team', job=f.query(), profile='default',
                                           execution_config_sha256=config)

    def receipt(self):
        f = self.f
        return f.results.query(f.job_id, **f.scope, request_id=self.graph['request_id'], authorize=f.auth)

    async def assert_rejected(self, code='analysis_reuse_basis_changed'):
        with self.assertRaises(AnalysisClientError) as rejected:
            await self.reuse()
        self.assertEqual(rejected.exception.code, code)

    async def test_same_basis_uses_confirmed_saves_without_model_or_rewrite(self):
        f = self.f
        before = {p: p.read_bytes() for p in f.store.data_dir.rglob('*') if p.is_file()}
        with patch.object(f.store, 'save', side_effect=AssertionError('reuse must never write')):
            stages, receipts = await self.reuse()
        self.assertEqual(stages, {('pump.md', 'prepare_wiki'), ('pump.md', 'extract_ontology')})
        self.assertEqual(len(receipts), 2)
        self.assertTrue(next(row for row in receipts if row['receipt']['stage'] == 'prepare_wiki')['current_output']['state_changed'])
        self.assertTrue(all(row['reuse_basis']['status'] == 'current' for row in receipts))
        self.assertEqual(before, {p: p.read_bytes() for p in f.store.data_dir.rglob('*') if p.is_file()})

    async def test_config_mismatch_and_unrecorded_ai_settings_refuse_reuse(self):
        with self.assertRaises(AnalysisClientError) as rejected:
            await self.reuse('f' * 64)
        self.assertEqual(rejected.exception.code, 'analysis_execution_settings_changed')
        async def missing(_client, _name, args):
            f = self.f
            value = f.results.query(f.job_id, **f.scope, request_id=args['request_id'], authorize=f.auth)
            if value['receipt']['stage'] == 'extract_ontology':
                value['receipt']['execution'].pop('execution_config_sha256')
            return value
        with self.assertRaises(AnalysisClientError) as rejected:
            await self.reuse(tool=missing)
        self.assertEqual(rejected.exception.code, 'analysis_execution_settings_changed')

    async def test_review_change_refuses_reuse_but_preserves_past_receipt(self):
        f = self.f
        reviews = ReviewStore(f.store)
        snapshot = reviews.query('pump.md')
        reviews.review('pump.md', action='defer', claim_id=snapshot['claims'][0]['claim_id'],
                       expected_state_revision=snapshot['state_revision'], reason='Synthetic pending judgment', actor=f.actor)
        current = self.receipt()
        self.assertEqual(current['current_output']['status'], 'current')
        self.assertTrue(current['current_output']['state_changed'])
        self.assertEqual(current['state'], 'complete')
        await self.assert_rejected()

    async def test_selected_context_change_and_round_trip_history_refuse_reuse(self):
        f = self.f
        before = f.store.read('context.md')
        changed = f.store.save('context.md', before.content + 'Another exception.\n', expected_revision=before.revision)
        f.store.save('context.md', before.content, expected_revision=changed.revision)
        self.assertEqual(f.store.read('context.md').revision, before.revision)
        await self.assert_rejected()

    async def test_source_version_change_refuses_reuse_without_deleting_results(self):
        f = self.f
        staged = f.sources.stage(BytesIO(b'A pump moves water with a new condition.\n'), kind='text', title='Pump', format='txt')
        f.sources.commit(staged, **f.scope, source_id=f.source['source_id'],
            expected_registration_revision=f.source['registration_revision'], request_id=uuid4().hex, authorize=f.auth)
        self.assertEqual(self.receipt()['state'], 'complete')
        await self.assert_rejected()

    async def test_target_change_refuses_reuse(self):
        f = self.f
        before = f.store.read('pump.md')
        f.store.save('pump.md', before.content + 'An additional qualifier.\n', expected_revision=before.revision)
        await self.assert_rejected('analysis_saved_output_changed')

    async def test_revoked_rules_access_change_and_cancel_refuse_reuse(self):
        f = self.f
        policy_path = f.root / 'rules-policy.json'
        policy = json.loads(policy_path.read_text())
        policy['tenants']['team']['revoked'] = [dict(ruleset_id='common', ruleset_version='v1')]
        policy_path.write_text(json.dumps(policy))
        self.assertEqual(self.receipt()['state'], 'complete')
        await self.assert_rejected()
        policy['tenants']['team']['revoked'] = []
        policy_path.write_text(json.dumps(policy))
        f.actor['access_revision'] = 'f' * 64
        await self.assert_rejected()
        f.actor['access_revision'] = 'b' * 64
        job = f.query()
        f.jobs.cancel(f.job_id, **f.scope, expected_job_revision=job['job_revision'], authorize=f.auth)
        self.assertEqual(self.receipt()['state'], 'complete')
        await self.assert_rejected()

    async def test_unchecked_old_server_and_partial_receipts_fail_closed(self):
        async def old_server(_client, _name, arguments):
            f = self.f
            value = f.results.query(f.job_id, **f.scope, request_id=arguments['request_id'], authorize=f.auth)
            value.pop('reuse_basis')
            return value
        with self.assertRaises(AnalysisClientError) as rejected:
            await self.reuse(tool=old_server)
        self.assertEqual(rejected.exception.code, 'analysis_reuse_basis_changed')
        job = self.f.query()
        job['result_summary']['results'][0]['state'] = 'pending_reconcile'
        with self.assertRaises(AnalysisClientError) as rejected:
            await completed_results(None, tenant='team', job=job, profile='default')
        self.assertEqual(rejected.exception.code, 'analysis_result_unconfirmed')

    async def test_wrong_tenant_or_owner_cannot_read_reusable_result(self):
        f = self.f
        for tenant, user in [('other', 'alice'), ('team', 'bob')]:
            actor = {**f.actor, 'tenant': tenant, 'user_id': user}
            with self.assertRaises((FileNotFoundError, JobCorruptError)):
                f.results.query(f.job_id, tenant=tenant, user_id=user, request_id=self.graph['request_id'],
                                authorize=lambda _permission: actor)

    async def test_revoked_read_permission_never_discloses_receipt(self):
        def denied(_permission):
            raise AccessDenied()
        f = self.f
        with self.assertRaises(AccessDenied):
            f.results.query(f.job_id, **f.scope, request_id=self.graph['request_id'], authorize=denied)


class ExecutionConfigurationContract(unittest.TestCase):
    def test_optional_hash_is_validated_and_legacy_record_unchanged(self):
        value = execution()
        legacy = deepcopy(value)
        legacy.pop('execution_config_sha256')
        self.assertEqual(execution_report(legacy), {'origin': 'client_reported', **legacy})
        self.assertNotIn('execution_config_sha256', legacy)
        self.assertEqual(execution_report(value)['execution_config_sha256'], CONFIG)
        for invalid in [None, True, 3, 'x' * 64, 'e' * 63, 'E' * 64]:
            with self.subTest(invalid=invalid), self.assertRaises(ResultError):
                execution_report({**value, 'execution_config_sha256': invalid})
