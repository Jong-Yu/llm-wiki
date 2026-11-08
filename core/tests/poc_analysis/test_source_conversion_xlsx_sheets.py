"""여러 시트의 순서/정확한 이름/원문 연결과 의미에 필요한 서식 출처를 검사한다."""

from io import BytesIO
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from core.client import source_conversion_formats as formats
from core.client import source_conversion_xlsx as xlsx_view

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
NAMES = ('총괄', '실적', '실적 ', "O'Brien", '빈 시트', '숨김', '완전 숨김', '색상')


def multisheet_bytes():
    from openpyxl import Workbook
    from openpyxl.styles import PatternFill
    from openpyxl.formatting.rule import CellIsRule
    workbook = Workbook(); workbook.remove(workbook.active)
    for index, name in enumerate(NAMES, 1):
        sheet = workbook.create_sheet(name)
        if name == '빈 시트':
            continue
        sheet['A1'] = '공통 이름'; sheet['B2'] = index
        sheet['C3'] = "='실적 '!B2"; sheet['D4'] = "='O''Brien'!B2"; sheet['E5'] = '=Rate'
        sheet['F6'] = "=SUM('실적:실적 '!B2)"
    workbook['숨김'].sheet_state = 'hidden'; workbook['완전 숨김'].sheet_state = 'veryHidden'
    colors = workbook['색상']; colors['A8'] = '빨강=보류 / 초록=진행'
    colors['B8'] = '같은 값'; colors['B9'] = '같은 값'
    colors['B8'].fill = PatternFill('solid', fgColor='FFFF0000')
    colors['B9'].fill = PatternFill('solid', fgColor='FF00FF00')
    colors.row_dimensions[8].height = 30; colors.column_dimensions['B'].width = 25
    colors['D9'] = 0
    colors.conditional_formatting.add('D9', CellIsRule(operator='lessThan', formula=['1'],
        fill=PatternFill('solid', fgColor='FFFF0000')))
    raw = BytesIO(); workbook.save(raw)
    with ZipFile(BytesIO(raw.getvalue())) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    for index, _ in enumerate(NAMES, 1):
        part = f'xl/worksheets/sheet{index}.xml'; root = ET.fromstring(entries[part])
        for cell in root.iter(NS + 'c'):
            if cell.find(NS + 'f') is not None:
                cached = cell.find(NS + 'v')
                if cached is None:
                    cached = ET.SubElement(cell, NS + 'v')
                cached.text = str(1000 + index * 10 + int(cell.attrib['r'][1:]))
        entries[part] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    root = ET.fromstring(entries['xl/workbook.xml']); sheets = root.find(NS + 'sheets')
    original = list(sheets); order = (3, 0, 6, 2, 4, 7, 1, 5)
    sheets[:] = [original[index] for index in order]
    for index, sheet in enumerate(sheets, 1):
        sheet.set('sheetId', str(100 + index * 7))
    defined = root.find(NS + 'definedNames')
    if defined is None:
        defined = ET.SubElement(root, NS + 'definedNames')
    ET.SubElement(defined, NS + 'definedName', name='Rate').text = "'총괄'!$B$2"
    for index, sheet in enumerate(sheets):
        if sheet.get('name') in ('실적', '실적 '):
            target = "'" + sheet.get('name') + "'!$B$2"
            ET.SubElement(defined, NS + 'definedName', name='Rate', localSheetId=str(index)).text = target
    entries['xl/workbook.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    relations = ET.fromstring(entries['xl/_rels/workbook.xml.rels']); relations[:] = list(reversed(list(relations)))
    entries['xl/_rels/workbook.xml.rels'] = ET.tostring(relations)
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


def snapshot(raw):
    with ZipFile(BytesIO(raw)) as archive:
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        relations = {item.attrib['Id']: item.attrib['Target'] for item in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        sheets, cells = [], {}
        for sheet in workbook.find(NS + 'sheets'):
            target = relations[sheet.attrib[RID]]
            part = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            sheets.append(dict(name=sheet.attrib['name'], sheet_id=sheet.attrib['sheetId'], part=part))
            for cell in ET.fromstring(archive.read(part)).iter(NS + 'c'):
                formula, cached = cell.find(NS + 'f'), cell.find(NS + 'v')
                inline = ''.join(item.text or '' for item in cell.iter(NS + 't'))
                if formula is not None or cached is not None or inline:
                    cells[(sheet.attrib['name'], cell.attrib['r'])] = dict(formula=formula.text if formula is not None else None,
                        cached=cached.text if cached is not None else None, inline=inline)
        return sheets, cells


class MultipleSheetTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original'; self.raw = multisheet_bytes(); self.path.write_bytes(self.raw)

    def convert(self):
        result = formats.convert_file(self.path, 'xlsx')
        self.assertTrue(result['complete'], result['unread_ranges'])
        self.assertEqual(self.path.read_bytes(), self.raw)
        structure = json.JSONDecoder().raw_decode(result['units'][0]['content'].split('```json\n', 1)[1])[0]
        return result, structure

    def test_every_sheet_order_name_empty_hidden_and_relationship_mapping(self):
        result, structure = self.convert(); sheets, expected = snapshot(self.raw)
        self.assertEqual([item['name'] for item in structure['sheets']], [item['name'] for item in sheets])
        self.assertEqual([item['part'] for item in structure['sheets']], [item['part'] for item in sheets])
        self.assertEqual([item['sheet_id'] for item in structure['sheets']], [item['sheet_id'] for item in sheets])
        self.assertEqual([item['index'] for item in structure['sheets']], list(range(1, 9)))
        units = {(item['location']['sheet'], item['location']['cells']): item['content'] for item in result['units'] if item['location']['kind'] == 'cells'}
        self.assertEqual(set(units), set(expected))
        for key, source in expected.items():
            if source['formula'] is not None:
                self.assertIn('formula: =' + source['formula'], units[key])
                self.assertIn('cached_raw: ' + json.dumps(source['cached']), units[key])
        states = {item['name']: item['state'] for item in structure['sheets']}
        self.assertEqual(states['숨김'], 'hidden'); self.assertEqual(states['완전 숨김'], 'veryHidden')
        self.assertEqual(result['execution']['converter'], 'openpyxl')

    def test_defined_name_scope_and_color_only_meaning_remain_traceable(self):
        _, structure = self.convert()
        names = structure['defined_names']
        self.assertEqual(len([item for item in names if item['attributes']['name'] == 'Rate']), 3)
        local = {item['scope_sheet']: item['text'] for item in names if item['scope_sheet'] is not None}
        self.assertEqual(local, {'실적 ': "'실적 '!$B$2", '실적': "'실적'!$B$2"})
        color = next(item for item in structure['sheets'] if item['name'] == '색상')
        self.assertNotEqual(color['cell_styles']['B8'], color['cell_styles']['B9'])
        styles = structure['styles']
        red = styles['cell_xfs'][color['cell_styles']['B8']]['attributes']['fillId']
        green = styles['cell_xfs'][color['cell_styles']['B9']]['attributes']['fillId']
        self.assertIn('FFFF0000', json.dumps(styles['fills'][red]))
        self.assertIn('FF00FF00', json.dumps(styles['fills'][green]))
        self.assertEqual(color['row_formatting']['8']['ht'], '30')
        self.assertTrue(any(item.get('width') == '25' and item['min'] == '2' for item in color['column_formatting']))
        self.assertIn('lessThan', json.dumps(color['conditional_formatting']))

    def test_names_and_source_styles_are_preserved(self):
        result, structure = self.convert()
        self.assertEqual(result['execution']['converter'], 'openpyxl')
        self.assertEqual(len(structure['sheets']), 8)
        self.assertEqual(len(structure['defined_names']), 3)
        self.assertIn('FFFF0000', json.dumps(structure['styles']))
