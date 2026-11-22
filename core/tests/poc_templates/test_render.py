"""실제 파일 바이트·Office 보호 요소·잘못된 AI 작성 결과를 격리 검증한다."""

from io import BytesIO
import json
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from core.modules.templates.render import TemplateRenderError, inspect_template, render_template

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
TYPES = b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'


def package(parts):
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.comment = b"original-template"
        archive.writestr("[Content_Types].xml", TYPES)
        for name, content in parts.items():
            archive.writestr(name, content)
    return output.getvalue()


def result(*items):
    return '작성을 완료했습니다.\n\n```wiki-template-result\n' + json.dumps(
        {"version": 1, "replacements": [{"id": identifier, "text": text} for identifier, text in items]},
        ensure_ascii=False) + '\n```'


def read_file(content, name):
    with ZipFile(BytesIO(content)) as archive:
        return archive.read(name)


def word(text="{{내용}}"):
    return package({
        "word/document.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:document xmlns:w="{W}" xmlns:w14="urn:unused-but-required" '
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">'
            '<w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>'
            '<w:r><w:rPr><w:b/></w:rPr><w:t>제목: </w:t></w:r>'
            f'<w:r><w:t>{text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'),
        "word/styles.xml": b'<style original="unchanged"/>',
        "word/media/logo.png": b"preserved-image-bytes",
        "word/_rels/document.xml.rels": b'<relationships original="unchanged"/>',
    })


def slides():
    return package({
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}"/>',
        "ppt/slides/slide1.xml": (
            f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody>'
            '<a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="1"/><a:r><a:rPr b="1" sz="2400"/>'
            '<a:t>{{화면 이름}}</a:t></a:r><a:endParaRPr lang="ko-KR"/></a:p>'
            '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
        "ppt/slideMasters/slideMaster1.xml": b'<master original="unchanged"/>',
        "ppt/theme/theme1.xml": b'<theme original="unchanged"/>',
        "ppt/media/image1.png": b"preserved-logo-bytes",
    })


def workbook():
    return package({
        "xl/workbook.xml": f'<workbook xmlns="{S}"/>',
        "xl/sharedStrings.xml": f'<sst xmlns="{S}" count="2" uniqueCount="1"><si><t>공통 값</t></si></sst>',
        "xl/worksheets/sheet1.xml": (
            f'<worksheet xmlns="{S}"><sheetData><row r="1">'
            '<c r="A1" s="2" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c>'
            '<c r="C1" s="3"><f>SUM(D1:E1)</f><v>9</v></c>'
            '<c r="D1" s="4"><v>4</v></c><c r="E1" s="4"/>'
            '</row></sheetData><mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>'),
        "xl/styles.xml": b'<styles original="unchanged"/>',
        "xl/calcChain.xml": b'<calcChain original="unchanged"/>',
    })


