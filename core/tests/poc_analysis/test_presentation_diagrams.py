"""도식 문자·명시 연결·대체 표현의 보존과 객체 단위 실패를 검증한다."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from xml.sax.saxutils import escape
from zipfile import ZipFile
import unittest

from core.client import source_conversion_formats as formats
from core.client import source_conversion_presentation as presentations
from core.tests.poc_analysis.test_presentation_conversion import A, P, R, REL, package

DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'


def shape(identifier, name, text, *, x='914400'):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{identifier}" name="{name}"/>'
        '<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>'
        f'<a:xfrm><a:off x="{x}" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{escape(text)}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


def connector(*, destination='202', arrows=True):
    decorations = '<a:headEnd type="none"/><a:tailEnd type="triangle"/>' if arrows else ''
    return (
        '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="303" name="처리 연결"/>'
        f'<p:cNvCxnSpPr><a:stCxn id="101" idx="3"/><a:endCxn id="{destination}" idx="1"/>'
        '</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>'
        f'<p:spPr><a:prstGeom prst="line"/><a:ln>{decorations}</a:ln></p:spPr></p:cxnSp>'
    )


def smartart_frame():
    return (
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="404" name="업무 SmartArt"/>'
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        f'<a:graphic><a:graphicData uri="{DGM}"><dgm:relIds r:dm="diagram-data"/>'
        '</a:graphicData></a:graphic></p:graphicFrame>'
    )


def smartart_data():
    return (
        f'<dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}"><dgm:ptLst>'
        '<dgm:pt modelId="501" type="node"><dgm:t><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:r><a:t>요청 검토</a:t></a:r><a:br/><a:r><a:t>조건 확인</a:t></a:r></a:p>'
        '</dgm:t></dgm:pt><dgm:pt modelId="502" type="node"><dgm:t><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:r><a:t>처리 완료</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst>'
        '<dgm:cxnLst><dgm:cxn modelId="503" type="parOf" srcId="501" destId="502" srcOrd="0" destOrd="0"/>'
        '</dgm:cxnLst></dgm:dataModel>'
    )


def diagram_package(body, *, diagram=None, relation_target='../diagrams/data1.xml', external=False,
                    broken_relations=False):
    """기존 2슬라이드 fixture의 첫 표시 슬라이드만 도식으로 바꾼다."""
    with ZipFile(BytesIO(package())) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries['ppt/slides/slide2.xml'] = (
        f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}" xmlns:dgm="{DGM}" xmlns:mc="{MC}" '
        'xmlns:unsupported="urn:unsupported-diagram"><p:cSld><p:spTree>'
        f'{body}</p:spTree></p:cSld></p:sld>'
    )
    mode = ' TargetMode="External"' if external else ''
    entries['ppt/slides/_rels/slide2.xml.rels'] = '<invalid' if broken_relations else (
        f'<Relationships xmlns="{REL}"><Relationship Id="diagram-data" Type="{R}/diagramData" '
        f'Target="{relation_target}"{mode}/></Relationships>'
    )
    if diagram is not None:
        entries['ppt/diagrams/data1.xml'] = diagram
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


class PresentationDiagramTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.source = Path(temporary.name) / 'diagram.pptx'
        diagnostics = patch.object(formats, 'diagnostics', return_value={
            'packages': {}, 'tesseract': {'version': None},
        })
        diagnostics.start()
        self.addCleanup(diagnostics.stop)

    def convert(self, body, **kwargs):
        original = diagram_package(body, **kwargs)
        self.source.write_bytes(original)
        result = formats.convert_file(self.source, 'pptx', ocr='never')
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(result['method'], 'pptx_text')
        self.assertEqual(result['original_coverage'], 'not_verified')
        self.assertEqual(result['semantic_validation'], 'not_run')
        return result

    def first(self, result):
        self.assertEqual(result['units'][0]['location'], {'kind': 'slides', 'start': 1, 'end': 1})
        return result['units'][0]['content']

    def test_reversed_storage_order_keeps_shape_identity_and_unlabelled_connector(self):
        result = self.convert(shape('202', '결과 도형', '완료', x='4572000')
                              + shape('101', '시작 도형', '입력') + connector())
        text = self.first(result)
        self.assertLess(text.index('완료'), text.index('입력'))
        for value in ('101', '202', '303', '결과 도형', '시작 도형', '처리 연결',
                      '4572000', '914400', 'triangle', 'none'):
            self.assertIn(value, text)
        self.assertRegex(text, r'시작 도형 참조: [^\n]*id="101"[^\n]*idx="3"')
        self.assertRegex(text, r'끝 도형 참조: [^\n]*id="202"[^\n]*idx="1"')
        self.assertRegex(text, r'headEnd: [^\n]*type="none"')
        self.assertRegex(text, r'tailEnd: [^\n]*type="triangle"')
        self.assertNotIn('connector_endpoint_not_resolved', ' '.join(result['unread_ranges']))

    def test_connector_without_arrow_decoration_does_not_gain_a_direction(self):
        result = self.convert(shape('101', '왼쪽 상태', '입력') + shape('202', '오른쪽 상태', '완료')
                              + connector(arrows=False))
        text = self.first(result)
        self.assertRegex(text, r'시작 도형 참조: [^\n]*id="101"')
        self.assertRegex(text, r'끝 도형 참조: [^\n]*id="202"')
        self.assertNotIn('triangle', text)
        self.assertNotIn('→', text)
        self.assertNotIn('connector_endpoint_not_resolved', ' '.join(result['unread_ranges']))

    def test_identical_labels_remain_separate_and_missing_connector_target_is_unread(self):
        result = self.convert(shape('101', '첫 번째 상태', '동일 상태')
                              + shape('202', '두 번째 상태', '동일 상태')
                              + connector(destination='999', arrows=False))
        text = self.first(result)
        self.assertEqual(text.count('동일 상태'), 2)
        self.assertIn('101', text)
        self.assertIn('202', text)
        self.assertIn('999', text)
        self.assertIn('connector_endpoint_not_resolved', ' '.join(result['unread_ranges']))
        self.assertEqual(result['state'], 'partial')

    def test_nested_groups_keep_their_names_and_local_transforms(self):
        def group(identifier, name, body):
            return (f'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="{identifier}" name="{name}"/>'
                    '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>'
                    '<a:off x="8123456" y="7123456"/><a:ext cx="6123456" cy="5123456"/>'
                    '<a:chOff x="4123456" y="3123456"/><a:chExt cx="2123456" cy="1123456"/>'
                    f'</a:xfrm></p:grpSpPr>{body}</p:grpSp>')
        result = self.convert(group('701', '상위 묶음', group('702', '하위 묶음',
                              shape('101', '내부 도형', '안쪽 내용'))))
        text = self.first(result)
        for value in ('701', '702', '상위 묶음', '하위 묶음', '그룹', '8123456', '4123456', '1123456'):
            self.assertIn(value, text)
        self.assertLess(text.index('상위 묶음'), text.index('하위 묶음'))
        self.assertLess(text.index('하위 묶음'), text.index('안쪽 내용'))
        self.assertEqual(text.count('그룹 시작'), 2)
        self.assertEqual(text.count('그룹 끝'), 2)

    def test_duplicate_shape_ids_make_connector_target_ambiguous(self):
        result = self.convert(shape('101', '중복 A', '첫 문자') + shape('101', '중복 B', '둘째 문자')
                              + shape('202', '목적 도형', '완료') + connector())
        text = self.first(result)
        self.assertIn('첫 문자', text)
        self.assertIn('둘째 문자', text)
        self.assertIn('connector_endpoint_not_resolved', ' '.join(result['unread_ranges']))

    def test_tables_in_separate_groups_have_slide_wide_numbers(self):
        def grouped_table(value):
            return ('<p:grpSp><p:graphicFrame><a:graphic><a:graphicData><a:tbl>'
                    '<a:tr><a:tc><a:txBody><a:p><a:r>'
                    f'<a:t>{value}</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
                    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:grpSp>')
        text = self.first(self.convert(grouped_table('앞 그룹 값') + grouped_table('뒤 그룹 값')))
        self.assertEqual(text.count('### 표 1'), 1)
        self.assertEqual(text.count('### 표 2'), 1)
        self.assertLess(text.index('### 표 1'), text.index('앞 그룹 값'))
        self.assertLess(text.index('앞 그룹 값'), text.index('### 표 2'))
        self.assertLess(text.index('### 표 2'), text.index('뒤 그룹 값'))

    def test_alternate_content_reads_only_fallback_once(self):
        body = ('<mc:AlternateContent><mc:Choice Requires="unsupported">'
                + shape('101', '지원하지 않는 표현', '선택 표현 문자')
                + '</mc:Choice><mc:Fallback>' + shape('202', '대체 도형', '대체 표현 문자')
                + '</mc:Fallback></mc:AlternateContent>')
        result = self.convert(body)
        text = self.first(result)
        self.assertEqual(text.count('대체 표현 문자'), 1)
        self.assertNotIn('선택 표현 문자', text)
        self.assertIn('alternate_content_fallback_used_visual_equivalence_not_verified',
                      ' '.join(result['unread_ranges']))

    def test_smartart_text_and_explicit_data_relation_are_preserved(self):
        result = self.convert(smartart_frame(), diagram=smartart_data())
        text = self.first(result)
        for value in ('요청 검토\n조건 확인', '처리 완료', '501', '502', 'parOf', 'srcId', 'destId'):
            self.assertIn(value, text)
        self.assertRegex(text, r'type="parOf"[^\n]*srcId="501"[^\n]*destId="502"')
        self.assertIn('smartart_layout_and_visual_content_not_read', ' '.join(result['unread_ranges']))
        self.assertEqual(result['state'], 'partial')

    def test_missing_and_malformed_smartart_preserve_other_shapes_on_same_slide(self):
        for diagram in (None, '<invalid'):
            with self.subTest(diagram=diagram):
                result = self.convert(shape('101', '보존할 본문', '같은 슬라이드 본문')
                                      + smartart_frame(), diagram=diagram)
                self.assertIn('같은 슬라이드 본문', self.first(result))
                self.assertIn('smartart_data_not_read', ' '.join(result['unread_ranges']))
                self.assertEqual(len(result['units']), 2)

    def test_external_smartart_relation_is_not_followed(self):
        with patch.object(presentations, '_xml', wraps=presentations._xml) as read_xml:
            result = self.convert(shape('101', '보존할 본문', '외부 도식 옆 본문') + smartart_frame(),
                                  diagram=smartart_data(), relation_target='https://invalid.example/data.xml',
                                  external=True)
        self.assertIn('외부 도식 옆 본문', self.first(result))
        self.assertNotIn('요청 검토', self.first(result))
        self.assertIn('smartart_data_not_read', ' '.join(result['unread_ranges']))
        self.assertFalse(any(str(call.args[1]).startswith('https:') for call in read_xml.call_args_list))

    def test_broken_slide_relationships_do_not_discard_read_shape_text(self):
        result = self.convert(shape('101', '보존할 본문', '관계 손상 전 본문') + smartart_frame(),
                              diagram=smartart_data(), broken_relations=True)
        self.assertIn('관계 손상 전 본문', self.first(result))
        self.assertIn('slide_relationships_not_read', ' '.join(result['unread_ranges']))
        self.assertIn('smartart_data_not_read', ' '.join(result['unread_ranges']))

    def test_smartart_xml_limit_preserves_other_text_and_slides(self):
        oversized = smartart_data().replace('요청 검토', '요청 검토' * 2000)
        with patch.object(presentations, 'MAX_XML', 4096):
            result = self.convert(shape('101', '일반 본문', '한도 초과 도식 옆 본문') + smartart_frame(),
                                  diagram=oversized)
        self.assertFalse(result['complete'])
        self.assertEqual(result['state'], 'partial')
        self.assertIn('한도 초과 도식 옆 본문', self.first(result))
        self.assertEqual(len(result['units']), 2)
        self.assertIn('두 번째', result['units'][1]['content'])
        self.assertIn('smartart_data_xml_limit', ' '.join(result['unread_ranges']))


if __name__ == '__main__':
    unittest.main()
