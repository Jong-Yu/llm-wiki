"""실제 파서/worker + 격리 HTTP 계약을 검사한다. OCR 엔진 자체 검증은 별도다."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import socket
import time
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2
from core.client.source_conversion import convert_source, run_worker
from core.client.source_conversion_formats import convert_file, ocr_image
from core.tests.api import test_sources_api as fixture


def make_pdf(path, *, blank=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 20 100 Td (Hello source) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(content)
    if blank:
        writer.add_blank_page(width=200, height=200)
    writer.write(path)
    return path.read_bytes()


class FormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wiki-conversion-formats-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_pdf_text_blank_page_and_original_preservation(self):
        path = self.root / 'input.pdf'
        raw = make_pdf(path, blank=True)
        result = convert_file(path, 'pdf', ocr='never')
        self.assertEqual(result['units'][0]['content'], 'Hello source')
        self.assertEqual(result['units'][1]['location'], {'kind': 'pages', 'start': 2, 'end': 2})
        self.assertFalse(result['complete'])
        self.assertIn('page 2: ocr_required_but_disabled', result['unread_ranges'])
        self.assertEqual(path.read_bytes(), raw)

    def test_real_pdf_render_then_missing_ocr_is_partial(self):
        path = self.root / 'input.pdf'
        make_pdf(path)
        with patch('core.client.source_conversion_formats.shutil.which', return_value=None):
            result = convert_file(path, 'pdf', ocr='always')
        self.assertEqual(result['units'][0]['content'], 'Hello source')
        self.assertTrue(any('tesseract' in value for value in result['unread_ranges']))
        self.assertFalse(result['complete'])

    def test_xlsx_cells_hidden_and_formula_cache_are_not_recalculated(self):
        from openpyxl import Workbook
        path = self.root / 'input.xlsx'
        book = Workbook()
        book.active.title = '기준'
        book.active['A1'] = '한글 조건'
        book.active['B3'] = 42
        book.active['C3'] = '=B3*2'
        book.active.row_dimensions[3].hidden = True
        book.save(path)
        raw = path.read_bytes()
        result = convert_file(path, 'xlsx')
        self.assertEqual([unit['location']['cells'] for unit in result['units']], ['A1', 'B3', 'C3'])
        self.assertEqual(result['units'][0]['content'], '한글 조건')
        self.assertIn('formula: =B3*2', result['units'][2]['content'])
        self.assertIn('cached_value: [unavailable]', result['units'][2]['content'])
        self.assertFalse(result['complete'])
        self.assertEqual(path.read_bytes(), raw)

    def test_docx_body_table_order_and_header_omission(self):
        from docx import Document
        path = self.root / 'input.docx'
        document = Document()
        document.add_paragraph('첫 문단')
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = '표 조건'
        table.cell(0, 1).text = '기한'
        document.add_paragraph('마지막 문단')
        document.sections[0].header.paragraphs[0].text = '머리말'
        document.save(path)
        result = convert_file(path, 'docx')
        self.assertEqual([u['content'] for u in result['units']], ['첫 문단', '표 조건', '기한', '마지막 문단'])
        self.assertEqual(result['units'][1]['location'], {'kind': 'table_cells', 'table': 1, 'row': 1, 'column': 1})
        self.assertFalse(result['complete'])
        self.assertIn('headers_footers', ' '.join(result['unread_ranges']))

    def test_image_frames_missing_tool_and_unsupported_file(self):
        from PIL import Image
        path = self.root / 'input.tiff'
        Image.new('RGB', (20, 20), 'white').save(path, save_all=True, append_images=[Image.new('RGB', (20, 20), 'black')])
        with patch('core.client.source_conversion_formats.shutil.which', return_value=None):
            result = convert_file(path, 'tiff')
        self.assertEqual(len(result['units']), 2)
        self.assertEqual(result['units'][1]['location']['start'], 2)
        self.assertFalse(result['complete'])
        self.assertEqual(result['units'][0]['content'], '')
        broken = self.root / 'broken.docx'
        broken.write_bytes(b'PKbroken')
        self.assertEqual(convert_file(broken, 'docx')['state'], 'failed')
        self.assertEqual(broken.read_bytes(), b'PKbroken')

    def test_missing_parser_and_output_limit_preserve_checkpoint(self):
        path = self.root / 'input.pdf'
        make_pdf(path, blank=True)
        checkpoints = []
        with patch('core.client.source_conversion_formats.MAX_UNITS', 1):
            result = convert_file(path, 'pdf', ocr='never', checkpoint=lambda value: checkpoints.append(json.loads(json.dumps(value))))
        self.assertEqual(len(result['units']), 1)
        self.assertFalse(result['complete'])
        self.assertTrue(checkpoints[-1]['units'])
        with patch('core.client.source_conversion_formats.util.find_spec', return_value=None):
            missing = convert_file(path, 'pdf')
        self.assertEqual(missing['units'], [])
        self.assertIn('dependency_missing:pypdf', missing['unread_ranges'][0])

    @unittest.skipIf(os.name == 'nt', 'POSIX synthetic executable fixture; Windows not exercised')
    def test_synthetic_ocr_command_reads_image_and_returns_exact_tool_text(self):
        from PIL import Image
        # 실제 OCR 정확도 시험이 아니다. 외부 명령 인자/결과 보존 경계만 검사한다.
        executable = self.root / 'synthetic-tesseract'
        executable.write_text('#!/usr/bin/env python3\nimport pathlib,sys\n'
            'if sys.argv[1:] == ["--version"]: print("tesseract fixture");sys.exit()\n'
            'if sys.argv[1:] == ["--list-langs"]: print("eng");sys.exit()\n'
            'assert pathlib.Path(sys.argv[1]).read_bytes().startswith(b"\\x89PNG")\n'
            'assert sys.argv[3:] == ["-l", "eng", "--psm", "3", "txt", "tsv"]\n'
            'pathlib.Path(sys.argv[2]+".txt").write_text("synthetic fixture transcript\\n")\n')
        executable.chmod(0o700)
        with patch('core.client.source_conversion_formats.shutil.which', return_value=str(executable)):
            self.assertEqual(ocr_image(Image.new('RGB', (10, 10), 'white'), 'eng'), 'synthetic fixture transcript\n')


class ConversionApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.SourceApiTests.save_policy
    snapshot = fixture.SourceApiTests.snapshot
    headers = fixture.SourceApiTests.headers
    client = fixture.SourceApiTests.client
    nothing = fixture.SourceApiTests.nothing
    value = fixture.SourceApiTests.value

    def setUp(self):
        fixture.SourceApiTests.setUp(self)
        self.work = self.root.resolve() / 'client'
        self.work.mkdir(mode=0o700)

    async def source(self, http, format='txt'):
        if format == 'txt':
            source = self.value(await http.post(self.base + '/sources', json={'request_id': uuid4().hex,
                'title': 'conversion fixture', 'format': 'txt', 'content': '원문\r\n고정 조건'}), 201)
        else:
            path = self.root / ('fixture.' + format)
            if format == 'pdf':
                raw = make_pdf(path)
            elif format == 'docx':
                from docx import Document
                document = Document()
                document.add_paragraph('DOCX 본문')
                document.add_table(rows=1, cols=1).cell(0, 0).text = '표'
                document.save(path)
                raw = path.read_bytes()
            elif format == 'xlsx':
                from openpyxl import Workbook
                workbook = Workbook()
                workbook.active['B2'] = '셀 원문'
                workbook.save(path)
                raw = path.read_bytes()
            else:
                from PIL import Image
                Image.new('RGB', (20, 20), 'white').save(path)
                raw = path.read_bytes()
            source = self.value(await http.post(self.base + '/sources', data={'request_id': uuid4().hex, 'title': 'fixture'},
                files={'file': ('fixture.' + format, raw, 'application/octet-stream')}), 201)
        reference = {key: source[key] for key in ('source_id', 'source_version', 'source_sha256', 'registration_revision')}
        return source, reference

    async def convert(self, http, reference, **kwargs):
        return await convert_source(base_url='http://127.0.0.1:8766', tenant='alpha', token=self.tokens['alice'],
            source_ref=reference, work_dir=self.work, profile='all', submit=True, http=http, **kwargs)

    async def test_actual_workers_and_reports_pdf_xlsx_docx_image(self):
        async with self.client() as http:
            for format in ('pdf', 'xlsx', 'docx', 'png'):
                source, reference = await self.source(http, format)
                result = await self.convert(http, reference, ocr='never' if format != 'png' else 'auto')
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['receipt']['state'], 'saved', result)
                self.assertEqual(result['receipt']['manifest']['source_ref'], reference)
                self.assertEqual(result['receipt']['manifest']['original_coverage'], 'not_verified')
                self.assertEqual(sha256(Path(result['original_file']).read_bytes()).hexdigest(), source['source_sha256'])
                if format == 'png':
                    self.assertFalse(result['conversion']['complete'])
                saved = result['receipt']['conversion_ref']
                read = self.value(await http.get(self.base + '/analysis-conversions/' + saved['conversion_id']))
                self.assertEqual(read['revision'], saved['conversion_revision'])

    async def test_report_conflict_preserves_local_and_server_result(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            first = await self.convert(http, reference, request_id='a' * 32)
            self.assertEqual(first['receipt']['state'], 'saved', first)
            # 같은 요청 ID의 원본이 달라지면 기존 보고를 덮어쓸 수 없다.
            _, other = await self.source(http)
            second = await self.convert(http, other, request_id='a' * 32)
            self.assertEqual(second['receipt']['state'], 'rejected', second)
            self.assertEqual(second['receipt']['error']['code'], 'request_conflict')
            self.assertTrue(Path(second['original_file']).exists())
            self.assertTrue(Path(second['report_file']).exists())
            self.assertTrue(first['conversion']['units'])

    async def test_revocation_at_submit_preserves_download_and_converted_text(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            def event(value):
                if value['stage'] == 'submit' and value['completed'] == 0:
                    self.config['users']['alice']['memberships']['alpha']['permissions'] = ['read']
                    self.save_policy()
            result = await self.convert(http, reference, on_event=event)
            self.assertEqual(result['receipt']['state'], 'rejected', result)
            self.assertEqual(result['receipt']['http_status'], 403)
            self.assertEqual(Path(result['original_file']).read_bytes(), '원문\r\n고정 조건'.encode())
            self.assertEqual(result['conversion']['units'][0]['content'], '원문\r\n고정 조건')

    async def test_source_change_and_hash_mismatch_never_submit(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            stale = {**reference, 'registration_revision': '0' * 64}
            before = self.snapshot()
            result = await self.convert(http, stale)
            self.assertEqual(result['error']['code'], 'source_basis_changed')
            self.assertEqual(self.snapshot(), before)
            original_stream = http.stream
            def altered(method, url, **kwargs):
                if str(url).split('?')[0].endswith('/file'):
                    class BadStream:
                        async def __aenter__(self):
                            return httpx2.Response(200, content=b'corrupt')
                        async def __aexit__(self, *args):
                            pass
                    return BadStream()
                return original_stream(method, url, **kwargs)
            with patch.object(http, 'stream', side_effect=altered):
                mismatch = await self.convert(http, reference)
            self.assertEqual(mismatch['error']['code'], 'source_hash_mismatch')
            self.assertEqual(mismatch['receipt']['state'], 'not_submitted')
            self.assertEqual(self.snapshot(), before)

    async def test_response_loss_read_reconciliation_and_unconfirmed_no_repost(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            real_post = http.post
            count = 0
            async def lost(*args, **kwargs):
                nonlocal count
                count += 1
                await real_post(*args, **kwargs)
                raise httpx2.ReadError('secret must not be printed')
            with patch.object(http, 'post', side_effect=lost):
                result = await self.convert(http, reference)
            self.assertEqual(count, 1)
            self.assertEqual(result['receipt']['state'], 'saved', result)
            self.assertTrue(result['receipt']['reconciled'])
            with patch.object(http, 'post', side_effect=httpx2.ReadError('private transport')):
                unknown = await self.convert(http, reference)
            self.assertEqual(unknown['state'], 'report_unconfirmed', unknown)
            self.assertTrue(Path(unknown['report_file']).exists())
            self.assertNotIn('private transport', json.dumps(unknown))

    async def test_cancel_after_download_does_not_submit_or_remove_original(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            stop = self.work / 'cancel'
            def event(value):
                if value['stage'] == 'download':
                    stop.touch()
            before = self.snapshot()
            result = await self.convert(http, reference, cancel_file=stop, on_event=event)
            self.assertEqual(result['state'], 'cancelled', result)
            self.assertEqual(result['receipt']['state'], 'not_submitted')
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(Path(result['original_file']).read_bytes(), '원문\r\n고정 조건'.encode())

    async def test_timeout_and_preexisting_work_are_preserved(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            marker = self.work / 'user-owned.txt'
            marker.write_text('do not touch')
            result = await self.convert(http, reference, timeout=0.001)
            self.assertFalse(result['conversion']['complete'])
            self.assertIn('conversion_timeout', json.dumps(result))
            self.assertTrue(Path(result['original_file']).exists())
            self.assertEqual(marker.read_text(), 'do not touch')
            self.assertFalse(list(Path(result['work_dir']).glob('scratch-*')))

    async def test_postprocessing_exception_keeps_completed_conversion(self):
        async with self.client() as http:
            _, reference = await self.source(http)
            with patch('core.client.source_conversion.submit_report', side_effect=OSError('private detail')):
                result = await self.convert(http, reference)
            self.assertFalse(result['ok'])
            self.assertEqual(result['receipt']['state'], 'unconfirmed')
            self.assertEqual(result['conversion']['units'][0]['content'], '원문\r\n고정 조건')
            self.assertTrue(Path(result['report_file']).exists())
            self.assertNotIn('private detail', json.dumps(result))

    @unittest.skipIf(os.name == 'nt', 'Actual POSIX process group; Windows not exercised')
    async def test_worker_cancel_retains_checkpoint_and_terminates_ocr_child(self):
        # 합성 파서가 한 단위를 기록한 뒤 멈춰 있어 취소 시점을 결정적으로 만든다.
        script = self.work / 'synthetic-worker.py'
        output = self.work / 'conversion.json'
        pid_file = self.work / 'child.pid'
        stop = self.work / 'cancel'
        script.write_text('import json,pathlib,subprocess,sys,time\n'
            'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\n'
            f'pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n'
            f'pathlib.Path({str(output)!r}).write_text(json.dumps({{"state":"running","format":"pdf","method":"pdf_text","units":[{{"unit_id":"page-1","location":{{"kind":"pages","start":1,"end":1}},"content":"checkpoint text"}}],"unread_ranges":[],"warnings":[],"diagnostics":[],"unit_methods":{{"page-1":"pdf_text"}},"complete":False}}))\n'
            'time.sleep(30)\n')
        actual = asyncio.create_subprocess_exec
        async def launch(*args, **kwargs):
            return await actual(sys.executable, str(script), **kwargs)
        def progress(stage, **value):
            if value['completed']:
                stop.touch()
        with patch('core.client.source_conversion.asyncio.create_subprocess_exec', side_effect=launch):
            result = await run_worker(self.work / 'original', 'pdf', output, ocr='auto', language='eng',
                timeout=5, cancel_file=stop, emit=progress)
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual(result['units'][0]['content'], 'checkpoint text')
        child = int(pid_file.read_text())
        check = await actual('ps', '-o', 'stat=', '-p', str(child), stdout=asyncio.subprocess.PIPE)
        status, _ = await check.communicate()
        self.assertTrue(not status.strip() or status.strip().startswith(b'Z'), status)
        self.assertFalse(list(self.work.glob('scratch-*')))


class ConversionCliTests(ConversionApiTests):
    # 부모의 검사들을 다시 상속하지 않고 별도 실행할 수 있도록 아래 load_tests로 수집한다.
    async def test_real_loopback_cli_jsonl_and_receipt(self):
        from core.paths import PROJECT_DIR
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
        server = await asyncio.create_subprocess_exec(sys.executable, '-B', '-m', 'core.runtime.http_cli',
            '--access-config', str(self.config_path), '--tenant-root', str(self.tenant_root), '--port', str(port),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            async with httpx2.AsyncClient(base_url=f'http://127.0.0.1:{port}', headers=self.headers(), trust_env=False, timeout=5) as http:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        if (await http.get('/api/v1/access-context')).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if server.returncode is not None or time.monotonic() > deadline:
                        self.fail('isolated conversion server failed to start')
                    await asyncio.sleep(0.05)
                _, reference = await self.source(http, 'docx')
                token_file = self.work / 'token'
                token_file.write_text(self.tokens['alice'])
                token_file.chmod(0o600)
                args = [sys.executable, '-B', '-m', 'tools.source_conversion_cli', '--server', f'http://127.0.0.1:{port}',
                    '--tenant', 'alpha', '--profile', 'all', '--token-file', str(token_file), '--work-dir', str(self.work), '--submit']
                for key, value in reference.items():
                    args += ['--' + key.replace('_', '-'), value]
                cli = await asyncio.create_subprocess_exec(*args, cwd=PROJECT_DIR,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                stdout, stderr = await asyncio.wait_for(cli.communicate(), 15)
                self.assertEqual(cli.returncode, 0, stderr.decode())
                self.assertEqual(stderr, b'')
                self.assertNotIn(self.tokens['alice'].encode(), stdout)
                events = [json.loads(line) for line in stdout.decode().splitlines()]
                self.assertTrue(any(e['type'] == 'progress' for e in events))
                final = events[-1]
                self.assertEqual(final['type'], 'result')
                self.assertEqual(final['receipt']['state'], 'saved')
                self.assertEqual([u['content'] for u in final['conversion']['units']], ['DOCX 본문', '표'])
                self.assertTrue(all(__import__('re').fullmatch(r'[a-zA-Z0-9_.-]{1,128}', d['code']) for d in final['conversion']['diagnostics']))
                original = await http.get(self.base + f"/sources/{reference['source_id']}/versions/{reference['source_version']}/file")
                self.assertEqual(original.content, Path(final['original_file']).read_bytes())
        finally:
            if server.returncode is None:
                server.terminate()
            await asyncio.wait_for(server.wait(), 10)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(FormatTests))
    suite.addTests(loader.loadTestsFromTestCase(ConversionApiTests))
    suite.addTest(ConversionCliTests('test_real_loopback_cli_jsonl_and_receipt'))
    return suite
