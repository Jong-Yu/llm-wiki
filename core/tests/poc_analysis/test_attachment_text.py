"""채팅 첨부 파일 읽기: 형식별 글자 추출, 한도, 읽지 못한 범위의 고정 코드."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.client import attachment_text as attach
from core.client.attachment_text import AttachmentError, read_attachment


class AttachmentTextTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.dir = Path(temporary.name)

    def write(self, name, data):
        path = self.dir / name
        path.write_bytes(data) if isinstance(data, bytes) else path.write_text(data, encoding="utf-8")
        return path

    def docx(self):
        from docx import Document
        document = Document(); document.add_heading("분기 보고서", 1)
        document.add_paragraph("본문 첫 문단입니다.")
        table = document.add_table(rows=2, cols=2)
        for cell, text in zip((table.cell(0, 0), table.cell(0, 1), table.cell(1, 0), table.cell(1, 1)), ("항목", "값", "포인트", "10")):
            cell.text = text
        document.add_paragraph("표 뒤 문단.")
        path = self.dir / "a.docx"; document.save(path); return path

    def test_docx_keeps_body_order_and_joins_table_rows(self):
        result = read_attachment(self.docx(), "docx", limit=12000)
        lines = result["text"].split("\n")
        self.assertEqual(lines, ["분기 보고서", "본문 첫 문단입니다.", "항목 | 값", "포인트 | 10", "표 뒤 문단."])
        self.assertFalse(result["truncated"])

    def test_xlsx_makes_sheet_headings_and_tab_separated_rows(self):
        from openpyxl import Workbook
        workbook = Workbook(); sheet = workbook.active; sheet.title = "매핑"
        sheet.append(["요소", "엔드포인트", None]); sheet.append(["버튼1", "/api/pay/1", 3.5]); sheet.append([None, None, None])
        other = workbook.create_sheet("메모"); other.append(["가"])
        buffer = BytesIO(); workbook.save(buffer)
        result = read_attachment(self.write("a.xlsx", buffer.getvalue()), "xlsx", limit=12000)
        self.assertEqual(result["text"].split("\n"), ["## 시트: 매핑", "요소\t엔드포인트", "버튼1\t/api/pay/1\t3.5", "## 시트: 메모", "가"])

    def test_text_files_and_utf8_bom(self):
        result = read_attachment(self.write("a.md", "﻿# 제목\n본문\r\n"), "md", limit=100)
        self.assertEqual(result["text"], "# 제목\n본문")
        self.assertEqual(read_attachment(self.write("b.txt", "한글"), ".TXT", limit=100)["text"], "한글")

    def test_limit_marks_truncated_with_the_full_length(self):
        result = read_attachment(self.write("a.txt", "가" * 500), "txt", limit=120)
        self.assertEqual((len(result["text"]), result["total_chars"], result["truncated"]), (120, 500, True))

    def test_large_sheet_stops_reading_and_is_marked_partial(self):
        from openpyxl import Workbook
        workbook = Workbook(); sheet = workbook.active
        for index in range(2000):
            sheet.append([f"행 {index}", "값" * 20])
        buffer = BytesIO(); workbook.save(buffer)
        result = read_attachment(self.write("big.xlsx", buffer.getvalue()), "xlsx", limit=500)
        self.assertTrue(result["truncated"]); self.assertLessEqual(len(result["text"]), 500)
        self.assertIn("rows_stopped_at_limit", result["notes"])

    def test_unread_parts_are_reported_as_codes_without_content(self):
        from docx import Document
        document = Document(); document.add_paragraph("본문")
        table = document.add_table(rows=1, cols=1)
        table.cell(0, 0).add_table(rows=1, cols=1).cell(0, 0).text = "비밀 중첩 표 내용"
        path = self.dir / "n.docx"; document.save(path)
        result = read_attachment(path, "docx", limit=12000)
        self.assertIn("nested_table_not_read", result["notes"])
        self.assertNotIn("비밀", " ".join(result["notes"]))

    def test_image_without_ocr_has_no_text_and_pdf_without_text_is_reported(self):
        from PIL import Image
        buffer = BytesIO(); Image.new("RGB", (10, 10), "white").save(buffer, format="PNG")
        with self.assertRaises(AttachmentError) as caught:
            read_attachment(self.write("a.png", buffer.getvalue()), "png", limit=100, ocr="never")
        self.assertEqual(caught.exception.code, "no_text_found")
        from pypdf import PdfWriter
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100); pdf = BytesIO(); writer.write(pdf)
        with self.assertRaises(AttachmentError) as caught:
            read_attachment(self.write("a.pdf", pdf.getvalue()), "pdf", limit=100, ocr="never")
        self.assertEqual(caught.exception.code, "no_text_found")

    def test_unsupported_oversized_and_broken_files_use_fixed_codes(self):
        for name, data, extension, code in (("a.exe", b"x", "exe", "unsupported_format"),
                                            ("broken.docx", b"not a zip", "docx", "file_unreadable"),
                                            ("broken.xlsx", b"not a zip", "xlsx", "file_unreadable")):
            with self.subTest(extension=extension), self.assertRaises(AttachmentError) as caught:
                read_attachment(self.write(name, data), extension, limit=100)
            self.assertEqual(caught.exception.code, code)
        with patch.object(attach, "MAX_FILE_BYTES", 3), self.assertRaises(AttachmentError) as caught:
            read_attachment(self.write("big.txt", "12345"), "txt", limit=100)
        self.assertEqual(caught.exception.code, "file_too_large")

    def test_cli_prints_one_json_line_and_never_leaks_the_error_text(self):
        import io, json, contextlib
        from tools import attach_file_cli
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = attach_file_cli.main(["--file", str(self.write("c.txt", "내용")), "--extension", "txt"])
        value = json.loads(out.getvalue())
        self.assertEqual((code, value["ok"], value["text"], value["protocol"]), (0, True, "내용", "attach-file-cli-v1"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = attach_file_cli.main(["--file", str(self.dir / "없는파일.txt"), "--extension", "txt"])
        self.assertEqual((code, json.loads(out.getvalue())["error"]["code"]), (1, "file_unreadable"))


if __name__ == "__main__":
    unittest.main()
