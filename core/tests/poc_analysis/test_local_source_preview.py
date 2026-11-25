"""로컬 원본 미리보기의 원본 보존·정적 사본·페이지 경계를 격리 검증한다."""

from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
import os
from pathlib import Path
import shutil
import socket
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from PIL import Image
from docx import Document
from openpyxl import Workbook
from pypdf import PdfReader

from tools.source_preview_cli import PreviewError, network_guard, office_binary, prepare, render, sanitize_package


class LocalSourcePreviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="wiki-local-preview-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_image_frames_orientation_bounds_and_original_preserved(self):
        source = self.root / "source.tiff"
        first = Image.new("RGB", (2500, 1000), "red")
        second = Image.new("RGB", (100, 150), "blue")
        first.save(source, save_all=True, append_images=[second])
        original = source.read_bytes()
        self.assertEqual(prepare(self.root, "tiff")["pageCount"], 2)
        for page, size in ((1, (1600, 640)), (2, (100, 150))):
            render(self.root, "tiff", page)
            with Image.open(self.root / "page.png") as result:
                self.assertEqual(result.size, size)
        with self.assertRaisesRegex(PreviewError, "preview_page_not_found"):
            render(self.root, "tiff", 3)
        self.assertEqual(source.read_bytes(), original)
        jpeg = self.root / "source.jpg"
        metadata = Image.Exif()
        metadata[274] = 6
        Image.new("RGB", (30, 20), "green").save(jpeg, exif=metadata)
        render(self.root, "jpg", 1)
        with Image.open(self.root / "page.png") as result:
            self.assertEqual(result.size, (20, 30))

    def test_static_copy_removes_active_and_external_parts_without_original_mutation(self):
        source = self.root / "source.docx"
        entries = {
            "word/document.xml": '<w:document xmlns:w="urn:w"><w:instrText>DDEAUTO remote</w:instrText><w:fldSimple w:instr="INCLUDETEXT remote"><w:t>cached field</w:t></w:fldSimple><w:t>source body</w:t><w:imagedata src="https://example.invalid/image"/></w:document>',
            "word/_rels/document.xml.rels": '<Relationships><Relationship Id="x" Type="image" Target="http://127.0.0.1/a" TargetMode="External"/><Relationship Id="vba" Type="vbaProject" Target="vbaProject.bin"/><Relationship Id="ole" Type="oleObject" Target="embeddings/ole.bin"/><Relationship Id="vector" Type="image" Target="media/pic.svg"/></Relationships>',
            "word/vbaProject.bin": b"macro",
            "word/embeddings/ole.bin": b"embedded",
            "word/media/pic.svg": b'<svg><image href="http://127.0.0.1/a"/></svg>',
            "xl/worksheets/sheet1.xml": '<worksheet><c><f>WEBSERVICE("http://127.0.0.1/a")</f><v>7</v></c></worksheet>',
        }
        with ZipFile(source, "w") as output:
            for name, content in entries.items():
                output.writestr(name, content)
        before = sha256(source.read_bytes()).hexdigest()
        self.assertTrue(sanitize_package(source, self.root / "static.docx"))
        with ZipFile(self.root / "static.docx") as result:
            self.assertNotIn("word/vbaProject.bin", result.namelist())
            self.assertNotIn("word/embeddings/ole.bin", result.namelist())
            self.assertNotIn("word/media/pic.svg", result.namelist())
            self.assertNotIn(b"Relationship Id", result.read("word/_rels/document.xml.rels"))
            self.assertIn(b"cached field", result.read("word/document.xml"))
            self.assertNotIn(b"INCLUDETEXT", result.read("word/document.xml"))
            self.assertNotIn(b"DDEAUTO", result.read("word/document.xml"))
            self.assertNotIn(b"https:", result.read("word/document.xml"))
            self.assertNotIn(b"WEBSERVICE", result.read("xl/worksheets/sheet1.xml"))
            self.assertIn(b"<v>7</v>", result.read("xl/worksheets/sheet1.xml"))
        self.assertEqual(sha256(source.read_bytes()).hexdigest(), before)

    def test_rejects_entities_paths_and_legacy_without_network_guard(self):
        for index, (name, content) in enumerate((("../bad.xml", b"<a/>"), ("a.xml", b'<!DOCTYPE a [<!ENTITY v SYSTEM "file:///private/secret">]><a>&v;</a>'))):
            source = self.root / f"invalid-{index}.docx"
            with ZipFile(source, "w") as output:
                output.writestr(name, content)
            with self.assertRaisesRegex(PreviewError, "preview_document_invalid"):
                sanitize_package(source, self.root / f"copy-{index}.docx")
        (self.root / "source.ppt").write_bytes(b"synthetic-legacy")
        with patch("tools.source_preview_cli.office_binary", return_value="soffice"), patch("tools.source_preview_cli.network_guard", side_effect=PreviewError("legacy_office_preview_unavailable")), patch("tools.source_preview_cli.subprocess.run") as run:
            with self.assertRaisesRegex(PreviewError, "legacy_office_preview_unavailable"):
                prepare(self.root, "ppt")
            run.assert_not_called()

    def test_windows_existing_office_discovery_does_not_install(self):
        programs = self.root / "Program Files"
        binary = programs / "LibreOffice/program/soffice.exe"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"isolated discovery fixture")
        with patch("tools.source_preview_cli.sys.platform", "win32"), patch("tools.source_preview_cli.shutil.which", return_value=None), patch.dict(os.environ, {"PROGRAMFILES": str(programs)}, clear=True):
            self.assertEqual(office_binary(), str(binary))

    @unittest.skipUnless(os.environ.get("WIKI_TEST_OFFICE_PREVIEW") == "1", "실제 LibreOffice 검증은 명시 환경에서 실행")
    def test_real_docx_xlsx_static_layout_and_external_http_hit_zero(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"external content must not load")
            def log_message(self, *_args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        endpoint = f"http://127.0.0.1:{server.server_port}/external"
        for format in ("docx", "xlsx"):
            work = self.root / format
            work.mkdir()
            source = work / ("source." + format)
            if format == "docx":
                document = Document()
                document.add_heading("FIRST PAGE FIXTURE", 1)
                document.add_page_break()
                document.add_paragraph("SECOND PAGE FIXTURE")
                document.save(source)
                with ZipFile(source) as package:
                    entries = {name: package.read(name) for name in package.namelist()}
                entries["word/_rels/document.xml.rels"] = entries["word/_rels/document.xml.rels"].replace(b"</Relationships>", f'<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="{endpoint}" TargetMode="External"/></Relationships>'.encode())
                with ZipFile(source, "w") as package:
                    for name, content in entries.items():
                        package.writestr(name, content)
            else:
                workbook = Workbook()
                workbook.active["A1"] = "SHEET FIXTURE"
                workbook.active["B2"] = 42
                workbook.active["C3"] = f'=WEBSERVICE("{endpoint}")'
                workbook.create_sheet("Other")["A1"] = "SECOND SHEET FIXTURE"
                workbook.save(source)
            before = source.read_bytes()
            result = prepare(work, format)
            self.assertEqual(result["kind"], "office")
            self.assertGreaterEqual(result["pageCount"], 2, format)
            self.assertTrue(result["limited"])
            render(work, format, 2)
            self.assertTrue((work / "page.png").read_bytes().startswith(b"\x89PNG"))
            text = " ".join(page.extract_text() for page in PdfReader(work / "preview.pdf").pages)
            self.assertIn("FIXTURE", text)
            self.assertEqual(source.read_bytes(), before)
            profile = (work / "profile/user/registrymodifications.xcu").read_text()
            self.assertIn('DisableMacrosExecution', profile)
        self.assertEqual(hits, [])

    @unittest.skipUnless(os.environ.get("WIKI_TEST_OFFICE_PREVIEW") == "1", "실제 LibreOffice 검증은 명시 환경에서 실행")
    def test_real_pptx_and_guarded_legacy_capability(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("PPTX 합성 fixture 생성용 기존 node 없음")
        repository = Path(__file__).resolve().parents[3]
        source = self.root / "source.pptx"
        script = "const pptxgen=require('./app/node_modules/pptxgenjs'); const doc=new pptxgen(); for (const text of ['SLIDE ONE FIXTURE','SLIDE TWO FIXTURE']) {const slide=doc.addSlide();slide.addText(text,{x:1,y:1,w:8,h:1});} doc.writeFile({fileName:process.argv[1]});"
        subprocess.run([node, "-e", script, str(source)], cwd=repository, check=True, capture_output=True, timeout=20)
        original = source.read_bytes()
        self.assertEqual(prepare(self.root, "pptx")["pageCount"], 2)
        render(self.root, "pptx", 2)
        self.assertEqual(source.read_bytes(), original)
        self.assertIn("SLIDE TWO FIXTURE", PdfReader(self.root / "preview.pdf").pages[1].extract_text())
        if os.sys.platform != "darwin":
            return
        legacy = self.root / "legacy"
        legacy.mkdir()
        subprocess.run([office_binary(), "-env:UserInstallation=" + (legacy / "fixture-profile").as_uri(), "--headless", "--convert-to", "ppt", "--outdir", str(legacy), str(source)], check=True, capture_output=True, timeout=60)
        legacy_bytes = (legacy / "source.ppt").read_bytes()
        try:
            metadata = prepare(legacy, "ppt")
        except PreviewError as error:
            # 강화된 격리가 렌더러 필수 동작도 막는 환경은 우회 없이 지원 불가로 끝낸다.
            self.assertEqual(str(error), "legacy_office_preview_unavailable")
            self.assertFalse((legacy / "preview.pdf").exists())
        else:
            self.assertEqual(metadata["pageCount"], 2)
            render(legacy, "ppt", 1)
            self.assertIn("SLIDE ONE FIXTURE", PdfReader(legacy / "preview.pdf").pages[0].extract_text())
        self.assertEqual((legacy / "source.ppt").read_bytes(), legacy_bytes)
        protected = self.root / "outside-source.txt"
        protected.write_text("must not enter a preview")
        guard = network_guard(legacy)
        blocked = subprocess.run([*guard, "/usr/bin/head", str(protected)], capture_output=True, timeout=5)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertNotIn(b"must not enter", blocked.stdout)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(0.1)
            blocked = subprocess.run([*guard, "/usr/bin/curl", "--max-time", "1", f"http://127.0.0.1:{listener.getsockname()[1]}/blocked"], capture_output=True, timeout=5)
            self.assertNotEqual(blocked.returncode, 0)
            with self.assertRaises(TimeoutError):
                listener.accept()


if __name__ == "__main__":
    unittest.main()
