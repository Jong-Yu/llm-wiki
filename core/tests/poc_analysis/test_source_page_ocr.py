"""한 쪽 재인식은 원본·전체 보고를 바꾸지 않는 명시 검토 후보이다."""
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from core.client import source_conversion_formats as formats
from core.client import source_conversion_worker as worker
from core.client.source_conversion import convert_source
from core.client.transport import AnalysisClientError


def make_pdf(path, count=3):
    from pypdf import PdfWriter
    writer = PdfWriter()
    for _ in range(count):
        writer.add_blank_page(width=144, height=72)
    with path.open('wb') as stream:
        writer.write(stream)


class PageFormatTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original.pdf'
        make_pdf(self.path)

    def test_only_selected_original_page_is_ocr_and_other_ranges_stay_unread(self):
        original = self.path.read_bytes()
        sizes = []
        def recognize(image, language, **kwargs):
            sizes.append(image.size)
            self.assertEqual(language, 'kor+eng')
            return '다시 확인할 문자'
        with patch('pypdf._page.PageObject.extract_text', side_effect=ValueError('broken text')) as extract, \
                patch.object(formats, 'ocr_image', side_effect=recognize) as ocr:
            value = formats.convert_file(self.path, 'pdf', ocr='never', language='kor+eng', selected_page=2)
        extract.assert_not_called()
        self.assertEqual(ocr.call_count, 1)
        self.assertEqual(sizes, [(600, 300)])
        self.assertEqual(value['execution']['ocr'], 'always')
        self.assertEqual(value['units'], [{'unit_id': 'page-2', 'location': {'kind': 'pages', 'start': 2, 'end': 2},
                                          'content': '다시 확인할 문자'}])
        self.assertEqual(value['unit_methods'], {'page-2': 'ocr'})
        self.assertFalse(value['complete'])
        self.assertEqual(value['state'], 'partial')
        self.assertIn('pages 1-1: not_selected_for_page_ocr', value['unread_ranges'])
        self.assertIn('pages 3-3: not_selected_for_page_ocr', value['unread_ranges'])
        self.assertEqual(self.path.read_bytes(), original)

    def test_general_pdf_path_still_reads_all_pages(self):
        with patch('pypdf._page.PageObject.extract_text', side_effect=['first', 'second', 'third']), \
                patch.object(formats, 'ocr_image') as ocr:
            value = formats.convert_file(self.path, 'pdf', ocr='never')
        ocr.assert_not_called()
        self.assertEqual([unit['content'] for unit in value['units']], ['first', 'second', 'third'])
        self.assertTrue(value['complete'])
        self.assertNotIn('selected_pdf_page_ocr_candidate', ' '.join(value['warnings']))

    def test_out_of_range_does_not_ocr_another_page(self):
        with patch.object(formats, 'ocr_image') as ocr:
            value = formats.convert_file(self.path, 'pdf', selected_page=4)
        ocr.assert_not_called()
        self.assertEqual(value['units'], [])
        self.assertFalse(value['complete'])
        self.assertIn('PDF: selected_pdf_page_out_of_range', value['unread_ranges'])

    def test_failed_reocr_does_not_fallback_to_old_extracted_text(self):
        with patch('pypdf._page.PageObject.extract_text', return_value='old text') as extract, \
                patch.object(formats, 'ocr_image', return_value=''):
            value = formats.convert_file(self.path, 'pdf', selected_page=2)
        extract.assert_not_called()
        self.assertEqual(value['units'][0]['content'], '')
        self.assertEqual(value['unit_methods'], {'page-2': 'pdf_text'})
        self.assertFalse(value['complete'])
        self.assertTrue(any('ocr_no_text_detected' in item for item in value['unread_ranges']))

    def test_selection_rejects_other_formats_and_invalid_page_before_read(self):
        for format, page in [('txt', 1), ('pdf', 0), ('pdf', -1), ('pdf', True), ('pdf', 1_000_001)]:
            with self.subTest(format=format, page=page), self.assertRaises(ValueError):
                formats.convert_file(self.path, format, selected_page=page)

    def test_worker_forwards_page_without_changing_checkpoint_contract(self):
        result = self.path.parent / 'result.json'
        with patch('sys.argv', ['worker', str(self.path), 'pdf', str(result), '--page', '2']), \
                patch.object(worker, 'convert_file') as convert:
            self.assertEqual(worker.main(), 0)
        self.assertEqual(convert.call_args.kwargs['selected_page'], 2)
        checkpoint = convert.call_args.kwargs['checkpoint']
        checkpoint({'candidate': 'kept'})
        self.assertEqual(result.read_text(), '{"candidate": "kept"}')

    def test_cli_rejects_page_submit_before_reading_credentials(self):
        from tools.source_conversion_cli import main
        with patch('sys.argv', ['source-conversion', '--page', '2', '--submit']), \
                patch('tools.source_conversion_cli.read_token') as token, \
                self.assertRaises(SystemExit) as raised:
            main()
        self.assertEqual(raised.exception.code, 2)
        token.assert_not_called()


class PageClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.source = dict(source_id='a' * 32, source_version='b' * 32,
                           source_sha256=sha256(b'original').hexdigest(), registration_revision='d' * 64)
        self.catalog = {'source_id': self.source['source_id'], 'current_version': self.source['source_version'],
                        'registration_revision': self.source['registration_revision'],
                        'versions': [{**self.source, 'format': 'pdf', 'size_bytes': 8}],
                        'access': {'user_id': 'fixture'}}
        self.options = dict(base_url='http://127.0.0.1:8766', tenant='test', token='synthetic',
                            source_ref=self.source, work_dir=self.directory / 'work', http=object())

    async def test_page_submit_is_rejected_before_network_or_directory_creation(self):
        with patch('core.client.source_conversion.api_call', new=AsyncMock()) as api, \
                self.assertRaises(AnalysisClientError) as raised:
            await convert_source(**self.options, selected_page=2, submit=True)
        self.assertEqual(raised.exception.code, 'invalid_page_conversion_options')
        api.assert_not_called()
        self.assertFalse((self.directory / 'work').exists())

    async def test_non_pdf_is_rejected_before_download_or_worker(self):
        self.catalog['versions'][0]['format'] = 'txt'
        with patch('core.client.source_conversion.api_call', new=AsyncMock(return_value=self.catalog)), \
                patch('core.client.source_conversion.download', new=AsyncMock()) as download, \
                patch('core.client.source_conversion.run_worker', new=AsyncMock()) as convert:
            value = await convert_source(**self.options, selected_page=2)
        self.assertFalse(value['ok'])
        self.assertEqual(value['error']['code'], 'page_conversion_requires_pdf')
        download.assert_not_called(); convert.assert_not_called()

    async def test_client_passes_exact_page_and_never_submits_candidate(self):
        from core.client.source_conversion_report import Conversion
        from core.client.source_conversion_formats import location
        report = Conversion('pdf')
        report.result['method'] = 'ocr'
        report.add('page-2', location('pages', start=2, end=2), 'candidate', 'ocr')
        report.note('not_selected_for_page_ocr', 'pages 1-1')
        candidate = report.finish()
        with patch('core.client.source_conversion.api_call', new=AsyncMock(return_value=self.catalog)), \
                patch('core.client.source_conversion.download', new=AsyncMock(return_value=self.directory / 'original')), \
                patch('core.client.source_conversion.run_worker', new=AsyncMock(return_value=candidate)) as convert, \
                patch('core.client.source_conversion.submit_report', new=AsyncMock()) as submit:
            value = await convert_source(**self.options, selected_page=2, ocr='never')
        self.assertEqual(convert.call_args.kwargs['selected_page'], 2)
        self.assertEqual(convert.call_args.kwargs['ocr'], 'always')
        self.assertTrue(value['ok'])
        self.assertEqual(value['source_ref'], self.source)
        self.assertEqual(value['receipt'], {'state': 'not_submitted'})
        self.assertEqual(value['conversion']['units'][0]['content'], 'candidate')
        submit.assert_not_called()

    async def test_real_download_worker_and_ocr_keep_only_selected_page_without_post(self):
        import httpx2
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        from io import BytesIO
        if not formats.diagnostics('eng')['tesseract']['ready']:
            self.skipTest('Tesseract English runtime is unavailable')
        writer = PdfWriter()
        for text in ['ONLY PAGE ONE', 'ONLY PAGE TWO', 'ONLY PAGE THREE']:
            page = writer.add_blank_page(width=500, height=100)
            page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({
                NameObject('/F1'): DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                    NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})})})
            content = DecodedStreamObject()
            content.set_data(f'BT /F1 24 Tf 20 40 Td ({text}) Tj ET'.encode())
            page[NameObject('/Contents')] = writer._add_object(content)
        stream = BytesIO(); writer.write(stream); raw = stream.getvalue()
        self.source['source_sha256'] = sha256(raw).hexdigest()
        self.catalog['versions'] = [{**self.source, 'format': 'pdf', 'size_bytes': len(raw)}]
        requests = []
        def respond(request):
            requests.append((request.method, request.url.path))
            self.assertEqual(request.headers['authorization'], 'Bearer isolated-fixture')
            self.assertEqual(request.method, 'GET')
            return (httpx2.Response(200, content=raw) if request.url.path.endswith('/file')
                    else httpx2.Response(200, json={'data': self.catalog}))
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond),
                                     headers={'Authorization': 'Bearer isolated-fixture'}) as http:
            options = {**self.options, 'http': http}
            value = await convert_source(**options, selected_page=2, ocr_language='eng')
        self.assertTrue(value['ok'], value.get('error'))
        self.assertEqual(len(requests), 2)
        self.assertEqual(value['receipt']['state'], 'not_submitted')
        self.assertEqual(Path(value['original_file']).read_bytes(), raw)
        self.assertEqual([unit['unit_id'] for unit in value['conversion']['units']], ['page-2'])
        text = value['conversion']['units'][0]['content']
        self.assertIn('ONLY PAGE TWO', text, value['conversion']['unread_ranges'])
        self.assertNotIn('PAGE ONE', text); self.assertNotIn('PAGE THREE', text)
        self.assertFalse(value['conversion']['complete'])
