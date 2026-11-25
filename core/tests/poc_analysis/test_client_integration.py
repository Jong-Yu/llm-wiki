"""Real API/MCP and personal orchestration, with a clearly synthetic model adapter."""
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx2
from core.common.json_codec import canonical_json_bytes
from core.client.analysis import prepare
from core.modules.access.policy import AccessPolicy
from core.modules.access.auth import initialize_auth
from core.tests.poc_access.fixtures import grant_test_membership
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.modules.analysis_results.diagnostics import empty_report
from core.runtime.application import create_application
from core.runtime.extraction_schema import build_submission_schema
from core.modules.documents.metadata import parse_document
from core.modules.analysis_jobs.store import JobStore
from core.client.transport import AnalysisClientError, client_error_code, tool_call


class SyntheticAdapter:
    def __init__(self):
        self.calls = 0

    async def preflight(self):
        pass

    async def run(self, *, prompt, schema, output_schema, directory):
        self.calls += 1
        data = json.loads(prompt.split('\nFIXED_INPUT_DATA\n', 1)[1])
        assert data['manifest']['stage'] == 'extract_ontology'
        context = json.loads(data['components']['data/context.json'])
        source = context['documents'][0]['source']
        assert source['body_start_line'] > 1
        assert source['revision'] == sha256(source['content'].encode()).hexdigest()
        if self.calls == 1:
            raise AnalysisClientError('synthetic_graph_failure')
        value = dict(submission=dict(schema_version=3, entities=[dict(id='pump', type='physical_object',
            label='pump', evidence='A pump moves water.')], relations=[], relation_candidates=[], attributes=[]),
            diagnostics=empty_report())
        return dict(value=value, execution=dict(provider='codex', cli_version='synthetic-contract-test',
            prompt_sha256=sha256(prompt.encode()).hexdigest(), schema_sha256=sha256(canonical_json_bytes(schema)).hexdigest(),
            output_sha256=sha256(canonical_json_bytes(value)).hexdigest()))


