"""개인 변환기의 보존·실패 계약. 변환 실행과 의미 정확성 평가는 구분한다."""

from hashlib import sha256
from io import BytesIO
import json
import errno
import os
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from core.client import source_conversion_formats as formats
from core.client.source_conversion import convert_source, report_body, run_worker
from core.client.source_conversion import worker_exit_failure
from core.client import source_conversion_worker as worker
from core.client import source_conversion_xlsx as xlsx_view
from core.tests.poc_access.fixtures import grant_test_membership


def docx_bytes(*, extras=False, image=False, header=False):
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    document = Document()
    document.add_heading('조건과 예외 “원문”', 1)
    document.add_paragraph('Before table: keep every condition.')
    table = document.add_table(rows=2, cols=2)
    for cell, text in zip((table.cell(0, 0), table.cell(0, 1), table.cell(1, 0), table.cell(1, 1)),
                          ('Item', 'Rule', 'Pump', 'Never omit exceptions.')):
        cell.text = text
    paragraph = document.add_paragraph('After table.')
    if extras:
        for name in ('footnote', 'endnote'):
            run = OxmlElement('w:r')
            ref = OxmlElement('w:' + name + 'Reference')
            ref.set(qn('w:id'), '1'); run.append(ref); paragraph._p.append(run)
        for name, text in (('ins', 'Inserted condition.'), ('del', 'Deleted condition.')):
            change = OxmlElement('w:' + name)
            change.set(qn('w:id'), '2'); change.set(qn('w:author'), 'Fixture reviewer')
            change.set(qn('w:date'), '2026-10-29T00:00:00Z')
            run = OxmlElement('w:r'); value = OxmlElement('w:delText' if name == 'del' else 'w:t')
            value.text = text; run.append(value); change.append(run); paragraph._p.append(change)
        for name in ('commentRangeStart', 'commentRangeEnd'):
            marker = OxmlElement('w:' + name); marker.set(qn('w:id'), '1'); paragraph._p.append(marker)
    if image:
        from PIL import Image
        pixels = BytesIO(); Image.new('RGB', (10, 10), 'white').save(pixels, format='PNG'); pixels.seek(0)
        document.add_picture(pixels)
    if header:
        document.sections[0].header.paragraphs[0].text = 'Unread header condition.'
    raw = BytesIO(); document.save(raw)
    if not extras:
        return raw.getvalue()
    with ZipFile(BytesIO(raw.getvalue())) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    ET.register_namespace('w', w)
    relationships = ET.fromstring(entries['word/_rels/document.xml.rels'])
    types = ET.fromstring(entries['[Content_Types].xml'])
    for name, text in (('footnote', 'Footnote exception.'), ('endnote', 'Endnote exception.'),
                       ('comment', 'Reviewer comment.')):
        part = f'word/{name}s.xml'
        root = ET.Element(f'{{{w}}}{name}s')
        note = ET.SubElement(root, f'{{{w}}}{name}', {f'{{{w}}}id': '1'})
        if name == 'comment':
            note.set(f'{{{w}}}author', 'Fixture reviewer')
            note.set(f'{{{w}}}date', '2026-10-29T00:00:00Z')
        p = ET.SubElement(note, f'{{{w}}}p'); r = ET.SubElement(p, f'{{{w}}}r')
        ET.SubElement(r, f'{{{w}}}t').text = text
        entries[part] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        ET.SubElement(relationships, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship',
            Id='fixture-' + name, Type=f'http://schemas.openxmlformats.org/officeDocument/2006/relationships/{name}s',
            Target=f'{name}s.xml')
        ET.SubElement(types, '{http://schemas.openxmlformats.org/package/2006/content-types}Override',
            PartName='/' + part, ContentType=f'application/vnd.openxmlformats-officedocument.wordprocessingml.{name}s+xml')
    entries['word/_rels/document.xml.rels'] = ET.tostring(relationships)
    entries['[Content_Types].xml'] = ET.tostring(types)
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return output.getvalue()


