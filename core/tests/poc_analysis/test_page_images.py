"""AI 해석 후보 쪽의 원본 화면 그림을 그래프 추출 호출에 함께 넘긴다(D-169).

변환 보고의 후보 목록 읽기, 쪽 그림 만들기, 크기 한도, 원본 확인, Claude·Codex 전달, 작업 흐름 연결을 검사한다.
실제 AI는 부르지 않는다.
"""
import asyncio
from contextlib import contextmanager
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import httpx2
import pypdfium2
from PIL import Image

from core.client import source_conversion_formats as formats
from core.client.ai import page_images, workflow
from core.client.ai.claude import ClaudeAdapter
from core.client.ai.codex import CodexAdapter
from core.client.ai.contracts import AIAdapterError
from core.client.transport import AnalysisClientError
from core.runtime.client_platform import private_directory, write_new
from core.tests.poc_analysis import test_draft_workflow as draft
from core.tests.poc_analysis.test_draft_workflow import DraftAdapter, isolated_server
from core.tests.poc_analysis.test_presentation_relations import A, P, R, REL, blank, line

PDF_REVIEW = "pages 2,5: pdf_diagram_relations_need_review"


def pdf_bytes(pages=3):
    document = pypdfium2.PdfDocument.new()
    for _ in range(pages):
        document.new_page(720, 405)
    output = BytesIO()
    document.save(output)
    document.close()
    return output.getvalue()


def slides_package(count, *, hidden=()):
    """도형 두 개와 끝을 못 찾는 선만 있는 슬라이드 count장(모두 AI 해석 후보가 된다)."""
    shapes = blank(5, 500, 1000, 1000, 400) + blank(6, 3000, 1000, 1000, 400) + line(7, 1500, 1200, 1500, start=5, end=6)
    ids = "".join(f'<p:sldId id="{255 + n}" r:id="s{n}"/>' for n in range(1, count + 1))
    rels = "".join(f'<Relationship Id="s{n}" Type="{R}/slide" Target="slides/slide{n}.xml"/>' for n in range(1, count + 1))
    # LibreOffice가 열 수 있도록 형식 표와 문서 시작 관계를 갖춘다(변환 코드는 이 둘을 읽지 않는다).
    kind = "application/vnd.openxmlformats-officedocument.presentationml"
    types = (f'<Override PartName="/ppt/presentation.xml" ContentType="{kind}.presentation.main+xml"/>'
             + "".join(f'<Override PartName="/ppt/slides/slide{n}.xml" ContentType="{kind}.slide+xml"/>'
                       for n in range(1, count + 1)))
    entries = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                               f'<Default Extension="xml" ContentType="application/xml"/>{types}</Types>',
        "_rels/.rels": f'<Relationships xmlns="{REL}"><Relationship Id="r1" Type="{R}/officeDocument" '
                       'Target="ppt/presentation.xml"/></Relationships>',
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>{ids}</p:sldIdLst>'
                                '<p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
        "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{REL}">{rels}</Relationships>'}
    for n in range(1, count + 1):
        show = ' show="0"' if n in hidden else ""
        entries[f"ppt/slides/slide{n}.xml"] = (f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"{show}><p:cSld><p:spTree>'
                                               f'{shapes}</p:spTree></p:cSld></p:sld>')
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


def png(path, size=(64, 36)):
    buffer = BytesIO()
    Image.new("RGB", size, "white").save(buffer, "PNG")
    write_new(path, buffer.getvalue())
    return path


