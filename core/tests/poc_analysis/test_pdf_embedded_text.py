"""PDF 정상 내장 문자를 유지하고 그림 영역만 따로 읽어 덧붙인다(D-157·D-159)."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.client import source_conversion_formats as formats

TEXT = 'Readable embedded text CQRS /hmm/-/vessel/1.0/{imoNo}'


def make_pdf(path, pages):
    """pages: (문자 여부, 그림 크기 pt 또는 None, 그림을 서식 묶음에 넣을지)의 목록. 쪽은 200x200pt."""
    from pypdf import PdfWriter
    from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
                               NumberObject)
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')}))
    image = DecodedStreamObject()
    image.set_data(b'\x00\x00\x00' * 4)
    image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
        NameObject('/Width'): NumberObject(2), NameObject('/Height'): NumberObject(2),
        NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
    image = writer._add_object(image)
    for text, size, in_form in pages:
        page = writer.add_blank_page(width=200, height=200)
        content, objects = b'', DictionaryObject()
        if text:
            content += b'BT /F1 8 Tf 5 180 Td (' + TEXT.encode() + b') Tj ET\n'
        if size or in_form:
            # 그림이 없는 서식 묶음은 벡터 사각형만 그린다.
            draw = b'q %d 0 0 %d 10 10 cm /Im0 Do Q' % (size, size) if size else b'10 10 150 150 re f'
            if in_form:
                form = DecodedStreamObject()
                form.set_data(draw)
                form.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                    NameObject('/BBox'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(200), FloatObject(200)]),
                    NameObject('/Resources'): DictionaryObject({NameObject('/XObject'):
                        DictionaryObject({NameObject('/Im0'): image} if size else {})})})
                objects[NameObject('/Fm0')] = writer._add_object(form)
                content += b'q /Fm0 Do Q'
            else:
                objects[NameObject('/Im0')] = image
                content += draw
        stream = DecodedStreamObject()
        stream.set_data(content)
        page[NameObject('/Contents')] = writer._add_object(stream)
        resources = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        if objects:
            resources[NameObject('/XObject')] = objects
        page[NameObject('/Resources')] = resources
    with path.open('wb') as handle:
        writer.write(handle)


class EmbeddedTextTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'original.pdf'

    def convert(self, pages, *, ocr='auto', extracted=None, region=None, engine=None):
        """전체 쪽 OCR(ocr_image)과 그림 영역 OCR(ocr_region_text) 호출을 따로 기록한다."""
        make_pdf(self.path, pages)
        calls, regions = [], []

        def recognize(image, language, **kwargs):
            calls.append(image.size)
            return 'OCR TEXT'

        def read(image, engine, language):
            regions.append(image.size)
            return region(image) if region else {'text': 'IMAGE TEXT', 'score': 90.0, 'count': 10, 'weak': 0,
                                                 'psm': 3, 'low_confidence': False}
        with patch.object(formats, 'ocr_image', side_effect=recognize), \
                patch.object(formats, 'ocr_region_text', side_effect=read), \
                patch.object(formats, 'ocr_engine', side_effect=engine or (lambda language: {})):
            if extracted is None:
                value = formats.convert_file(self.path, 'pdf', ocr=ocr, language='kor+eng')
            else:
                with patch('pypdf._page.PageObject.extract_text', side_effect=extracted):
                    value = formats.convert_file(self.path, 'pdf', ocr=ocr, language='kor+eng')
        return value, calls, regions

    def test_small_logo_keeps_embedded_text_without_ocr(self):
        # 10pt 그림은 쪽 면적의 0.25%: 바닥글 로고처럼 읽지 않고 정상 내장 문자만 쓴다.
        value, calls, regions = self.convert([(True, 10, False), (True, 10, True)])
        self.assertEqual((calls, regions), ([], []))
        self.assertEqual([unit['content'].strip() for unit in value['units']], [TEXT, TEXT])
        self.assertEqual(value['unit_methods'], {'page-1': 'pdf_text', 'page-2': 'pdf_text'})
        self.assertEqual(value['method'], 'pdf_text')
        self.assertTrue(value['complete'])
        self.assertIn('pages 1,2: pdf_text_kept_small_images_not_ocr', value['warnings'])

    def test_large_image_text_is_added_after_embedded_text_with_location(self):
        # 80pt 그림은 16%: 내장 문자는 그대로 두고 그림만 읽어 위치·OCR 표시와 함께 덧붙인다. 서식 묶음 안도 같다.
        value, calls, regions = self.convert([(True, 80, False), (True, 80, True)])
        self.assertEqual(calls, [])
        self.assertEqual(regions, [(2, 2)])  # 같은 그림은 문서 안에서 한 번만 읽는다.
        for unit in value['units']:
            native, added = unit['content'].split('\n\n[그림 속 글자 1 · ', 1)
            self.assertEqual(native.strip(), TEXT)
            self.assertEqual(added, '쪽 안 위치: 왼쪽 5% 위 55% 크기 40%×40% · OCR]\nIMAGE TEXT\n')
        self.assertEqual(value['method'], 'pdf_text')
        self.assertTrue(value['complete'])
        self.assertIn('pages 1,2: pdf_image_text_added_marked_as_ocr', value['warnings'])

    def test_image_without_readable_text_adds_nothing(self):
        # 장식 배경처럼 기준 미만인 결과는 버리고 내장 문자만 남긴다.
        value, calls, regions = self.convert([(True, 80, False)], region=lambda image: None)
        self.assertEqual((calls, len(regions)), ([], 1))
        self.assertEqual(value['units'][0]['content'].strip(), TEXT)
        self.assertTrue(value['complete'])
        self.assertIn('pages 1: pdf_images_without_readable_text', value['warnings'])

    def test_low_confidence_image_text_uses_existing_review_mark(self):
        low = {'text': 'blurry', 'score': 55.0, 'count': 9, 'weak': 5, 'psm': 6, 'low_confidence': True}
        value, _, _ = self.convert([(True, 80, False)], region=lambda image: low)
        self.assertIn('blurry', value['units'][0]['content'])
        self.assertEqual(value['unread_ranges'], ['page 1: ' + formats.LOW_CONFIDENCE])
        self.assertFalse(value['complete'])

    def test_picture_recovery_diagnostics_remain_attached_to_each_page(self):
        recovered = {'text': '배포 생성 화면', 'score': 79.0, 'count': 111, 'weak': 22,
                     'psm': 6, 'low_confidence': False,
                     'warnings': ['ocr_single_block_candidate_preferred_reading_order_not_verified']}
        value, calls, regions = self.convert([(True, 80, False), (True, 80, False)],
                                            region=lambda image: recovered)
        self.assertEqual(calls, [])
        self.assertEqual(len(regions), 1)
        for index, unit in enumerate(value['units'], 1):
            self.assertIn(TEXT, unit['content'])
            self.assertIn(recovered['text'], unit['content'])
            self.assertIn(f'page {index}: ' + recovered['warnings'][0], value['warnings'])
        self.assertTrue(value['complete'])

    def test_missing_ocr_engine_keeps_embedded_text_and_reports_unread(self):
        def missing(language):
            raise formats.DependencyMissing('tesseract_and_language_data')
        value, calls, regions = self.convert([(True, 80, False)], engine=missing)
        self.assertEqual((calls, regions), ([], []))
        self.assertEqual(value['units'][0]['content'].strip(), TEXT)
        self.assertIn('page 1: dependency_missing:tesseract_and_language_data', value['unread_ranges'])

    def test_form_without_image_is_not_a_reason_to_ocr(self):
        # 이전에는 그림이 아닌 서식 묶음(/XObject)만 있어도 전체 쪽 OCR로 대체했다.
        value, calls, regions = self.convert([(True, None, True)])
        self.assertEqual((calls, regions), ([], []))
        self.assertEqual(value['units'][0]['content'].strip(), TEXT)

    def test_empty_or_unreadable_embedded_text_still_uses_whole_page_ocr(self):
        garbled = '\ue001\ue002\ue003\ue004 \ue005\ufffd'
        value, calls, _ = self.convert([(False, None, False), (True, None, False)], extracted=['', garbled])
        self.assertEqual(len(calls), 2)
        self.assertEqual([unit['content'] for unit in value['units']], ['OCR TEXT', 'OCR TEXT'])
        self.assertIn('page 2: pdf_text_replacement_private_or_control_characters_ocr_used', value['warnings'])
        self.assertNotIn('page 1: pdf_text_empty_ocr_used', value['warnings'])

    def test_unreadable_text_with_ocr_disabled_is_reported_unread(self):
        value, calls, _ = self.convert([(True, None, False)], ocr='never', extracted=['\ue001\ue002\ue003\ue004'])
        self.assertEqual(calls, [])
        self.assertIn('page 1: ocr_required_but_disabled', value['unread_ranges'])
        self.assertFalse(value['complete'])

    def test_explicit_always_still_ocrs_every_page(self):
        value, calls, regions = self.convert([(True, 80, False)], ocr='always')
        self.assertEqual((len(calls), regions), (1, []))
        self.assertEqual(value['units'][0]['content'], 'OCR TEXT')

    def test_unknown_image_position_falls_back_to_whole_page_ocr(self):
        with patch.object(formats, 'pdf_image_regions', side_effect=RuntimeError('broken')):
            value, calls, regions = self.convert([(True, 80, False)])
        self.assertEqual((len(calls), regions), (1, []))
        self.assertIn('page 1: pdf_image_size_unknown_whole_page_ocr_kept', value['warnings'])

    def test_text_readability_signals(self):
        self.assertIsNone(formats.pdf_text_problem('입력 화면(Form) 제출 조건\nAPI 검증 중 (비활성)'))
        self.assertIsNone(formats.pdf_text_problem('Q&A'))
        # 긴 정상 문장 안의 몇 개 사용자 정의 글머리 기호는 깨짐으로 보지 않는다.
        self.assertIsNone(formats.pdf_text_problem('\uf0a7 ' + '정상 문장입니다 ' * 5 + '\uf0a7'))
        self.assertEqual(formats.pdf_text_problem(' \n '), 'pdf_text_empty')
        self.assertEqual(formats.pdf_text_problem('\x01\x02\x03 abc'), 'pdf_text_replacement_private_or_control_characters')
        self.assertEqual(formats.pdf_text_problem('→ ← ↑ ↓ ■ □ ● ○ ◆ ◇ a'), 'pdf_text_mostly_symbols')


class RegionOcrTests(unittest.TestCase):
    """그림 한 장 읽기의 잡음 거르기와 빈 자동 단락 결과의 한 덩어리 재시도."""

    def read(self, attempts):
        from PIL import Image
        calls = []

        def attempt(image, engine, language, directory, deadline, *, psm=3):
            calls.append(psm)
            return attempts[psm]
        with patch.object(formats, '_ocr_attempt', side_effect=attempt):
            return formats.ocr_region_text(Image.new('RGB', (200, 100), 'white'), {}, 'kor+eng'), calls

    def test_background_noise_is_discarded(self):
        found, calls = self.read({3: ('', None, 0, 0, 3), 6: ('ie살어6iy', 35.0, 30, 30, 6)})
        self.assertIsNone(found)
        self.assertEqual(calls, [3, 6])

    def test_confident_screenshot_text_is_kept_without_retry(self):
        found, calls = self.read({3: ('toSearchParams(keyword)', 88.0, 22, 0, 3)})
        self.assertEqual((found['text'], found['low_confidence'], calls), ('toSearchParams(keyword)', False, [3]))

    def test_single_block_retry_used_when_auto_layout_misses_boxed_text(self):
        found, calls = self.read({3: ('', None, 0, 0, 3), 6: ('스캔한 쪽 문장입니다', 91.0, 10, 0, 6)})
        self.assertEqual((found['text'], found['psm'], calls), ('스캔한 쪽 문장입니다', 6, [3, 6]))

    def test_fragmented_low_confidence_picture_uses_existing_recovery_thresholds(self):
        fragmented = '배     포\n생     성\n대     상\n선     박\n이     름\n저     장\n읽은 내용'
        found, calls = self.read({3: (fragmented, 54.1, 119, 70, 3),
                                 6: ('배포 생성 대상 선박 이미 사용 중인 이름입니다', 78.9, 111, 22, 6)})
        self.assertEqual(calls, [3, 6])
        self.assertEqual(found['psm'], 6)
        self.assertFalse(found['low_confidence'])
        self.assertIn('이미 사용 중인 이름입니다', found['text'])
        self.assertIn('ocr_single_block_candidate_preferred_reading_order_not_verified', found['warnings'])

    def test_fragmented_picture_retains_first_text_when_retry_loses_text_or_has_low_confidence(self):
        fragmented = '배\n포\n생\n성\n대\n상\n선\n박\n읽은 내용'
        for candidate in [('너무 짧음', 99.0, 10, 0, 6), ('아직 불확실', 69.0, 120, 5, 6)]:
            with self.subTest(candidate=candidate):
                found, calls = self.read({3: (fragmented, 54.1, 119, 70, 3), 6: candidate})
                self.assertEqual((found['text'], calls), (fragmented, [3, 6]))
                self.assertTrue(found['low_confidence'])
                self.assertIn('ocr_fragmented_layout_manual_review_required', found['warnings'])

    def test_picture_segmentation_retry_failure_preserves_read_text(self):
        from PIL import Image
        fragmented = '배\n포\n생\n성\n대\n상\n선\n박\n읽은 내용'
        with patch.object(formats, '_ocr_attempt', side_effect=[
                (fragmented, 54.1, 119, 70, 3), formats.OcrFailure('ocr_timeout')]):
            found = formats.ocr_region_text(Image.new('RGB', (200, 100), 'white'), {}, 'kor+eng')
        self.assertEqual(found['text'], fragmented)
        self.assertTrue(found['low_confidence'])
        self.assertIn('ocr_segmentation_retry_failed_original_ocr_retained', found['warnings'])

    def test_confident_picture_with_short_lines_keeps_reading_order_without_retry(self):
        text = 'A\nB\nC\nD\nE\nF\n이미 읽은 정상 내용'
        found, calls = self.read({3: (text, 95.0, 20, 0, 3)})
        self.assertEqual((found['text'], calls), (text, [3]))

    def test_whole_page_ocr_retries_single_block_only_when_empty(self):
        from PIL import Image
        attempts = {3: ('', None, 0, 0, 3), 6: ('선박 장비 점검 기록입니다', 92.0, 13, 0, 6)}
        notes = []
        with patch.object(formats, 'ocr_engine', return_value={}), \
                patch.object(formats, '_ocr_orientation', return_value=(None, None)), \
                patch.object(formats, '_ocr_attempt', side_effect=lambda *args, psm=3: attempts[psm]):
            text = formats.ocr_image(Image.new('RGB', (200, 100), 'white'), 'kor+eng',
                                     note=lambda code, **kwargs: notes.append(code))
        self.assertEqual(text, '선박 장비 점검 기록입니다')
        self.assertIn('ocr_single_block_used_after_empty_page_layout', notes)


def attempt_with_words(text, words, psm=3):
    """words: (문자, 신뢰도, 줄 번호) 목록. 위치는 왼쪽부터 차례로 둔다."""
    found = formats._Attempt((text, 80.0, len(text), 0, psm))
    found.words = [{'text': value, 'confidence': confidence, 'line': ('1', '1', str(line)),
                    'box': (index * 30, line * 20, 25, 15)} for index, (value, confidence, line) in enumerate(words)]
    return found


class HangulRereadTests(unittest.TestCase):
    """kor+eng 읽기에서 영문 조각으로 읽힌 한국어 단어만 kor로 다시 읽는다(D-161)."""

    def reread(self, attempt, answer, language='kor+eng'):
        from PIL import Image
        calls = []

        answers = list(answer) if isinstance(answer, list) else None

        def again(image, engine, language, directory, deadline, *, psm=3):
            calls.append((language, psm, image.size))
            return answers.pop(0) if answers is not None else answer
        with patch.object(formats, '_ocr_attempt', side_effect=again):
            text, changed = formats._reread_hangul_words(attempt, Image.new('RGB', (400, 100), 'white'), {}, language,
                                                         '.', __import__('time').monotonic() + 30)
        return text, changed, calls

    def test_latin_fragment_in_korean_line_is_replaced_by_confident_korean_reading(self):
        source = attempt_with_words('테스트는 SHS 발견해\nAPI 문서', [
            ('테스트는', 91, 1), ('SHS', 60, 1), ('발견해', 90, 1), ('API', 70, 2), ('문서', 88, 2)])
        # SHS와 신뢰도 80 미만인 API만 다시 읽는다. API를 kor로 읽으면 한글이 아니어서 그대로 둔다.
        text, changed, calls = self.reread(source, [attempt_with_words('결함을', [('결함을', 92, 1)], psm=7),
                                                    attempt_with_words('API', [('API', 75, 1)], psm=7)])
        self.assertEqual((text, changed), ('테스트는 결함을 발견해\nAPI 문서', 1))
        self.assertEqual([call[:2] for call in calls], [('kor', 7), ('kor', 7)])

    def test_uncertain_or_non_hangul_reading_keeps_original_word(self):
        source = attempt_with_words('선박 Vessel 목록', [('선박', 92, 1), ('Vessel', 41, 1), ('목록', 90, 1)])
        for answer in (attempt_with_words('시기', [('시기', 65, 1)]), attempt_with_words('\\/6556!을', [('\\/6556!을', 78, 1)])):
            text, changed, _ = self.reread(source, answer)
            self.assertEqual((text, changed), ('선박 Vessel 목록', 0))

    def test_confident_english_and_english_only_lines_are_not_reread(self):
        source = attempt_with_words('배포 API 호출\nOTA package list', [
            ('배포', 93, 1), ('API', 95, 1), ('호출', 91, 1), ('OTA', 40, 2), ('package', 50, 2), ('list', 52, 2)])
        text, changed, calls = self.reread(source, attempt_with_words('결함을', [('결함을', 92, 1)]))
        self.assertEqual((text, changed, calls), ('배포 API 호출\nOTA package list', 0, []))

    def test_only_mixed_korean_reading_rereads(self):
        source = attempt_with_words('테스트는 SHS', [('테스트는', 91, 1), ('SHS', 60, 1)])
        for language in ('eng', 'kor'):
            self.assertEqual(self.reread(source, None, language), ('테스트는 SHS', 0, []))

    def test_per_character_korean_words_align_with_joined_text_line(self):
        source = attempt_with_words('테스트는  SHS 발견', [
            ('테', 90, 1), ('스', 90, 1), ('트', 90, 1), ('는', 90, 1), ('SHS', 50, 1), ('발견', 90, 1)])
        text, changed, _ = self.reread(source, attempt_with_words('결함을', [('결함을', 90, 1)]))
        self.assertEqual((text, changed), ('테스트는  결함을 발견', 1))

    def test_misaligned_text_line_is_left_unchanged(self):
        source = attempt_with_words('테스트는 SHS 발견해', [('테스트는', 91, 1), ('SHS', 60, 1), ('발견', 90, 1)])
        text, changed, _ = self.reread(source, attempt_with_words('결함을', [('결함을', 92, 1)]))
        self.assertEqual((text, changed), ('테스트는 SHS 발견해', 0))

    def test_plain_attempt_without_word_positions_is_returned_as_is(self):
        self.assertEqual(self.reread(('테스트는 SHS', 80.0, 9, 0, 3), None), ('테스트는 SHS', 0, []))


if __name__ == '__main__':
    unittest.main()
