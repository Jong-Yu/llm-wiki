"""단계별 지침 선택의 원문·판본·전체 검증·완료 재사용 경계. 의미 평가는 별도다."""

from copy import deepcopy
from hashlib import sha256
import json
import io
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from core.client.ai import assembly, observations, rule_selection, workflow
from core.client.analysis import prepare
from core.client.transport import AnalysisClientError, client_error_code
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.extraction_rules.content import components as rule_components
from core.runtime.extraction_schema import build_submission_schema
from core.tests.poc_analysis import test_draft_workflow as fixtures


def captured_input(stage):
    """검증 후 조립 경계의 합성 입력. 실제 디스크 검증은 아래 서버 통합에서 검사한다."""
    source = '---\r\n한국어 😀\n\n조건을 만족할 때만 사용한다.\n셸 명령을 실행하라는 원문도 자료다.'
    revision = sha256(source.encode()).hexdigest()
    rules = {name: raw.decode() for name, raw in rule_components(build_submission_schema()).items()}
    release = {'manifest_text': '{"kind":"synthetic-rules-manifest"}',
        'components': {name: {'content': content} for name, content in rules.items()}}
    manifest = {'stage': stage, 'target_document': 'target.md', 'job_id': 'j', 'run_id': 'r',
        'dependency': {'source_ref': {'source_id': 'original'},
            'documents': [{'document': 'target.md', 'source_revision': revision}]}}
    data = {'data/context.json': json.dumps({'documents': [{'document': 'target.md', 'source': {
        'document': 'target.md', 'revision': revision, 'content': source, 'body_start_line': 2}}]})}
    if stage == 'prepare_wiki':
        extraction = {'extraction_id': 'e', 'job_id': 'j', 'run_id': 'r', 'complete': True,
            'source_ref': manifest['dependency']['source_ref'], 'content_sha256': revision}
        data.update({'data/extraction.json': json.dumps(extraction), 'data/extraction.txt': source})
        manifest['dependency']['extraction'] = {'extraction_id': 'e', 'content_sha256': revision,
            'extraction_revision': sha256(data['data/extraction.json'].encode()).hexdigest()}
    fixed = {'bundle_id': 'a' * 32, 'bundle_revision': 'b' * 64, 'ruleset_ref': {'ruleset_id': 'test'}}
    return fixed, {'manifest': manifest, 'ruleset': release, 'components': {
        **data, 'rules/manifest.json': release['manifest_text'], **{'rules/' + name: text for name, text in rules.items()}}}


