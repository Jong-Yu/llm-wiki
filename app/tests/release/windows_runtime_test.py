"""Office가 없는 Windows용 묶음의 실제 파일 경계와 실패 보존을 검증한다."""

import importlib.util
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/prepare-windows-runtime.py'
SPEC = importlib.util.spec_from_file_location('windows_runtime', SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def pe():
    """파일 이름이 아닌 PE CPU 검증을 거치는 작은 x64 실행 파일 표본이다."""
    data = bytearray(70)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 64)
    data[64:68] = b'PE\0\0'
    struct.pack_into('<H', data, 68, 0x8664)
    return bytes(data)


class OfficeBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'official.paf.exe'
        self.output = self.root / 'office'
        self.extracted = self.root / 'extracted'
        self.files = {
            'program/soffice.exe': pe(), 'program/soffice.bin': pe(),
            'program/mergedlo.dll': pe(), 'program/sal3.dll': pe(),
            'program/vcruntime140.dll': pe(), 'program/vcruntime140_1.dll': pe(),
            'program/msvcp140.dll': pe(), 'program/bootstrap.ini': b'profile',
            'program/fundamental.ini': b'filters', 'program/version.ini': b'26.2.4',
            'share/registry/main.xcd': b'registry', 'license.txt': b'MPL 2.0',
            'LICENSE.html': b'licenses', 'NOTICE': b'notices', 'CREDITS.fodt': b'credits',
            'share/fonts/truetype/Carlito-Regular.ttf': b'font',
        }
        self.listing = self.make_listing()
        self.extract_calls = []

    def make_listing(self):
        """설치기 외부 파일은 선택된 Office 트리와 구분한다."""
        return '\n\n'.join(
            f'Path = App/libreoffice/{name}\nSize = {len(data)}'
            for name, data in self.files.items()
        ) + '\n\nPath = LibreOfficePortable.exe\nSize = 100\n'

    def command(self, arguments, **kwargs):
        """목록과 추출을 분리하여 검사 전에 쓰기가 발생하지 않음을 확인한다."""
        if arguments[1] == 'l':
            return subprocess.CompletedProcess(arguments, 0, stdout=self.listing)
        self.extract_calls.append(arguments)
        self.assertIn('App/libreoffice/*', arguments)
        for name, data in self.files.items():
            target = self.extracted / 'App/libreoffice' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return subprocess.CompletedProcess(arguments, 0, stdout=b'')

    def extract(self):
        with patch.object(runtime.subprocess, 'run', side_effect=self.command):
            runtime.extract_office(self.source, self.output, '7zz', self.extracted)

    def test_includes_runtime_filters_fonts_and_original_licenses_without_launcher(self):
        self.extract()
        self.assertEqual({p.relative_to(self.output).as_posix() for p in self.output.rglob('*')
                          if p.is_file()}, set(self.files))
        self.assertEqual((self.output / 'license.txt').read_bytes(), b'MPL 2.0')
        self.assertFalse((self.output / 'LibreOfficePortable.exe').exists())

    def test_traversal_link_and_duplicate_are_rejected_before_extraction(self):
        for extra in (
            'Path = App/libreoffice/../../escape\nSize = 1',
            'Path = App/libreoffice/link\nSize = 1\nSymbolic Link = other',
            'Path = App/libreoffice/PROGRAM/soffice.exe\nSize = 70',
        ):
            with self.subTest(extra=extra):
                self.listing = self.make_listing() + '\n\n' + extra
                with self.assertRaises(ValueError):
                    self.extract()
                self.assertEqual(self.extract_calls, [])
                self.assertFalse(self.output.exists())

    def test_missing_license_does_not_publish_bundle(self):
        del self.files['license.txt']
        self.listing = self.make_listing()
        with self.assertRaises(FileNotFoundError):
            self.extract()
        self.assertFalse(self.output.exists())

    def test_wrong_cpu_does_not_publish_bundle(self):
        self.files['program/soffice.exe'] = b'not a Windows executable'
        self.listing = self.make_listing()
        with self.assertRaisesRegex(ValueError, 'windows_executable_required'):
            self.extract()
        self.assertFalse(self.output.exists())

    def test_missing_or_changed_extracted_file_is_rejected(self):
        self.listing = self.make_listing()
        self.files['program/soffice.exe'] = pe() + b'changed'
        with self.assertRaisesRegex(ValueError, 'office_file_size_mismatch'):
            self.extract()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'existing'
        sentinel.write_bytes(b'preserve')
        with self.assertRaisesRegex(FileExistsError, 'office_output_exists'):
            self.extract()
        self.assertEqual(sentinel.read_bytes(), b'preserve')

    def test_nsis_generated_file_with_unlisted_size_is_preserved(self):
        self.files['extra_languages_removed.txt'] = b'Original portable distribution notice'
        self.listing = self.make_listing().replace(
            f"Path = App/libreoffice/extra_languages_removed.txt\nSize = {len(self.files['extra_languages_removed.txt'])}",
            'Path = App/libreoffice/extra_languages_removed.txt\nSize = ',
        )
        self.extract()
        self.assertEqual((self.output / 'extra_languages_removed.txt').read_bytes(),
                         self.files['extra_languages_removed.txt'])


if __name__ == '__main__':
    unittest.main()
