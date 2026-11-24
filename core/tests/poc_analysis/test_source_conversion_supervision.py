"""실제 변환 자식의 진행·정지·Windows 조회 충돌을 짧은 시간축으로 검증한다."""

import errno
import asyncio
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.client import source_conversion as conversion


SCRIPT = '''
import sys, time
from pathlib import Path
from core.client.source_conversion_report import Conversion
from core.client.source_conversion_worker import atomic_json
path = Path(sys.argv[1])
count, pause, linger = int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
report = Conversion('pdf', lambda value: atomic_json(path, value))
for page in range(1, count + 1):
    report.add('page-' + str(page), {'kind': 'pages', 'start': page, 'end': page},
               'preserved page ' + str(page), 'pdf_text')
    time.sleep(pause)
time.sleep(linger)
report.finish()
'''


class SupervisionTest(unittest.IsolatedAsyncioTestCase):
    async def worker(self, directory, *, count=4, pause=.05, linger=0,
                     timeout=conversion.MAX_CONVERSION_SECONDS,
                     idle_timeout=conversion.MAX_IDLE_SECONDS, scale=1, script=SCRIPT,
                     check_result_file=True):
        original = directory / 'original'
        original.write_bytes(b'original remains unchanged')
        result_path = directory / 'conversion.json'
        started = time.monotonic()
        # 이 모듈의 시계만 확대해 asyncio의 실제 clock과 자식 sleep은 바꾸지 않는다.
        clock = SimpleNamespace(monotonic=lambda: (time.monotonic() - started) * scale)
        events = []
        with patch.object(conversion, 'time', clock), patch.object(conversion, 'process_arguments',
                return_value=[sys.executable, '-c', script, str(result_path), str(count), str(pause), str(linger)]):
            result = await conversion.run_worker(original, 'pdf', result_path, ocr='never', language='eng',
                timeout=timeout, idle_timeout=idle_timeout, cancel_file=None,
                emit=lambda stage, **values: events.append((stage, values)))
        self.assertEqual(original.read_bytes(), b'original remains unchanged')
        self.assertEqual(list(directory.glob('scratch-*')), [])
        if check_result_file:
            self.assertEqual(json.loads(result_path.read_text()), result)
        return result, events, (time.monotonic() - started) * scale

    async def test_progress_can_pass_the_former_120_second_total_limit(self):
        with TemporaryDirectory() as temporary:
            result, events, elapsed = await self.worker(Path(temporary), count=16, pause=.12, scale=80)
        self.assertGreater(elapsed, 120)
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(len(result['units']), 16)
        self.assertNotIn('worker_failure', result)
        self.assertGreater(len(events), 1)

    async def test_stalled_worker_preserves_completed_pages(self):
        with TemporaryDirectory() as temporary:
            result, _, _ = await self.worker(Path(temporary), count=1, linger=3, idle_timeout=40, scale=80)
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(result['units'][0]['content'], 'preserved page 1')
        self.assertEqual(result['worker_failure']['code'], 'conversion_idle_timeout')
        self.assertFalse(result['complete'])

    async def test_explicit_total_limit_still_stops_an_active_worker(self):
        with TemporaryDirectory() as temporary:
            result, _, _ = await self.worker(Path(temporary), count=20, pause=.1, timeout=60, scale=80)
        self.assertEqual(result['state'], 'partial')
        self.assertGreater(len(result['units']), 0)
        self.assertLess(len(result['units']), 20)
        self.assertEqual(result['worker_failure']['code'], 'conversion_timeout')

    async def test_rewriting_unchanged_checkpoint_does_not_reset_idle_limit(self):
        script = SCRIPT.replace('time.sleep(linger)',
            'for _ in range(50):\n    atomic_json(path, report.result)\n    time.sleep(.05)')
        with TemporaryDirectory() as temporary:
            result, _, _ = await self.worker(Path(temporary), count=1, idle_timeout=40, scale=80, script=script)
        self.assertEqual(len(result['units']), 1)
        self.assertEqual(result['worker_failure']['code'], 'conversion_idle_timeout')

    @unittest.skipIf(sys.platform == 'win32', 'Windows uses the existing owned Job cleanup')
    async def test_finished_worker_also_stops_children_in_its_owned_process_group(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            survivor = directory / 'child-survived'
            child = ('import time; from pathlib import Path; time.sleep(.6); '
                     f'Path({str(survivor)!r}).write_text("still running")')
            script = SCRIPT.replace('report.finish()',
                f'import subprocess\nsubprocess.Popen([sys.executable, "-c", {child!r}])\nreport.finish()')
            result, _, _ = await self.worker(directory, count=1, script=script)
            self.assertEqual(result['state'], 'complete')
            await asyncio.sleep(.8)
            self.assertFalse(survivor.exists())

    async def test_transient_windows_progress_read_does_not_kill_worker(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            read_text = Path.read_text
            failures = []

            def shared_read(path, *args, **kwargs):
                if path == directory / 'conversion.json' and path.exists() and not failures:
                    failures.append(True)
                    error = PermissionError(errno.EACCES, 'private path must not escape')
                    error.winerror = 32
                    raise error
                return read_text(path, *args, **kwargs)

            with patch.object(Path, 'read_text', shared_read):
                result, _, _ = await self.worker(directory, count=6, pause=.1)
            self.assertEqual(failures, [True])
            self.assertEqual(result['state'], 'complete')
            self.assertEqual(len(result['units']), 6)
            self.assertNotIn('private', json.dumps(result))

    async def test_final_checkpoint_read_retries_only_known_windows_sharing_errors(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'conversion.json'
            path.write_text('{"state":"complete","units":[]}')
            error = PermissionError(errno.EACCES, 'private path must not escape')
            error.winerror = 32
            with patch.object(Path, 'read_text', side_effect=[error, path.read_text()]):
                self.assertEqual(await conversion.read_checkpoint(path, final=True), {'state': 'complete', 'units': []})
            with patch.object(Path, 'read_text', side_effect=PermissionError(errno.EACCES, 'private')):
                with self.assertRaises(conversion.AnalysisClientError) as caught:
                    await conversion.read_checkpoint(path)
            self.assertEqual(caught.exception.code, 'conversion_checkpoint_read_failed')
            self.assertNotIn('private', str(caught.exception))

    async def test_unread_final_checkpoint_is_not_overwritten_with_cached_progress(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            read_text = Path.read_text

            def cannot_read_completed_checkpoint(path, *args, **kwargs):
                text = read_text(path, *args, **kwargs)
                if path == directory / 'conversion.json' and json.loads(text).get('state') == 'complete':
                    raise PermissionError(errno.EACCES, 'unread final checkpoint')
                return text

            with patch.object(Path, 'read_text', cannot_read_completed_checkpoint):
                result, _, _ = await self.worker(directory, count=4, pause=.1, check_result_file=False)
            stored = json.loads((directory / 'conversion.json').read_text())
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(result['worker_failure']['code'], 'conversion_checkpoint_read_failed')
        self.assertEqual(stored['state'], 'complete')
        self.assertEqual(len(stored['units']), 4)


if __name__ == '__main__':
    unittest.main()