def xlsx_bytes(*, missing_cache=False, relative=False):
    from openpyxl import Workbook
    from openpyxl.worksheet.formula import ArrayFormula
    workbook = Workbook(); sheet = workbook.active; sheet.title = '계산 표'
    sheet['A1'] = '항목'; sheet['C1'] = '값'; sheet['A3'] = '조건 | 예외 `원문`\n다음 줄'
    sheet['C3'] = '=SUM(B4:B5)'; sheet['B4'] = .1; sheet['B5'] = .2
    sheet['D7'] = '="저장 문자열"'; sheet['E9'] = '=0'; sheet['F10'] = '=1/0'; sheet['G11'] = '=""'
    sheet['H12'] = '=NOW()'; sheet['H12'].number_format = 'yyyy-mm-dd hh:mm:ss'
    sheet['I13'] = '=1/7'; sheet['K15'] = ArrayFormula(ref='K15:K16', text='=SUM(B4:B5)')
    if missing_cache:
        sheet['J14'] = '=1+2'
    second = workbook.create_sheet('보조 자료'); second['B2'] = '한글 끝'; second.merge_cells('B2:C2')
    raw = BytesIO(); workbook.save(raw)
    with ZipFile(BytesIO(raw.getvalue())) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    ns = '{' + xlsx_view.NS + '}'
    root = ET.fromstring(entries['xl/worksheets/sheet1.xml'])
    caches = {'C3': ('n', '0.30000000000000004'), 'D7': ('str', '저장 문자열'), 'E9': ('b', '0'),
              'F10': ('e', '#DIV/0!'), 'G11': ('str', ''), 'H12': ('n', '46000.5'),
              'I13': ('n', '0.142857142857142857142857142857'), 'K15': ('n', '0.3')}
    for cell in root.iter(ns + 'c'):
        if cell.attrib['r'] in caches:
            kind, value = caches[cell.attrib['r']]; cell.set('t', kind)
            cached = cell.find(ns + 'v')
            if cached is None:
                cached = ET.SubElement(cell, ns + 'v')
            cached.text = value
    entries['xl/worksheets/sheet1.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    if relative:
        root = ET.fromstring(entries['xl/_rels/workbook.xml.rels'])
        for relation in root:
            if relation.get('Target', '').startswith('/xl/'):
                relation.set('Target', relation.get('Target')[4:])
        entries['xl/_rels/workbook.xml.rels'] = ET.tostring(root)
    result = BytesIO()
    with ZipFile(result, 'w') as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return result.getvalue()


class ConversionTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original'

    def test_docx_uses_paragraph_and_table_cell_coordinates_in_body_order(self):
        raw = docx_bytes(); self.path.write_bytes(raw)
        result = formats.convert_file(self.path, 'docx')
        self.assertTrue(result['complete'], result['unread_ranges'])
        self.assertEqual(result['execution']['converter'], 'python-docx')
        self.assertEqual(result['method'], 'docx_text')
        kinds = {unit['location']['kind'] for unit in result['units']}
        self.assertEqual(kinds, {'paragraphs', 'table_cells'})
        texts = [unit['content'] for unit in result['units']]
        self.assertLess(texts.index('Before table: keep every condition.'), texts.index('Item'))
        self.assertLess(texts.index('Never omit exceptions.'), texts.index('After table.'))
        self.assertEqual(result['original_coverage'], 'not_verified')
        self.assertEqual(result['semantic_validation'], 'not_run')
        self.assertEqual(self.path.read_bytes(), raw)

    def test_notes_comments_and_revision_markup_are_reported_unread_not_complete(self):
        self.path.write_bytes(docx_bytes(extras=True))
        result = formats.convert_file(self.path, 'docx')
        self.assertEqual(result['state'], 'partial')
        self.assertFalse(result['complete'])
        self.assertTrue(any('headers_footers_notes_images_or_embedded_objects_not_read' in item for item in result['unread_ranges']))
        self.assertTrue(any('revision_markup' in item for item in result['unread_ranges']))

    def test_image_and_header_remain_partial(self):
        self.path.write_bytes(docx_bytes(image=True, header=True))
        result = formats.convert_file(self.path, 'docx')
        self.assertEqual(result['state'], 'partial')
        self.assertFalse(result['complete'])
        self.assertTrue(any('images_or_embedded_objects_not_read' in item for item in result['unread_ranges']))

    def test_merged_cell_is_read_once_and_nested_table_is_reported_unread(self):
        from docx import Document
        document = Document(); table = document.add_table(rows=3, cols=2)
        table.cell(0, 0).merge(table.cell(0, 1)).text = 'Merged heading.'
        table.cell(1, 0).text = 'First line.\nSecond line.'
        table.cell(1, 1).text = 'Outer condition.'
        nested = table.cell(2, 0).add_table(rows=1, cols=1)
        nested.cell(0, 0).text = 'Nested exception.'
        document.save(self.path)
        result = formats.convert_file(self.path, 'docx')
        texts = [unit['content'] for unit in result['units']]
        self.assertEqual(texts.count('Merged heading.'), 1)
        self.assertIn('First line.\nSecond line.', texts)
        self.assertNotIn('Nested exception.', texts)
        self.assertFalse(result['complete'])
        self.assertTrue(any('nested_table_not_read' in item for item in result['unread_ranges']))

    def test_no_pandoc_is_required_or_reported_anywhere(self):
        self.path.write_bytes(docx_bytes())
        result = formats.convert_file(self.path, 'docx')
        self.assertNotIn('pandoc', json.dumps(result, ensure_ascii=False).lower())
        self.assertNotIn('pandoc', formats.diagnostics())

    def test_verbatim_text_xlsx_formulas_and_pdf_remain_on_existing_paths(self):
        self.path.write_bytes('**원문**\r\n\tkeep\n'.encode())
        for format in ('md', 'txt'):
            with self.subTest(format=format):
                result = formats.convert_file(self.path, format)
                self.assertEqual(result['units'][0]['content'].encode(), self.path.read_bytes())
        from openpyxl import Workbook
        workbook = Workbook(); workbook.active['B3'] = '=A1*3'
        raw = BytesIO(); workbook.save(raw); self.path.write_bytes(raw.getvalue())
        result = formats.convert_file(self.path, 'xlsx')
        unit = next(unit for unit in result['units'] if unit['location']['kind'] == 'cells')
        self.assertEqual(unit['location'], {'kind': 'cells', 'sheet': 'Sheet', 'cells': 'B3'})
        self.assertIn('formula: =A1*3\ncached_value: [unavailable]', unit['content'])
        self.assertFalse(result['complete'])
        from pypdf import PdfWriter
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
        with self.path.open('wb') as stream:
            writer.write(stream)
        result = formats.convert_file(self.path, 'pdf', ocr='never')
        self.assertEqual(result['units'][0]['location'], {'kind': 'pages', 'start': 1, 'end': 1})
        self.assertFalse(result['complete'])
        from PIL import Image
        Image.new('RGB', (10, 10), 'white').save(self.path, format='PNG')
        result = formats.convert_file(self.path, 'png', ocr='never')
        self.assertEqual(result['method'], 'ocr')
        self.assertTrue(any('ocr_required_but_disabled' in item for item in result['unread_ranges']))


class XlsxConversionTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original'

    def test_structure_then_exact_cell_records_without_source_mutation(self):
        raw = xlsx_bytes(); self.path.write_bytes(raw)
        result = formats.convert_file(self.path, 'xlsx')
        self.assertTrue(result['complete'], result['unread_ranges'])
        self.assertEqual(result['execution']['converter'], 'openpyxl')
        self.assertEqual(result['method'], 'xlsx_values')
        self.assertEqual(result['units'][0]['unit_id'], 'workbook-structure')
        self.assertEqual(result['units'][0]['location'], {'kind': 'whole'})
        self.assertIn('## XLSX 원본 구조', result['units'][0]['content'])
        self.assertEqual(len([item for item in result['units'] if item['location']['kind'] == 'cells']), 14)
        self.assertEqual(self.path.read_bytes(), raw)

    def test_formula_raw_caches_types_array_formula_and_exact_cell_locations(self):
        self.path.write_bytes(xlsx_bytes())
        result = formats.convert_file(self.path, 'xlsx')
        units = {(unit['location']['sheet'], unit['location']['cells']): unit for unit in result['units']
                 if unit['location']['kind'] == 'cells'}
        self.assertEqual(len(units), 14)
        expected = {'C3': ('=SUM(B4:B5)', '0.30000000000000004'), 'D7': ('="저장 문자열"', '저장 문자열'),
                    'E9': ('=0', '0'), 'F10': ('=1/0', '#DIV/0!'), 'G11': ('=""', ''),
                    'H12': ('=NOW()', '46000.5'), 'I13': ('=1/7', '0.142857142857142857142857142857'),
                    'K15': ('=SUM(B4:B5)', '0.3')}
        for address, (formula, cached) in expected.items():
            text = units[('계산 표', address)]['content']
            self.assertIn('formula: ' + formula, text)
            self.assertIn('cached_raw: ' + json.dumps(cached, ensure_ascii=False), text)
            self.assertIn('"계산 표"!' + address, text)
        self.assertIn('cached_value: false', units[('계산 표', 'E9')]['content'])
        self.assertIn('cached_value: ""', units[('계산 표', 'G11')]['content'])
        self.assertIn('"ref": "K15:K16"', units[('계산 표', 'K15')]['content'])
        self.assertIn('조건 | 예외 `원문`\n다음 줄', units[('계산 표', 'A3')]['content'])
        self.assertEqual(result['original_coverage'], 'not_verified')
        self.assertEqual(result['semantic_validation'], 'not_run')

    def test_relative_part_paths_and_missing_cache_remain_partial(self):
        self.path.write_bytes(xlsx_bytes(missing_cache=True, relative=True))
        result = formats.convert_file(self.path, 'xlsx')
        self.assertEqual(result['execution']['converter'], 'openpyxl')
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(result['unread_ranges'], ['계산 표!J14: formula_cached_value_unavailable'])
        unit = next(item for item in result['units'] if item['location'].get('cells') == 'J14')
        self.assertIn('cached_value: [unavailable]', unit['content'])
        self.assertIn('cached_raw: ""', unit['content'])

    def test_every_cell_record_keeps_its_original_cache_text(self):
        self.path.write_bytes(xlsx_bytes())
        result = formats.convert_file(self.path, 'xlsx')
        self.assertTrue(result['complete'])
        self.assertIn('cached_raw: "0.142857142857142857142857142857"',
                      next(item['content'] for item in result['units'] if item['location'].get('cells') == 'I13'))

    def test_part_paths_are_package_local_only(self):
        self.assertEqual(xlsx_view.part_path('/xl/worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml')
        self.assertEqual(xlsx_view.part_path('./worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml')
        for target in ('../../secret.xml', 'https://example.test/secret.xml', 'file:///secret.xml', '..\\secret.xml'):
            with self.subTest(target=target), self.assertRaises(ValueError):
                xlsx_view.part_path(target)


class CheckpointTest(unittest.TestCase):
    def test_windows_transient_replace_keeps_old_checkpoint_until_success(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'conversion.json'
            path.write_text('{"units": ["old"]}')
            original = path.read_bytes()
            replace = os.replace
            attempts = []

            def busy_then_replace(source, target):
                attempts.append(source)
                self.assertEqual(path.read_bytes(), original)
                if len(attempts) <= 2:
                    error = PermissionError(errno.EACCES, 'private path and token must not escape')
                    error.winerror = 32
                    raise error
                replace(source, target)

            with patch.object(worker.os, 'replace', side_effect=busy_then_replace), patch.object(worker.time, 'sleep'):
                worker.atomic_json(path, {'units': ['old', 'new']})
            self.assertEqual(len(attempts), 3)
            self.assertEqual(json.loads(path.read_text()), {'units': ['old', 'new']})
            self.assertEqual(list(path.parent.glob('.conversion-*')), [])

    def test_permanent_lock_and_other_io_failure_preserve_checkpoint(self):
        for winerror, expected_attempts, code in ((32, 8, 'conversion_checkpoint_locked'),
                (None, 1, 'conversion_checkpoint_write_failed')):
            with self.subTest(winerror=winerror), TemporaryDirectory() as temporary:
                path = Path(temporary) / 'conversion.json'
                path.write_text('{"units": ["old"]}')
                original = path.read_bytes()
                error = PermissionError(errno.EACCES, 'private path and token must not escape')
                if winerror is not None:
                    error.winerror = winerror
                with patch.object(worker.os, 'replace', side_effect=error) as replace, patch.object(worker.time, 'sleep'):
                    with self.assertRaises(worker.CheckpointWriteError) as caught:
                        worker.atomic_json(path, {'units': ['new']})
                self.assertEqual(replace.call_count, expected_attempts)
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(list(path.parent.glob('.conversion-*')), [])
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn('private', str(caught.exception))

    def test_worker_exit_reports_whitelist_and_native_failure(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'failure.json'
            path.write_text(json.dumps({'schema_version': 1, 'code': 'conversion_checkpoint_locked',
                'winerror': 32, 'errno': 13, 'message': 'secret', 'path': '/private/input'}))
            self.assertEqual(worker_exit_failure(path, 1), {'code': 'conversion_checkpoint_locked',
                'winerror': 32, 'errno': 13, 'exit_code': 1})
            for value in ({'schema_version': 1, 'code': 'secret'}, {'schema_version': 1, 'code': []},
                          {'schema_version': 1, 'code': 'conversion_worker_exception', 'message': 'x' * 5000}):
                path.write_text(json.dumps(value))
                self.assertEqual(worker_exit_failure(path, 1), {'code': 'worker_failed', 'exit_code': 1})
            path.unlink()
            for exit_code, code in ((-signal.SIGSEGV, 'conversion_worker_crashed'),
                    (-signal.SIGTERM, 'conversion_worker_terminated'),
                    (0xc0000005, 'conversion_worker_crashed'), (-1073741819, 'conversion_worker_crashed'),
                    (0xc0000017, 'conversion_memory_failed'),
                    (0xc000009a, 'conversion_resources_failed')):
                self.assertEqual(worker_exit_failure(path, exit_code), {'code': code, 'exit_code': exit_code})


class WorkerTest(unittest.IsolatedAsyncioTestCase):
    async def test_failure_before_first_unit_retains_attempt_method_without_claiming_conversion(self):
        from core.client.source_conversion_report import empty_conversion
        source = dict(source_id='a' * 32, source_version='b' * 32,
                      source_sha256='c' * 64, registration_revision='d' * 64)
        catalog = {'source_id': source['source_id'], 'current_version': source['source_version'],
                   'registration_revision': source['registration_revision'],
                   'versions': [{**source, 'format': 'pdf', 'size_bytes': 10}], 'access': {'user_id': 'fixture'}}
        failure = empty_conversion('pdf', 'conversion_checkpoint_locked')
        failure['worker_failure'] = {'code': 'conversion_checkpoint_locked', 'exit_code': 1, 'winerror': 32}
        with TemporaryDirectory() as temporary:
            with patch('core.client.source_conversion.api_call', new=AsyncMock(return_value=catalog)), \
                    patch('core.client.source_conversion.download', new=AsyncMock(return_value=Path(temporary) / 'original')), \
                    patch('core.client.source_conversion.run_worker', new=AsyncMock(return_value=failure)):
                result = await convert_source(base_url='http://127.0.0.1:8766', tenant='test', token='private',
                    source_ref=source, work_dir=Path(temporary).resolve() / 'work', http=object())
        self.assertFalse(result['ok'])
        self.assertEqual(result['conversion']['method'], 'pdf_text')
        self.assertEqual(result['conversion']['units'], [])
        self.assertFalse(result['conversion']['complete'])
        self.assertEqual(result['state'], 'failed')
        self.assertIn('conversion_attempt_no_text', result['conversion']['warnings'])
        self.assertEqual(result['error'], {'code': 'conversion_checkpoint_locked'})

    async def test_worker_checkpoint_failure_retains_units_and_safe_reason(self):
        script = '''
import errno, sys
from core.client import source_conversion_worker as worker
from core.client.source_conversion_report import Conversion
def fail(path, format, **kwargs):
    report = Conversion(format, kwargs['checkpoint'])
    report.add('page-1', {'kind': 'pages', 'start': 1, 'end': 1}, 'preserved text', 'ocr')
    report.note('ocr_confidence=87', 'page 2', unread=False)
    error = PermissionError(errno.EACCES, 'sensitive path/token must not escape')
    error.winerror = 32
    raise worker.CheckpointWriteError(error)
worker.convert_file = fail
sys.exit(worker.main())
'''
        with TemporaryDirectory() as temporary:
            directory = Path(temporary); original = directory / 'original'; original.write_bytes(b'preserve')
            with patch('core.client.source_conversion.process_arguments',
                    side_effect=lambda arguments: [sys.executable, '-c', script, *arguments[4:]]):
                result = await run_worker(original, 'pdf', directory / 'conversion.json', ocr='auto', language='eng',
                    timeout=30, cancel_file=None, emit=lambda *args, **kwargs: None)
            self.assertEqual(result['state'], 'partial')
            self.assertFalse(result['complete'])
            self.assertEqual(result['units'][0]['content'], 'preserved text')
            self.assertIn('page 2: ocr_confidence=87', result['warnings'])
            self.assertEqual(result['unread_ranges'], ['remaining source: conversion_checkpoint_locked'])
            self.assertEqual(result['worker_failure'], {'code': 'conversion_checkpoint_locked',
                'errno': 13, 'winerror': 32, 'exit_code': 1})
            self.assertNotIn('sensitive', json.dumps(result))
            self.assertNotIn(str(directory), json.dumps(result))
            self.assertEqual(original.read_bytes(), b'preserve')
            self.assertEqual(list(directory.glob('scratch-*')), [])

    async def test_worker_timeout_and_cancel_do_not_report_complete(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary); original = directory / 'original'; original.write_bytes(docx_bytes())
            for reason in ('timeout', 'cancel'):
                cancel = directory / 'cancel'
                if reason == 'cancel':
                    cancel.touch()
                result = await run_worker(original, 'docx', directory / (reason + '.json'), ocr='never', language='eng',
                    timeout=.001 if reason == 'timeout' else 30, cancel_file=cancel, emit=lambda *args, **kwargs: None)
                self.assertFalse(result['complete'])
                self.assertEqual(result['state'], 'cancelled' if reason == 'cancel' else 'failed')
                self.assertIn('conversion_' + ('cancelled' if reason == 'cancel' else 'timeout'), str(result['unread_ranges']))
                self.assertEqual(result['worker_failure']['code'], 'conversion_' + ('cancelled' if reason == 'cancel' else 'timeout'))
                self.assertTrue(original.exists())
            self.assertEqual(list(directory.glob('scratch-*')), [])


class RegistrationFlowTest(unittest.IsolatedAsyncioTestCase):
    async def workflow_mutation(self, http, path, operation, **values):
        current = await http.get(path)
        self.assertEqual(current.status_code, 200, current.text)
        workflow = current.json()['data']['workflow']
        response = await http.post(path + '/' + operation, json=dict(request_id=uuid4().hex,
            expected_revision=workflow['revision'], **values))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['data']['workflow']

    async def test_actual_upload_worker_report_response_loss_and_preserved_markdown_revision(self):
        await self.registration_flow('docx', manual_content_appendix=(
            '사용자 직접 보완: Unread header condition.\nFootnote exception.\nEndnote exception.\n'
            'Reviewer comment.\n삽입 기록: Inserted condition.\n삭제 기록: Deleted condition.\n그림: 흰색 빈 이미지.'))

    async def test_actual_xlsx_upload_worker_report_and_preserved_markdown_revision(self):
        await self.registration_flow('xlsx', manual_content_appendix='사용자 직접 보완: 계산 표 J14의 =1+2 계산 결과는 3.')

    async def test_complex_xlsx_structure_and_cells_reach_exact_markdown_revision(self):
        from .test_source_conversion_xlsx_complex import complex_xlsx_bytes
        await self.registration_flow('xlsx', original=complex_xlsx_bytes(), expected_state='complete')

    async def test_eight_sheets_and_styles_reach_same_markdown_revision(self):
        from .test_source_conversion_xlsx_sheets import multisheet_bytes
        await self.registration_flow('xlsx', original=multisheet_bytes(), expected_state='complete')

    async def registration_flow(self, format, *, original=None, expected_state='partial', manual_content_appendix=None):
        import httpx2
        from core.common.access import access_dict
        from core.modules.access.policy import AccessPolicy
        from core.modules.access.auth import initialize_auth
        from core.modules.analysis_jobs.store import JobStore
        from core.modules.analysis_jobs import records
        from core.modules.analysis_inputs.store import InputStore
        from core.modules.analysis_inputs import bundles
        from core.modules.analysis_results.store import ResultStore
        from core.modules.documents.metadata import parse_document
        from core.modules.extraction_rules.publish import publish
        from core.modules.extraction_rules.store import RulesetRegistry
        from core.runtime.application import create_application
        from core.runtime.extraction_schema import build_submission_schema

        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); (root / 'data').mkdir(); (root / 'tenancy').mkdir()
            config = root / 'tenancy/policy.json'; config.write_text(json.dumps(dict(version=1, tenants={}, users={})))
            policy = AccessPolicy(config, root / 'data'); auth = initialize_auth(policy)
            user = grant_test_membership(policy, auth.signup('문서 등록 시험'))
            tenant = user['default_tenant']
            schema = build_submission_schema()
            publish(root / 'rules', tenant_root=root / 'data', ruleset_id='common', ruleset_version='v1',
                    reason='isolated conversion registration test', schema=schema, expected_schema=schema)
            release = dict(ruleset_id='common', ruleset_version='v1')
            (root / 'rules-policy.json').write_text(json.dumps(dict(version=1, tenants={tenant: dict(
                default=release, allowed=[release], revoked=[])})))
            rules = RulesetRegistry(root / 'rules', root / 'rules-policy.json', root / 'data', expected_schema=schema)
            app = create_application(policy, auth=auth, rulesets=rules)
            base = 'http://127.0.0.1:8766'; prefix = f'/api/v1/tenants/{tenant}'
            if original is None:
                original = docx_bytes(extras=True, image=True, header=True) if format == 'docx' else xlsx_bytes(missing_cache=True)
            async with app.router.lifespan_context(app), httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                    base_url=base, headers={'Authorization': 'Bearer ' + user['token']}) as http:
                response = await http.post(prefix + '/sources', data=dict(request_id=uuid4().hex, title='조건 보존'),
                    files={'file': ('conditions.' + format, original, 'application/octet-stream')})
                self.assertEqual(response.status_code, 201, response.text)
                registered = response.json()['data']
                source = {key: registered[key] for key in ('source_id', 'source_version', 'source_sha256', 'registration_revision')}
                self.assertEqual(source['source_sha256'], sha256(original).hexdigest())
                lost_posts = []
                class LoseReportResponse:
                    def __getattr__(self, key):
                        return getattr(http, key)

                    async def post(self, *args, **kwargs):
                        response = await http.post(*args, **kwargs)
                        lost_posts.append(response.status_code)
                        raise httpx2.ReadError('simulated response loss after conversion commit')

                converted = await convert_source(base_url=base, tenant=tenant, token=user['token'], source_ref=source,
                    work_dir=root / 'work', ocr='never', submit=True, http=LoseReportResponse())
                self.assertTrue(converted['ok'], converted)
                self.assertEqual(converted['state'], expected_state)
                self.assertEqual(converted['receipt']['state'], 'saved')
                self.assertTrue(converted['receipt']['reconciled'])
                self.assertEqual(lost_posts, [201])
                self.assertEqual(Path(converted['original_file']).read_bytes(), original)
                conversion = converted['conversion']
                stored = converted['receipt']['manifest']
                self.assertEqual(stored['source_ref'], source)
                self.assertEqual(stored['warnings'], conversion['warnings'])
                self.assertEqual(stored['unread_ranges'], conversion['unread_ranges'])
                self.assertEqual(stored['units'][0]['location']['kind'], 'whole' if format == 'xlsx' else 'paragraphs')
                expected_report = report_body(conversion, source, converted['request_id'], None)
                self.assertEqual([item['location'] for item in stored['units']], [item['location'] for item in expected_report['units']])
                self.assertEqual(json.loads(Path(converted['report_file']).read_text()),
                                 report_body(conversion, source, converted['request_id'], None))
                request_id, execution_claim_id, workflow_path = uuid4().hex, None, None
                expected_body = '\n\n'.join(unit['content'] for unit in conversion['units'])
                if not conversion['complete'] and conversion['unread_ranges']:
                    # 누락이 있는 옛 fixture도 현재 제품과 같이 직접 입력을 확정한다.
                    # 합성 작성자가 헤더/각주/수식 누락을 실제 보완한 전체 본문을 선택한다.
                    self.assertTrue(manual_content_appendix)
                    manual_content = expected_body + '\n\n' + manual_content_appendix
                    expected_body = manual_content
                    workflow_path = prefix + '/notification-workflows/' + converted['receipt']['conversion_ref']['conversion_id']
                    selected = await self.workflow_mutation(http, workflow_path, 'corrections',
                        whole_document=True, method='manual', content=manual_content)
                    correction = selected['pages'][0]['correction_ref']
                    await self.workflow_mutation(http, workflow_path, 'pages', decisions=[dict(
                        whole_document=True, correction_ref=correction, state='usable')])
                    await self.workflow_mutation(http, workflow_path, 'approve', device_id='1' * 32,
                        device_name='Synthetic owner', target_document='conditions.md',
                        correction_refs=[dict(whole_document=True, correction_ref=correction)])
                    granted = await self.workflow_mutation(http, workflow_path, 'claim',
                        device_id='1' * 32, device_name='Synthetic owner')
                    request_id, execution_claim_id = granted['resume_request_id'], granted['execution']['claim_id']
                response = await http.post(prefix + '/analysis-jobs/registrations', json=dict(request_id=request_id,
                    source_ref=source, title='조건 보존', document='conditions.md', conversion_ref=converted['receipt']['conversion_ref']))
                self.assertEqual(response.status_code, 201, response.text)
                created = response.json()['data']
                if workflow_path:
                    await self.workflow_mutation(http, workflow_path, 'execution',
                        claim_id=execution_claim_id, job_id=created['job_id'])
                download = await http.get(prefix + f"/sources/{source['source_id']}/versions/{source['source_version']}/file")
                self.assertEqual(download.content, original)
                rejected = await convert_source(base_url=base, tenant=tenant, token=user['token'],
                    source_ref={**source, 'source_sha256': '0' * 64}, work_dir=root / 'work', submit=True, http=http)
                self.assertEqual(rejected['error']['code'], 'source_basis_changed')
                self.assertIsNone(rejected['original_file'])
            scope = policy.authorize(user['token'], tenant, 'read')
            def authorize(permission=None):
                return access_dict(policy.authorize(user['token'], tenant, permission or 'source_write'))
            jobs = JobStore(scope.store, rulesets=rules); args = dict(tenant=tenant, user_id=user['user_id'])
            claimed = jobs.claim(created['job_id'], **args, expected_job_revision=created['job_revision'], authorize=authorize,
                                 execution_claim_id=execution_claim_id)
            inputs = InputStore(scope.store, rules, jobs=jobs)
            fixed = inputs.prepare(created['job_id'], **args, run_id=claimed['run_id'],
                expected_job_revision=claimed['job_revision'], stage='prepare_wiki', authorize=authorize)
            job = records.owned_state(jobs, created['job_id'], **args)
            _, _, components = bundles.load_locked(inputs, job, fixed['bundle_id'], fixed['bundle_revision'])
            results = ResultStore(scope.store, rules, jobs=jobs)
            saved = results.write_wiki(created['job_id'], **args, run_id=claimed['run_id'],
                expected_job_revision=fixed['job_revision'], bundle_id=fixed['bundle_id'], bundle_revision=fixed['bundle_revision'],
                request_id=uuid4().hex, document='conditions.md', content=components['data/registration.md'],
                expected_revision=None, authorize=authorize)
            self.assertTrue(saved['saved'], saved)
            document = scope.store.read('conditions.md')
            self.assertEqual(parse_document(document.content).body, expected_body)
            report = jobs.query(created['job_id'], **args)['conversion']
            self.assertEqual(report['first_markdown']['revision'], document.revision)
            self.assertEqual(report['source_ref'], source)
            self.assertEqual(report['warnings'], conversion['warnings'])
            self.assertEqual(report['unread_ranges'], conversion['unread_ranges'])
            self.assertEqual(report['complete'], conversion['complete'])
            self.assertEqual(len(list((scope.store.data_dir / '_sources').iterdir())), 1)