class CandidateListTests(unittest.TestCase):
    def test_reads_grouped_pdf_and_slide_candidates_only(self):
        self.assertEqual(page_images.review_locations({"warnings": [
            "pages 1-3: pdf_text_kept_small_images_not_ocr", PDF_REVIEW, "pages 9: pdf_diagram_relations_need_review",
            "remaining scopes: additional diagnostics exceed the report limit"]}), ("pdf", [2, 5, 9]))
        self.assertEqual(page_images.review_locations({"warnings": [
            "slides 3,4: pptx_diagram_relations_need_review", "slide 7: pptx_diagram_relations_need_review"]}),
            ("slides", [3, 4, 7]))
        self.assertEqual(page_images.review_locations({"warnings": ["slides 3: diagram_relations_estimated_by_position"]}),
                         (None, []))
        # 형식이 섞인 보고는 어느 원본 쪽인지 정할 수 없으므로 그림을 만들지 않는다.
        self.assertEqual(page_images.review_locations({"warnings": [
            PDF_REVIEW, "slides 1: pptx_diagram_relations_need_review"]}), (None, []))

    def test_pptx_candidates_are_grouped_and_kept_in_reserved_report_room(self):
        with TemporaryDirectory() as root:
            path = Path(root) / "deck.pptx"
            path.write_bytes(slides_package(3))
            value = formats.convert_file(path, "pptx", ocr="never")
        self.assertIn("slides 1,2,3: pptx_diagram_relations_need_review", value["warnings"])
        self.assertEqual(page_images.review_locations(value), ("slides", [1, 2, 3]))


class RenderTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.out = private_directory(self.root / "images", exist_ok=False) or self.root / "images"

    def test_pdf_pages_render_small_png_and_missing_pages_are_listed(self):
        source = self.root / "source.pdf"
        source.write_bytes(pdf_bytes(3))
        images, omitted, method = page_images.render(source, "pdf", [2, 5], self.out)
        self.assertEqual(method, "pdfium")
        self.assertEqual([image["location"] for image in images], ["2쪽"])
        self.assertEqual(omitted, [{"location": "5쪽", "reason": "page_out_of_range"}])
        self.assertLessEqual(max(images[0]["width"], images[0]["height"]), page_images.LONG_EDGE)
        raw = images[0]["path"].read_bytes()
        self.assertTrue(raw.startswith(b"\x89PNG"))
        self.assertEqual(images[0]["sha256"], sha256(raw).hexdigest())

    def test_wrong_format_and_legacy_ppt_are_refused(self):
        source = self.root / "source.bin"
        source.write_bytes(b"PK\x03\x04 not a pdf")
        with self.assertRaises(AnalysisClientError) as caught:
            page_images.render(source, "pdf", [1], self.out)
        self.assertEqual(caught.exception.code, "page_images_format_mismatch")
        source.write_bytes(b"\xd0\xcf\x11\xe0legacy")
        with self.assertRaises(AnalysisClientError) as caught:
            page_images.render(source, "slides", [1], self.out)
        self.assertEqual(caught.exception.code, "page_images_legacy_ppt_not_supported")

    def test_slides_need_libreoffice_and_matching_page_count(self):
        source = self.root / "deck.pptx"
        source.write_bytes(slides_package(3))

        def converted(pages, problem=None):
            @contextmanager
            def fake(path, suffix, convert_to, output_suffix, *, timeout=90):
                self.assertIn('"ExportHiddenSlides"', convert_to)
                if problem:
                    yield None, problem
                    return
                pdf = self.root / f"converted-{pages}.pdf"
                pdf.write_bytes(pdf_bytes(pages))
                yield pdf, None
            return fake

        target = "core.client.source_conversion_presentation.libreoffice_converted"
        with patch(target, converted(0, "missing")), self.assertRaises(AnalysisClientError) as caught:
            page_images.render(source, "slides", [1], self.out)
        self.assertEqual(caught.exception.code, "page_images_libreoffice_missing")
        # 숨긴 슬라이드가 빠지는 등 쪽 수가 다르면 번호가 어긋나므로 그리지 않는다.
        with patch(target, converted(2)), self.assertRaises(AnalysisClientError) as caught:
            page_images.render(source, "slides", [1], self.out)
        self.assertEqual(caught.exception.code, "page_images_slide_count_mismatch")
        with patch(target, converted(3)):
            images, omitted, method = page_images.render(source, "slides", [3], self.out)
        self.assertEqual(([image["location"] for image in images], omitted, method),
                         (["슬라이드 3"], [], "libreoffice_pdf+pdfium"))

    @unittest.skipUnless(__import__("core.client.source_conversion_presentation", fromlist=["_libreoffice"])._libreoffice(),
                         "LibreOffice is not installed")
    def test_real_libreoffice_keeps_hidden_slides_in_numbering(self):
        source = self.root / "deck.pptx"
        source.write_bytes(slides_package(3, hidden={2}))
        images, omitted, _ = page_images.render(source, "slides", [2, 3], self.out)
        self.assertEqual(([image["location"] for image in images], omitted), (["슬라이드 2", "슬라이드 3"], []))

    def test_fit_keeps_order_within_count_and_size_budget(self):
        images = [{"location": f"{n}쪽", "bytes": 1000} for n in range(1, 4)]
        with patch.object(page_images, "MAX_IMAGES", 2):
            chosen, omitted = page_images.fit(images, "prompt")
        self.assertEqual([image["location"] for image in chosen], ["1쪽", "2쪽"])
        self.assertEqual(omitted, [{"location": "3쪽", "reason": "image_count_limit"}])
        # 글이 Claude stdin 한도를 거의 채우면 그림을 붙이지 않는다.
        chosen, omitted = page_images.fit(images, "가" * 3_340_000)
        self.assertEqual((chosen, [item["reason"] for item in omitted]), ([], ["image_input_budget"] * 3))

    def test_guidance_goes_before_data_not_after(self):
        prompt = "지침\nSOURCE_LINE_REFERENCE\n{}\nPUBLISHED_RULES\n{}\nFIXED_INPUT_DATA\n{}"
        value = page_images.with_section(prompt, [{"location": "2쪽"}])
        self.assertLess(value.index("PAGE_IMAGES_ORDER"), value.index("\nSOURCE_LINE_REFERENCE\n"))
        self.assertTrue(value.endswith("\nFIXED_INPUT_DATA\n{}"))
        self.assertIn('[{"image": 1, "location": "2쪽"}]', value)


class PrepareTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.raw = pdf_bytes(3)
        self.source = {"source_id": "a" * 32, "source_version": "b" * 32,
                       "source_sha256": sha256(self.raw).hexdigest(), "size_bytes": len(self.raw)}
        self.requests = []

    def http(self, body):
        def handler(request):
            self.requests.append(str(request.url))
            return httpx2.Response(200, content=body)
        return httpx2.AsyncClient(transport=httpx2.MockTransport(handler), base_url="http://127.0.0.1:8766/")

    async def test_verified_original_becomes_images_and_is_removed(self):
        async with self.http(self.raw) as http:
            paths, audit = await page_images.prepare(http, tenant="team", source_ref=self.source,
                conversion={"warnings": [PDF_REVIEW]}, directory=self.root / "page-images", prompt="prompt")
        self.assertEqual(self.requests, [f"http://127.0.0.1:8766/api/v1/tenants/team/sources/{'a' * 32}/versions/{'b' * 32}/file"])
        self.assertEqual(audit["status"], "attached")
        self.assertEqual([item["location"] for item in audit["attached"]], ["2쪽"])
        self.assertEqual(audit["omitted"], [{"location": "5쪽", "reason": "page_out_of_range"}])
        self.assertEqual(len(paths), 1)
        self.assertFalse((self.root / "page-images" / "original").exists())

    async def test_hash_mismatch_or_no_candidates_keep_text_only(self):
        async with self.http(self.raw[:-1] + b"x") as http:
            paths, audit = await page_images.prepare(http, tenant="team", source_ref=self.source,
                conversion={"warnings": [PDF_REVIEW]}, directory=self.root / "bad", prompt="prompt")
        self.assertEqual((paths, audit["status"], audit["reason"]), ([], "not_attached", "source_hash_mismatch"))
        self.assertEqual(list((self.root / "bad").iterdir()), [])
        async with self.http(self.raw) as http:
            paths, audit = await page_images.prepare(http, tenant="team", source_ref=self.source,
                conversion={"warnings": []}, directory=self.root / "none", prompt="prompt")
        self.assertEqual((paths, audit["status"], len(self.requests)), ([], "not_needed", 1))
        self.assertFalse((self.root / "none").exists())

    async def test_cli_without_image_input_keeps_text_only_without_download(self):
        async def unavailable():
            return False
        async with self.http(self.raw) as http:
            paths, audit = await page_images.prepare(http, tenant="team", source_ref=self.source,
                conversion={"warnings": [PDF_REVIEW]}, directory=self.root / "old-cli", prompt="prompt",
                available=unavailable)
        self.assertEqual((paths, audit["status"], audit["reason"]), ([], "not_attached", "cli_without_image_input"))
        self.assertEqual((self.requests, audit["candidates"]), ([], ["2쪽", "5쪽"]))


