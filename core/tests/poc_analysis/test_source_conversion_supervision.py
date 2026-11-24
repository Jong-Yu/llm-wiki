"""실제 변환 자식의 진행·정지·Windows 조회 충돌을 짧은 시간축으로 검증한다."""

import errno
import asyncio
from contextlib import contextmanager
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

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


@contextmanager
def windows_checkpoint_reads():
    """읽기 오류 분류만 Windows로 만들고 실제 자식/종료 방식은 호스트를 따른다."""
    read_checkpoint = conversion.read_checkpoint

    async def read(path, **kwargs):
        with patch.object(conversion, 'is_windows', return_value=True):
            return await read_checkpoint(path, **kwargs)

    with patch.object(conversion, 'read_checkpoint', read):
        yield


class SupervisionTest(unittest.IsolatedAsyncioTestCase):
    async def worker(self, directory, *, count=4, pause=.05, linger=0,
                     timeout=conversion.MAX_CONVERSION_SECONDS,
                     idle_timeout=conversion.MAX_IDLE_SECONDS, scale=1, script=SCRIPT,
                     check_result_file=True, cancel_file=None):
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
                timeout=timeout, idle_timeout=idle_timeout, cancel_file=cancel_file,
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
            with patch.object(conversion, 'is_windows', return_value=False), \
                    patch.object(Path, 'read_text', side_effect=PermissionError(errno.EACCES, 'private')):
                with self.assertRaises(conversion.AnalysisClientError) as caught:
                    await conversion.read_checkpoint(path)
            self.assertEqual(caught.exception.code, 'conversion_checkpoint_read_failed')
            self.assertNotIn('private', str(caught.exception))

    async def test_windows_crt_progress_read_retries_without_winerror(self):
        for failures_to_inject in (1, 3):
            with self.subTest(failures=failures_to_inject), TemporaryDirectory() as temporary:
                directory = Path(temporary)
                read_text = Path.read_text
                failures = []

                def shared_read(path, *args, **kwargs):
                    if path == directory / 'conversion.json' and path.exists() and len(failures) < failures_to_inject:
                        failures.append(True)
                        raise PermissionError(errno.EACCES, 'private path must not escape')
                    return read_text(path, *args, **kwargs)

                with windows_checkpoint_reads(), patch.object(Path, 'read_text', shared_read):
                    result, _, _ = await self.worker(directory, count=6, pause=.12)
                self.assertEqual(len(failures), failures_to_inject)
                self.assertEqual(result['state'], 'complete')
                self.assertEqual(len(result['units']), 6)
                self.assertNotIn('private', json.dumps(result))

    async def test_windows_crt_final_read_recovers_and_has_a_bounded_retry(self):
        error = PermissionError(errno.EACCES, 'private path must not escape')
        path = Path('isolated-checkpoint')
        with patch.object(conversion, 'is_windows', return_value=True), \
                patch.object(Path, 'read_text', side_effect=[error, '{"state":"complete","units":[]}']) as read:
            self.assertEqual(await conversion.read_checkpoint(path, final=True), {'state': 'complete', 'units': []})
            self.assertEqual(read.call_count, 2)
        with patch.object(conversion, 'is_windows', return_value=True), \
                patch.object(Path, 'read_text', side_effect=error) as read, \
                patch.object(conversion.asyncio, 'sleep', new_callable=AsyncMock) as sleep:
            with self.assertRaises(conversion.AnalysisClientError) as caught:
                await conversion.read_checkpoint(path, final=True)
            self.assertEqual(read.call_count, 8)
            self.assertEqual(sleep.await_count, 7)
            self.assertLessEqual(sum(call.args[0] for call in sleep.await_args_list), .72)
        self.assertEqual(caught.exception.code, 'conversion_checkpoint_read_failed')
        self.assertEqual(caught.exception.failure['errno'], errno.EACCES)
        self.assertNotIn('winerror', caught.exception.failure)
        self.assertNotIn('private', str(caught.exception))

    async def test_other_checkpoint_read_errors_are_not_retried(self):
        unknown_windows = PermissionError(errno.EACCES, 'private path must not escape')
        unknown_windows.winerror = 123
        cases = [(False, PermissionError(errno.EACCES, 'private')),
                 (True, OSError(errno.EIO, 'private')), (True, unknown_windows),
                 (True, UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'private')),
                 (True, json.JSONDecodeError('private', 'broken JSON', 0))]
        for windows, error in cases:
            with self.subTest(windows=windows, error=type(error).__name__, winerror=getattr(error, 'winerror', None)), \
                    patch.object(conversion, 'is_windows', return_value=windows), \
                    patch.object(Path, 'read_text', side_effect=error) as read:
                with self.assertRaises(conversion.AnalysisClientError) as caught:
                    await conversion.read_checkpoint(Path('isolated-checkpoint'), final=True)
                self.assertEqual(read.call_count, 1)
                self.assertEqual(caught.exception.code, 'conversion_checkpoint_read_failed')
                self.assertNotIn('private', str(caught.exception))

    async def test_persistent_crt_lock_preserves_checkpoint_and_supervision_limits(self):
        for reason in ('conversion_idle_timeout', 'conversion_timeout', 'conversion_cancelled'):
            with self.subTest(reason=reason), TemporaryDirectory() as temporary:
                directory = Path(temporary)
                cancel_file = directory / 'cancel'
                read_text = Path.read_text
                seen_progress = []
                unread_checkpoints = []

                def shared_read(path, *args, **kwargs):
                    text = read_text(path, *args, **kwargs)
                    if path == directory / 'conversion.json' and json.loads(text)['units']:
                        if not seen_progress:
                            seen_progress.append(text)
                        else:
                            unread_checkpoints.append(text)
                            if reason == 'conversion_cancelled':
                                cancel_file.touch()
                            raise PermissionError(errno.EACCES, 'private lock')
                    return text

                options = {'idle_timeout': 40} if reason == 'conversion_idle_timeout' else {'timeout': 60}
                with windows_checkpoint_reads(), patch.object(Path, 'read_text', shared_read):
                    result, _, _ = await self.worker(directory, count=30, pause=.1, scale=80,
                        cancel_file=cancel_file, check_result_file=False, **options)
                stored_text = (directory / 'conversion.json').read_text()
                self.assertTrue(unread_checkpoints)
                self.assertEqual(stored_text, unread_checkpoints[-1])
                self.assertEqual(result['units'], json.loads(seen_progress[0])['units'])
                self.assertEqual(result['worker_failure']['code'], reason)
                self.assertEqual(result['worker_failure']['checkpoint_errno'], errno.EACCES)
                self.assertNotIn('checkpoint_winerror', result['worker_failure'])
                self.assertNotIn('errno', result['worker_failure'])
                self.assertEqual(result['state'], 'cancelled' if reason == 'conversion_cancelled' else 'partial')
                self.assertFalse(result['complete'])

    async def test_worker_failure_survives_full_warning_list_without_losing_warnings(self):
        warnings = ['preserved warning ' + str(index) for index in range(99)] + [
            'remaining scopes: additional diagnostics exceed the report limit']
        script = SCRIPT.replace('for page in range', f'report.result["warnings"] = {warnings!r}\nfor page in range')
        with TemporaryDirectory() as temporary:
            result, _, _ = await self.worker(Path(temporary), count=1, linger=3,
                idle_timeout=40, scale=80, script=script)
        self.assertEqual(len(result['warnings']), 100)
        self.assertEqual(result['warnings'][:99], warnings[:99])
        self.assertTrue(result['warnings'][-1].startswith(warnings[-1] + ' | worker: '))
        self.assertIn('code=conversion_idle_timeout', result['warnings'][-1])
        self.assertLessEqual(len(result['warnings'][-1]), 1000)
        body = conversion.report_body(result, {}, 'isolated-request', None)
        self.assertEqual(body['warnings'], result['warnings'])

    async def test_worker_exit_failure_survives_an_unread_final_checkpoint(self):
        read_checkpoint = conversion.read_checkpoint
        unread_files = []

        async def fail_final_read(path, *, final=False):
            if final:
                unread_files.append(path.read_bytes())
                raise conversion.CheckpointReadError(PermissionError(errno.EACCES, 'private final checkpoint'))
            return await read_checkpoint(path)

        script = SCRIPT.replace('report.finish()', 'sys.exit(17)')
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(conversion, 'read_checkpoint', fail_final_read):
                result, _, _ = await self.worker(directory, count=4, pause=.1, linger=.2,
                    script=script, check_result_file=False)
            self.assertEqual((directory / 'conversion.json').read_bytes(), unread_files[0])
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(len(result['units']), 4)
        self.assertEqual(result['worker_failure']['code'], 'worker_failed')
        self.assertEqual(result['worker_failure']['exit_code'], 17)
        self.assertEqual(result['worker_failure']['checkpoint_errno'], errno.EACCES)
        self.assertIn('remaining source: conversion_checkpoint_read_failed', result['unread_ranges'])
        self.assertNotIn('private', json.dumps(result))

    @unittest.skipUnless(sys.platform == 'win32', 'requires a real Windows sharing lock')
    async def test_native_windows_sharing_lock_has_no_winerror_and_recovers(self):
        import win32file
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'conversion.json'
            path.write_text('{"state":"complete","units":[]}', encoding='utf-8')
            handle = win32file.CreateFile(str(path), win32file.GENERIC_READ, 0, None,
                win32file.OPEN_EXISTING, win32file.FILE_ATTRIBUTE_NORMAL, None)
            try:
                with self.assertRaises(PermissionError) as caught:
                    path.read_text(encoding='utf-8')
                self.assertEqual(caught.exception.errno, errno.EACCES)
                self.assertIsNone(getattr(caught.exception, 'winerror', None))
                self.assertIsNone(await conversion.read_checkpoint(path))
                retry = asyncio.create_task(conversion.read_checkpoint(path, final=True))
                await asyncio.sleep(.02)
            finally:
                handle.Close()
            self.assertEqual(await retry, {'state': 'complete', 'units': []})

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
        self.assertEqual(result['worker_failure']['errno'], errno.EACCES)
        self.assertEqual(stored['state'], 'complete')
        self.assertEqual(len(stored['units']), 4)


if __name__ == '__main__':
    unittest.main()
