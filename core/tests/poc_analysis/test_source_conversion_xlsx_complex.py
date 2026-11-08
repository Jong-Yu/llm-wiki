"""병합/여러 표의 대응을 원본 OOXML과 대조한다. 시각·의미 평가는 별도다."""

from io import BytesIO
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from core.client import source_conversion_formats as formats
from core.client import source_conversion_xlsx as xlsx_view

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
SHEETS = ('계획 | 원문', '요율 표', '숨김 근거')


def complex_xlsx_bytes():
    from openpyxl import Workbook
    from openpyxl.worksheet.table import Table, TableStyleInfo, TableColumn
    workbook = Workbook(); sheet = workbook.active; sheet.title = SHEETS[0]
    sheet['A1'] = '설명 문장: 열 머리글이 아님'
    for bounds, value in (('B2:G2', '계획 전체'), ('B3:B5', '품목'), ('C3:D3', '금액'),
                          ('E3:F4', '요율'), ('G3:G5', '조건'), ('B6:B7', '품목 묶음'),
                          ('E6:F7', '=C6/C7'), ('G6:G7', '조건 | 예외 `기호`\n다음 줄')):
        sheet.merge_cells(bounds); sheet[bounds.split(':')[0]] = value
    sheet.merge_cells('J2:L4')  # 의도한 빈 기준셀. 인접 텍스트를 전파하면 안 된다.
    sheet['C4'] = '예산'; sheet['D4'] = '실적'; sheet['C5'] = '원화'; sheet['D5'] = '원화'
    sheet['C6'] = "='요율 표'!D4*C7"; sheet['C7'] = 10
    sheet['D6'] = '=SUM(C6:C7)'; sheet['D7'] = '금액'
    for start, name in ((2, 'OriginalBudget'), (10, 'SeparateBudget')):
        for offset, value in enumerate(('품목', '금액', '조건', '원문') if start == 10 else ('품목', '금액', '조건', '계획', '근거', '비고')):
            sheet.cell(11, start + offset, value)
        width = 4 if start == 10 else 6
        for row in (12, 13, 14):
            for offset in range(width):
                sheet.cell(row, start + offset, '금액' if offset == 0 else f'{name}-{row}-{offset}')
        last = 'M' if start == 10 else 'G'
        final_row = 14 if start == 10 else 15
        if start == 2:
            sheet['B15'] = '합계'; sheet['C15'] = '=SUM(C12:C14)'
        table = Table(displayName=name, ref=f'{"J" if start == 10 else "B"}11:{last}{final_row}',
                      totalsRowCount=1 if start == 2 else None)
        table.tableColumns = [TableColumn(id=index + 1, name=sheet.cell(11, start + index).value,
            totalsRowFunction='sum' if start == 2 and index == 1 else None) for index in range(width)]
        table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium9', showRowStripes=True)
        sheet.add_table(table)
    sheet['J12'] = '=SUM(C6:C7)'; sheet['J13'] = '=SUM(C7:C8)'
    sheet.row_dimensions[14].hidden = True; sheet.column_dimensions['F'].hidden = True
    sheet['P20'].number_format = '0.00'  # 데이터 없는 서식 셀
    rates = workbook.create_sheet(SHEETS[1]); rates.merge_cells('C2:E3'); rates['C2'] = '금액'; rates['D4'] = 12
    hidden = workbook.create_sheet(SHEETS[2]); hidden.sheet_state = 'hidden'
    hidden['C3'] = '금액'; hidden['D5'] = "='계획 | 원문'!C7"; hidden['E7'] = '```\n원문 | 유지\n```'
    raw = BytesIO(); workbook.save(raw)
    with ZipFile(BytesIO(raw.getvalue())) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    for index, caches in ((1, {'C6': '120', 'D6': '130', 'E6': '12', 'J12': '130', 'J13': '10', 'C15': '0'}), (3, {'D5': '10'})):
        part = f'xl/worksheets/sheet{index}.xml'; root = ET.fromstring(entries[part])
        for cell in root.iter(NS + 'c'):
            address = cell.attrib['r']
            if address in caches:
                cached = cell.find(NS + 'v')
                if cached is None:
                    cached = ET.SubElement(cell, NS + 'v')
                cached.text = caches[address]
                if address in ('J12', 'J13'):
                    formula = cell.find(NS + 'f'); formula.set('t', 'shared'); formula.set('si', '0')
                    if address == 'J12':
                        formula.set('ref', 'J12:J13')
                    else:
                        formula.text = None
        entries[part] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


