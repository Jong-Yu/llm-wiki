"""큰 등록 본문의 고정 참조·CAS·이력·영수증을 격리 자료로 검증한다."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.mcp.tools.analysis_results import WikiSubmit
from core.modules.analysis_inputs import contracts, files
from core.modules.analysis_results.contracts import ResultError
from core.modules.documents.metadata import parse_document
from core.tests.poc_analysis import test_registration as fixtures


class RegistrationReferenceTests(unittest.TestCase):
    setUp = fixtures.RegistrationTest.setUp
    auth = fixtures.RegistrationTest.auth
    new = fixtures.RegistrationTest.new
    query = fixtures.RegistrationTest.query
    claim = fixtures.RegistrationTest.claim
    prepare = fixtures.RegistrationTest.prepare

    def large(self):
        self.text = '한글🙂 원문을 그대로 보관합니다.\n' * (9 * 1024 * 1024 // 48)
        self.assertGreater(len(self.text.encode()), contracts.MAX_BUNDLE_BYTES)
        staged = self.sources.stage(BytesIO(self.text.encode()), kind='text', title='Large', format='txt')
        registered = self.sources.commit(staged, **self.scope, request_id=uuid4().hex, authorize=self.auth)
        catalog = self.sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        self.source = {key: original[key] for key in ('source_id', 'source_version', 'source_sha256')}
        self.source['registration_revision'] = catalog['registration_revision']
        self.request.update(source_ref=self.source)
        self.new(); self.claim()

    def reference_args(self):
        args, manifest, parts = self.prepare('prepare_wiki')
        args.update(content_ref=dict(component='data/registration.md',
            sha256=manifest['components']['data/registration.md']['sha256']), expected_revision=None)
        return args, manifest, parts

    def test_large_reference_exact_save_and_old_history_read(self):
        self.large()
        args, manifest, parts = self.reference_args()
        self.assertEqual(manifest['input_mode'], contracts.REGISTRATION_REFERENCE_MODE)
        self.assertEqual(manifest['input_budget_bytes'], contracts.MAX_REGISTRATION_BUNDLE_BYTES)
        self.assertLess(len(canonical_json_bytes({key: value for key, value in args.items() if key != 'authorize'})), 4096)
        original_conversion = (self.jobs.job_root(self.job_id) / 'conversion.json').read_bytes()
        saved = self.results.write_wiki(self.job_id, **args)
        self.assertTrue(saved['saved'])
        snapshot = self.store.read('pump.md')
        self.assertEqual(snapshot.content, parts['data/registration.md'])
        self.assertEqual(parse_document(snapshot.content).body, self.text)
        request_path = self.jobs.job_root(self.job_id) / 'results' / args['request_id'] / 'component-0.txt'
        payload = json.loads(request_path.read_text())
        self.assertNotIn('content', payload)
        self.assertEqual(payload['content_ref'], args['content_ref'])
        self.assertLess(request_path.stat().st_size, 4096)
        graph_args, graph_manifest, graph_parts = self.prepare('extract_ontology')
        self.assertEqual(graph_manifest['input_mode'], contracts.REGISTRATION_REFERENCE_MODE)
        self.assertEqual(json.loads(graph_parts['data/context.json'])['documents'][0]['source']['content'], snapshot.content)
        self.assertEqual(graph_manifest['previous_result']['source_revision'], snapshot.revision)
        changed = self.store.save('pump.md', snapshot.content + 'A new condition.\n', expected_revision=snapshot.revision)
        self.assertIsNotNone(changed.history_path)
        self.assertEqual(changed.history_path.read_text(), snapshot.content)
        _, _, old_parts = files.load(self.store, self.jobs.job_root(self.job_id) / 'inputs' / graph_args['bundle_id'],
                                     expected_revision=graph_args['bundle_revision'])
        self.assertEqual(json.loads(old_parts['data/context.json'])['documents'][0]['source']['content'], snapshot.content)
        before = json.loads(original_conversion)
        after = json.loads((self.jobs.job_root(self.job_id) / 'conversion.json').read_bytes())
        self.assertEqual({key: value for key, value in after.items() if key != 'first_markdown'},
                         {key: value for key, value in before.items() if key != 'first_markdown'})
        self.assertEqual(self.query()['result_summary']['status'], 'partial')

    def test_reference_receipt_loss_replays_without_a_second_save(self):
        self.large()
        args, _, _ = self.reference_args()
        write = self.results._write_receipt
        def lose_final(path, value):
            if value['state'] == 'complete':
                raise OSError('isolated final receipt interruption')
            return write(path, value)
        with patch.object(self.results, '_write_receipt', side_effect=lose_final):
            saved = self.results.write_wiki(self.job_id, **args)
        self.assertTrue(saved['saved'])
        self.assertEqual(saved['state'], 'pending_reconcile')
        with patch.object(self.store, 'save', side_effect=AssertionError('must not repeat successful Wiki save')):
            replayed = self.results.write_wiki(self.job_id, **args)
            queried = self.results.query(self.job_id, **self.scope, request_id=args['request_id'], authorize=self.auth)
        self.assertTrue(replayed['saved']); self.assertEqual(queried['state'], 'complete')

    def test_reference_hash_permission_and_fixed_target_are_checked(self):
        self.new(); self.claim()
        args, _, _ = self.reference_args()
        wrong = deepcopy(args['content_ref']); wrong['sha256'] = '0' * 64
        with self.assertRaises(ResultError) as failed:
            self.results.write_wiki(self.job_id, **{**args, 'content_ref': wrong})
        self.assertEqual(failed.exception.code, 'preservation_content_mismatch')
        self.assertFalse((self.store.wiki_dir / 'pump.md').exists())
        fresh, _, _ = self.reference_args()
        self.actor['access_revision'] = 'c' * 64
        with self.assertRaises(ResultError) as failed:
            self.results.write_wiki(self.job_id, **fresh)
        self.assertEqual(failed.exception.code, 'access_basis_changed')
        self.assertFalse((self.store.wiki_dir / 'pump.md').exists())

    def test_reference_cannot_replace_changed_wiki_or_reuse_request_body(self):
        self.new(); self.claim()
        args, _, _ = self.reference_args()
        created = self.store.save('pump.md', 'Concurrent user document.\n', expected_revision=None)
        with self.assertRaises(ResultError):
            self.results.write_wiki(self.job_id, **args)
        self.assertEqual(self.store.read('pump.md').revision, created.revision)
        altered = {**args, 'content_ref': {**args['content_ref'], 'sha256': '0' * 64}}
        with self.assertRaises(ResultError) as error:
            self.results.write_wiki(self.job_id, **altered)
        self.assertEqual(error.exception.code, 'request_conflict')

    def test_ordinary_input_budget_and_exactly_one_content_remain_enforced(self):
        self.new(); self.claim()
        args, manifest, _ = self.reference_args()
        self.assertNotIn('input_mode', manifest)
        model = {key: value for key, value in args.items() if key not in {'tenant', 'user_id', 'authorize'}}
        model['job_id'] = self.job_id
        self.assertEqual(WikiSubmit.model_validate(model).content_ref, args['content_ref'])
        for changes in ({'content': 'Both values'}, {'content_ref': None},
                        {'content_ref': {'component': '../other', 'sha256': '0' * 64}}):
            with self.assertRaises(ValueError):
                WikiSubmit.model_validate({**model, **changes})
        content = 'x' * contracts.MAX_BUNDLE_BYTES
        ordinary = {'components': files.descriptors({'ordinary': content})}
        with self.assertRaises(contracts.InputLimitError):
            files.publish(self.store, self.store.data_dir / '_test-input-budget', ordinary, {'ordinary': content})
        with self.assertRaises(contracts.InputCorruptError):
            files.bundle_budget({**ordinary, 'input_mode': contracts.REGISTRATION_REFERENCE_MODE,
                                 'input_budget_bytes': contracts.MAX_REGISTRATION_BUNDLE_BYTES})


class RegistrationReferenceMCPTests(unittest.TestCase):
    def test_reference_is_a_real_mcp_argument_and_keeps_replay_receipt(self):
        from core.tests.poc_mcp import test_compact_responses as transport_fixtures
        transport = transport_fixtures.CompactAnalysisTransport(methodName='runTest')
        self.addCleanup(transport.doCleanups)
        transport.setUp()
        args, manifest = transport.input('prepare_wiki')
        args.update(expected_revision=None, content_ref=dict(component='data/registration.md',
            sha256=manifest['components']['data/registration.md']['sha256']))
        saved = transport.call('analysis_job_wiki_write', **args, response_mode='compact')
        self.assertTrue(saved['ok'], saved)
        self.assertTrue(saved['saved'])
        replay = transport.call('analysis_job_wiki_write', **args)
        self.assertTrue(replay['ok'], replay)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], saved['receipt'])
        queried = transport.call('analysis_job_result_query', request_id=args['request_id'])
        self.assertEqual(queried['receipt'], saved['receipt'])
        self.assertEqual(queried['state'], 'complete')


if __name__ == '__main__':
    unittest.main()