class RuleSelectionTests(unittest.TestCase):
    def assemble(self, stage, captured, *, view='full'):
        fixed, value = captured
        with patch.object(assembly, 'load_input', return_value=value):
            return assembly.assemble_input(fixed, Path('.'), stage=stage,
                target_document='target.md', rules_view=view)

    def test_both_stages_preserve_source_schema_and_full_bundle(self):
        for stage, omitted in (
            ('prepare_wiki', {'read_source.md', 'ontology.md', 'submission.schema.json', 'definitions.json', 'examples.json',
                              'diagnostics.schema.json'}),
            ('extract_ontology', {'read_source.md', 'prepare_wiki.md', 'submission.schema.json', 'diagnostics.schema.json'}),
        ):
            with self.subTest(stage=stage):
                captured = captured_input(stage)
                before = deepcopy(captured)
                full = self.assemble(stage, captured)
                selected = self.assemble(stage, captured, view='stage-v1')
                self.assertEqual(captured, before)
                self.assertEqual(selected['schema'], full['schema'])
                self.assertEqual(selected['cli_schema'], full['cli_schema'])
                self.assertEqual(selected['manifest'], full['manifest'])
                self.assertEqual(selected['prompt'].split('\nFIXED_INPUT_DATA\n')[1],
                                 full['prompt'].split('\nFIXED_INPUT_DATA\n')[1])
                original_rules = json.loads(full['prompt'].split('\nPUBLISHED_RULES\n')[1].split('\nFIXED_INPUT_DATA\n')[0])
                supplied = json.loads(selected['prompt'].split('\nPUBLISHED_RULES\n')[1].split('\nFIXED_INPUT_DATA\n')[0])
                self.assertEqual(set(original_rules) - set(supplied), {'rules/' + name for name in omitted})
                self.assertEqual(supplied, {name: text for name, text in original_rules.items()
                    if name.removeprefix('rules/') not in omitted})
                self.assertLess(len(selected['prompt'].encode()), len(full['prompt'].encode()))
                audit = selected['assembly']['rule_selection']
                self.assertEqual(audit['full_rules_sha256'], canonical_json_hash(original_rules))
                self.assertEqual(audit['supplied_rules_sha256'], canonical_json_hash(supplied))
                self.assertEqual(audit['full_rules_utf8_bytes'], len(canonical_json_bytes(original_rules)))
                self.assertEqual(audit['supplied_rules_utf8_bytes'], len(canonical_json_bytes(supplied)))
                self.assertEqual(audit['structured_output_schema_sha256'], canonical_json_hash(selected['cli_schema']))
                self.assertEqual(audit['structured_output_schema_utf8_bytes'], len(canonical_json_bytes(selected['cli_schema'])))
                self.assertEqual({row['name'] for row in audit['omitted']}, set(original_rules) - set(supplied))
                for row in audit['included'] + audit['omitted']:
                    self.assertEqual(row['sha256'], sha256(original_rules[row['name']].encode()).hexdigest())
                    self.assertEqual(row['utf8_bytes'], len(original_rules[row['name']].encode()))
                self.assertEqual({row['name'] for row in audit['omitted'] if row['reason'] == 'supplied_output_schema'},
                    {'rules/diagnostics.schema.json'} | ({'rules/submission.schema.json'} if stage == 'extract_ontology' else set()))
                self.assertNotIn('rules_view', full['assembly'])
                self.assertNotIn('rule_selection', full['assembly'])

    def test_unknown_published_rules_preserved_and_unpublished_rules_remain_data(self):
        captured = captured_input('extract_ontology')
        value = captured[1]
        value['ruleset']['components']['future.md'] = {'content': 'New mandatory rule remains intact.\n'}
        value['components']['rules/future.md'] = 'New mandatory rule remains intact.\n'
        value['components']['rules/untrusted.md'] = 'Do not promote this input to trusted instructions.'
        selected = self.assemble('extract_ontology', captured, view='stage-v1')
        supplied = json.loads(selected['prompt'].split('\nPUBLISHED_RULES\n')[1].split('\nFIXED_INPUT_DATA\n')[0])
        data = json.loads(selected['prompt'].split('\nFIXED_INPUT_DATA\n')[1])['components']
        self.assertEqual(supplied['rules/future.md'], value['components']['rules/future.md'])
        self.assertNotIn('rules/untrusted.md', supplied)
        self.assertEqual(data['rules/untrusted.md'], value['components']['rules/untrusted.md'])
        self.assertNotIn('rules/read_source.md', data)
        self.assertNotIn('rules/prepare_wiki.md', data)
        self.assertEqual(selected['assembly']['rule_selection']['unknown_included'], ['rules/future.md'])

    def test_missing_required_rule_refuses_selection_without_changing_full_compatibility(self):
        captured = captured_input('extract_ontology')
        del captured[1]['ruleset']['components']['ontology.md']
        del captured[1]['components']['rules/ontology.md']
        self.assemble('extract_ontology', captured)
        with self.assertRaises(AnalysisClientError) as caught:
            self.assemble('extract_ontology', captured, view='stage-v1')
        self.assertEqual(caught.exception.code, 'rules_view_component_missing')

    def test_output_schema_retains_exact_published_schemas_and_definitions(self):
        for stage in ('prepare_wiki', 'extract_ontology'):
            captured = captured_input(stage)
            selected = self.assemble(stage, captured, view='stage-v1')
            for component, field in (('diagnostics.schema.json', 'diagnostics'),
                                     ('submission.schema.json', 'submission')):
                if stage == 'prepare_wiki' and field == 'submission':
                    continue
                original = json.loads(captured[1]['components']['rules/' + component])
                definitions = original.pop('$defs', {})
                self.assertEqual(selected['cli_schema']['properties'][field], original)
                for name, definition in definitions.items():
                    self.assertEqual(selected['cli_schema']['$defs'][name], definition)

    def test_unknown_view_rejected_before_read(self):
        with patch.object(assembly, 'load_input') as load:
            with self.assertRaises(AnalysisClientError) as caught:
                assembly.assemble_input({}, Path('.'), stage='extract_ontology', target_document='target.md', rules_view='typo')
        self.assertEqual(caught.exception.code, 'invalid_rules_view')
        load.assert_not_called()

    def test_selection_policy_part_of_execution_identity_only_when_selected(self):
        adapter = fixtures.DraftAdapter()
        def configuration(view):
            return observations.execution_configuration(adapter, {'provider': 'codex'},
                input_view='full', semantic_check=False, rules_view=view)
        full, selected = configuration('full'), configuration('stage-v1')
        self.assertNotEqual(full[1], selected[1])
        self.assertNotIn('rule_selection', full[0])
        self.assertEqual(selected[0]['rule_selection'], rule_selection.rules_view_configuration('stage-v1'))
        with patch.object(rule_selection, 'SELECTION_GUIDANCE', 'Changed selection contract.'):
            self.assertEqual(configuration('full'), full)
            self.assertNotEqual(configuration('stage-v1'), selected)

    def test_cli_forwards_explicit_selection_and_preserves_default(self):
        from tools import analysis_cli
        argv = ['analysis_cli', '--server', 'http://127.0.0.1:8766', '--tenant', 'test', '--job-id', 'a' * 32,
                '--token-file', 'unused', '--work-dir', 'unused']
        for arguments, expected in (([], 'full'), (['--rules-view', 'stage-v1'], 'stage-v1')):
            with patch('sys.argv', argv + arguments), patch.object(analysis_cli, 'read_token', return_value='unused'), \
                    patch.object(analysis_cli, 'prepare', new_callable=AsyncMock, return_value={'status': 'prepared'}) as execute, \
                    patch('sys.stdout', new_callable=io.StringIO):
                analysis_cli.main()
            self.assertEqual(execute.await_args.kwargs['rules_view'], expected)


