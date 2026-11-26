"""그림 복구 CLI의 단일 결과·안전한 오류와 실제 재조립 작업자를 검증한다."""

import asyncio
from contextlib import redirect_stdout
from hashlib import sha256
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from core.client import source_image_recovery as recovery
from core.client.transport import AnalysisClientError
from core.runtime.client_platform import private_directory, write_new
from core.tests.poc_analysis.test_source_image_recovery import image_bytes, recovery_package, LOW_TEXT, NORMAL_TEXT
from tools import source_image_recovery_cli as cli


class RecoveryCliTests(unittest.TestCase):
    def arguments(self):
        return ['source_image_recovery_cli', '--server', 'https://example.test', '--tenant', 'alpha',
                '--profile', 'member', '--token-file', '/private/token', '--request-file', '/private/request',
                '--work-dir', '/private/work', '--ai-provider', 'claude', '--ai-cli', '/personal/claude',
                '--ai-model', 'chosen-model', '--timeout', '240']

    def test_one_terminal_preserves_ai_arguments_without_token_in_output(self):
        terminal = {'schema_version': 1, 'type': 'result', 'ok': True, 'units': []}
        operation = AsyncMock(return_value=terminal)
        output = StringIO()
        with patch('sys.argv', self.arguments()), patch.object(cli, 'read_request', return_value={'units': []}), \
                patch.object(cli, 'read_token', return_value='secret-' + 'a' * 40), \
                patch.object(cli, 'recover_images', operation), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], [terminal])
        self.assertNotIn('secret', output.getvalue())
        arguments = operation.await_args.kwargs
        self.assertEqual((arguments['provider'], arguments['cli'], arguments['model']),
                         ('claude', '/personal/claude', 'chosen-model'))
        self.assertEqual(arguments['ocr_language'], 'kor+eng')

    def test_failures_are_one_fixed_code_without_raw_exception(self):
        for error, expected in ((AnalysisClientError('api_request_failed'), 'api_request_failed'),
                                (ValueError('secret-token-raw'), 'image_recovery_client_failed')):
            with self.subTest(expected=expected):
                output = StringIO()
                with patch('sys.argv', self.arguments()), patch.object(cli, 'read_request', side_effect=error), \
                        redirect_stdout(output):
                    self.assertEqual(cli.main(), 1)
                self.assertEqual(json.loads(output.getvalue()), {'schema_version': 1, 'type': 'error', 'ok': False,
                                                               'error': {'code': expected}})
                self.assertEqual(len(output.getvalue().splitlines()), 1)
                self.assertNotIn('secret', output.getvalue())

    def test_invalid_arguments_still_return_jsonl(self):
        output = StringIO()
        with patch('sys.argv', ['source_image_recovery_cli', '--unexpected', 'secret']), redirect_stdout(output):
            self.assertEqual(cli.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['error']['code'], 'image_recovery_invalid_arguments')
        self.assertNotIn('secret', output.getvalue())


class RecoveryWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_owned_subprocess_reassembles_cached_selected_slide_without_ocr(self):
        with TemporaryDirectory() as temporary:
            directory = private_directory(Path(temporary).resolve())
            low, normal = image_bytes('white'), image_bytes('black')
            original = directory / 'original'
            original_bytes = recovery_package(low, normal)
            write_new(original, original_bytes)
            low_id, normal_id = sha256(low).hexdigest(), sha256(normal).hexdigest()
            cache = {'pictures': {low_id: {'text': LOW_TEXT, 'low_confidence': True},
                                  normal_id: {'text': NORMAL_TEXT, 'low_confidence': False}}, 'image_ids': {}}
            write_new(directory / 'ocr-cache.json', recovery._json_bytes(cache))
            baseline = recovery._convert(original, [2], lambda raw: cache['pictures'][sha256(raw).hexdigest()], None)
            write_new(directory / 'fixed-units.json', recovery._json_bytes(baseline['units']))
            recovery._fix_slots(original, [2], directory, cache['pictures'], [{'id': low_id}], None)
            replacements = {low_id: {'id': low_id, 'text': '복구 후보의 @코드', 'unread': []}}
            report = await recovery._run_conversion('assemble', original, [2], directory, 'kor+eng', None, replacements)
            self.assertEqual([unit['unit_id'] for unit in report['units']], ['slide-2'])
            content = report['units'][0]['content']
            self.assertIn('내장 문자 2: ' + LOW_TEXT, content)
            self.assertIn('[그림 속 글자 · AI 전사 후보]\n복구 후보의 @코드', content)
            self.assertIn('[그림 속 글자 · OCR]\n' + NORMAL_TEXT, content)
            self.assertIn('발표자 노트 2의 조건', content)
            self.assertEqual(original.read_bytes(), original_bytes)

    async def test_worker_environment_excludes_server_token_and_api_keys(self):
        with TemporaryDirectory() as temporary:
            directory = private_directory(Path(temporary).resolve())
            execute = AsyncMock(return_value=(0, b'{"images":[]}', b''))
            with patch.dict('os.environ', {'WIKI_TOKEN': 'secret-wiki', 'ANTHROPIC_API_KEY': 'secret-ai',
                                            'OPENAI_API_KEY': 'secret-openai'}), patch.object(recovery, '_execute', execute):
                await recovery._run_conversion('prepare', directory / 'original', [1], directory, 'kor+eng', None)
            environment = execute.await_args.kwargs['environment']
            for key in ('WIKI_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'):
                self.assertNotIn(key, environment)
            self.assertNotIn(b'secret', execute.await_args.kwargs['prompt'])


if __name__ == '__main__':
    unittest.main()