class ClientIntegration(unittest.IsolatedAsyncioTestCase):
    async def test_input_limit_is_retained_without_exposing_remote_error_text(self):
        from core.mcp.results import _error_details, _result
        from core.modules.analysis_inputs.contracts import InputLimitError
        response = _result({'ok': False, 'error': _error_details(
            InputLimitError('private source path'), 'analysis_job_input_prepare')})
        client = SimpleNamespace(call_tool=AsyncMock(return_value=response))
        with self.assertRaises(AnalysisClientError) as stopped:
            await tool_call(client, 'analysis_job_input_prepare', {})
        self.assertEqual(stopped.exception.code, 'input_limit')
        self.assertNotIn('private', str(stopped.exception))
        client.call_tool.assert_awaited_once()
        for value in ({'ok': False, 'error': {'code': 'private-token'}},
                      {'error': {'code': 'input_limit'}},
                      {'ok': False, 'error': 'private path'}):
            client.call_tool.return_value = _result({'ok': False, **value}) if 'ok' in value else SimpleNamespace(
                structured_content=value, is_error=True)
            with self.assertRaises(AnalysisClientError) as hidden:
                await tool_call(client, 'analysis_job_input_prepare', {})
            self.assertEqual(hidden.exception.code, 'mcp_request_failed')

    async def test_signup_http_mcp_registration_personal_flow_and_no_repeat(self):
        await self.registration_flow('full')

    async def test_selected_input_view_real_transport_resume_and_configuration_guard(self):
        await self.registration_flow('current-review-v1')

    async def test_unbound_device_claim_reaches_real_mcp_and_stops_before_ai(self):
        await self.registration_flow('full', execution_claim_id=uuid4().hex)

    async def test_invalid_device_claim_stops_before_network_or_work_directory(self):
        with patch('core.client.analysis.httpx2.AsyncClient') as client:
            with self.assertRaises(AnalysisClientError) as failed:
                await prepare(base_url='http://127.0.0.1:8766', tenant='test', job_id=uuid4().hex,
                    token='not-used', work_dir='/not-used', execution_claim_id='../../wrong')
        self.assertEqual(failed.exception.code, 'invalid_identifier')
        client.assert_not_called()

    async def registration_flow(self, input_view, execution_claim_id=None):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'data').mkdir()
            (root / 'tenancy').mkdir()
            config = root / 'tenancy/policy.json'
            config.write_text(json.dumps(dict(version=1, tenants={}, users={})))
            policy = AccessPolicy(config, root / 'data')
            auth = initialize_auth(policy)
            user = auth.signup('분석 사용자')
            user = grant_test_membership(policy, user)
            tenant = user['default_tenant']
            schema = build_submission_schema()
            publish(root / 'rules', tenant_root=root / 'data', ruleset_id='common', ruleset_version='v1',
                    reason='isolated client contract', schema=schema, expected_schema=schema)
            ref = dict(ruleset_id='common', ruleset_version='v1')
            (root / 'rules-policy.json').write_text(json.dumps(dict(version=1, tenants={tenant: dict(default=ref, allowed=[ref], revoked=[])})))
            rules = RulesetRegistry(root / 'rules', root / 'rules-policy.json', root / 'data', expected_schema=schema)
            app = create_application(policy, auth=auth, rulesets=rules)
            original_client = httpx2.AsyncClient
            transport = httpx2.ASGITransport(app=app)
            def local_client(*args, **kwargs):
                return original_client(*args, transport=transport, **kwargs)
            headers = {'Authorization': 'Bearer ' + user['token']}
            base = 'http://127.0.0.1:8766'
            async with app.router.lifespan_context(app):
                async with original_client(transport=transport, base_url=base, headers=headers) as http:
                    response = await http.post(f'/api/v1/tenants/{tenant}/sources', json=dict(
                        request_id=uuid4().hex, title='Pump', format='txt', content='A pump moves water.\n'))
                    self.assertEqual(response.status_code, 201, response.text)
                    source = response.json()['data']
                    request = dict(request_id=uuid4().hex, title='Pump', document='pump.md',
                        source_ref={key: source[key] for key in ('source_id', 'source_version', 'source_sha256', 'registration_revision')})
                    response = await http.post(f'/api/v1/tenants/{tenant}/analysis-jobs/registrations', json=request)
                    self.assertEqual(response.status_code, 201, response.text)
                    created = response.json()['data']
                    replay = await http.post('/mcp', headers={'Accept': 'application/json, text/event-stream'},
                        json=dict(jsonrpc='2.0', id=1, method='tools/call', params=dict(name='analysis_registration_create',
                            arguments=dict(tenant=tenant, **request))))
                    self.assertEqual(replay.status_code, 200, replay.text)
                    result = replay.json()['result']['structuredContent']
                    self.assertTrue(result['ok'], result)
                    self.assertTrue(result['replayed'])
                    self.assertEqual(result['job_id'], created['job_id'])
                    before = policy.authorize(user['token'], tenant, 'read').access_revision
                    auth.signup('새로 가입한 다른 사용자')
                    self.assertEqual(before, policy.authorize(user['token'], tenant, 'read').access_revision)
                adapter = SyntheticAdapter()
                from core.client.ai import workflow
                actual_tool = workflow.tool_call
                wiki_submissions = []
                claims = []
                async def observe_claim(client, tool, arguments):
                    if tool == 'analysis_job_claim':
                        claims.append(arguments.copy())
                    return await actual_tool(client, tool, arguments)
                async def lose_wiki_response(client, tool, arguments):
                    result = await actual_tool(client, tool, arguments)
                    if tool == 'analysis_job_wiki_write':
                        wiki_submissions.append(arguments['request_id'])
                        raise OSError('simulated transport response loss after commit')
                    return result
                with patch('core.client.analysis.httpx2.AsyncClient', side_effect=local_client), patch.object(
                        workflow, 'tool_call', side_effect=lose_wiki_response), patch(
                        'core.client.analysis.tool_call', side_effect=observe_claim):
                    with self.assertRaises(Exception) as stopped:
                        await prepare(base_url=base, tenant=tenant, job_id=created['job_id'], token=user['token'],
                            work_dir=root / 'work', adapter=adapter, input_view=input_view, execution_claim_id=execution_claim_id)
                    if execution_claim_id is not None:
                        self.assertEqual(client_error_code(stopped.exception), 'mcp_request_failed')
                        self.assertEqual(len(claims), 1)
                        self.assertEqual(claims[0]['execution_claim_id'], execution_claim_id)
                        self.assertEqual(adapter.calls, 0)
                        return
                    self.assertEqual(client_error_code(stopped.exception), 'synthetic_graph_failure')
                    output = await prepare(base_url=base, tenant=tenant, job_id=created['job_id'], token=user['token'],
                        work_dir=root / 'work', adapter=adapter, reclaim=True, input_view=input_view, execution_claim_id=execution_claim_id)
                    again = await prepare(base_url=base, tenant=tenant, job_id=created['job_id'], token=user['token'],
                        work_dir=root / 'work', adapter=adapter, input_view=input_view)
                    with self.assertRaises(Exception) as changed:
                        await prepare(base_url=base, tenant=tenant, job_id=created['job_id'], token=user['token'],
                            work_dir=root / 'work', adapter=adapter,
                            input_view='full' if input_view != 'full' else 'current-review-v1')
                    self.assertEqual(client_error_code(changed.exception), 'analysis_execution_settings_changed')
                self.assertEqual(output['ai_execution']['status'], 'stored')
                self.assertEqual(len(claims), 2)
                for claim in claims:
                    self.assertNotIn('execution_claim_id', claim)
                self.assertFalse(again['ai_execution']['new_execution'])
                self.assertEqual(adapter.calls, 2)
                self.assertEqual(output['ai_execution']['usage_observations']['adapter_call_count'], 1)
                self.assertEqual(again['ai_execution']['usage_observations']['adapter_call_count'], 0)
                for path in (root / 'work').rglob('assembly.json'):
                    assembly = json.loads(path.read_text())
                    self.assertEqual(assembly['input_view'], input_view)
                    self.assertGreater(assembly['sizes']['prompt_utf8_bytes'], 0)
                    self.assertIsNone(assembly['sizes']['actual_token_usage'])
                self.assertEqual(len(wiki_submissions), 1)
                scope = policy.authorize(user['token'], tenant, 'read')
                document = scope.store.read('pump.md')
                self.assertEqual(parse_document(document.content).body, 'A pump moves water.\n')
                job = JobStore(scope.store, rulesets=rules).query(created['job_id'], tenant=tenant, user_id=user['user_id'])
                self.assertEqual(job['conversion']['first_markdown']['revision'], document.revision)
                self.assertEqual(job['result_summary']['status'], 'complete')
                from core.modules.documents.changes import authorship
                authored = authorship(scope.store, 'pump.md', document.revision)
                self.assertEqual(authored['created']['actor']['user_id'], user['user_id'])
                self.assertEqual(authored['created']['origin']['kind'], 'ai')
