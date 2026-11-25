"""PPT/PPTX의 불변 업로드·슬라이드 위치·부분 변환과 서버 보고 호환을 검증한다."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile
import unittest

from pydantic import ValidationError
from core.api.v1.analysis_plans.schemas import CreateConversion, Location
from core.client import source_conversion_formats as formats
from core.client import source_conversion_presentation as presentations
from core.client.source_conversion import report_body, run_worker
from core.modules.analysis_plans.store import PlanStore
from core.modules.documents.store import WikiStore
from core.modules.sources.contracts import UnsupportedSourceError
from core.modules.sources.formats import validate_binary
from core.modules.sources.store import SourceStore

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'


def package(*, image=False, bad_notes=False, bad_slide=False, external=False, inherited=None):
    """파일명 순서와 실제 발표 순서가 다른 작은 격리 원본을 만든다."""
    shape = '<p:sp><p:txBody><a:p><a:pPr><a:tabLst><a:tab pos="100"/></a:tabLst></a:pPr><a:r><a:t>{}</a:t></a:r><a:br/><a:r><a:t>다음 줄</a:t></a:r></a:p></p:txBody></p:sp>'
    table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>값 | 원문</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    slide = f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>{{}}</p:spTree></p:cSld></p:sld>'
    entries = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="{REL}"><Relationship Id="p" Type="{R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
        'ppt/presentation.xml': f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="first" Type="{R}/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="{R}/slide" Target="slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide1.xml': '<invalid' if bad_slide else slide.format(shape.format('두 번째')),
        'ppt/slides/slide2.xml': slide.format(shape.format('첫 번째 &amp; 조건') + table + ('<p:pic/>' if image else '')),
        'ppt/slides/_rels/slide2.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="notes" Type="{R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
        'ppt/notesSlides/notesSlide1.xml': '<invalid' if bad_notes else f'<p:notes xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>{shape.format("노트의 예외")}</p:spTree></p:cSld></p:notes>',
    }
    if external:
        entries['ppt/_rels/presentation.xml.rels'] = entries['ppt/_rels/presentation.xml.rels'].replace('Target="slides/slide2.xml"', 'Target="https://invalid.example/slide.xml" TargetMode="External"')
    if inherited is not None:
        entries['ppt/slides/_rels/slide2.xml.rels'] = entries['ppt/slides/_rels/slide2.xml.rels'].replace('</Relationships>', f'<Relationship Id="layout" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>')
        inherited_shape = shape.format('상속된 조건')
        if inherited == 'placeholder':
            inherited_shape = inherited_shape.replace('<p:sp>', '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>')
        entries['ppt/slideLayouts/slideLayout1.xml'] = f'<p:sldLayout xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>{inherited_shape}</p:spTree></p:cSld></p:sldLayout>'
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


class PresentationConversionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.pptx'
        self.diagnostics = patch.object(formats, 'diagnostics', return_value={'packages': {}, 'tesseract': {'version': None}})
        self.diagnostics.start()
        self.addCleanup(self.diagnostics.stop)

    def convert(self, **kwargs):
        original = package(**kwargs)
        self.source.write_bytes(original)
        result = formats.convert_file(self.source, 'pptx', ocr='never')
        self.assertEqual(self.source.read_bytes(), original)
        return result

    def test_slides_order_table_notes_and_linebreaks_preserved(self):
        result = self.convert()
        self.assertTrue(result['complete'])
        self.assertEqual(result['method'], 'pptx_text')
        self.assertEqual([unit['location'] for unit in result['units']], [
            {'kind': 'slides', 'start': 1, 'end': 1}, {'kind': 'slides', 'start': 2, 'end': 2}])
        first, second = [unit['content'] for unit in result['units']]
        self.assertIn('첫 번째 & 조건\n다음 줄', first)
        self.assertNotIn('\t', first)
        self.assertIn('행 1 · 열 1 (gridSpan=2)\n값 | 원문', first)
        self.assertIn('노트의 예외', first)
        self.assertIn('두 번째', second)
        self.assertEqual(result['original_coverage'], 'not_verified')

    def test_images_are_reported_unread_with_text_preserved(self):
        result = self.convert(image=True)
        self.assertEqual(result['state'], 'partial')
        self.assertIn('picture_content_not_read', ' '.join(result['unread_ranges']))
        self.assertEqual(len(result['units']), 2)

    def test_broken_notes_preserve_read_slide_text(self):
        result = self.convert(bad_notes=True)
        self.assertEqual(result['state'], 'partial')
        self.assertIn('첫 번째', result['units'][0]['content'])
        self.assertIn('notes_xml_not_read', ' '.join(result['unread_ranges']))

    def test_broken_slide_preserves_previous_units(self):
        result = self.convert(bad_slide=True)
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(len(result['units']), 1)
        self.assertIn('slide 2:', result['unread_ranges'][0])

    def test_external_slide_is_not_followed(self):
        result = self.convert(external=True)
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(result['units'][0]['location']['start'], 2)

    def test_actual_inherited_text_is_preserved_but_placeholder_prompt_is_not(self):
        actual = self.convert(inherited='content')
        self.assertTrue(actual['complete'])
        self.assertIn('상속된 조건', actual['units'][0]['content'])
        self.assertIn('표시 여부 미검증', actual['units'][0]['content'])
        placeholder = self.convert(inherited='placeholder')
        self.assertTrue(placeholder['complete'])
        self.assertNotIn('상속된 조건', placeholder['units'][0]['content'])

    def test_upload_package_identity_rejects_renamed_docx_and_macro_type(self):
        raw = package()
        validate_binary(BytesIO(raw), 'pptx')
        with self.assertRaises(UnsupportedSourceError):
            validate_binary(BytesIO(raw), 'docx')
        entries = {}
        with ZipFile(BytesIO(raw)) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace(b'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', b'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml')
        output = BytesIO()
        with ZipFile(output, 'w') as archive:
            for name, content in entries.items():
                archive.writestr(name, content)
        with self.assertRaises(UnsupportedSourceError):
            validate_binary(BytesIO(output.getvalue()), 'pptx')

    def test_legacy_dependency_missing_is_actionable_and_preserves_original(self):
        original = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'fixture'
        self.source.write_bytes(original)
        validate_binary(BytesIO(original), 'ppt')
        with patch.object(presentations, '_libreoffice', return_value=None):
            result = formats.convert_file(self.source, 'ppt')
        self.assertEqual(result['state'], 'failed')
        self.assertIn('legacy_ppt_requires_libreoffice_or_pptx', result['unread_ranges'][0])
        self.assertEqual(self.source.read_bytes(), original)

    def test_xml_limit_is_not_silently_truncated(self):
        with patch.object(presentations, 'MAX_XML', 50):
            result = self.convert()
        self.assertFalse(result['complete'])
        self.assertIn('conversion_output_or_archive_limit', ' '.join(result['unread_ranges']))

    async def test_real_worker_publishes_slide_checkpoint_and_preserves_bytes(self):
        original = package()
        self.source.write_bytes(original)
        result = await run_worker(self.source, 'pptx', self.root / 'result.json', ocr='never', language='eng',
            timeout=10, cancel_file=None, emit=lambda stage, **kwargs: None)
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(result['units'][0]['location']['kind'], 'slides')
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(list(self.root.glob('scratch-*')), [])

    def test_upload_and_server_report_keep_original_hash_and_slide_coordinates(self):
        raw = package()
        (self.root / 'data').mkdir()
        store = WikiStore(self.root / 'data')
        sources = SourceStore(store)
        actor = dict(user_id='alice', tenant='team', profile_id='default', domain=None, viewpoint=None, policy_revision='a' * 64)
        staged = sources.stage(BytesIO(raw), kind='file', title='발표', format='pptx', filename='발표.pptx')
        registered = sources.commit(staged, tenant='team', user_id='alice', request_id=uuid4().hex, authorize=lambda: actor)
        catalog = sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        reference = {key: original[key] for key in ('source_id', 'source_version', 'source_sha256')}
        reference['registration_revision'] = catalog['registration_revision']
        self.assertEqual(reference['source_sha256'], sha256(raw).hexdigest())
        result = self.convert()
        body = CreateConversion.model_validate(report_body(result, reference, uuid4().hex, None))
        saved = PlanStore(store, actor).conversion(body.model_dump(exclude={"profile"}), lambda: None)
        self.assertEqual(saved['manifest']['method'], 'pptx_text')
        self.assertEqual(saved['manifest']['units'][0]['location']['kind'], 'slides')
        selected = PlanStore(store, actor)._select(result['units'], [{'kind': 'slides', 'start': 1, 'end': 2}])
        self.assertIn('첫 번째', selected)
        self.assertIn('두 번째', selected)
        with self.assertRaises(ValueError):
            PlanStore(store, actor)._select(result['units'], [{'kind': 'slides', 'start': 1, 'end': 3}])
        wrong = body.model_copy(update={'method': 'docx_text'})
        with self.assertRaises(ValueError):
            PlanStore(store, actor).conversion(wrong.model_dump(exclude={"profile"}), lambda: None)
        with self.assertRaises(ValidationError):
            Location(kind='slides', start=2, end=1)


if __name__ == '__main__':
    unittest.main()