class AdapterImageTests(unittest.IsolatedAsyncioTestCase):
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}

    async def asyncSetUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.image = png(self.root / "01-0002.png")

    async def test_claude_sends_one_stream_json_message_with_image_then_text(self):
        calls = []

        async def execute(arguments, **kwargs):
            calls.append((arguments, kwargs.get("prompt")))
            if "--help" in arguments:
                return 0, b"--input-format --output-format", b""
            kwargs["event_parser"](json.dumps({"type": "result", "subtype": "success", "is_error": False,
                                               "structured_output": {"ok": True}}), kwargs["on_event"])
            return 0, b"", b""
        adapter = ClaudeAdapter()
        adapter._capabilities = (["claude"], "isolated-fixture")
        with patch("core.client.ai.claude._execute", execute), patch("core.client.ai.claude.cli_command", return_value=["claude"]):
            result = await adapter.run(prompt="도식 확인", schema=self.schema, directory=self.root / "call",
                                       images=[self.image])
        arguments, stdin = calls[-1]
        self.assertEqual(arguments[arguments.index("--input-format") + 1], "stream-json")
        self.assertEqual(arguments[arguments.index("--tools") + 1], "")
        message = json.loads(stdin)
        content = message["message"]["content"]
        self.assertEqual([block["type"] for block in content], ["image", "text"])
        self.assertEqual(content[1]["text"], "도식 확인")
        self.assertEqual(result["execution"]["input_images"][0]["sha256"], sha256(self.image.read_bytes()).hexdigest())
        self.assertEqual(result["execution"]["prompt_transport"], "stream-json")

    async def test_claude_without_images_keeps_plain_stdin(self):
        calls = []

        async def execute(arguments, **kwargs):
            calls.append((arguments, kwargs.get("prompt")))
            kwargs["event_parser"](json.dumps({"type": "result", "subtype": "success", "is_error": False,
                                               "structured_output": {"ok": True}}), kwargs["on_event"])
            return 0, b"", b""
        adapter = ClaudeAdapter()
        adapter._capabilities = (["claude"], "isolated-fixture")
        with patch("core.client.ai.claude._execute", execute), patch("core.client.ai.claude.cli_command", return_value=["claude"]):
            result = await adapter.run(prompt="글만", schema=self.schema, directory=self.root / "plain")
        self.assertEqual(calls[0][1], "글만".encode())
        self.assertNotIn("--input-format", calls[0][0])
        self.assertNotIn("input_images", result["execution"])

    async def test_codex_attaches_image_files_and_keeps_view_image_disabled(self):
        calls = []

        async def execute(arguments, **kwargs):
            calls.append(arguments)
            if arguments[-1] == "--help":
                return 0, b"--image --sandbox", b""
            Path(kwargs["result_path"]).write_text('{"ok":true}', encoding="utf-8")
            return 0, b'{"type":"turn.completed"}', b""
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        with patch("core.client.ai.codex._execute", execute), patch("core.client.ai.codex.cli_command",
                                                                     return_value=["codex"]):
            result = await adapter.run(prompt="도식 확인", schema=self.schema, directory=self.root / "codex",
                                       images=[self.image])
        arguments = calls[-1]
        self.assertEqual(arguments[1:4], ["exec", "--image", str(self.image)])
        self.assertIn("view_image", arguments)
        self.assertEqual(arguments[-1], "-")
        self.assertEqual(result["execution"]["input_images"][0]["bytes"], self.image.stat().st_size)

    async def test_cli_without_image_flag_reports_unavailable_and_refuses_images(self):
        async def execute(arguments, **kwargs):
            return 0, b"--sandbox --json", b""
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        with patch("core.client.ai.codex._execute", execute), patch("core.client.ai.codex.cli_command",
                                                                     return_value=["codex"]):
            self.assertFalse(await adapter.image_input_available())
            with self.assertRaises(AIAdapterError) as caught:
                await adapter.run(prompt="x", schema=self.schema, directory=self.root / "old", images=[self.image])
        self.assertEqual(caught.exception.code, "ai_cli_incompatible")

    async def test_images_are_refused_for_resume_search_or_unknown_files(self):
        adapter = ClaudeAdapter()
        with self.assertRaises(AIAdapterError):
            await adapter.run(prompt="x", schema=self.schema, directory=self.root / "r", images=[self.image],
                              session_id="00000000-0000-0000-0000-000000000000")
        bad = self.root / "not-image.png"
        write_new(bad, b"plain text")
        with self.assertRaises(AIAdapterError) as caught:
            await CodexAdapter().run(prompt="x", schema=self.schema, directory=self.root / "u", images=[bad])
        self.assertEqual(caught.exception.code, "ai_invalid_input")