def raw_snapshot(raw):
    cells, merges, tables = {}, {}, {}
    with ZipFile(BytesIO(raw)) as archive:
        for index, name in enumerate(SHEETS, 1):
            root = ET.fromstring(archive.read(f'xl/worksheets/sheet{index}.xml'))
            merges[name] = [item.attrib['ref'] for item in root.findall(NS + 'mergeCells/' + NS + 'mergeCell')]
            for cell in root.iter(NS + 'c'):
                formula, cached = cell.find(NS + 'f'), cell.find(NS + 'v')
                inline = ''.join(item.text or '' for item in cell.iter(NS + 't'))
                if formula is not None or (cached is not None and cached.text is not None) or inline:
                    cells[(name, cell.attrib['r'])] = dict(formula=formula, cached=cached.text if cached is not None else None, inline=inline)
        for name in archive.namelist():
            if name.startswith('xl/tables/') and name.endswith('.xml'):
                root = ET.fromstring(archive.read(name)); tables[root.attrib['displayName']] = root.attrib['ref']
    return cells, merges, tables


class ComplexXlsxTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original'; self.raw = complex_xlsx_bytes(); self.path.write_bytes(self.raw)

    def convert(self):
        result = formats.convert_file(self.path, 'xlsx')
        self.assertEqual(self.path.read_bytes(), self.raw)
        self.assertEqual(result['execution']['converter'], 'openpyxl')
        return result

    def test_every_source_cell_formula_cache_and_coordinate_remains_attached(self):
        cells, _, _ = raw_snapshot(self.raw); result = self.convert()
        units = {(unit['location']['sheet'], unit['location']['cells']): unit for unit in result['units'] if unit['location']['kind'] == 'cells'}
        self.assertEqual(set(units), set(cells))
        for key, original in cells.items():
            content = units[key]['content']
            self.assertIn(json.dumps(key[0], ensure_ascii=False) + '!' + key[1], content)
            if original['formula'] is not None:
                self.assertIn('cached_raw: ' + json.dumps(original['cached'], ensure_ascii=False), content)
                self.assertIn('formula_raw: ' + json.dumps(original['formula'].text or '', ensure_ascii=False), content)
            elif original['inline']:
                self.assertIn(original['inline'], content)
        self.assertIn('formula: =SUM(C7:C8)', units[(SHEETS[0], 'J13')]['content'])
        self.assertNotIn((SHEETS[0], 'F7'), units)  # 병합된 빈 칸에 기준셀의 수식을 복제하지 않는다.
        self.assertNotIn((SHEETS[0], 'J2'), units)  # 빈 병합 기준셀은 값으로 만들어내지 않는다.
        self.assertTrue(result['complete'], result['unread_ranges'])

    def test_all_merge_anchors_table_ranges_and_hidden_scopes_are_in_markdown(self):
        _, expected_merges, expected_tables = raw_snapshot(self.raw)
        result = self.convert(); text = result['units'][0]['content']
        self.assertIn('```json\n', text, '원본 병합/표 경계가 Markdown에 필요하다')
        structure = json.JSONDecoder().raw_decode(text.split('```json\n', 1)[1])[0]
        for sheet in structure['sheets']:
            self.assertEqual([item['range'] for item in sheet['merged_ranges']], expected_merges[sheet['name']])
            for item in sheet['merged_ranges']:
                self.assertEqual(item['anchor'], item['range'].split(':')[0])
        actual_tables = {item['name']: item['range'] for sheet in structure['sheets'] for item in sheet['tables']}
        self.assertEqual(actual_tables, expected_tables)
        first = structure['sheets'][0]
        budget = next(item for item in first['tables'] if item['name'] == 'OriginalBudget')
        self.assertEqual(budget['attributes']['totalsRowCount'], '1')
        self.assertEqual(budget['columns'][1]['name'], '금액')
        self.assertEqual(budget['columns'][1]['totalsRowFunction'], 'sum')
        self.assertIn(14, first['hidden_rows'])
        self.assertTrue(any(item['start'] == 6 and item['end'] == 6 for item in first['hidden_columns']))
        self.assertEqual(structure['sheets'][2]['state'], 'hidden')

    def test_horizontal_vertical_rectangular_and_column_boundary_merges(self):
        from openpyxl import Workbook
        for reference in ('B2:F2', 'C4:C8', 'E7:H9', 'Z1:AA2', 'XFC1:XFD2'):
            with self.subTest(reference=reference):
                workbook = Workbook(); sheet = workbook.active; sheet.title = '경계 표'
                sheet.merge_cells(reference); anchor, last = reference.split(':'); sheet[anchor] = '기준 내용'
                raw = BytesIO(); workbook.save(raw); self.raw = raw.getvalue(); self.path.write_bytes(self.raw)
                result = self.convert(); text = result['units'][0]['content']
                cells = [item for item in result['units'] if item['location']['kind'] == 'cells']
                self.assertEqual([item['location']['cells'] for item in cells], [anchor])
                structure = json.JSONDecoder().raw_decode(text.split('```json\n', 1)[1])[0]
                self.assertEqual([(item['range'], item['anchor']) for item in structure['sheets'][0]['merged_ranges']],
                                 [(reference, anchor)])
                self.assertTrue(result['complete'], result['unread_ranges'])

    def test_structure_comes_first_and_literal_cells_stay_fenced(self):
        cells, _, _ = raw_snapshot(self.raw)
        result = self.convert()
        self.assertTrue(result['complete'], result['unread_ranges'])
        self.assertEqual(result['units'][0]['unit_id'], 'workbook-structure')
        self.assertIn('OriginalBudget', result['units'][0]['content'])
        self.assertEqual(len([item for item in result['units'] if item['location']['kind'] == 'cells']), len(cells))
        literal = next(item for item in result['units'] if item['location'].get('sheet') == SHEETS[2] and item['location'].get('cells') == 'E7')
        self.assertIn('```text\n', literal['content'])
        self.assertIn('원문 | 유지', literal['content'])
        self.assertTrue(literal['content'].rstrip().endswith('```'))

    def test_non_anchor_formula_is_retained_and_reported_as_ambiguous(self):
        from openpyxl.utils.cell import coordinate_to_tuple
        with ZipFile(BytesIO(self.raw)) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        root = ET.fromstring(entries['xl/worksheets/sheet1.xml'])
        row = next(item for item in root.iter(NS + 'row') if item.get('r') == '3')
        for cell in list(row):
            if cell.get('r') == 'D3':
                row.remove(cell)
        cell = ET.SubElement(row, NS + 'c', r='D3'); ET.SubElement(cell, NS + 'f').text = '99'; ET.SubElement(cell, NS + 'v').text = '99'
        row[:] = sorted(row, key=lambda item: coordinate_to_tuple(item.get('r')))
        entries['xl/worksheets/sheet1.xml'] = ET.tostring(root)
        changed = BytesIO()
        with ZipFile(changed, 'w') as archive:
            for name, content in entries.items():
                archive.writestr(name, content)
        self.raw = changed.getvalue(); self.path.write_bytes(self.raw)
        result = self.convert()
        self.assertFalse(result['complete'])
        self.assertTrue(any('non_anchor_value_inside_merge' in value and 'D3' in value for value in result['unread_ranges']))
        unit = next(item for item in result['units'] if item['location'].get('cells') == 'D3')
        self.assertIn('formula: =99', unit['content']); self.assertIn('cached_raw: "99"', unit['content'])

    def test_overlapping_merges_keep_source_records_and_report_partial(self):
        with ZipFile(BytesIO(self.raw)) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        root = ET.fromstring(entries['xl/worksheets/sheet1.xml'])
        ET.SubElement(root.find(NS + 'mergeCells'), NS + 'mergeCell', ref='C3:E4')
        entries['xl/worksheets/sheet1.xml'] = ET.tostring(root)
        changed = BytesIO()
        with ZipFile(changed, 'w') as archive:
            for name, content in entries.items():
                archive.writestr(name, content)
        self.raw = changed.getvalue(); self.path.write_bytes(self.raw)
        result = formats.convert_file(self.path, 'xlsx')
        self.assertEqual(self.path.read_bytes(), self.raw)
        self.assertFalse(result['complete'])
        self.assertEqual(result['execution']['converter'], 'openpyxl')
        self.assertTrue(any('overlapping_merged_ranges' in value for value in result['unread_ranges']))
        self.assertIn('C3:E4', result['units'][0]['content'])
        actual = {(item['location']['sheet'], item['location']['cells']) for item in result['units'] if item['location']['kind'] == 'cells'}
        self.assertEqual(actual, set(raw_snapshot(self.raw)[0]))