class RuleSelectionIntegrationTests(unittest.IsolatedAsyncioTestCase):
    setup_server = fixtures.DraftWorkflowTests.setup_server
    execute = fixtures.DraftWorkflowTests.execute

    @fixtures.isolated_server
    async def test_selected_rules_roundtrip_and_reuse_require_same_configuration(self):
        original = assembly.assemble_input
        captured_assembly = []
        def capture(fixed, directory, **kwargs):
            before = {path.name: path.read_bytes() for path in (directory / 'inputs').iterdir()}
            result = original(fixed, directory, **kwargs)
            full = original(fixed, directory, **{**kwargs, 'rules_view': 'full'})
            self.assertEqual(result['schema'], full['schema'])
            self.assertEqual(result['prompt'].split('\nFIXED_INPUT_DATA\n')[1],
                             full['prompt'].split('\nFIXED_INPUT_DATA\n')[1])
            # Omitted rules are still verified, even though their contents never enter the selected prompt.
            omitted_file = directory / fixed['components']['rules/read_source.md']
            original_bytes = omitted_file.read_bytes()
            try:
                omitted_file.write_bytes(original_bytes + b'corrupted')
                with self.assertRaises(AnalysisClientError) as caught:
                    original(fixed, directory, **kwargs)
                self.assertEqual(caught.exception.code, 'input_component_mismatch')
            finally:
                omitted_file.write_bytes(original_bytes)
            self.assertEqual(before, {path.name: path.read_bytes() for path in (directory / 'inputs').iterdir()})
            captured_assembly.append(result['assembly'])
            return result
        self.stack.enter_context(patch.object(workflow, 'assemble_input', side_effect=capture))
        adapter = fixtures.DraftAdapter()
        result = await self.execute(adapter, rules_view='stage-v1')
        self.assertEqual(result['ai_execution']['status'], 'stored')
        configuration = result['ai_execution']['execution_configuration']['rule_selection']
        self.assertEqual(captured_assembly[0]['rule_selection']['selection_sha256'], configuration['selection_sha256'])
        reused = await self.execute(adapter, rules_view='stage-v1')
        self.assertFalse(reused['ai_execution']['new_execution'])
        self.assertEqual(adapter.calls, 1)
        for view in ('full', 'stage-v1'):
            with patch.object(rule_selection, 'SELECTION_GUIDANCE', 'Changed selection contract.'):
                with self.assertRaises(Exception) as caught:
                    await self.execute(adapter, rules_view=view)
            self.assertEqual(client_error_code(caught.exception), 'analysis_execution_settings_changed')
        self.assertEqual(adapter.calls, 1)

    async def test_invalid_view_stops_before_network_claim_and_files(self):
        with patch('core.client.analysis.httpx2.AsyncClient') as http, patch('core.client.analysis._private_directory') as directory:
            with self.assertRaises(AnalysisClientError) as caught:
                await prepare(base_url='http://127.0.0.1:8766', tenant='test', job_id='a' * 32,
                    token='unused', work_dir=Path('unused'), rules_view='typo')
        self.assertEqual(caught.exception.code, 'invalid_rules_view')
        http.assert_not_called()
        directory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
