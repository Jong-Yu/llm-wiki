"""추출안 실행·진단 연결의 소유권/CAS/보존과 실제 격리 HTTP 경계를 검사한다."""
import asyncio
from copy import deepcopy
import json
import socket
import sys
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from core.api.dependencies import access_value
from core.common.json_codec import canonical_json_hash
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_proposals.executions import ProposalExecutionStore, ensure_proposal_job_draft
from core.modules.analysis_proposals.store import ProposalStore
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.analysis_results.store import ResultStore
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema
from core.tests.api import test_analysis_proposals_api as fixture


class ProposalExecutionTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.AnalysisProposalApiTests.save_policy
    headers = fixture.AnalysisProposalApiTests.headers
    client = fixture.AnalysisProposalApiTests.client
    nothing = fixture.AnalysisProposalApiTests.nothing
    value = fixture.AnalysisProposalApiTests.value
    current = fixture.AnalysisProposalApiTests.current
    graph_bytes = fixture.AnalysisProposalApiTests.graph_bytes
    prepare = fixture.AnalysisProposalApiTests.prepare
    read = fixture.AnalysisProposalApiTests.read
    apply = fixture.AnalysisProposalApiTests.apply

    def setUp(self):
        fixture.AnalysisProposalApiTests.setUp(self)
        self.config['users']['alice']['memberships']['alpha']['permissions'].append('source_write')
        self.save_policy()
        self.rules_root, self.rules_policy = self.root / 'rules', self.root / 'rules-policy.json'
        schema = build_submission_schema()
        self.reference = {'ruleset_id': 'wiki', 'ruleset_version': '1'}
        publish(self.rules_root, tenant_root=self.tenant_root, reason='isolated proposal test',
                schema=schema, expected_schema=schema, **self.reference)
        self.rules_config = {'version': 1, 'tenants': {'alpha': {
            'default': self.reference, 'allowed': [self.reference], 'revoked': []}}}
        self.rules_policy.write_text(json.dumps(self.rules_config))
        self.rulesets = RulesetRegistry(self.rules_root, self.rules_policy, self.tenant_root, expected_schema=schema)
        self.app.state.rulesets = self.rulesets

    def authorize(self, permission='ontology_write'):
        return access_value(self.policy.authorize(self.tokens['alice'], 'alpha', permission))

    def url(self, proposal):
        return self.base + '/analysis-proposals/' + proposal['proposal_id']

    def start_body(self, proposal):
        return {'request_id': uuid4().hex, 'expected_state_revision': proposal['state_revision'],
            'candidate_revision': None if proposal['candidate_ref'] is None else proposal['candidate_ref']['candidate_revision'],
            'reason': '합성 재추출 실행'}

    async def start(self, http, proposal):
        body = self.start_body(proposal)
        execution = self.value(await http.post(self.url(proposal) + '/executions', json=body))
        self.assertEqual(execution['state'], 'ready')
        self.assertFalse(execution['execution_started'])
        return execution, body, await self.read(http, proposal['proposal_id'])

    def result(self, execution, submission=None, *, diagnostics=None, prepared=None):
        jobs = JobStore(self.store, rulesets=self.rulesets)
        if prepared is None:
            claimed = jobs.claim(execution['job_id'], tenant='alpha', user_id='alice',
                expected_job_revision=execution['job_revision'], authorize=self.authorize)
            prepared = InputStore(self.store, self.rulesets, jobs=jobs).prepare(execution['job_id'], tenant='alpha',
                user_id='alice', run_id=claimed['run_id'], expected_job_revision=claimed['job_revision'],
                stage='extract_ontology', authorize=self.authorize)
        submission = deepcopy(fixture.GRAPH if submission is None else submission)
        args = {'tenant': 'alpha', 'user_id': 'alice', 'run_id': prepared['run_id'],
            'expected_job_revision': prepared['job_revision'], 'bundle_id': prepared['bundle_id'],
            'bundle_revision': prepared['bundle_revision'], 'request_id': uuid4().hex,
            'document': 'target.md', 'expected_revision': self.store.read('target.md').revision,
            'submission': submission, 'save': False, 'authorize': self.authorize,
            'expected_state_revision': self.current()['state_revision'], 'diagnostics': diagnostics}
        result = ResultStore(self.store, self.rulesets, jobs=jobs).generate_ontology(execution['job_id'], **args)
        ref = {key: args[key] for key in ('run_id', 'bundle_id', 'bundle_revision', 'request_id')}
        ref.update(job_id=execution['job_id'], payload_hash=result['submission_ref']['payload_hash'],
                   submission_sha256=canonical_json_hash(submission))
        return ref, prepared, args

    def link_body(self, proposal, execution, ref, mode='candidate'):
        return {**self.start_body(proposal), 'execution_id': execution['execution_id'], 'mode': mode,
                'result_ref': ref} | {'reason': None}

    async def link(self, http, proposal, execution, ref, mode='candidate', status=200, body=None):
        if body is None:
            body = self.link_body(proposal, execution, ref, mode)
            del body['reason']
        result = self.value(await http.post(self.url(proposal) + '/result-links', json=body), status)
        return result, body

    async def test_execution_candidate_diagnostics_apply_and_exact_receipts(self):
        before = self.graph_bytes()
        async with self.client() as http:
            proposal = await self.prepare(http, None)
            execution, start_body, proposal = await self.start(http, proposal)
            replay = self.value(await http.post(self.url(proposal) + '/executions', json=start_body))
            self.assertEqual(replay['job_id'], execution['job_id'])
            ref, prepared, _ = self.result(execution, diagnostics=empty_report())
            linked, body = await self.link(http, proposal, execution, ref)
            self.assertEqual(linked['submission'], fixture.GRAPH)
            self.assertEqual(linked['result_links'][0]['result_ref']['submission_sha256'], canonical_json_hash(fixture.GRAPH))
            self.assertEqual(before, self.graph_bytes())
            semantic_ref, _, _ = self.result(execution, diagnostics=empty_report(), prepared=prepared)
            reported, report_body = await self.link(http, linked, execution, semantic_ref, 'diagnostics')
            self.assertEqual(len(reported['result_links']), 2)
            report = reported['current_reports'][-1]['report']
            self.assertFalse(report['diagnostics']['human_approval'])
            self.assertEqual(report['diagnostics']['validation'], 'structure_and_source_checked')
            self.assertEqual(before, self.graph_bytes())
            repeated, _ = await self.link(http, reported, execution, semantic_ref, body=report_body)
            self.assertTrue(repeated['replayed'])
            self.assertEqual(len(repeated['result_links']), 2)
            applied, _ = await self.apply(http, reported)
            self.assertTrue(applied['saved'])
            self.config['users']['alice']['memberships']['alpha']['permissions'] = ['read']
            self.save_policy()
            receipt = self.value(await http.get(self.url(proposal) + '/requests/' + body['request_id']))
            self.assertEqual(receipt['state'], 'complete')
            self.assertEqual(receipt['result_ref']['payload_hash'], ref['payload_hash'])
            self.value(await http.get(self.url(proposal) + '/executions/' + execution['execution_id']))

    async def test_wrong_owner_profile_hash_and_same_document_other_execution_rejected(self):
        before = self.graph_bytes()
        async with self.client() as http:
            proposal = await self.prepare(http, fixture.GRAPH)
            execution, _, proposal = await self.start(http, proposal)
            ref, _, _ = self.result(execution)
            other = await self.prepare(http, fixture.GRAPH)
            other_execution, _, other = await self.start(http, other)
            await self.link(http, other, other_execution, ref, status=409)
            await self.link(http, proposal, execution, {**ref, 'payload_hash': '0' * 64}, status=409)
            await self.link(http, proposal, execution, {**ref, 'submission_sha256': '0' * 64}, status=409)
            url = self.url(proposal) + '/executions/' + execution['execution_id']
            self.value(await http.get(url, headers=self.headers('carol')), 404)
            self.value(await http.get(url, headers=self.headers('bob')), 403)
            self.value(await http.get(url + '?profile=business'), 403)
            self.assertEqual(before, self.graph_bytes())

    async def test_cancel_supersede_candidate_edit_and_source_aba_preserve_results(self):
        async with self.client() as http:
            for action in ('cancel', 'supersede', 'candidate', 'source_aba'):
                with self.subTest(action=action):
                    proposal = await self.prepare(http, fixture.GRAPH)
                    execution, _, proposal = await self.start(http, proposal)
                    ref, prepared, _ = self.result(execution)
                    if action == 'cancel':
                        self.value(await http.post(self.base + '/analysis-jobs/' + execution['job_id'] + '/cancel',
                            json={'expected_job_revision': prepared['job_revision'], 'reason': 'cancel test'}))
                    elif action == 'supersede':
                        _, _, proposal = await self.start(http, proposal)
                    elif action == 'candidate':
                        proposal = self.value(await http.post(self.url(proposal) + '/submissions', json={
                            'request_id': uuid4().hex, 'expected_state_revision': proposal['state_revision'],
                            'submission': fixture.GRAPH}))
                    else:
                        old = self.store.read('target.md')
                        changed = self.store.save('target.md', old.content + '변경\n', expected_revision=old.revision)
                        self.store.save('target.md', old.content, expected_revision=changed.revision)
                    before = self.graph_bytes()
                    await self.link(http, proposal, execution, ref, status=409)
                    receipt = self.value(await http.get(self.base + '/analysis-jobs/' + execution['job_id'] + '/results/' + ref['request_id']))
                    self.assertEqual(receipt['state'], 'draft')
                    self.assertEqual(before, self.graph_bytes())

    async def test_report_link_failure_exact_recovery_keeps_candidate_and_raw_files(self):
        async with self.client() as http:
            proposal = await self.prepare(http, None)
            execution, _, proposal = await self.start(http, proposal)
            ref, _, _ = self.result(execution, diagnostics=empty_report())
            body = self.link_body(proposal, execution, ref); del body['reason']
            original = ProposalStore._write
            def fail(service, path, state):
                if body['request_id'] in state['requests']:
                    raise OSError('injected result link failure')
                return original(service, path, state)
            with patch.object(ProposalStore, '_write', fail):
                await self.link(http, proposal, execution, ref, body=body, status=500)
            receipt = self.value(await http.get(self.url(proposal) + '/requests/' + body['request_id']))
            self.assertEqual(receipt['state'], 'published_unlinked')
            root = ProposalStore(self.store, self.authorize(), rulesets=self.rulesets)._path(proposal['proposal_id'])
            immutable = {str(p): p.read_bytes() for p in root.rglob('*') if p.is_file() and p.name != 'state.json'}
            linked, _ = await self.link(http, proposal, execution, ref, body=body)
            self.assertEqual(linked['candidate_ref'], receipt['candidate_ref'])
            self.assertEqual(immutable, {str(p): p.read_bytes() for p in root.rglob('*') if p.is_file() and p.name != 'state.json'})

    async def test_execution_intent_failure_replays_only_exact_request(self):
        async with self.client() as http:
            proposal = await self.prepare(http, None)
            body = self.start_body(proposal)
            with patch.object(ProposalStore, '_write', side_effect=OSError('injected intent linkage failure')):
                self.value(await http.post(self.url(proposal) + '/executions', json=body), 500)
            read = self.value(await http.get(self.url(proposal) + '/executions/' + body['request_id']))
            self.assertFalse(read['linked'])
            self.assertEqual(read['state'], 'pending_reconcile')
            self.value(await http.post(self.url(proposal) + '/executions', json={**body, 'reason': 'different'}), 409)
            recovered = self.value(await http.post(self.url(proposal) + '/executions', json=body))
            self.assertEqual(recovered['state'], 'ready')

    async def test_shared_result_guard_rejects_canonical_save_and_diagnostic_wrong_submission(self):
        async with self.client() as http:
            proposal = await self.prepare(http, fixture.GRAPH)
            execution, _, proposal = await self.start(http, proposal)
            ref, prepared, args = self.result(execution)
            before = self.graph_bytes()
            args.update(save=True, request_id=uuid4().hex)
            from core.modules.analysis_results.contracts import ResultError
            with self.assertRaises(ResultError) as caught:
                ResultStore(self.store, self.rulesets).generate_ontology(execution['job_id'], **args)
            self.assertEqual(caught.exception.code, 'proposal_explicit_apply_required')
            other_graph = {**deepcopy(fixture.GRAPH), 'relations': []}
            diagnostic_ref, _, _ = self.result(execution, submission=other_graph, diagnostics=empty_report(), prepared=prepared)
            await self.link(http, proposal, execution, diagnostic_ref, mode='diagnostics', status=409)
            self.assertEqual(before, self.graph_bytes())

    async def test_actual_http_process_mcp_job_result_to_candidate(self):
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0)); port = reserved.getsockname()[1]
        process = await asyncio.create_subprocess_exec(sys.executable, '-B', '-m', 'core.runtime.http_cli',
            '--access-config', str(self.config_path), '--tenant-root', str(self.tenant_root), '--port', str(port),
            '--ruleset-root', str(self.rules_root), '--ruleset-policy', str(self.rules_policy),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            async with httpx2.AsyncClient(base_url=f'http://127.0.0.1:{port}', headers=self.headers(), trust_env=False, timeout=10) as http:
                deadline = time.monotonic() + 10
                while True:
                    if process.returncode is not None:
                        self.fail('Isolated HTTP process exited')
                    try:
                        if (await http.get('/api/v1/access-context')).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() > deadline:
                        self.fail('Isolated HTTP process startup timeout')
                    await asyncio.sleep(0.05)
                proposal = await self.prepare(http, None)
                execution, _, proposal = await self.start(http, proposal)
                before = self.graph_bytes()
                async with Client(streamable_http_client(f'http://127.0.0.1:{port}/mcp', http_client=http), mode='legacy') as mcp:
                    async def call(name, args):
                        result = await mcp.call_tool(name, args)
                        self.assertFalse(result.is_error, result.structured_content)
                        return result.structured_content
                    common = {'tenant': 'alpha', 'job_id': execution['job_id']}
                    claim = await call('analysis_job_claim', {**common, 'expected_job_revision': execution['job_revision']})
                    common['run_id'] = claim['run_id']
                    prepared = await call('analysis_job_input_prepare', {**common, 'expected_job_revision': claim['job_revision'], 'stage': 'extract_ontology'})
                    raw = {**common, 'expected_job_revision': prepared['job_revision'], 'bundle_id': prepared['bundle_id'],
                        'bundle_revision': prepared['bundle_revision'], 'request_id': uuid4().hex, 'document': 'target.md',
                        'expected_revision': self.store.read('target.md').revision, 'expected_state_revision': self.current()['state_revision'],
                        'submission': fixture.GRAPH, 'save': False, 'diagnostics': empty_report()}
                    result = await call('analysis_job_ontology_generate', raw)
                ref = {key: raw[key] for key in ('job_id', 'run_id', 'bundle_id', 'bundle_revision', 'request_id')}
                ref.update(payload_hash=result['submission_ref']['payload_hash'], submission_sha256=canonical_json_hash(fixture.GRAPH))
                linked, body = await self.link(http, proposal, execution, ref)
                self.assertEqual(linked['submission'], fixture.GRAPH)
                self.assertEqual(before, self.graph_bytes())
                self.value(await http.get(self.url(proposal) + '/requests/' + body['request_id']))
        finally:
            if process.returncode is None:
                process.terminate()
            stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
            self.assertEqual(stdout, b'')
            for token in self.tokens.values():
                self.assertNotIn(token.encode(), stderr)
