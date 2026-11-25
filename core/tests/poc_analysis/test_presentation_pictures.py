"""PPTX 슬라이드 그림은 그림 파일만 읽어 OCR 표시와 함께 덧붙인다(D-159)."""
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZipFile
import unittest

from core.client import source_conversion_formats as formats

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
SLIDE = (9144000, 5143500)


def png():
    from PIL import Image
    raw = BytesIO()
    Image.new('RGB', (40, 20), 'white').save(raw, format='PNG')
    return raw.getvalue()


def package(pictures, *, fill=False):
    """pictures: 슬라이드 너비·높이 대비 비율(0~1)의 목록. 모두 같은 그림 파일을 가리킨다."""
    shapes = '<p:sp><p:txBody><a:p><a:r><a:t>본문 문자</a:t></a:r></a:p></p:txBody></p:sp>'
    for number, ratio in enumerate(pictures, 1):
        shapes += (f'<p:pic><p:nvPicPr><p:cNvPr id="{number + 10}" name="그림 {number}"/></p:nvPicPr>'
                   f'<p:blipFill><a:blip r:embed="img"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/>'
                   f'<a:ext cx="{int(SLIDE[0] * ratio)}" cy="{int(SLIDE[1] * ratio)}"/></a:xfrm></p:spPr></p:pic>')
    if fill:
        shapes += '<p:sp><p:spPr><a:blipFill><a:blip r:embed="img"/></a:blipFill></p:spPr></p:sp>'
    entries = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'ppt/presentation.xml': f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="s1"/>'
                                f'</p:sldIdLst><p:sldSz cx="{SLIDE[0]}" cy="{SLIDE[1]}"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="s1" Type="{R}/slide" '
                                           f'Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml': f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>{shapes}'
                                 f'</p:spTree></p:cSld></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="img" Type="{R}/image" '
                                            f'Target="../media/image1.png"/></Relationships>',
    }
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
        archive.writestr('ppt/media/image1.png', png())
    return output.getvalue()


class PresentationPictureTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'source.pptx'
        diagnostics = patch.object(formats, 'diagnostics', return_value={'packages': {}, 'tesseract': {'version': None}})
        diagnostics.start()
        self.addCleanup(diagnostics.stop)

    def convert(self, pictures, *, found=None, ocr='auto', fill=False):
        self.path.write_bytes(package(pictures, fill=fill))
        calls = []

        def reader(language):
            def read(raw):
                calls.append(len(raw))
                return found
            return read
        with patch.object(formats, 'picture_reader', side_effect=reader):
            value = formats.convert_file(self.path, 'pptx', ocr=ocr, language='kor+eng')
        return value, calls

    def test_picture_text_is_added_with_ocr_mark(self):
        text = {'text': 'deploymentSchema', 'score': 88.0, 'count': 16, 'weak': 0, 'psm': 3, 'low_confidence': False}
        value, calls = self.convert([.5], found=text)
        self.assertEqual(len(calls), 1)
        content = value['units'][0]['content']
        self.assertIn('본문 문자', content)
        self.assertIn('[그림 속 글자 · OCR]\ndeploymentSchema', content)
        self.assertEqual(value['unread_ranges'], [])
        self.assertTrue(value['complete'])

    def test_small_picture_is_not_read(self):
        value, calls = self.convert([.05])  # 슬라이드 면적의 0.25%
        self.assertEqual(calls, [])
        self.assertIn('slide 1: small_picture_not_ocr', value['warnings'])
        self.assertTrue(value['complete'])

    def test_picture_without_text_adds_nothing(self):
        value, calls = self.convert([.5], found=None)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('그림 속 글자', value['units'][0]['content'])
        self.assertIn('slide 1: picture_without_readable_text', value['warnings'])
        self.assertTrue(value['complete'])

    def test_failure_and_low_confidence_stay_unread(self):
        value, _ = self.convert([.5], found={'failure': 'picture_format_not_read'})
        self.assertEqual(value['unread_ranges'], ['slide 1: picture_format_not_read'])
        low = {'text': 'blurry', 'score': 52.0, 'count': 9, 'weak': 6, 'psm': 6, 'low_confidence': True}
        value, _ = self.convert([.5], found=low)
        self.assertEqual(value['unread_ranges'], ['slide 1: ' + formats.LOW_CONFIDENCE])

    def test_ocr_never_keeps_previous_unread_report(self):
        value, calls = self.convert([.5], ocr='never')
        self.assertEqual(calls, [])
        self.assertIn('slide 1: picture_content_not_read', value['unread_ranges'])
        self.assertIn('slide 1: picture_or_shape_fill_content_not_read', value['unread_ranges'])

    def test_shape_fill_picture_is_still_reported_unread(self):
        value, _ = self.convert([.5], found=None, fill=True)
        self.assertIn('slide 1: picture_or_shape_fill_content_not_read', value['unread_ranges'])

    def test_reader_rejects_unknown_format_and_reads_same_picture_once(self):
        read = formats.picture_reader('kor+eng')
        self.assertEqual(read(b'not an image'), {'failure': 'picture_format_not_read'})
        calls = []
        with patch.object(formats, 'ocr_engine', return_value={}), \
                patch.object(formats, 'ocr_region_text', side_effect=lambda *args: calls.append(1) or None):
            read = formats.picture_reader('kor+eng')
            self.assertIsNone(read(png()))
            self.assertIsNone(read(png()))
        self.assertEqual(calls, [1])


if __name__ == '__main__':
    unittest.main()
