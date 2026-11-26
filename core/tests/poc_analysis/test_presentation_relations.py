"""PPTX 연결선을 "A → B" 관계 문장으로 정리한다(D-160). 파일 연결 정보와 위치 추정을 구분한다.

D-167: 글자 없는 도형은 설명 글로 이름을 정하고, 꺾임용 투명 상자·나무 모양 갈래를 이어 붙이며,
끝·이름을 못 정한 연결이 많으면 붙이지 않고 AI 해석 후보로 알린다.
"""
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


def blank(ident, x, y, cx, cy, *, invisible=False, prst='rect', name=None):
    """글자 없는 도형. invisible이면 채우기·테두리가 없다(꺾임용 점)."""
    paint = ('<a:noFill/><a:ln><a:noFill/></a:ln>' if invisible
             else '<a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="000000"/>'
                  '</a:solidFill></a:ln>')
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="{name or f"직사각형 {ident}"}"/><p:cNvSpPr/><p:nvPr/>'
            f'</p:nvSpPr><p:spPr><a:xfrm><a:off x="{x * K}" y="{y * K}"/><a:ext cx="{cx * K}" cy="{cy * K}"/></a:xfrm>'
            f'<a:prstGeom prst="{prst}"/>{paint}</p:spPr></p:sp>')


