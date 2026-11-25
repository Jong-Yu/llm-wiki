"""PDF 도식의 상자·선 위치로 관계를 추정해 덧붙인다(D-160). 기준을 넘으면 본문에 붙이지 않고 검토로 알린다."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

from core.client import source_conversion_formats as formats
from core.client import source_conversion_relations as relations


def make_pdf(path, body, image=False):
    """300x200pt 한 쪽. body는 PDF 그리기 명령(Helvetica는 /F1, image면 2x2 그림 /Im0)."""
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')}))
    page = writer.add_blank_page(width=300, height=200)
    stream = DecodedStreamObject()
    stream.set_data(body.encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
    if image:
        picture = DecodedStreamObject()
        picture.set_data(b'\x80\x80\x80' * 4)
        picture.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
            NameObject('/Width'): NumberObject(2), NameObject('/Height'): NumberObject(2),
            NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
        page['/Resources'][NameObject('/XObject')] = DictionaryObject({NameObject('/Im0'): writer._add_object(picture)})
    with path.open('wb') as handle:
        writer.write(handle)


BOXES = ('20 80 80 40 re S BT /F1 10 Tf 32 96 Td (Alpha) Tj ET '
         '180 80 80 40 re S BT /F1 10 Tf 200 96 Td (Beta) Tj ET ')
ARROW_HEAD = '172 104 m 180 100 l 172 96 l f '
# 높이 30pt의 둥근 모서리 상자(곡선 경로). 예전 규칙은 이것을 대각선 "선"으로 보았다.
ROUNDED = ('190 85 m 250 85 l 260 85 260 95 260 95 c 260 105 l 260 115 250 115 250 115 c 190 115 l '
           '180 115 180 105 180 105 c 180 95 l 180 85 190 85 190 85 c h ')


class PdfRelationTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'diagram.pdf'

    def convert(self, body):
        make_pdf(self.path, body)
        with patch.object(formats, 'ocr_image', side_effect=AssertionError('no whole-page OCR')):
            value = formats.convert_file(self.path, 'pdf', ocr='auto', language='kor+eng')
        return value, value['units'][0]['content']

    def test_arrow_between_named_boxes_is_added_with_estimate_mark(self):
        value, text = self.convert(BOXES + '100 100 m 180 100 l S ' + ARROW_HEAD
                                   + 'BT /F1 8 Tf 125 106 Td (calls) Tj ET')
        self.assertIn('Alpha', text.split('[도식 관계')[0])
        self.assertIn('[도식 관계 · PDF에는 연결 정보가 없어 선과 상자의 위치로 추정함]', text)
        self.assertIn('- Alpha → Beta · 라벨 "calls" (위치로 추정) · 끝은 위치로 추정', text)
        self.assertIn('pages 1: pdf_diagram_relations_added_estimated_by_position', value['warnings'])
        self.assertTrue(value['complete'])

    def test_line_without_head_has_no_direction(self):
        _, text = self.convert(BOXES + '100 100 m 180 100 l S ')
        self.assertIn('- Alpha — Beta · 끝은 위치로 추정', text)
        self.assertNotIn('→', text)

    def test_mostly_unresolved_lines_are_not_added_but_flagged_for_review(self):
        loose = ''.join(f'100 {y} m 150 {y} l S 150 {y + 4} m 158 {y} l 150 {y - 4} l f ' for y in (20, 40, 60))
        value, text = self.convert(BOXES + '100 100 m 180 100 l S ' + ARROW_HEAD + loose)
        self.assertNotIn('[도식 관계', text)
        self.assertIn('pages 1: pdf_diagram_relations_need_review', value['warnings'])

    def test_arrow_to_bordered_rounded_box_resolves_its_end(self):
        _, text = self.convert('20 80 80 40 re S BT /F1 10 Tf 32 96 Td (Alpha) Tj ET ' + ROUNDED + 'S '
                               'BT /F1 10 Tf 200 96 Td (Beta) Tj ET 100 100 m 180 100 l S ' + ARROW_HEAD)
        self.assertIn('- Alpha → Beta · 끝은 위치로 추정', text)

    def test_fill_only_rounded_badge_is_not_a_box(self):
        value, text = self.convert('20 80 80 40 re S BT /F1 10 Tf 32 96 Td (Alpha) Tj ET ' + ROUNDED + 'f '
                                   'BT /F1 10 Tf 200 96 Td (Beta) Tj ET 100 100 m 180 100 l S ' + ARROW_HEAD)
        self.assertNotIn('Alpha → Beta', text)
        self.assertIn('pages 1: pdf_diagram_relations_need_review', value['warnings'])

    def test_arrow_to_picture_uses_caption_below_as_name(self):
        make_pdf(self.path, '20 80 80 40 re S BT /F1 10 Tf 32 96 Td (Alpha) Tj ET q 60 0 0 40 180 80 cm /Im0 Do Q '
                 'BT /F1 10 Tf 194 68 Td (Gamma) Tj ET 100 100 m 180 100 l S ' + ARROW_HEAD, image=True)
        with patch.object(formats, 'ocr_image', side_effect=AssertionError('no whole-page OCR')), \
                patch.object(formats, 'ocr_engine', return_value={}), \
                patch.object(formats, 'ocr_region_text', return_value=None):
            value = formats.convert_file(self.path, 'pdf', ocr='auto', language='kor+eng')
        self.assertIn('- Alpha → Gamma · 끝은 위치로 추정', value['units'][0]['content'])

    def test_relation_failure_keeps_page_text(self):
        make_pdf(self.path, BOXES + '100 100 m 180 100 l S ' + ARROW_HEAD)
        with patch.object(relations, 'pdf_page_relations', side_effect=RuntimeError('broken')):
            value = formats.convert_file(self.path, 'pdf', ocr='never')
        self.assertIn('Alpha', value['units'][0]['content'])
        self.assertNotIn('[도식 관계', value['units'][0]['content'])
        self.assertIn('pages 1: pdf_diagram_relations_failed', value['warnings'])
        self.assertTrue(value['complete'])

    def test_page_without_lines_adds_nothing(self):
        value, text = self.convert(BOXES)
        self.assertNotIn('[도식 관계', text)
        self.assertFalse(any('diagram' in warning for warning in value['warnings']))

    def test_whole_page_ocr_pages_are_not_given_relations(self):
        make_pdf(self.path, '20 80 80 40 re S 180 80 80 40 re S 100 100 m 180 100 l S ' + ARROW_HEAD)
        with patch.object(formats, 'ocr_image', return_value='scanned words'):
            value = formats.convert_file(self.path, 'pdf', ocr='auto', language='kor+eng')
        self.assertEqual(value['units'][0]['content'], 'scanned words')


if __name__ == '__main__':
    unittest.main()
