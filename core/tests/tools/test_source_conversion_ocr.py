"""OCR 준비 상태와 영상 정규화 회귀. 실제 엔진 품질 평가는 별도 실행 기록이다."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from core.client.source_conversion_formats import (
    Conversion, DependencyMissing, OcrFailure, OutputLimit, _ocr_fragmented_retry,
    convert_file, ocr_diagnostics, ocr_image,
)


class OcrDiagnosticsTests(unittest.TestCase):
    def probe(self, languages, *, language='kor+eng', code=0):
        with patch('core.client.source_conversion_formats.shutil.which', return_value='/tool/tesseract'), \
             patch('core.client.source_conversion_formats.subprocess.run', side_effect=[
                 subprocess.CompletedProcess([], 0, 'tesseract 5.5.3\nprivate machine details'),
                 subprocess.CompletedProcess([], code, languages)]):
            return ocr_diagnostics(language)

    def test_requested_languages_all_required_even_when_executable_present(self):
        value = self.probe('List of available languages in "/private/data/" (2):\neng\nosd\n')
        self.assertTrue(value['available'])
        self.assertFalse(value['ready'])
        self.assertEqual(value['status'], 'language_missing')
        self.assertEqual(value['missing_languages'], ['kor'])
        self.assertEqual(value['languages'], ['eng', 'osd'])

    def test_ready_and_version_preserve_only_structured_probe_data(self):
        value = self.probe('eng\nkor\nosd\n', language='kor+eng+kor')
        self.assertTrue(value['ready'])
        self.assertEqual(value['version'], '5.5.3')
        self.assertEqual(value['requested_languages'], ['kor', 'eng'])
        self.assertEqual(value['missing_languages'], [])
        self.assertNotIn('private machine details', str(value))

    def test_missing_executable_is_not_a_missing_language(self):
        with patch('core.client.source_conversion_formats.shutil.which', return_value=None):
            value = ocr_diagnostics('kor+eng')
        self.assertFalse(value['available'])
        self.assertEqual(value['status'], 'executable_missing')
        self.assertFalse(value['ready'])

    def test_invalid_language_does_not_launch_process(self):
        with patch('core.client.source_conversion_formats.subprocess.run') as run:
            self.assertEqual(ocr_diagnostics('kor;private')['status'], 'invalid_ocr_language')
        run.assert_not_called()

    def test_probe_failure_and_timeout_are_safe_not_ready(self):
        self.assertEqual(self.probe('private error', code=1)['status'], 'probe_failed')
        for error, expected in [(OSError('private detail'), 'probe_failed'),
                                (subprocess.TimeoutExpired('private command', 5), 'probe_timeout')]:
            with self.subTest(expected=expected), \
                 patch('core.client.source_conversion_formats.shutil.which', return_value='/tool/tesseract'), \
                 patch('core.client.source_conversion_formats.subprocess.run', side_effect=error):
                value = ocr_diagnostics()
            self.assertEqual(value['status'], expected)
            self.assertFalse(value['ready'])
            self.assertNotIn('private detail', str(value))


class OcrInputTests(unittest.TestCase):
    def setUp(self):
        self.ready = {'available': True, 'ready': True, 'status': 'ready', 'missing_languages': [],
                      'executable': '/tool/tesseract'}

    def test_partial_language_fallback_is_rejected_before_ocr(self):
        from PIL import Image
        missing = {**self.ready, 'ready': False, 'status': 'language_missing', 'missing_languages': ['kor']}
        with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value=missing), \
             patch('core.client.source_conversion_formats.subprocess.run') as run:
            with self.assertRaises(DependencyMissing) as error:
                ocr_image(Image.new('RGB', (20, 20)), 'kor+eng')
        self.assertEqual(error.exception.name, 'tesseract_languages:kor')
        run.assert_not_called()

    def test_transparency_and_exif_orientation_are_normalized_without_source_mutation(self):
        from PIL import Image
        source = Image.new('RGBA', (3, 2), (0, 0, 0, 0))
        source.putpixel((0, 0), (0, 0, 0, 255))
        source.getexif()[274] = 6
        before = source.tobytes(), source.getexif().tobytes()
        def execute(args, **kwargs):
            with Image.open(args[1]) as rendered:
                self.assertEqual(rendered.size, (2, 3))
                self.assertEqual(rendered.getpixel((1, 0)), (0, 0, 0))
                self.assertEqual(rendered.getpixel((0, 0)), (255, 255, 255))
            Path(args[2] + '.txt').write_text('transcript\n')
            return subprocess.CompletedProcess(args, 0)
        with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value=self.ready), \
             patch('core.client.source_conversion_formats.subprocess.run', side_effect=execute):
            self.assertEqual(ocr_image(source, 'eng'), 'transcript\n')
        self.assertEqual((source.tobytes(), source.getexif().tobytes()), before)

    def test_engine_timeout_and_nonzero_are_distinct(self):
        from PIL import Image
        for effect, expected in [(subprocess.TimeoutExpired('private command', 40), 'ocr_timeout'),
                                 (subprocess.CompletedProcess([], 1), 'ocr_engine_failed'),
                                 (subprocess.CompletedProcess([], 0, stderr=b"private path\nFailed loading language 'kor'"),
                                  'ocr_language_load_failed')]:
            options = {'side_effect': effect} if isinstance(effect, Exception) else {'return_value': effect}
            with self.subTest(expected=expected), \
                 patch('core.client.source_conversion_formats.ocr_diagnostics', return_value=self.ready), \
                 patch('core.client.source_conversion_formats.subprocess.run', **options):
                with self.assertRaisesRegex(OcrFailure, expected):
                    ocr_image(Image.new('RGB', (20, 20)), 'eng')

    def test_partial_frame_failure_preserves_text_locations_and_total(self):
        from PIL import Image
        with tempfile.TemporaryDirectory(prefix='wiki-ocr-frame-regression-') as directory:
            path = Path(directory) / 'source.tiff'
            Image.new('RGB', (20, 20), 'white').save(path, save_all=True,
                append_images=[Image.new('RGB', (20, 20), 'black')])
            before = path.read_bytes()
            with patch('core.client.source_conversion_formats.ocr_image', side_effect=['first page', OcrFailure('ocr_timeout')]):
                value = convert_file(path, 'tiff')
            self.assertEqual(value['state'], 'partial')
            self.assertFalse(value['complete'])
            self.assertEqual(value['total_units'], 2)
            self.assertEqual(value['units'][0]['content'], 'first page')
            self.assertEqual(value['units'][1]['location'], {'kind': 'pages', 'start': 2, 'end': 2})
            self.assertIn('frame 2: ocr_timeout', value['unread_ranges'])
            self.assertEqual(path.read_bytes(), before)

    def run_oriented(self, baseline, candidate, *, rotation=90, confidence=3, failure=None):
        from PIL import Image
        notes, calls = [], []
        def execute(args, **kwargs):
            calls.append((args, kwargs))
            if args[-1] == '0':
                return subprocess.CompletedProcess(args, 0,
                    f'Rotate: {rotation}\nOrientation confidence: {confidence}\n')
            index = sum(call[0][-1] == 'tsv' for call in calls)
            if index == 2 and failure:
                raise failure
            text, score = baseline if index == 1 else candidate
            with Image.open(args[1]) as value:
                self.assertEqual(value.size, (60, 30) if index == 1 else (30, 60))
            Path(args[2] + '.txt').write_text(text)
            Path(args[2] + '.tsv').write_text('level\tconf\ttext\n5\t' + str(score) + '\t' + text.strip() + '\n')
            return subprocess.CompletedProcess(args, 0)
        with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value={**self.ready, 'languages': ['eng', 'osd']}), \
             patch('core.client.source_conversion_formats.subprocess.run', side_effect=execute):
            text = ocr_image(Image.new('RGB', (60, 30), 'white'), 'eng',
                note=lambda code, **kwargs: notes.append((code, kwargs)))
        self.assertLessEqual(len(calls), 3)
        self.assertTrue(all(0 < kwargs['timeout'] <= 40 for _, kwargs in calls))
        return text, notes

    def test_low_osd_supported_by_recognition_corrects_only_pixels_and_preserves_txt(self):
        text, notes = self.run_oriented(('wrong tokens text\n', 38), ('exact candidate transcript\n', 94))
        self.assertEqual(text, 'exact candidate transcript\n')
        self.assertTrue(any('applied_clockwise=90' in code for code, _ in notes))
        self.assertTrue(any('orientation_uncertain' in code for code, _ in notes))
        self.assertFalse(any(options['unread'] for _, options in notes))

    def test_confidence_tie_or_sparse_candidate_does_not_replace_original(self):
        for candidate in [('candidate retained only on evidence\n', 92), ('OK\n', 99)]:
            text, notes = self.run_oriented(('original transcript remains intact\n', 90), candidate)
            self.assertEqual(text, 'original transcript remains intact\n')
            self.assertTrue(any('candidate_rejected' in code for code, _ in notes))

    def test_orientation_retry_failure_retains_first_text_and_low_confidence_range(self):
        text, notes = self.run_oriented(('low confidence retained\n', 30), ('unused', 99),
            failure=subprocess.TimeoutExpired('private path', 1))
        self.assertEqual(text, 'low confidence retained\n')
        self.assertTrue(any('candidate_failed' in code for code, _ in notes))
        self.assertTrue(any('low_or_missing_confidence' in code and opts['unread'] for code, opts in notes))
        self.assertNotIn('private path', str(notes))

    def test_absent_or_malformed_confidence_keeps_text_but_marks_partial(self):
        from PIL import Image
        for score in (None, 'NaN', '101'):
            with self.subTest(score=score), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'input.png'
                Image.new('RGB', (20, 20), 'white').save(path)
                def execute(args, **kwargs):
                    Path(args[2] + '.txt').write_text('nonempty is not accuracy\n')
                    if score is not None:
                        Path(args[2] + '.tsv').write_text(f'level\tconf\ttext\n5\t{score}\ttext\n')
                    return subprocess.CompletedProcess(args, 0)
                with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value={**self.ready, 'version': 'test'}), \
                     patch('core.client.source_conversion_formats.subprocess.run', side_effect=execute):
                    result = convert_file(path, 'png')
                self.assertFalse(result['complete'])
                self.assertEqual(result['units'][0]['content'], 'nonempty is not accuracy\n')
                self.assertTrue(any(s.startswith('frame 1: ocr_low_or_missing_confidence') for s in result['unread_ranges']))

    def test_image_pixel_limit_precedes_engine_invocation(self):
        from PIL import Image
        with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value=self.ready), \
             patch('core.client.source_conversion_formats.MAX_PIXELS', 100), \
             patch('core.client.source_conversion_formats.subprocess.run') as run:
            with self.assertRaises(OutputLimit):
                ocr_image(Image.new('RGB', (11, 10)), 'eng')
        run.assert_not_called()

    def test_pdf_rotation_metadata_is_rendered_once_and_pixel_budget_is_kept(self):
        from core.tests.tools.test_source_conversion import make_pdf
        from pypdf import PdfReader, PdfWriter
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.pdf'
            make_pdf(path)
            reader = PdfReader(path)
            writer = PdfWriter()
            writer.add_page(reader.pages[0].rotate(90))
            writer.write(path)
            before = path.read_bytes()
            sizes = []
            def ocr(image, language, **kwargs):
                sizes.append(image.size)
                return 'unchanged converter text'
            with patch('core.client.source_conversion_formats.MAX_PIXELS', 200000), \
                 patch('core.client.source_conversion_formats.ocr_image', side_effect=ocr):
                value = convert_file(path, 'pdf', ocr='always')
            self.assertLessEqual(sizes[0][0] * sizes[0][1], 200000)
            self.assertTrue(any('pdf_rotation_metadata=90;render_applies_metadata' in s for s in value['warnings']))
            self.assertEqual(value['units'][0]['location']['start'], 1)
            self.assertEqual(path.read_bytes(), before)

    def test_fragmented_retry_requires_better_evidence_and_keeps_exact_transcript(self):
        fragmented = ('a\nb\nc\nd\ne\nf\n', 35, 6, 6, 3)
        candidate = ('original tool transcript\n', 94, 24, 0, 6)
        notes = []
        with patch('core.client.source_conversion_formats._ocr_attempt', return_value=candidate) as run:
            result = _ocr_fragmented_retry(fragmented, None, {}, 'kor+eng', '/unused', 40,
                lambda code, **kwargs: notes.append(code))
        self.assertEqual(result, candidate)
        self.assertEqual(run.call_args.kwargs['psm'], 6)
        self.assertTrue(any('reading_order_not_verified' in note for note in notes))
        with patch('core.client.source_conversion_formats._ocr_attempt', return_value=('worse', 30, 5, 5, 6)):
            self.assertEqual(_ocr_fragmented_retry(fragmented, None, {}, 'eng', '/unused', 40,
                lambda *a, **kw: None), fragmented)

    def test_normal_layout_does_not_force_single_block(self):
        value = ('LEFT 1       RIGHT 1\nLEFT 2       RIGHT 2\n', 95, 26, 0, 3)
        with patch('core.client.source_conversion_formats._ocr_attempt') as run:
            self.assertEqual(_ocr_fragmented_retry(value, None, {}, 'eng', '/unused', 40,
                lambda *a, **kw: None), value)
        run.assert_not_called()

    def test_local_processing_history_survives_server_warning_cap(self):
        result = Conversion('pdf')
        for number in range(120):
            result.ocr_note(f'page {number + 1}', 'applied_clockwise=90;confidence_is_not_accuracy')
        self.assertEqual(len(result.result['warnings']), 100)
        self.assertIn('additional diagnostics', result.result['warnings'][-1])
        self.assertEqual(len(result.result['ocr_processing']), 120)
        self.assertIn('page 120', result.result['ocr_processing'])

    def test_ocr_text_limit_is_not_bypassed_by_tsv_diagnostics(self):
        from PIL import Image
        def execute(args, **kwargs):
            Path(args[2] + '.txt').write_text('01234567890')
            return subprocess.CompletedProcess(args, 0)
        with patch('core.client.source_conversion_formats.ocr_diagnostics', return_value=self.ready), \
             patch('core.client.source_conversion_formats.MAX_TEXT', 10), \
             patch('core.client.source_conversion_formats.subprocess.run', side_effect=execute):
            with self.assertRaises(OutputLimit):
                ocr_image(Image.new('RGB', (20, 20), 'white'), 'eng')


if __name__ == '__main__':
    unittest.main()
