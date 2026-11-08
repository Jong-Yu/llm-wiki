"""Isolated D-074 storage contracts; these fixtures are not model-quality evaluations."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.modules.documents.store import WikiStore
from core.modules.documents.metadata import parse_document
from core.modules.sources.store import SourceStore
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_jobs.contracts import JobConflictError, JobValidationError
from core.modules.analysis_jobs import records
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_inputs import bundles
from core.modules.analysis_results.store import ResultStore
from core.modules.analysis_results.contracts import ResultError
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema


class RegistrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data' / 'team').mkdir(parents=True)
        self.store = WikiStore(self.root / 'data' / 'team')
        self.actor = dict(user_id='alice', tenant='team', profile_id='default', domain=None, viewpoint=None,
                          policy_revision='a' * 64, access_revision='b' * 64)
        schema = build_submission_schema()
        publish(self.root / 'rules', tenant_root=self.root / 'data', ruleset_id='common', ruleset_version='v1',
                reason='isolated contract test', schema=schema, expected_schema=schema)
        release = dict(ruleset_id='common', ruleset_version='v1')
        (self.root / 'rules-policy.json').write_text(json.dumps(dict(version=1, tenants={'team': dict(
            default=release, allowed=[release], revoked=[])})))
        self.rules = RulesetRegistry(self.root / 'rules', self.root / 'rules-policy.json', self.root / 'data', expected_schema=schema)
        self.sources = SourceStore(self.store)
        self.jobs = JobStore(self.store, rulesets=self.rules)
        self.inputs = InputStore(self.store, self.rules, jobs=self.jobs)
        self.results = ResultStore(self.store, self.rules, jobs=self.jobs)
        self.scope = dict(tenant='team', user_id='alice')
        self.text = 'A pump moves water.\nKeep every condition and exception.\n'
        staged = self.sources.stage(BytesIO(self.text.encode()), kind='text', title='Pump', format='txt')
        registered = self.sources.commit(staged, **self.scope, request_id=uuid4().hex, authorize=self.auth)
        catalog = self.sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        self.source = {key: original[key] for key in ('source_id', 'source_version', 'source_sha256')}
        self.source['registration_revision'] = catalog['registration_revision']
        self.request = dict(**self.scope, request_id=uuid4().hex, source_ref=self.source,
                            document='pump.md', title='Pump', authorize=self.auth)

    def auth(self, permission=None):
        return deepcopy(self.actor)

    def new(self):
        response = self.jobs.create_registration(**self.request)
        self.job_id = response['job_id']
        return response

    def query(self):
        return self.jobs.query(self.job_id, **self.scope)

    def claim(self, reclaim=False):
        job = self.query()
        return self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'],
                               authorize=self.auth, reclaim=reclaim)

    def prepare(self, stage):
        job = self.query()
        fixed = self.inputs.prepare(self.job_id, **self.scope, run_id=job['run_id'],
            expected_job_revision=job['job_revision'], stage=stage, authorize=self.auth)
        job = records.owned_state(self.jobs, self.job_id, **self.scope)
        manifest, _, parts = bundles.load_locked(self.inputs, job, fixed['bundle_id'], fixed['bundle_revision'])
        args = dict(**self.scope, run_id=job['run_id'], expected_job_revision=fixed['job_revision'],
            bundle_id=fixed['bundle_id'], bundle_revision=fixed['bundle_revision'], request_id=uuid4().hex,
            document='pump.md', authorize=self.auth)
        return args, manifest, parts

    def save_markdown(self):
        args, manifest, parts = self.prepare('prepare_wiki')
        args.update(content=parts['data/registration.md'], expected_revision=None)
        result = self.results.write_wiki(self.job_id, **args)
        self.assertTrue(result['saved'], result)
        self.assertEqual(result['state'], 'complete', result)
        return args, result

    def graph_args(self):
        args, manifest, _ = self.prepare('extract_ontology')
        target = manifest['dependency']['documents'][0]
        args.update(expected_revision=target['source_revision'], expected_state_revision=target['state_revision'],
                    submission=dict(schema_version=3, entities=[dict(id='pump', type='physical_object', label='pump',
                        evidence='A pump moves water.')], relations=[], relation_candidates=[], attributes=[]))
        return args, manifest

    def test_single_source_exact_markdown_graph_and_personal_paths(self):
        self.new(); self.claim()
        args, receipt = self.save_markdown()
        document = self.store.read('pump.md')
        self.assertEqual(parse_document(document.content).body, self.text)
        self.assertEqual(parse_document(document.content).metadata['source']['id'], self.source['source_id'])
        conversion = json.loads((self.jobs.job_root(self.job_id) / 'conversion.json').read_text())
        self.assertEqual(conversion['first_markdown']['revision'], document.revision)
        self.assertEqual(conversion['actor']['user_id'], 'alice')
        self.assertEqual(conversion['author'], 'AI')
        self.assertTrue((self.store.data_dir / '_personal/alice/analysis' / self.job_id / 'job.json').is_file())
        self.assertFalse((self.store.data_dir / '_jobs').exists())
        self.assertFalse((self.store.data_dir / '_extractions').exists())
        self.assertEqual(len([p for p in (self.store.data_dir / '_sources').iterdir() if p.is_dir()]), 1)
        raw = (self.jobs.job_root(self.job_id) / 'results' / args['request_id'] / 'component-0.txt').read_text()
        self.assertNotIn(self.text, raw)
        self.assertIn('preserved_content_ref', raw)
        graph_args, manifest = self.graph_args()
        self.assertEqual(manifest['previous_result']['source_revision'], document.revision)
        references = manifest['component_references']
        self.assertNotIn('content', references['data/context.json']['context']['documents'][0]['source'])
        descriptor = manifest['components']['data/context.json']
        self.assertFalse((self.jobs.job_root(self.job_id) / 'inputs' / manifest['bundle_id'] / descriptor['file']).exists())
        graph = self.results.generate_ontology(self.job_id, **graph_args)
        self.assertEqual(graph['receipt']['source_revision'], receipt['receipt']['source_revision'])
        self.assertEqual(self.query()['result_summary']['status'], 'complete')

    def test_replay_cas_cancel_ownership_and_access_revision(self):
        first = self.new()
        replay = self.jobs.create_registration(**self.request)
        self.assertTrue(replay['replayed'])
        self.assertEqual(first['job_id'], replay['job_id'])
        with self.assertRaises(JobConflictError):
            self.jobs.create_registration(**{**self.request, 'title': 'Changed'})
        self.actor['policy_revision'] = 'c' * 64  # another membership changes global file only
        claimed = self.claim()
        with self.assertRaises(FileNotFoundError):
            self.jobs.query(self.job_id, tenant='team', user_id='bob')
        self.assertEqual(len(self.jobs.list_jobs(**self.scope, scope_key='alice')['items']), 1)
        self.assertEqual(self.jobs.list_jobs(tenant='team', user_id='bob', scope_key='bob')['items'], [])
        with self.assertRaises(JobConflictError):
            self.jobs.cancel(self.job_id, **self.scope, expected_job_revision=first['job_revision'], authorize=self.auth)
        self.jobs.cancel(self.job_id, **self.scope, expected_job_revision=claimed['job_revision'], authorize=self.auth)
        with self.assertRaises(JobConflictError):
            self.claim()
        self.assertTrue((self.jobs.job_root(self.job_id) / 'conversion.json').is_file())

    def test_graph_failure_reclaim_does_not_resave_markdown(self):
        self.new(); self.claim(); _, saved = self.save_markdown()
        args, _ = self.graph_args()
        invalid = {**args, 'submission': deepcopy(args['submission'])}; invalid['submission']['entities'][0]['evidence'] = 'invented evidence'
        with self.assertRaises(ResultError):
            self.results.generate_ontology(self.job_id, **invalid)
        self.assertEqual(self.query()['result_summary']['status'], 'partial')
        job = self.query()
        self.jobs.update(self.job_id, **self.scope, run_id=job['run_id'], expected_job_revision=job['job_revision'],
                         reported_status='failed', authorize=self.auth)
        self.claim(reclaim=True)
        args, _ = self.graph_args()
        with patch.object(self.store, 'save', side_effect=AssertionError('must not save wiki twice')):
            self.results.generate_ontology(self.job_id, **args)
        self.assertEqual(self.store.read('pump.md').revision, saved['receipt']['source_revision'])

    def test_saved_evidence_survives_receipt_response_loss(self):
        self.new(); self.claim()
        args, _, parts = self.prepare('prepare_wiki')
        args.update(content=parts['data/registration.md'], expected_revision=None)
        write = self.results._write_receipt
        def lose_final(path, value):
            if value['state'] == 'complete':
                raise OSError('simulated response boundary interruption')
            return write(path, value)
        with patch.object(self.results, '_write_receipt', side_effect=lose_final):
            response = self.results.write_wiki(self.job_id, **args)
        self.assertTrue(response['saved'])
        self.assertEqual(response['state'], 'pending_reconcile')
        with patch.object(self.store, 'save', side_effect=AssertionError('no duplicate wiki write')):
            replay = self.results.write_wiki(self.job_id, **args)
            queried = self.results.query(self.job_id, **self.scope, request_id=args['request_id'], authorize=self.auth)
        self.assertTrue(replay['saved']); self.assertTrue(queried['saved'])
        self.assertEqual(queried['state'], 'complete')
        self.assertEqual(replay['receipt']['source_revision'], self.store.read('pump.md').revision)

    def test_change_after_fixed_input_rejects_old_result(self):
        self.new(); self.claim(); self.save_markdown()
        args, _ = self.graph_args()
        current = self.store.read('pump.md')
        self.store.save('pump.md', current.content + 'A new condition.\n', expected_revision=current.revision)
        with self.assertRaises(ResultError):
            self.results.generate_ontology(self.job_id, **args)
        self.assertTrue(self.store.read('pump.md').content.endswith('A new condition.\n'))
        from core.modules.analysis_inputs.files import load
        _, _, parts = load(self.store, self.jobs.job_root(self.job_id) / 'inputs' / args['bundle_id'], expected_revision=args['bundle_revision'])
        fixed_source = json.loads(parts['data/context.json'])['documents'][0]['source']
        self.assertEqual(fixed_source['content'], current.content)
        self.assertEqual(fixed_source['revision'], current.revision)

    def test_preservation_rejects_summary_and_changed_permission(self):
        self.new(); self.claim()
        args, _, _ = self.prepare('prepare_wiki')
        with self.assertRaises(ResultError):
            self.results.write_wiki(self.job_id, **args, content='Summary', expected_revision=None)
        self.actor['access_revision'] = 'd' * 64
        with self.assertRaises(JobConflictError):
            self.prepare('prepare_wiki')

    def test_advanced_text_extraction_and_legacy_bundle_compatibility(self):
        self.actor.pop('access_revision')
        created = self.jobs.create(**self.scope, request_id=uuid4().hex,
            **{key: self.source[key] for key in ('source_id', 'source_version', 'source_sha256')},
            expected_registration_revision=self.source['registration_revision'], targets=['pump.md'], outputs=['wiki'], authorize=self.auth)
        self.job_id = created['job_id']
        job = self.claim()
        fixed = self.inputs.prepare(self.job_id, **self.scope, run_id=job['run_id'], expected_job_revision=job['job_revision'],
                                    stage='read_source', authorize=self.auth)
        frozen = self.jobs.job_root(self.job_id) / 'inputs' / fixed['bundle_id'] / 'manifest.json'
        original = frozen.read_bytes()
        self.actor['access_revision'] = 'b' * 64
        self.actor['policy_revision'] = 'c' * 64
        self.inputs.read(self.job_id, **self.scope, run_id=job['run_id'], bundle_id=fixed['bundle_id'],
                         bundle_revision=fixed['bundle_revision'], authorize=self.auth)
        self.assertEqual(frozen.read_bytes(), original)
        # A fresh service instance must resolve the personal request path after ownership validation.
        reading = InputStore(self.store, self.rules).submit_extraction(self.job_id, **self.scope, run_id=job['run_id'],
            expected_job_revision=fixed['job_revision'], bundle_id=fixed['bundle_id'], bundle_revision=fixed['bundle_revision'],
            request_id=uuid4().hex, content=self.text, method='verbatim', authorize=self.auth)
        self.assertEqual(reading['state'], 'complete')
        self.assertTrue((self.jobs.job_root(self.job_id) / 'extraction_requests').is_dir())
        self.assertFalse((self.store.data_dir / '_jobs').exists())
        prepared = self.inputs.prepare(self.job_id, **self.scope, run_id=job['run_id'],
            expected_job_revision=reading['job_revision'], stage='prepare_wiki', extraction_id=reading['extraction_id'], authorize=self.auth)
        saved = self.results.write_wiki(self.job_id, **self.scope, run_id=job['run_id'], expected_job_revision=prepared['job_revision'],
            bundle_id=prepared['bundle_id'], bundle_revision=prepared['bundle_revision'], request_id=uuid4().hex,
            document='pump.md', content=self.text, expected_revision=None, authorize=self.auth)
        self.assertTrue(saved['saved'])

    def test_binary_conversion_keeps_warnings_locations_without_new_source(self):
        from core.modules.analysis_plans.store import PlanStore
        from core.api.v1.analysis_plans.schemas import CreateConversion
        staged = self.sources.stage(BytesIO(b'%PDF-1.4\n% contract fixture\n%%EOF\n'), kind='file', title='PDF', format='pdf', filename='source.pdf')
        registered = self.sources.commit(staged, **self.scope, request_id=uuid4().hex, authorize=self.auth)
        catalog = self.sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        source = {key: original[key] for key in ('source_id', 'source_version', 'source_sha256')}
        source['registration_revision'] = catalog['registration_revision']
        body = CreateConversion(request_id=uuid4().hex, source_ref=source, method='pdf_text', complete=False,
            unread_ranges=['page 2 unread'], warnings=['layout not verified'], units=[
                dict(unit_id='page1', location=dict(kind='pages', start=1, end=1), content=self.text)])
        converted = PlanStore(self.store, self.actor).conversion(body, self.auth)
        self.request.update(source_ref=source, conversion_ref=dict(conversion_id=converted['manifest']['id'],
                                                                  conversion_revision=converted['revision']))
        self.new(); self.claim(); self.save_markdown()
        report = self.query()['conversion']
        self.assertFalse(report['complete'])
        self.assertEqual(report['unread_ranges'], ['page 2 unread'])
        self.assertEqual(report['warnings'], ['layout not verified'])
        self.assertEqual(report['units'][0]['location']['start'], 1)
        _, fixed, parts = self.prepare('extract_ontology')
        self.assertTrue(fixed['input_ready'])
        self.assertFalse(fixed['completeness']['complete'])
        self.assertEqual(json.loads(parts['data/conversion.json'])['unread_ranges'], ['page 2 unread'])
        self.assertEqual(parse_document(self.store.read('pump.md').content).body, self.text)
        self.assertEqual(len([p for p in (self.store.data_dir / '_sources').iterdir() if p.is_dir()]), 2)
        self.assertFalse((self.store.data_dir / '_analysis_plans' / records.owner_key('team', 'alice') / 'plans').exists())

    def test_parallel_registration_one_job_and_cross_operation_request_conflict(self):
        from concurrent.futures import ThreadPoolExecutor
        from core.modules.sources.contracts import SourceConflictError
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda _: JobStore(self.store, rulesets=self.rules).create_registration(**self.request), range(2)))
        self.assertEqual(results[0]['job_id'], results[1]['job_id'])
        self.assertEqual(sum(item['replayed'] for item in results), 1)
        staged = self.sources.stage(BytesIO(b'Another original'), kind='text', title='Other', format='txt')
        with self.assertRaises(SourceConflictError):
            self.sources.commit(staged, **self.scope, request_id=self.request['request_id'], authorize=self.auth)

    def test_cancel_after_access_change_still_uses_current_authorization(self):
        self.new(); job = self.claim()
        self.actor['access_revision'] = 'e' * 64
        cancelled = self.jobs.cancel(self.job_id, **self.scope, expected_job_revision=job['job_revision'], authorize=self.auth)
        self.assertEqual(cancelled['state'], 'cancelled')

    def test_legacy_job_and_actor_bytes_are_read_without_rewrite(self):
        self.actor.pop('access_revision')
        created = self.jobs.create(**self.scope, request_id=uuid4().hex,
            **{key: self.source[key] for key in ('source_id', 'source_version', 'source_sha256')},
            expected_registration_revision=self.source['registration_revision'], targets=['pump.md'], outputs=['wiki'], authorize=self.auth)
        self.job_id = created['job_id']
        root = self.jobs.job_root(self.job_id)
        job = json.loads((root / 'job.json').read_text())
        legacy = self.store.data_dir / '_jobs' / self.job_id
        legacy.mkdir(parents=True)
        (legacy / 'state.json').write_bytes((root / 'job.json').read_bytes())
        old_owner = records.legacy_owner_path(self.jobs, 'team', 'alice', self.job_id)
        old_owner.parent.mkdir(parents=True)
        old_owner.write_bytes((root / 'owner.json').read_bytes())
        # Only this fixture's newly created personal records are removed to model an old dataset.
        for child in root.iterdir(): child.unlink()
        root.rmdir()
        original = (legacy / 'state.json').read_bytes()
        read = JobStore(self.store, rulesets=self.rules).query(self.job_id, **self.scope)
        self.assertNotIn('access_revision', read['actor'])
        self.assertEqual((legacy / 'state.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