class TemplateRenderTests(unittest.TestCase):
    def test_docx_preserves_style_namespace_and_every_other_part(self):
        original = word()
        inspection = inspect_template("screen.docx", original)
        self.assertEqual(inspection["fields"], [{"id": "f0001", "text": "제목: {{내용}}", "location": "본문 · 문단 1"}])
        updated = render_template("screen.docx", original, result(("f0001", "제목: 로그인 화면")))
        document = read_file(updated, "word/document.xml")
        self.assertIn(b'xmlns:w14="urn:unused-but-required"', document)
        self.assertIn(b'mc:Ignorable="w14"', document)
        self.assertIn(b'<w:pPr><w:pStyle w:val="Title"/></w:pPr>', document)
        self.assertIn(b'<w:rPr><w:b/></w:rPr>', document)
        self.assertEqual("".join(ET.fromstring(document).itertext()), "제목: 로그인 화면")
        with ZipFile(BytesIO(original)) as before, ZipFile(BytesIO(updated)) as after:
            self.assertEqual(before.comment, after.comment)
            self.assertEqual(before.namelist(), after.namelist())
            for name in before.namelist():
                if name != "word/document.xml":
                    self.assertEqual(before.read(name), after.read(name))

    def test_word_text_is_escaped_and_newlines_are_real_breaks(self):
        updated = render_template("screen.docx", word(), result(("f0001", "새 제목\n<&고객>")))
        xml = read_file(updated, "word/document.xml")
        root = ET.fromstring(xml)
        self.assertEqual(len(list(root.iter(f"{{{W}}}br"))), 1)
        self.assertIn(b"&lt;&amp;", xml)
        self.assertIn("<&고객>", "".join(root.itertext()))

    def test_pptx_preserves_master_logo_style_and_creates_break(self):
        original = slides()
        self.assertEqual(inspect_template("screen.pptx", original)["fields"][0]["text"], "{{화면 이름}}")
        updated = render_template("screen.pptx", original, result(("f0001", "로그인\n입력 화면")))
        xml = read_file(updated, "ppt/slides/slide1.xml")
        root = ET.fromstring(xml)
        self.assertEqual([node.text for node in root.iter(f"{{{A}}}t")], ["로그인", "입력 화면"])
        self.assertEqual(len(list(root.iter(f"{{{A}}}br"))), 1)
        self.assertEqual(len(list(root.iter(f"{{{A}}}rPr"))), 2)
        for name in ("ppt/slideMasters/slideMaster1.xml", "ppt/theme/theme1.xml", "ppt/media/image1.png"):
            self.assertEqual(read_file(updated, name), read_file(original, name))

    def test_xlsx_replaces_one_shared_cell_preserving_formula_other_cell_and_styles(self):
        original = workbook()
        self.assertEqual([value["text"] for value in inspect_template("checks.xlsx", original)["fields"]],
                         ["공통 값", "공통 값", "4", ""])
        updated = render_template("checks.xlsx", original, result(("f0001", "=1+1"), ("f0004", "새 값")))
        xml = read_file(updated, "xl/worksheets/sheet1.xml")
        cells = {cell.attrib["r"]: cell for cell in ET.fromstring(xml).iter(f"{{{S}}}c")}
        self.assertEqual(cells["A1"].attrib, {"r": "A1", "s": "2", "t": "inlineStr"})
        self.assertEqual(cells["A1"].find(f"{{{S}}}is/{{{S}}}t").text, "=1+1")
        self.assertIn(b'<c r="B1" t="s"><v>0</v></c>', xml)
        self.assertIn(b'<c r="C1" s="3"><f>SUM(D1:E1)</f><v>9</v></c>', xml)
        self.assertEqual(cells["E1"].find(f"{{{S}}}is/{{{S}}}t").text, "새 값")
        for name in ("xl/sharedStrings.xml", "xl/styles.xml", "xl/calcChain.xml"):
            self.assertEqual(read_file(updated, name), read_file(original, name))

    def test_xlsx_numeric_inputs_stay_numeric_for_protected_formulas(self):
        original = workbook()
        updated = render_template("numbers.xlsx", original, result(("f0003", "12.5"), ("f0004", "7")))
        xml = read_file(updated, "xl/worksheets/sheet1.xml")
        cells = {cell.attrib["r"]: cell for cell in ET.fromstring(xml).iter(f"{{{S}}}c")}
        self.assertEqual(cells["D1"].attrib["t"], "n")
        self.assertEqual(cells["D1"].find(f"{{{S}}}v").text, "12.5")
        self.assertEqual(cells["E1"].attrib["t"], "n")
        self.assertIn(b'<f>SUM(D1:E1)</f>', xml)

    def test_xlsx_cell_length_limit_is_checked_before_publishing(self):
        with self.assertRaises(TemplateRenderError):
            render_template("long.xlsx", workbook(), result(("f0001", "x" * 32768)))

    def test_xlsx_shared_rich_text_retains_run_styles_and_namespaces(self):
        original = workbook()
        with ZipFile(BytesIO(original)) as archive:
            parts = {name: archive.read(name) for name in archive.namelist() if name != "[Content_Types].xml"}
        parts["xl/sharedStrings.xml"] = (f'<x:sst xmlns:x="{S}" count="2" uniqueCount="1"><x:si>'
            '<x:r><x:rPr><x:b/><x:color rgb="FF123456"/></x:rPr><x:t>공통 </x:t></x:r>'
            '<x:r><x:t>값</x:t></x:r></x:si></x:sst>')
        original = package(parts)
        updated = render_template("rich.xlsx", original, result(("f0001", "작성 내용")))
        xml = read_file(updated, "xl/worksheets/sheet1.xml")
        root = ET.fromstring(xml)
        first = next(root.iter(f"{{{S}}}c"))
        self.assertEqual("".join(first.itertext()), "작성 내용")
        self.assertEqual(len(list(first.iter(f"{{{S}}}b"))), 1)
        self.assertIn(b'xmlns:x=', xml)
        self.assertEqual(read_file(original, "xl/sharedStrings.xml"), read_file(updated, "xl/sharedStrings.xml"))

    def test_xlsx_inline_rich_text_and_prefixes_remain_readable(self):
        original = package({"xl/workbook.xml": f'<s:workbook xmlns:s="{S}"/>',
            "xl/worksheets/sheet1.xml": f'<s:worksheet xmlns:s="{S}"><s:sheetData><s:row r="1">'
                '<s:c r="A1" t="inlineStr"><s:is><s:r><s:rPr><s:i/></s:rPr>'
                '<s:t>기존</s:t></s:r></s:is></s:c></s:row></s:sheetData></s:worksheet>'})
        updated = render_template("rich.xlsx", original, result(("f0001", "새로운 값")))
        root = ET.fromstring(read_file(updated, "xl/worksheets/sheet1.xml"))
        self.assertEqual(len(list(root.iter(f"{{{S}}}i"))), 1)
        self.assertEqual("".join(root.itertext()), "새로운 값")

    def test_result_hidden_in_another_code_block_is_rejected(self):
        with self.assertRaises(TemplateRenderError):
            render_template("test.md", b"original", '```text\n' + result(("f0001", "new")) + '\n```')

    def test_workbook_sheet_name_and_order_are_model_context(self):
        original = package({
            "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="요구사항" sheetId="2" r:id="r2"/><sheet name="검증" sheetId="1" r:id="r1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                '<Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row><c r="B2" t="inlineStr"><is><t>검증 내용</t></is></c></row></sheetData></worksheet>',
            "xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData><row><c r="A1" t="inlineStr"><is><t>요구 내용</t></is></c></row></sheetData></worksheet>',
        })
        fields = inspect_template("named.xlsx", original)["fields"]
        self.assertEqual([(item["text"], item["location"]) for item in fields], [("요구 내용", "요구사항 · A1"), ("검증 내용", "검증 · B2")])

    def test_presentation_order_overrides_part_filename_order(self):
        original = slides()
        with ZipFile(BytesIO(original)) as archive:
            parts = {name: archive.read(name) for name in archive.namelist() if name != "[Content_Types].xml"}
        parts["ppt/slides/slide2.xml"] = parts["ppt/slides/slide1.xml"].replace("화면 이름".encode(), "첫 슬라이드".encode())
        parts["ppt/presentation.xml"] = f'<p:presentation xmlns:p="{P}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="r2"/><p:sldId id="2" r:id="r1"/></p:sldIdLst></p:presentation>'
        parts["ppt/_rels/presentation.xml.rels"] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'
        fields = inspect_template("ordered.pptx", package(parts))["fields"]
        self.assertEqual(fields[0]["text"], "{{첫 슬라이드}}")
        self.assertEqual(fields[0]["location"], "슬라이드 1 · 문단 1")
        self.assertEqual(fields[1]["location"], "슬라이드 2 · 문단 1")

    def test_blank_word_table_cell_accepts_text_without_changing_table_layout(self):
        original = package({"word/document.xml": f'<w:document xmlns:w="{W}"><w:body><w:tbl><w:tblPr/><w:tr>'
            '<w:tc><w:tcPr><w:tcW w:w="2400"/></w:tcPr><w:p><w:r><w:t>목적</w:t></w:r></w:p></w:tc>'
            '<w:tc><w:tcPr><w:tcW w:w="4800"/></w:tcPr><w:p><w:pPr><w:rPr><w:color w:val="123456"/></w:rPr></w:pPr></w:p></w:tc>'
            '</w:tr></w:tbl></w:body></w:document>'})
        fields = inspect_template("blank.docx", original)["fields"]
        self.assertEqual(fields[1]["text"], "")
        self.assertIn("행 1 열 2", fields[1]["location"])
        updated = render_template("blank.docx", original, result(("f0002", "안전한 로그인")))
        xml = read_file(updated, "word/document.xml")
        self.assertIn(b'<w:tcW w:w="4800"/>', xml)
        root = ET.fromstring(xml)
        self.assertEqual([item.text for item in root.iter(f"{{{W}}}t")], ["목적", "안전한 로그인"])
        self.assertEqual(len(list(root.iter(f"{{{W}}}color"))), 2)

    def test_blank_powerpoint_placeholder_inherits_font_and_accepts_lines(self):
        original = package({"ppt/presentation.xml": f'<p:presentation xmlns:p="{P}"/>',
            "ppt/slides/slide1.xml": f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp>'
                '<p:nvSpPr><p:cNvPr id="1" name="본문 자리"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/>'
                '<a:p><a:pPr lvl="1"/><a:endParaRPr lang="ko-KR" sz="1800" b="1"/></a:p>'
                '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'})
        fields = inspect_template("blank.pptx", original)["fields"]
        self.assertEqual(fields[0]["text"], "")
        self.assertIn("본문 자리", fields[0]["location"])
        updated = render_template("blank.pptx", original, result(("f0001", "첫 줄\n둘째 줄")))
        root = ET.fromstring(read_file(updated, "ppt/slides/slide1.xml"))
        self.assertEqual([item.text for item in root.iter(f"{{{A}}}t")], ["첫 줄", "둘째 줄"])
        self.assertEqual([item.attrib["sz"] for item in root.iter(f"{{{A}}}rPr")], ["1800", "1800"])
        self.assertEqual(len(list(root.iter(f"{{{A}}}endParaRPr"))), 1)

    def test_self_closing_word_paragraph_is_fillable_but_picture_only_is_not(self):
        original = package({"word/document.xml": f'<w:document xmlns:w="{W}"><w:body><w:p/>'
            '<w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>'})
        fields = inspect_template("blank.docx", original)["fields"]
        self.assertEqual(len(fields), 1)
        updated = render_template("blank.docx", original, result(("f0001", "내용")))
        xml = read_file(updated, "word/document.xml")
        self.assertIn(b'<w:p><w:r><w:drawing/></w:r></w:p>', xml)
        self.assertEqual([item.text for item in ET.fromstring(xml).iter(f"{{{W}}}t")], ["내용"])

    def test_automatic_word_fields_cannot_be_replaced(self):
        original = package({"word/document.xml": (
            f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/>'
            '<w:instrText> PAGE </w:instrText><w:t>1</w:t></w:r></w:p></w:body></w:document>')})
        self.assertFalse(inspect_template("page.docx", original)["supported"])

    def test_nested_textbox_paragraphs_are_separate_fields(self):
        original = package({"word/document.xml": (
            f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>Outer</w:t>'
            '<w:drawing><w:txbxContent><w:p><w:r><w:t>Inner</w:t></w:r></w:p>'
            '</w:txbxContent></w:drawing></w:r></w:p></w:body></w:document>')})
        self.assertEqual([item["text"] for item in inspect_template("nested.docx", original)["fields"]], ["Outer", "Inner"])
        updated = render_template("nested.docx", original, result(("f0001", "밖"), ("f0002", "안")))
        self.assertEqual("".join(ET.fromstring(read_file(updated, "word/document.xml")).itertext()), "밖안")

    def test_text_formats_preserve_unicode_newlines_and_utf8_bom(self):
        for extension in ("md", "txt", "html", "csv"):
            with self.subTest(extension=extension):
                original = b"\xef\xbb\xbf" + "{{제목}}\n{{본문}}".encode()
                generated = render_template("test." + extension, original, result(("f0001", "로그인\n사용자 설명")))
                self.assertEqual(generated, b"\xef\xbb\xbf" + "로그인\n사용자 설명".encode())

    def test_unknown_formats_and_invalid_utf8_are_not_silently_converted(self):
        for filename, raw in (("old.hwp", b"hwp"), ("reference.pdf", b"%PDF"), ("binary.txt", b"\xff")):
            with self.subTest(filename=filename):
                value = inspect_template(filename, raw)
                self.assertFalse(value["supported"])
                self.assertTrue(value["reason"])
                self.assertEqual(value["fields"], [])
                with self.assertRaises(TemplateRenderError):
                    render_template(filename, raw, result(("f0001", "변경")))

    def test_no_output_block_and_malformed_duplicate_unknown_fields_are_rejected(self):
        invalid = ["어떤 범위로 작성할까요?", result(("other", "wrong")), result(("f0001", "x"), ("f0001", "y")),
                   result(), result(("f0001", "\u0000")), result(("f0001", "new")) + "\n" + result(("f0001", "again")),
                   '```wiki-template-result\n{"version":1,"version":1,"replacements":[]}\n```',
                   '```wiki-template-result\n{"version":true,"replacements":[{"id":"f0001","text":"x"}]}\n```',
                   '```wiki-template-result\n{"version":1,"replacements":[{"id":"f0001","text":"x","path":"/tmp/a"}]}\n```']
        for answer in invalid:
            with self.subTest(answer=answer):
                with self.assertRaises(TemplateRenderError):
                    render_template("test.txt", b"original", answer)

    def test_unchanged_output_is_not_claimed_as_generated(self):
        with self.assertRaises(TemplateRenderError) as caught:
            render_template("test.txt", b"original", result(("f0001", "original")))
        self.assertEqual(caught.exception.code, "template_no_change")

    def test_source_limits_refuse_instead_of_truncating(self):
        self.assertFalse(inspect_template("test.md", b"x" * 24001)["supported"])
        original = package({"word/document.xml": f'<w:document xmlns:w="{W}"><w:body>' +
                            '<w:p><w:r><w:t>x</w:t></w:r></w:p>' * 501 + '</w:body></w:document>'})
        inspection = inspect_template("many.docx", original)
        self.assertFalse(inspection["supported"])
        self.assertEqual(inspection["fields"], [])

    def test_dtd_and_external_entity_are_refused(self):
        original = package({"word/document.xml": '<!DOCTYPE x [<!ENTITY test SYSTEM "file:///secret">]>' +
                            f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&test;</w:t>' +
                            '</w:r></w:p></w:body></w:document>'})
        self.assertFalse(inspect_template("bad.docx", original)["supported"])

    def test_zip_unsafe_paths_duplicates_symlinks_and_bombs_are_refused(self):
        original = word()
        for unsafe in ("../outside", "/absolute", "word\\outside", "word/./a", "C:/a"):
            with self.subTest(unsafe=unsafe):
                with ZipFile(BytesIO(original)) as source:
                    modified = package({**{name: source.read(name) for name in source.namelist() if name != "[Content_Types].xml"}, unsafe: b"bad"})
                self.assertFalse(inspect_template("bad.docx", modified)["supported"])
        output = BytesIO(original)
        with ZipFile(output, "a") as archive:
            entry = ZipInfo("link")
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, "target")
        self.assertFalse(inspect_template("bad.docx", output.getvalue())["supported"])
        output = BytesIO(original)
        with ZipFile(output, "a", compression=ZIP_DEFLATED) as archive:
            archive.writestr("word/bomb.bin", b"a" * (2 * 1024 * 1024))
        self.assertFalse(inspect_template("bomb.docx", output.getvalue())["supported"])
        output = BytesIO(original)
        with ZipFile(output, "a") as archive:
            archive.writestr("WORD/document.xml", b"duplicate-case")
        self.assertFalse(inspect_template("duplicate.docx", output.getvalue())["supported"])

    def test_result_length_and_xml_depth_are_bounded(self):
        with self.assertRaises(TemplateRenderError):
            render_template("test.md", b"template", result(("f0001", "x" * 48001)))
        nested = package({"word/document.xml": f'<w:document xmlns:w="{W}">' + '<w:p>' * 101 + '<w:t>x</w:t>' + '</w:p>' * 101 + '</w:document>'})
        self.assertFalse(inspect_template("deep.docx", nested)["supported"])

    def test_real_docx_library_reopens_generated_document(self):
        try:
            from docx import Document
        except ImportError:
            self.skipTest("python-docx is not installed")
        document = Document()
        paragraph = document.add_paragraph()
        paragraph.add_run("제목: ").bold = True
        paragraph.add_run("{{내용}}")
        original = BytesIO()
        document.save(original)
        updated = render_template("test.docx", original.getvalue(), result(("f0001", "제목: 실제 문서")))
        reopened = Document(BytesIO(updated))
        self.assertEqual(reopened.paragraphs[0].text, "제목: 실제 문서")
        self.assertTrue(reopened.paragraphs[0].runs[0].bold)

    def test_real_xlsx_library_reopens_generated_workbook_with_formula(self):
        try:
            from openpyxl import Workbook, load_workbook
        except ImportError:
            self.skipTest("openpyxl is not installed")
        book = Workbook()
        book.active["A1"] = "{{이름}}"
        book.active["B1"] = "=SUM(1,2)"
        book.active["A1"].number_format = "@"
        original = BytesIO()
        book.save(original)
        updated = render_template("test.xlsx", original.getvalue(), result(("f0001", "로그인 화면")))
        reopened = load_workbook(BytesIO(updated))
        self.assertEqual(reopened.active["A1"].value, "로그인 화면")
        self.assertEqual(reopened.active["A1"].number_format, "@")
        self.assertEqual(reopened.active["B1"].value, "=SUM(1,2)")


if __name__ == "__main__":
    unittest.main()
