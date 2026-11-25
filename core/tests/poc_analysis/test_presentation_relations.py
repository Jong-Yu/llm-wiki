"""PPTX 연결선을 "A → B" 관계 문장으로 정리한다(D-160). 파일 연결 정보와 위치 추정을 구분한다."""
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
K = 1000  # 1000 EMU 단위로 좌표를 적는다.


def box(ident, text, x, y, cx=1500, cy=600, *, label=False):
    flag = '<p:cNvSpPr txBox="1"/>' if label else '<p:cNvSpPr/>'
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="상자 {ident}"/>{flag}<p:nvPr/></p:nvSpPr><p:spPr>'
            f'<a:xfrm><a:off x="{x * K}" y="{y * K}"/><a:ext cx="{cx * K}" cy="{cy * K}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"/></p:spPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>')


def line(ident, x, y, cx, cy=0, *, start=None, end=None, head=None, tail='triangle', flip='', dash=None):
    refs = (f'<a:stCxn id="{start}" idx="3"/>' if start else '') + (f'<a:endCxn id="{end}" idx="1"/>' if end else '')
    ends = (f'<a:headEnd type="{head}"/>' if head else '') + (f'<a:tailEnd type="{tail}"/>' if tail else '')
    pattern = f'<a:prstDash val="{dash}"/>' if dash else ''
    return (f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{ident}" name="연결 {ident}"/><p:cNvCxnSpPr>{refs}</p:cNvCxnSpPr>'
            f'<p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm{flip}><a:off x="{x * K}" y="{y * K}"/>'
            f'<a:ext cx="{cx * K}" cy="{cy * K}"/></a:xfrm><a:prstGeom prst="straightConnector1"/>'
            f'<a:ln>{pattern}{ends}</a:ln></p:spPr></p:cxnSp>')


def group(body, x, y, cx, cy, child_cx, child_cy):
    return (f'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="90" name="묶음"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            f'<p:grpSpPr><a:xfrm><a:off x="{x * K}" y="{y * K}"/><a:ext cx="{cx * K}" cy="{cy * K}"/>'
            f'<a:chOff x="0" y="0"/><a:chExt cx="{child_cx * K}" cy="{child_cy * K}"/></a:xfrm></p:grpSpPr>'
            f'{body}</p:grpSp>')


def package(shapes, *, size=True):
    slide_size = '<p:sldSz cx="9144000" cy="5143500"/>' if size else ''
    entries = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'ppt/presentation.xml': f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="s1"/>'
                                f'</p:sldIdLst>{slide_size}</p:presentation>',
        'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="s1" Type="{R}/slide" '
                                           f'Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml': f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>{shapes}'
                                 f'</p:spTree></p:cSld></p:sld>',
    }
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


class PresentationRelationTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'source.pptx'
        diagnostics = patch.object(formats, 'diagnostics', return_value={'packages': {}, 'tesseract': {'version': None}})
        diagnostics.start()
        self.addCleanup(diagnostics.stop)

    def convert(self, shapes, **kwargs):
        self.path.write_bytes(package(shapes, **kwargs))
        value = formats.convert_file(self.path, 'pptx', ocr='never')
        return value, value['units'][0]['content']

    def test_flow_with_file_links_label_and_free_drawn_arrow(self):
        value, text = self.convert(
            box(11, '초기 상태 (비활성)', 500, 1000) + box(12, 'API 검증 중 (비활성)', 3000, 1000)
            + box(13, '제출 가능 (활성)', 5500, 1000)
            + line(21, 2000, 1300, 1000, start=11, end=12)
            + box(31, '필수 필드 입력', 2050, 900, 900, 300, label=True)
            # 붙지 않은 화살표: flipH로 시작이 오른쪽이고 화살촉은 시작(head) 쪽이다.
            + line(22, 4500, 1300, 1000, head='triangle', tail=None, flip=' flipH="1"', dash='dash'))
        self.assertIn('### 도식 관계 (연결 2개: 파일의 연결 정보 1개, 위치로 추정 1개, 확인 필요 0개)', text)
        self.assertIn('- 초기 상태 (비활성) → API 검증 중 (비활성) · 라벨 "필수 필드 입력" (위치로 추정) · 연결선 id=21', text)
        self.assertIn('- API 검증 중 (비활성) → 제출 가능 (활성) · 선 모양 dash · 끝은 위치로 추정 · 연결선 id=22', text)
        self.assertEqual(value['unread_ranges'], [])
        self.assertIn('slide 1: diagram_relations_estimated_by_position', value['warnings'])

    def test_same_names_are_told_apart_and_lines_without_arrows_have_no_direction(self):
        _, text = self.convert(box(41, '모듈', 500, 1000) + box(42, '모듈', 3000, 1000)
                               + line(51, 2000, 1300, 1000, start=41, end=42, tail=None))
        self.assertIn('- 모듈 [id=41] — 모듈 [id=42] · 연결선 id=51', text)
        self.assertNotIn('→', text)

    def test_unreachable_free_line_stays_unread(self):
        value, text = self.convert(box(11, '외딴 상자', 500, 1000) + line(61, 500, 4500, 1000))
        self.assertIn('- ? → ? · 끝 확인 필요 · 연결선 id=61', text)
        self.assertIn('slide 1: connector_endpoint_not_resolved', value['unread_ranges'])

    def test_grouped_shape_and_boundary_containment(self):
        # 묶음은 2배 확대: 안쪽 (0,0)-(750,300)이 슬라이드 (5500,1000)-(7000,1600)이 된다.
        _, text = self.convert(
            box(70, 'ota', 200, 700, 8000, 1500) + box(11, 'Campaign', 500, 1000)
            + group(box(13, 'Vessel', 0, 0, 750, 300), 5500, 1000, 1500, 600, 750, 300)
            + line(23, 2000, 1300, 3500))
        self.assertIn('- Campaign → Vessel · 끝은 위치로 추정 · 연결선 id=23', text)
        self.assertIn('### 포함 관계 (위치로 추정)\n- ota: Campaign, Vessel', text)

    def test_without_slide_size_previous_report_is_kept(self):
        value, text = self.convert(box(11, '외딴 상자', 500, 1000) + line(61, 500, 4500, 1000), size=False)
        self.assertNotIn('도식 관계', text)
        self.assertIn('slide 1: connector_endpoint_not_resolved', value['unread_ranges'])


if __name__ == '__main__':
    unittest.main()