class ImageAdapter(DraftAdapter):
    supports_images = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.images = []

    async def image_input_available(self):
        return True

    async def run(self, *, prompt, schema, output_schema, directory, images=None):
        self.images.append(images)
        return await super().run(prompt=prompt, schema=schema, output_schema=output_schema, directory=directory)


class WorkflowImageTests(unittest.IsolatedAsyncioTestCase):
    setup_server = draft.DraftWorkflowTests.setup_server
    execute = draft.DraftWorkflowTests.execute
    graph_writes = draft.DraftWorkflowTests.graph_writes

    @isolated_server
    async def test_same_images_go_to_first_call_and_repair_and_are_recorded(self):
        calls = []

        async def prepare(http, *, tenant, source_ref, conversion, directory, prompt, available):
            self.assertTrue(await available())
            calls.append((tenant, source_ref["source_id"], conversion["method"]))
            private_directory(directory, exist_ok=False)
            image = png(directory / "01-0002.png")
            return [image], {**page_images.configuration(), "status": "attached", "candidates": ["2쪽"],
                             "attached": [{"location": "2쪽"}], "omitted": []}
        adapter = ImageAdapter(("invalid", "valid"))
        with patch.object(page_images, "prepare", prepare):
            await self.execute(adapter)
        self.assertEqual(len(calls), 1)
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(len({str(images[0]) for images in adapter.images}), 1)
        self.assertTrue(all("PAGE_IMAGES_ORDER" in prompt for prompt in adapter.prompts))
        self.assertTrue(all(prompt.index("PAGE_IMAGES_ORDER") < prompt.index("\nFIXED_INPUT_DATA\n")
                            for prompt in adapter.prompts))
        recorded = [json.loads(path.read_text()) for path in (self.root / "work").rglob("extract_ontology/assembly.json")]
        self.assertEqual(recorded[0]["page_images"]["status"], "attached")
        self.assertEqual(recorded[0]["page_images"]["prompt_sha256"], sha256(adapter.prompts[0].encode()).hexdigest())
        self.assertEqual(len(self.graph_writes()), 1)

    @isolated_server
    async def test_text_source_without_candidates_records_not_needed_and_sends_no_images(self):
        adapter = ImageAdapter()
        await self.execute(adapter)
        self.assertEqual(adapter.images, [None])
        recorded = [json.loads(path.read_text()) for path in (self.root / "work").rglob("extract_ontology/assembly.json")]
        self.assertEqual(recorded[0]["page_images"]["status"], "not_needed")

    @isolated_server
    async def test_adapter_without_image_support_is_unchanged(self):
        adapter = DraftAdapter()
        with patch.object(page_images, "prepare", side_effect=AssertionError("must not prepare")):
            await self.execute(adapter)
        recorded = [json.loads(path.read_text()) for path in (self.root / "work").rglob("extract_ontology/assembly.json")]
        self.assertNotIn("page_images", recorded[0])


if __name__ == "__main__":
    unittest.main()