def picture(ident, x, y, cx, cy):
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{ident}" name="Picture {ident}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
            f'<p:spPr><a:xfrm><a:off x="{x * K}" y="{y * K}"/><a:ext cx="{cx * K}" cy="{cy * K}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"/></p:spPr></p:pic>')


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
        self.assertIn('slides 1: diagram_relations_estimated_by_position', value['warnings'])

    def test_same_names_are_told_apart_and_lines_without_arrows_have_no_direction(self):
        _, text = self.convert(box(41, '모듈', 500, 1000) + box(42, '모듈', 3000, 1000)
                               + line(51, 2000, 1300, 1000, start=41, end=42, tail=None))
        self.assertIn('- 모듈 [id=41] — 모듈 [id=42] · 연결선 id=51', text)
        self.assertNotIn('→', text)

    def test_unreachable_free_line_is_an_ai_candidate_not_unread(self):
        # D-167: 글자는 모두 보존했으므로 끝을 못 찾은 연결은 미독이 아니라 AI 해석 후보다(PDF와 같은 기준).
        value, text = self.convert(box(11, '외딴 상자', 500, 1000) + line(61, 500, 4500, 1000))
        self.assertNotIn('### 도식 관계', text)
        self.assertEqual(value['unread_ranges'], [])
        self.assertIn('slides 1: pptx_diagram_relations_need_review', value['warnings'])

    def test_icon_named_by_caption_and_arrow_bent_at_invisible_box_is_one_connection(self):
        # 실제 문서 149쪽: 사용자 아이콘(그림) 아래 글상자가 이름이고, 화살표는 보이지 않는 작은 상자에서 꺾인다.
        # 봉투 아이콘은 사각형 안 삼각형 두 도형이고 연결선은 안쪽 삼각형에 붙어 있다.
        value, text = self.convert(
            picture(14, 500, 1000, 600, 600) + box(8, '등록 사용자', 450, 1650, 700, 250, label=True)
            + blank(16, 700, 300, 200, 100, invisible=True)
            + box(20, 'Keycloak', 3000, 200, 1500, 600)
            + line(35, 800, 400, 0, 600, start=16, end=14, tail=None)
            + line(36, 800, 350, 2200, 150, start=16, end=20)
            + blank(40, 5500, 1000, 500, 400) + blank(41, 5550, 1000, 400, 200, prst='triangle', name='이등변 삼각형 40')
            + box(9, '내부 이벤트', 5450, 1450, 600, 250, label=True)
            + line(42, 3750, 800, 1950, 200, start=20, end=41))
        self.assertIn('### 도식 관계 (연결 2개: 파일의 연결 정보 2개, 위치로 추정 0개, 확인 필요 0개)', text)
        self.assertIn('- 등록 사용자 → Keycloak · 연결선 id=35', text)
        self.assertIn('- Keycloak → 내부 이벤트 · 연결선 id=42', text)
        relations = text.split('### 도식 관계', 1)[1]
        for auto_name in ('Picture', '직사각형', '삼각형', '이름 없는 도형'):
            self.assertNotIn(auto_name, relations)
        self.assertNotIn('connector_endpoint_not_resolved', ' '.join(value['unread_ranges']))

    def test_connector_attached_to_caption_or_text_box_uses_that_name(self):
        # 실제 문서 149쪽: "기능 요청" 선은 아이콘이 아니라 아래 설명 글상자에 붙어 있다.
        _, text = self.convert(
            picture(14, 500, 1000, 600, 600) + box(8, '등록 사용자', 450, 1500, 700, 250, label=True)
            + box(20, 'vessel', 3000, 2500, 1500, 600)
            + box(30, '토큰 저장소', 6000, 2600, 1000, 300, label=True)
            + line(31, 800, 1750, 2200, 1000, start=8, end=20)
            + line(32, 4500, 2750, 1500, 0, start=20, end=30))
        self.assertIn('- 등록 사용자 → vessel · 연결선 id=31', text)
        self.assertIn('- vessel → 토큰 저장소 · 연결선 id=32', text)

    def test_class_box_compartments_take_the_title_name(self):
        # 실제 문서 61쪽: 클래스 상자는 제목 칸과 속성 칸 두 도형이고 연결선은 속성 칸에 붙어 있다.
        _, text = self.convert(
            box(7, '«aggregate» Space', 500, 1000, 1500, 300) + box(8, '- spaceId - name', 500, 1300, 1500, 700)
            + box(11, '«aggregate» Workspace', 4000, 1000, 1500, 300) + box(12, '- workspaceId', 4000, 1300, 1500, 700)
            + line(19, 2000, 1600, 2000, start=8, end=12))
        self.assertIn('- «aggregate» Space → «aggregate» Workspace · 연결선 id=19', text)
        self.assertNotIn('포함 관계', text)

    def test_tree_branches_ending_on_a_trunk_join_the_root(self):
        # 실제 문서 67쪽: 줄기 하나가 아래로 내려가고 가지가 줄기 중간·끝에서 옆 상자로 간다(화살촉 없음).
        _, text = self.convert(
            box(8, 'Campaign', 3000, 1000, 1500, 400) + box(12, 'Package A', 4500, 1800, 1000, 300)
            + box(13, 'Package B', 4500, 2400, 1000, 300)
            + line(16, 4000, 1400, 0, 1150, tail=None)
            + line(17, 4000, 1950, 500, 0, tail=None)
            + line(20, 4000, 2550, 500, 0, end=13, tail=None))
        self.assertIn('- Campaign — Package A · 끝은 위치로 추정 · 연결선 id=16', text)
        self.assertIn('- Campaign — Package B · 끝은 위치로 추정 · 연결선 id=16', text)
        self.assertNotIn('?', text.split('### 도식 관계', 1)[1])

    def test_fan_out_from_one_source_to_arrow_ends(self):
        _, text = self.convert(
            box(1, '허브', 500, 1000, 1000, 400) + box(2, '알림 1', 3000, 600, 1000, 400)
            + box(3, '알림 2', 3000, 1400, 1000, 400)
            + line(51, 1500, 1200, 1000, 0, tail=None)
            + line(52, 2500, 800, 500, 400, flip=' flipV="1"')
            + line(53, 2500, 1200, 500, 400))
        self.assertIn('- 허브 → 알림 1 · 끝은 위치로 추정 · 연결선 id=51', text)
        self.assertIn('- 허브 → 알림 2 · 끝은 위치로 추정 · 연결선 id=51', text)

    def test_shapes_without_text_or_caption_do_not_use_file_names(self):
        value, text = self.convert(blank(5, 500, 1000, 1000, 400) + blank(6, 3000, 1000, 1000, 400)
                                   + line(7, 1500, 1200, 1500, start=5, end=6))
        self.assertNotIn('### 도식 관계', text)
        self.assertIn('slides 1: pptx_diagram_relations_need_review', value['warnings'])
        self.assertEqual(value['unread_ranges'], [])

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
