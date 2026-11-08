"""개인 변환기의 보존·실패 계약. 변환 실행과 의미 정확성 평가는 구분한다."""

from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from core.client import source_conversion_formats as formats
from core.client.source_conversion import convert_source, report_body, run_worker
from core.client import source_conversion_xlsx as xlsx_view


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


class WorkerTest(unittest.IsolatedAsyncioTestCase):
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
                self.assertTrue(original.exists())
            self.assertEqual(list(directory.glob('scratch-*')), [])


class RegistrationFlowTest(unittest.IsolatedAsyncioTestCase):
    async def test_actual_upload_worker_report_response_loss_and_preserved_markdown_revision(self):
        await self.registration_flow('docx')

    async def test_actual_xlsx_upload_worker_report_and_preserved_markdown_revision(self):
        await self.registration_flow('xlsx')

    async def test_complex_xlsx_structure_and_cells_reach_exact_markdown_revision(self):
        from .test_source_conversion_xlsx_complex import complex_xlsx_bytes
        await self.registration_flow('xlsx', original=complex_xlsx_bytes(), expected_state='complete')

    async def test_eight_sheets_and_styles_reach_same_markdown_revision(self):
        from .test_source_conversion_xlsx_sheets import multisheet_bytes
        await self.registration_flow('xlsx', original=multisheet_bytes(), expected_state='complete')

    async def registration_flow(self, format, *, original=None, expected_state='partial'):
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
            user = auth.signup('문서 등록 시험'); tenant = user['default_tenant']
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
                response = await http.post(prefix + '/analysis-jobs/registrations', json=dict(request_id=uuid4().hex,
                    source_ref=source, title='조건 보존', document='conditions.md', conversion_ref=converted['receipt']['conversion_ref']))
                self.assertEqual(response.status_code, 201, response.text)
                created = response.json()['data']
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
            claimed = jobs.claim(created['job_id'], **args, expected_job_revision=created['job_revision'], authorize=authorize)
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
            self.assertEqual(parse_document(document.content).body, '\n\n'.join(unit['content'] for unit in conversion['units']))
            report = jobs.query(created['job_id'], **args)['conversion']
            self.assertEqual(report['first_markdown']['revision'], document.revision)
            self.assertEqual(report['source_ref'], source)
            self.assertEqual(report['warnings'], conversion['warnings'])
            self.assertEqual(report['unread_ranges'], conversion['unread_ranges'])
            self.assertEqual(len(list((scope.store.data_dir / '_sources').iterdir())), 1)
