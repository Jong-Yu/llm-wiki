"""선택 슬라이드의 AI 그림 전사 후보만 만들고 원본·일반 문자를 보존하는 계약."""

import asyncio
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import httpx2
from PIL import Image

from core.client import source_image_recovery as recovery
from core.client import source_conversion_report as reports
from core.client.ai.contracts import AIAdapterError
from core.client.transport import AnalysisClientError
from core.tests.poc_analysis.test_presentation_conversion import A, P, R, REL


LOW_TEXT = 'OCR 오류 초안'
NORMAL_TEXT = '정상 그림 문자 @value 0/O'
RECOVERED = '원문 `code` @value 0/O\n한국어 값: 17'
LOW_CODE = 'ocr_low_or_missing_confidence_text_retained_manual_review_required'


def image_bytes(color):
    """서로 다른 두 그림의 실제 바이트 hash를 전달 경계에 사용한다."""
    output = BytesIO()
    Image.new('RGB', (96, 48), color).save(output, 'PNG')
    return output.getvalue()


def recovery_package(low, normal):
    """두 장에서 같은 그림을 재사용하고 내장 문자와 발표자 노트를 둔다."""
    def shape(text):
        return '<p:sp><p:txBody><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>'

    def picture(identifier, relationship):
        return (f'<p:pic><p:nvPicPr><p:cNvPr id="{identifier}" name="그림 {identifier}"/>'
                '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
                f'<p:blipFill><a:blip r:embed="{relationship}"/></p:blipFill>'
                '<p:spPr><a:xfrm><a:off x="0" y="0"/>'
                '<a:ext cx="4572000" cy="2571750"/></a:xfrm></p:spPr></p:pic>')

    entries = {
        'ppt/presentation.xml': f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>'
            '<p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst>'
            '<p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{REL}">'
            f'<Relationship Id="s1" Type="{R}/slide" Target="slides/slide1.xml"/>'
            f'<Relationship Id="s2" Type="{R}/slide" Target="slides/slide2.xml"/></Relationships>',
        'ppt/media/low.png': low,
        'ppt/media/normal.png': normal,
    }
    for number in (1, 2):
        body = shape(f'내장 문자 {number}: {LOW_TEXT}') + picture('10', 'low') + picture('11', 'normal')
        entries[f'ppt/slides/slide{number}.xml'] = (
            f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>'
            f'{body}</p:spTree></p:cSld></p:sld>')
        entries[f'ppt/slides/_rels/slide{number}.xml.rels'] = (
            f'<Relationships xmlns="{REL}"><Relationship Id="low" Type="{R}/image" Target="../media/low.png"/>'
            f'<Relationship Id="normal" Type="{R}/image" Target="../media/normal.png"/>'
            f'<Relationship Id="notes" Type="{R}/notesSlide" Target="../notesSlides/notes{number}.xml"/>'
            '</Relationships>')
        entries[f'ppt/notesSlides/notes{number}.xml'] = (
            f'<p:notes xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>'
            f'{shape(f"발표자 노트 {number}의 조건")}</p:spTree></p:cSld></p:notes>')
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return output.getvalue()


class CandidateAdapter:
    """실제 개인 AI 대신 받은 비공개 이미지와 고정 구조화 답만 기록한다."""
    def __init__(self, transform=None, *, failure=None, before_return=None):
        self.calls = []
        self.transform = transform or (lambda entries: entries)
        self.failure = failure
        self.before_return = before_return

    async def run(self, **kwargs):
        # 실제 Codex/Claude 어댑터처럼 새 디렉터리의 단독 소유를 요구한다.
        Path(kwargs['directory']).mkdir(mode=0o700, exist_ok=False)
        images = [Path(path) for path in kwargs['images']]
        self.calls.append({**kwargs, 'image_bytes': [path.read_bytes() for path in images],
                           'image_modes': [path.stat().st_mode & 0o777 for path in images],
                           'baseline_slots': json.loads((Path(kwargs['directory']).parent / 'baseline-slots.json').read_text()),
                           'fixed_units': json.loads((Path(kwargs['directory']).parent / 'fixed-units.json').read_text())})
        if self.failure:
            raise self.failure
        entries = [{'id': sha256(path.read_bytes()).hexdigest(), 'text': RECOVERED, 'unread': []}
                   for path in images]
        if self.before_return:
            self.before_return()
        return {'value': {'images': self.transform(entries)},
                'execution': {'provider': 'claude', 'reported_model': 'fixture-model'}}


class SourceImageRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.work = self.root / 'work'
        self.low, self.normal = image_bytes('white'), image_bytes('black')
        self.raw = recovery_package(self.low, self.normal)
        fixture = self.root / 'fixture.pptx'
        fixture.write_bytes(self.raw)
        baseline = recovery._convert(fixture, [1, 2], lambda raw: {
            'text': LOW_TEXT if raw == self.low else NORMAL_TEXT,
            'low_confidence': raw == self.low, 'warnings': []}, None)
        fixed_content = {unit['unit_id']: unit['content'] for unit in baseline['units']}
        self.reference = {'source_id': 'a' * 32, 'source_version': 'b' * 32,
                          'source_sha256': sha256(self.raw).hexdigest(), 'registration_revision': 'c' * 64}
        self.request = {'source_ref': self.reference,
                        'conversion_ref': {'conversion_id': 'd' * 32, 'conversion_revision': 'e' * 64},
                        'units': [{'unit_id': f'slide-{number}',
                                   'location': {'kind': 'slides', 'start': number, 'end': number},
                                   'content': fixed_content[f'slide-{number}']}
                                  for number in (1, 2)]}
        self.catalog = {'source_id': self.reference['source_id'], 'current_version': self.reference['source_version'],
                        'registration_revision': self.reference['registration_revision'],
                        'versions': [{**self.reference, 'size_bytes': len(self.raw), 'format': 'pptx'}]}
        self.requests, self.reads = [], []
        self.catalog_reads = 0
        self.catalog_status = 200
        self.download_raw = self.raw
        self.changed = False
        self.reader_failure = None
        self.http = httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle))
        self.addAsyncCleanup(self.http.aclose)
        self.reader_patch = patch.object(recovery, 'picture_reader', return_value=self.read_picture)
        self.reader_patch.start()
        self.addCleanup(self.reader_patch.stop)
        self.conversion_patch = patch.object(recovery, '_run_conversion', side_effect=self.run_conversion)
        self.conversion_patch.start()
        self.addCleanup(self.conversion_patch.stop)

    async def run_conversion(self, mode, original, numbers, directory, language, cancel_file, replacements=None):
        # 모의 reader는 격리 자식에 전달하지 않고 동일 파서를 현재 테스트 과정에서 실행한다.
        if mode == 'prepare':
            return recovery._prepare(original, numbers, directory, language, cancel_file)
        return recovery._assemble(original, numbers, directory, cancel_file, replacements)

    def handle(self, request):
        self.requests.append(request)
        if request.method != 'GET':
            raise AssertionError('그림 복구 후보는 서버 자료를 쓰지 않는다.')
        if request.url.path.endswith('/file'):
            return httpx2.Response(200, content=self.download_raw)
        self.catalog_reads += 1
        catalog = deepcopy(self.catalog)
        if self.changed and self.catalog_reads > 1:
            catalog['registration_revision'] = 'f' * 64
        return httpx2.Response(self.catalog_status, json={'data': catalog})

    def read_picture(self, raw):
        self.reads.append(raw)
        if self.reader_failure:
            return {'failure': self.reader_failure}
        return {'text': LOW_TEXT if raw == self.low else NORMAL_TEXT,
                'low_confidence': raw == self.low, 'warnings': []}

    async def run_recovery(self, adapter=None, **options):
        return await recovery.recover_images(base_url='http://127.0.0.1:8766', tenant='team',
            token='server-secret-' + 's' * 32, request=options.pop('request', self.request),
            work_dir=self.work, profile='default', http=self.http,
            provider='claude', model='fixture-model', adapter=adapter or CandidateAdapter(), **options)

    def change_package(self, rewrite, additions=None):
        # 실패 경계용 원본은 새 합성 ZIP으로 만들며 원본 참조와 고정보고도 함께 고정한다.
        output = BytesIO()
        with ZipFile(BytesIO(self.raw)) as source, ZipFile(output, 'w') as destination:
            for name in source.namelist():
                raw = source.read(name)
                destination.writestr(name, rewrite(name, raw))
            for name, raw in (additions or {}).items():
                destination.writestr(name, raw)
        self.raw = self.download_raw = output.getvalue()
        digest = sha256(self.raw).hexdigest()
        self.reference['source_sha256'] = digest
        self.catalog['versions'][0].update(source_sha256=digest, size_bytes=len(self.raw))
        fixture = self.root / 'fixture.pptx'
        fixture.write_bytes(self.raw)
        baseline = recovery._convert(fixture, [1, 2], lambda raw: {
            'text': LOW_TEXT if raw == self.low else NORMAL_TEXT,
            'low_confidence': raw == self.low, 'warnings': []}, None)
        self.request['units'] = baseline['units']

    def add_inherited_normal_picture(self):
        with ZipFile(BytesIO(self.raw)) as archive:
            pictures = re.findall(r'<p:pic>.*?</p:pic>', archive.read('ppt/slides/slide1.xml').decode())
        layout = (f'<p:sldLayout xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}">'
                  '<p:cSld><p:spTree>' + pictures[1] + '</p:spTree></p:cSld></p:sldLayout>')
        additions = {'ppt/slideLayouts/layout.xml': layout,
            'ppt/slideLayouts/_rels/layout.xml.rels': f'<Relationships xmlns="{REL}">'
                f'<Relationship Id="normal" Type="{R}/image" Target="../media/normal.png"/></Relationships>'}

        def rewrite(name, raw):
            if name.startswith('ppt/slides/slide') and name.endswith('.xml'):
                # 선택적 레이아웃 머리말 앞에 실제 원문 anchor가 있어 인접 슬롯과 구별된다.
                footer = '<p:sp><p:txBody><a:p><a:r><a:t>슬라이드 바닥글 경계</a:t></a:r></a:p></p:txBody></p:sp>'
                return raw.decode().replace('</p:spTree>', footer + '</p:spTree>').encode()
            if name.startswith('ppt/slides/_rels/'):
                relationship = f'<Relationship Id="layout" Type="{R}/slideLayout" Target="../slideLayouts/layout.xml"/>'
                return raw.decode().replace('</Relationships>', relationship + '</Relationships>').encode()
            return raw

        self.change_package(rewrite, additions)

    def assert_original_removed(self):
        self.assertFalse(any(path.name in {'original', 'original.part'} for path in self.root.rglob('*')))

    async def test_shared_image_attached_once_and_native_normal_ocr_and_notes_preserved(self):
        adapter = CandidateAdapter()
        request_before = deepcopy(self.request)
        result = await self.run_recovery(adapter)
        self.assertTrue(result['ok'])
        self.assertEqual(result['source_ref'], self.reference)
        self.assertEqual(result['conversion_ref'], self.request['conversion_ref'])
        self.assertEqual(result['provider'], 'claude')
        self.assertEqual(result['model'], 'fixture-model')
        self.assertEqual([unit['unit_id'] for unit in result['units']], ['slide-1', 'slide-2'])
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(adapter.calls[0]['image_bytes'], [self.low])
        self.assertEqual(adapter.calls[0]['image_modes'], [0o600])
        self.assertEqual(self.reads.count(self.low), 1)
        self.assertEqual(self.reads.count(self.normal), 1)
        for number, unit in enumerate(result['units'], 1):
            self.assertIn(f'내장 문자 {number}: {LOW_TEXT}', unit['content'])
            self.assertEqual(unit['content'].count(LOW_TEXT), 1)
            self.assertIn(NORMAL_TEXT, unit['content'])
            self.assertIn(RECOVERED, unit['content'])
            self.assertIn(f'발표자 노트 {number}의 조건', unit['content'])
            warnings = '\n'.join(unit['warnings'])
            self.assertIn(LOW_CODE, warnings)
            self.assertIn(sha256(self.low).hexdigest(), warnings)
            self.assertIn('fixture-model', warnings)
        self.assertGreaterEqual(self.catalog_reads, 2)
        self.assertTrue(all(request.url.params.get('profile') == 'default' for request in self.requests))
        self.assertNotIn('server-secret', json.dumps(adapter.calls[0]['prompt']))
        self.assertNotIn('server-secret', json.dumps(result))
        exposed_text = adapter.calls[0]['prompt'] + json.dumps(adapter.calls[0]['schema'], ensure_ascii=False)
        for literal in (LOW_TEXT, NORMAL_TEXT, '내장 문자 1', '발표자 노트 1의 조건'):
            self.assertNotIn(literal, exposed_text)
        for fixed, candidate, binding in zip(adapter.calls[0]['fixed_units'], result['units'],
                                             adapter.calls[0]['baseline_slots']):
            old_cursor, new_cursor = 0, 0
            for slot in binding['slots']:
                if slot['id'] != sha256(self.low).hexdigest():
                    continue
                unchanged = fixed['content'][old_cursor:slot['start']]
                self.assertEqual(candidate['content'][new_cursor:new_cursor + len(unchanged)], unchanged)
                replacement = slot['prefix'] + '[그림 속 글자 · AI 전사 후보]\n' + RECOVERED
                new_cursor += len(unchanged)
                self.assertEqual(candidate['content'][new_cursor:new_cursor + len(replacement)], replacement)
                old_cursor, new_cursor = slot['end'], new_cursor + len(replacement)
            self.assertEqual(candidate['content'][new_cursor:], fixed['content'][old_cursor:])
        self.assertEqual(self.request, request_before)
        self.assert_original_removed()

    async def test_only_selected_slide_is_reassembled(self):
        request = deepcopy(self.request)
        request['units'] = request['units'][1:]
        result = await self.run_recovery(request=request)
        self.assertEqual([unit['unit_id'] for unit in result['units']], ['slide-2'])
        self.assertIn('내장 문자 2', result['units'][0]['content'])
        self.assertNotIn('내장 문자 1', result['units'][0]['content'])

    def expected_fixed_content(self, fixed):
        # 기대값의 위치는 합성 원본에 하나뿐인 명시 OCR 블록이다. 내장 문자의 같은 글자는 그대로다.
        before, marker, after = fixed.partition('[그림 속 글자 · OCR]\n' + LOW_TEXT)
        self.assertTrue(marker)
        self.assertNotIn('[그림 속 글자 · OCR]\n' + LOW_TEXT, after)
        return before + '[그림 속 글자 · AI 전사 후보]\n' + RECOVERED + after

    async def test_fixed_normal_ocr_survives_new_ocr_none_or_changed_text(self):
        for normal in (None, {'text': '새 OCR에서 달라진 값', 'low_confidence': False, 'warnings': []}):
            with self.subTest(normal=normal):
                def current_reader(raw):
                    return ({'text': LOW_TEXT, 'low_confidence': True, 'warnings': []}
                            if raw == self.low else normal)

                adapter = CandidateAdapter()
                with patch.object(recovery, 'picture_reader', return_value=current_reader):
                    result = await self.run_recovery(adapter)
                for fixed, candidate in zip(self.request['units'], result['units']):
                    self.assertEqual(candidate['content'], self.expected_fixed_content(fixed['content']))
                self.assertEqual(adapter.calls[0]['image_bytes'], [self.low])
                self.assertNotIn(NORMAL_TEXT, adapter.calls[0]['prompt'])
                self.assertNotIn('발표자 노트', adapter.calls[0]['prompt'])

    async def test_previously_empty_normal_ocr_stays_empty_when_new_ocr_finds_text(self):
        request = deepcopy(self.request)
        for unit in request['units']:
            unit['content'] = unit['content'].replace('\n\n[그림 속 글자 · OCR]\n' + NORMAL_TEXT, '')
        result = await self.run_recovery(request=request)
        for fixed, candidate in zip(request['units'], result['units']):
            self.assertEqual(candidate['content'], self.expected_fixed_content(fixed['content']))
            self.assertNotIn(NORMAL_TEXT, candidate['content'])

    async def test_fixed_inherited_normal_ocr_survives_new_ocr_none(self):
        self.add_inherited_normal_picture()
        with patch.object(recovery, 'picture_reader', return_value=lambda raw: (
                {'text': LOW_TEXT, 'low_confidence': True, 'warnings': []} if raw == self.low else None)):
            result = await self.run_recovery()
        for fixed, candidate in zip(self.request['units'], result['units']):
            self.assertEqual(candidate['content'], self.expected_fixed_content(fixed['content']))
            self.assertIn('### 슬라이드 레이아웃 그림 속 글자 (표시 여부 미검증)', candidate['content'])
            self.assertEqual(candidate['content'].count(NORMAL_TEXT), 2)

    async def test_absent_inherited_normal_ocr_remains_absent_when_new_ocr_finds_text(self):
        self.add_inherited_normal_picture()
        baseline = recovery._convert(self.root / 'fixture.pptx', [1, 2], lambda raw: (
            {'text': LOW_TEXT, 'low_confidence': True, 'warnings': []} if raw == self.low else None), None)
        request = deepcopy(self.request)
        request['units'] = baseline['units']
        result = await self.run_recovery(request=request)
        for fixed, candidate in zip(request['units'], result['units']):
            self.assertEqual(candidate['content'], self.expected_fixed_content(fixed['content']))
            self.assertNotIn('### 슬라이드 레이아웃 그림 속 글자', candidate['content'])
            self.assertNotIn(NORMAL_TEXT, candidate['content'])

    async def test_native_or_note_mismatch_rejects_candidate_instead_of_regenerating(self):
        for original, changed in (('내장 문자 1', '고정 보고에서 달라진 내장 문자'),
                                  ('발표자 노트 1의 조건', '고정 보고의 별도 노트')):
            with self.subTest(original=original):
                request = deepcopy(self.request)
                request['units'][0]['content'] = request['units'][0]['content'].replace(original, changed)
                with self.assertRaises(AnalysisClientError) as caught:
                    await self.run_recovery(request=request)
                self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
                self.assert_original_removed()

    async def test_structural_picture_heading_inside_fixed_ocr_is_rejected(self):
        request = deepcopy(self.request)
        spoof = NORMAL_TEXT + '\n\n### 그림: id=10, name=그림 10\n\n[그림 속 글자 · OCR]\n가짜 문자'
        request['units'][0]['content'] = request['units'][0]['content'].replace(NORMAL_TEXT, spoof)
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery(request=request)
        self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
        self.assert_original_removed()

    async def test_native_text_mimicking_picture_structure_is_not_treated_as_a_slot(self):
        def rewrite(name, raw):
            if name == 'ppt/slides/slide1.xml':
                spoof = '내장 문자 1: ' + LOW_TEXT + '\n\n### 그림: id=10, name=그림 10'
                return raw.decode().replace('내장 문자 1: ' + LOW_TEXT, spoof).encode()
            return raw

        self.change_package(rewrite)
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery()
        self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
        self.assert_original_removed()

    async def test_native_heading_split_across_runs_is_rejected_after_text_assembly(self):
        def rewrite(name, raw):
            if name == 'ppt/slides/slide1.xml':
                native = '<a:p><a:r><a:t>내장 문자 1: ' + LOW_TEXT + '</a:t></a:r></a:p>'
                spoof = (native + '<a:p><a:r><a:t>##</a:t></a:r>'
                         '<a:r><a:t># 그림: 조각으로 나뉜 원문</a:t></a:r></a:p>')
                return raw.decode().replace(native, spoof).encode()
            return raw

        self.change_package(rewrite)
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery()
        self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
        self.assert_original_removed()

    async def test_native_heading_after_explicit_break_and_split_runs_is_rejected(self):
        def rewrite(name, raw):
            if name == 'ppt/slides/slide1.xml':
                native = '<a:p><a:r><a:t>내장 문자 1: ' + LOW_TEXT + '</a:t></a:r></a:p>'
                spoof = ('<a:p><a:r><a:t>내장 문자 1: ' + LOW_TEXT + '</a:t></a:r><a:br/>'
                         '<a:r><a:t>##</a:t></a:r><a:r><a:t># 그림: 원문 줄바꿈</a:t></a:r></a:p>')
                return raw.decode().replace(native, spoof).encode()
            return raw

        self.change_package(rewrite)
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery()
        self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
        self.assert_original_removed()

    async def test_adjacent_unidentified_picture_slots_are_rejected_as_ambiguous(self):
        def rewrite(name, raw):
            if name.startswith('ppt/slides/slide') and name.endswith('.xml'):
                return re.sub(r'<p:nvPicPr>.*?</p:nvPicPr>', '', raw.decode()).encode()
            return raw

        self.change_package(rewrite)
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery()
        self.assertEqual(caught.exception.code, 'image_recovery_baseline_mismatch')
        self.assert_original_removed()

    async def test_current_provider_cli_and_actual_model_are_preserved(self):
        adapter = CandidateAdapter()
        with patch.object(recovery, 'create_adapter', return_value=adapter) as factory:
            result = await recovery.recover_images(base_url='http://127.0.0.1:8766', tenant='team',
                token='server-secret-' + 's' * 32, request=self.request, work_dir=self.work,
                http=self.http, provider='codex', cli='/fixture/codex', model='selected-model', timeout=37)
        factory.assert_called_once_with('codex', cli='/fixture/codex', model='selected-model', timeout_seconds=37)
        self.assertEqual(result['provider'], 'codex')
        self.assertEqual(result['model'], 'fixture-model')
        for unit in result['units']:
            warnings = '\n'.join(unit['warnings'])
            self.assertIn('provider=codex', warnings)
            self.assertIn('model=fixture-model', warnings)
            self.assertNotIn('model=selected-model', warnings)

    async def test_ai_duplicate_missing_and_foreign_image_ids_reject_whole_candidate(self):
        variants = [lambda entries: [], lambda entries: entries * 2,
                    lambda entries: [{**entries[0], 'id': 'f' * 64}]]
        for transform in variants:
            with self.subTest(transform=transform):
                with self.assertRaises(AnalysisClientError):
                    await self.run_recovery(CandidateAdapter(transform))
                self.assert_original_removed()

    async def test_oversized_ai_text_is_rejected_without_partial_units(self):
        adapter = CandidateAdapter(lambda entries: [{**entries[0], 'text': 'x' * (8 * 1024 * 1024 + 1)}])
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter)
        self.assert_original_removed()

    async def test_image_count_and_byte_limits_fail_without_silent_omission(self):
        request = deepcopy(self.request)
        request['units'] = request['units'][:1]
        for constant, limit in (('MAX_IMAGES', 1), ('MAX_IMAGE_BYTES', len(self.low) - 1),
                                ('MAX_IMAGE_FILE_BYTES', len(self.low) - 1)):
            with self.subTest(constant=constant):
                adapter = CandidateAdapter()
                with patch.object(recovery, constant, limit), patch.object(recovery, 'picture_reader',
                        return_value=lambda raw: {'text': LOW_TEXT, 'low_confidence': True, 'warnings': []}):
                    with self.assertRaises(AnalysisClientError) as caught:
                        await self.run_recovery(adapter, request=request)
                self.assertEqual(caught.exception.code, 'image_recovery_image_limit')
                self.assertFalse(adapter.calls)
                self.assert_original_removed()

    async def test_exact_image_byte_boundary_is_accepted(self):
        with patch.object(recovery, 'MAX_IMAGE_BYTES', len(self.low)), patch.object(
                recovery, 'MAX_IMAGE_FILE_BYTES', len(self.low)):
            result = await self.run_recovery()
        self.assertEqual(len(result['units']), 2)

    async def test_assembled_output_limit_rejects_whole_candidate(self):
        with patch.object(recovery, 'MAX_OUTPUT_BYTES', 1000):
            with self.assertRaises(AnalysisClientError) as caught:
                await self.run_recovery()
        self.assertEqual(caught.exception.code, 'image_recovery_output_limit')
        self.assert_original_removed()

    async def test_invalid_ai_text_or_unread_shape_is_rejected(self):
        for update in ({'text': None}, {'unread': 'unverified'}, {'unread': [1]}, {'extra': 'unexpected'}):
            with self.subTest(update=update):
                adapter = CandidateAdapter(lambda entries: [{**entries[0], **update}])
                with self.assertRaises(AnalysisClientError):
                    await self.run_recovery(adapter)
                self.assert_original_removed()

    async def test_uncertain_notes_exceeding_ipc_warning_limits_fail_explicitly(self):
        for unread in (['확' * 1000], [f'위치 {number} 확인 필요' for number in range(100)]):
            with self.subTest(unread_count=len(unread)):
                adapter = CandidateAdapter(lambda entries: [{**entries[0], 'unread': unread}])
                with self.assertRaises(AnalysisClientError) as caught:
                    await self.run_recovery(adapter)
                self.assertEqual(caught.exception.code, 'image_recovery_output_limit')
                self.assert_original_removed()

    async def test_download_hash_mismatch_fails_before_ai(self):
        adapter = CandidateAdapter()
        self.download_raw = self.raw[:-1] + bytes([self.raw[-1] ^ 1])
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery(adapter)
        self.assertEqual(caught.exception.code, 'source_hash_mismatch')
        self.assertFalse(adapter.calls)
        self.assert_original_removed()

    async def test_permission_denial_fails_without_download_or_ai(self):
        self.catalog_status = 403
        adapter = CandidateAdapter()
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter)
        self.assertFalse(adapter.calls)
        self.assertFalse(any(request.url.path.endswith('/file') for request in self.requests))
        self.assert_original_removed()

    async def test_permission_revocation_after_ai_discards_candidate(self):
        adapter = CandidateAdapter(before_return=lambda: setattr(self, 'catalog_status', 403))
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter)
        self.assertEqual(len(adapter.calls), 1)
        self.assert_original_removed()

    async def test_source_change_after_ai_discards_candidate(self):
        adapter = CandidateAdapter(before_return=lambda: setattr(self, 'changed', True))
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery(adapter)
        self.assertEqual(caught.exception.code, 'source_basis_changed')
        self.assertEqual(len(adapter.calls), 1)
        self.assert_original_removed()

    async def test_wrong_initial_source_basis_never_downloads(self):
        self.catalog['current_version'] = 'f' * 32
        adapter = CandidateAdapter()
        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery(adapter)
        self.assertEqual(caught.exception.code, 'source_basis_changed')
        self.assertFalse(adapter.calls)
        self.assertFalse(any(request.url.path.endswith('/file') for request in self.requests))

    async def test_missing_ocr_language_never_sends_images(self):
        self.reader_failure = 'dependency_missing:tesseract_language:kor'
        adapter = CandidateAdapter()
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter)
        self.assertFalse(adapter.calls)
        self.assert_original_removed()

    async def test_ai_unavailable_never_returns_partial_candidate(self):
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(CandidateAdapter(failure=AIAdapterError('ai_cli_missing')))
        self.assert_original_removed()

    async def test_uncertain_text_remains_candidate_with_original_and_new_review_warnings(self):
        adapter = CandidateAdapter(lambda entries: [{**entries[0], 'unread': ['둘째 줄 마지막 값']}])
        result = await self.run_recovery(adapter)
        self.assertTrue(result['ok'])
        for unit in result['units']:
            warnings = '\n'.join(unit['warnings'])
            self.assertIn(LOW_CODE, warnings)
            self.assertIn('둘째 줄 마지막 값', warnings)
            self.assertIn(sha256(self.low).hexdigest(), warnings)
            self.assertIn(RECOVERED, unit['content'])

    async def test_diagnostic_overflow_preserves_original_low_confidence_for_every_candidate(self):
        # 첫 쪽만 기존 진단에 남고 뒤쪽은 요약으로 접히는 조건을 만든다.
        with patch.object(reports, 'MAX_NOTES', reports.RESERVED_NOTES + 2):
            result = await self.run_recovery()
        self.assertIn(reports.OVERFLOW, result['warnings'])
        for number, unit in enumerate(result['units'], 1):
            self.assertIn(f'slide {number}: {LOW_CODE}', unit['warnings'])
            self.assertIn(RECOVERED, unit['content'])

    async def test_cancelling_ai_wait_cancels_adapter_before_cleanup(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        class WaitingAdapter:
            async def run(inner, **kwargs):
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    stopped.set()

        cancel = self.root / 'cancel'
        task = asyncio.create_task(self.run_recovery(WaitingAdapter(), cancel_file=cancel))
        await asyncio.wait_for(started.wait(), 3)
        cancel.touch(mode=0o600)
        with self.assertRaises(AnalysisClientError):
            await asyncio.wait_for(task, 3)
        self.assertTrue(stopped.is_set())
        self.assert_original_removed()

    async def test_total_timeout_stops_ai_before_cleanup(self):
        stopped = asyncio.Event()

        class WaitingAdapter:
            async def run(inner, **kwargs):
                try:
                    await asyncio.Future()
                finally:
                    stopped.set()

        with self.assertRaises(AnalysisClientError) as caught:
            await self.run_recovery(WaitingAdapter(), timeout=0.05)
        self.assertEqual(caught.exception.code, 'image_recovery_timeout')
        self.assertTrue(stopped.is_set())
        self.assert_original_removed()

    async def test_cancel_before_start_and_after_ai_never_returns_candidate(self):
        cancel = self.root / 'cancel'
        cancel.touch(mode=0o600)
        adapter = CandidateAdapter()
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter, cancel_file=cancel)
        self.assertFalse(adapter.calls)
        cancel.unlink()
        adapter = CandidateAdapter(before_return=lambda: cancel.touch(mode=0o600))
        with self.assertRaises(AnalysisClientError):
            await self.run_recovery(adapter, cancel_file=cancel)
        self.assertEqual(len(adapter.calls), 1)
        self.assert_original_removed()

    async def test_invalid_locations_duplicates_and_reference_fail_before_network(self):
        variants = []
        for location in ({'kind': 'pages', 'start': 1, 'end': 1},
                         {'kind': 'slides', 'start': True, 'end': True},
                         {'kind': 'slides', 'start': 1, 'end': 2}):
            request = deepcopy(self.request)
            request['units'][0]['location'] = location
            variants.append(request)
        duplicate = deepcopy(self.request)
        duplicate['units'][1] = deepcopy(duplicate['units'][0])
        variants.append(duplicate)
        invalid_ref = deepcopy(self.request)
        invalid_ref['source_ref']['source_sha256'] = 'invalid'
        variants.append(invalid_ref)
        for request in variants:
            with self.subTest(request=request):
                with self.assertRaises(AnalysisClientError):
                    await self.run_recovery(request=request)
        self.assertFalse(self.requests)

    async def test_fixed_content_is_required_and_has_per_unit_and_total_utf8_limits(self):
        missing = deepcopy(self.request)
        del missing['units'][0]['content']
        non_text = deepcopy(self.request)
        non_text['units'][0]['content'] = None
        too_large_unit = deepcopy(self.request)
        too_large_unit['units'][0]['content'] = 'x' * (4 * 1024 * 1024 + 1)
        too_large_total = deepcopy(self.request)
        too_large_total['units'] = [{'unit_id': f'slide-{number}',
            'location': {'kind': 'slides', 'start': number, 'end': number},
            'content': 'x' * (4 * 1024 * 1024)} for number in range(1, 7)]
        for request in (missing, non_text, too_large_unit, too_large_total):
            with self.subTest(content_kind=type(request['units'][0].get('content')).__name__):
                with self.assertRaises(AnalysisClientError):
                    await self.run_recovery(request=request)
        self.assertFalse(self.requests)

    def test_private_request_reads_exact_reference_and_rejects_duplicate_json_keys(self):
        path = self.root / 'request.json'
        path.write_text(json.dumps(self.request), encoding='utf-8')
        path.chmod(0o600)
        self.assertEqual(recovery.read_request(path), self.request)
        raw = json.dumps(self.request)
        path.write_text(raw[:-1] + ', "units": []}', encoding='utf-8')
        with self.assertRaises(AnalysisClientError) as caught:
            recovery.read_request(path)
        self.assertEqual(caught.exception.code, 'image_recovery_invalid_request')

    @unittest.skipIf(os.name == 'nt', 'POSIX mode 검증')
    def test_request_requires_private_regular_file_and_rejects_size_overflow(self):
        path = self.root / 'request.json'
        path.write_text(json.dumps(self.request), encoding='utf-8')
        path.chmod(0o644)
        with self.assertRaises(AnalysisClientError) as caught:
            recovery.read_request(path)
        self.assertEqual(caught.exception.code, 'image_recovery_private_request_required')
        path.chmod(0o600)
        link = self.root / 'linked-request.json'
        link.symlink_to(path)
        with self.assertRaises(AnalysisClientError):
            recovery.read_request(link)
        with patch.object(recovery, 'MAX_REQUEST_BYTES', 4096):
            path.write_bytes(b' ' * 4097)
            with self.assertRaises(AnalysisClientError):
                recovery.read_request(path)


if __name__ == '__main__':
    unittest.main()
