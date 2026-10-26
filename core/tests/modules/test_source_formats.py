"""DOCX/이미지 식별과 불변 보관 경계. 의미/렌더러 검증은 수행하지 않는다."""

from base64 import b64decode
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import struct
import unittest
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import zlib

from core.modules.sources import contracts, formats
from core.modules.sources.contracts import SourceConflictError, SourceTooLargeError, UnsupportedSourceError
from core.tests.modules import test_sources as fixture


def docx_bytes(text="원문", *, content_type=formats.DOCX_CONTENT_TYPE, extra=None):
    stream = BytesIO()
    with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
        def write(name, value):
            info = ZipInfo(name)
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, value)
        write("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            f'<Override PartName="/word/document.xml" ContentType="{content_type}"/></Types>')
        write("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        write("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
        if extra:
            write(*extra)
    return stream.getvalue()


def png_bytes():
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b"")


def signature_samples():
    # Pillow로 생성한 1x1 이미지 fixture를 고정해 저장 검사 자체는 디코더에 의존하지 않는다.
    samples = {"docx": docx_bytes(), "png": png_bytes()}
    samples["jpg"] = b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z")
    samples["gif"] = b64decode("R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==")
    samples["webp"] = b64decode("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=")
    samples["bmp"] = b64decode("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAADEDgAAxA4AAAAAAAAAAAAA////AA==")
    samples["tif"] = b64decode("SUkqAAgAAAAKAAABBAABAAAAAQAAAAEBBAABAAAAAQAAAAIBAwADAAAAhgAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAAjAAAABUBAwABAAAAAwAAABYBBAABAAAAAQAAABcBBAABAAAAAwAAABwBAwABAAAAAQAAAAAAAAAIAAgACAD///8=")
    samples["jpeg"] = samples["jpg"]
    samples["tiff"] = samples["tif"]
    return samples

class SourceFormatTests(unittest.TestCase):
    setUp = fixture.SourceStorageTests.setUp
    snapshot = fixture.SourceStorageTests.snapshot

    def save(self, raw, format="docx", *, request_id=None, **kwargs):
        staged = self.sources.stage(BytesIO(raw), kind="file", title="원본", format=format, filename="원본." + format)
        return self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=request_id or uuid4().hex,
            authorize=lambda: self.actor, **kwargs)

    def test_all_new_signatures_preserve_exact_bytes_hash_and_metadata(self):
        for format, raw in signature_samples().items():
            with self.subTest(format=format):
                result = self.save(raw, format)
                stream, manifest = self.sources.open_original(result["source_id"], result["source_version"])
                with stream:
                    self.assertEqual(stream.read(), raw)
                self.assertEqual(manifest["format"], format)
                self.assertEqual(result["source_sha256"], sha256(raw).hexdigest())
                self.assertEqual(result["size_bytes"], len(raw))
                self.assertEqual(result["receipt"]["analysis_status"], "not_started")

    def test_mismatched_empty_truncated_signatures_never_publish(self):
        for format in signature_samples():
            for raw in (b"", b"not this format", b"\x89P", b"PK\x03\x04"):
                with self.subTest(format=format, raw=raw), self.assertRaises(UnsupportedSourceError):
                    self.save(raw, format)
        self.assertFalse(self.sources.sources_dir.exists())
        self.assertEqual(list((self.root / "_incoming").iterdir()), [])

    def test_docx_rejects_zip_xlsx_macro_type_and_bounded_package_metadata(self):
        workbook = BytesIO()
        with ZipFile(workbook, "w") as archive:
            archive.writestr("xl/workbook.xml", "<workbook/>")
        cases = [workbook.getvalue(), docx_bytes(content_type="application/vnd.ms-word.document.macroEnabled.main+xml"), docx_bytes()[:-16]]
        for raw in cases:
            with self.assertRaises(UnsupportedSourceError):
                self.save(raw)
        with patch.object(formats, "MAX_CONTENT_TYPES_BYTES", 32), self.assertRaises(UnsupportedSourceError):
            self.save(docx_bytes())
        with patch.object(formats, "MAX_DOCX_ENTRIES", 2), self.assertRaises(UnsupportedSourceError):
            self.save(docx_bytes())
        self.assertFalse(self.sources.sources_dir.exists())

    def test_docx_doctype_and_corrupt_metadata_are_rejected_without_extraction(self):
        for metadata in ('<!DOCTYPE Types [<!ENTITY x "expanded">]><Types>&x;</Types>', '<Types'):
            stream = BytesIO()
            with ZipFile(stream, "w") as archive:
                archive.writestr("[Content_Types].xml", metadata)
                archive.writestr("word/document.xml", "<document/>")
                archive.writestr("_rels/.rels", "<Relationships/>")
            with self.assertRaises(UnsupportedSourceError):
                self.save(stream.getvalue())
        # 원본 속 경로도 추출하지 않으며 서버 밖 파일을 만들지 않는다.
        raw = docx_bytes(extra=("../../never-extract.txt", "untrusted original bytes"))
        self.save(raw)
        self.assertEqual(len(list(self.sources.sources_dir.rglob("original"))), 1)
        self.assertFalse((self.root / "never-extract.txt").exists())

    def test_binary_direct_input_and_unsafe_or_mismatched_display_names(self):
        for format, raw in signature_samples().items():
            with self.assertRaises(UnsupportedSourceError):
                self.sources.stage(BytesIO(raw), kind="text", title="원본", format=format)
            for name in ("../file." + format, "C:\\file." + format, "x\x00." + format, "file.txt"):
                with self.assertRaises(UnsupportedSourceError):
                    self.sources.stage(BytesIO(raw), kind="file", title="원본", format=format, filename=name)
        self.assertFalse((self.root / "_incoming").exists())

    def test_new_version_conflict_and_concurrent_replay_preserve_previous_bytes(self):
        raw = docx_bytes("첫 판본")
        first = self.save(raw)
        request = uuid4().hex
        next_raw = docx_bytes("새 판본")
        args = {"request_id": request, "source_id": first["source_id"], "expected_registration_revision": first["registration_revision"]}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.save(next_raw, **args), range(2)))
        self.assertEqual(results[0]["source_version"], results[1]["source_version"])
        self.assertEqual(sorted(item["replayed"] for item in results), [False, True])
        before = self.snapshot()
        with self.assertRaises(SourceConflictError):
            self.save(docx_bytes("오래된 기준"), **{**args, "request_id": uuid4().hex})
        self.assertEqual(self.snapshot(), before)
        stream, _ = self.sources.open_original(first["source_id"], first["source_version"])
        with stream:
            self.assertEqual(stream.read(), raw)

    def test_docx_and_image_byte_limits_never_truncate_or_replace_originals(self):
        for format in ("docx", "png"):
            raw = signature_samples()[format]
            with patch.object(contracts, "MAX_SOURCE_BYTES", len(raw)):
                self.save(raw, format)
                before = self.snapshot()
                with self.assertRaises(SourceTooLargeError):
                    self.save(raw + b"x", format)
                self.assertEqual(self.snapshot(), before)

    def test_image_catalog_failure_and_docx_receipt_failure_keep_originals(self):
        raw = png_bytes()
        request = uuid4().hex
        with patch.object(self.sources, "_write_catalog", side_effect=OSError("injected")):
            pending = self.save(raw, "png", request_id=request)
        self.assertEqual(pending["state"], "pending_reconcile")
        before = self.snapshot()
        self.assertEqual(self.save(raw, "png", request_id=request)["source_version"], pending["source_version"])
        self.assertEqual(self.snapshot(), before)
        original_write = self.sources._write_request
        def fail_receipt(path, record):
            if record["state"] == "complete":
                raise OSError("injected")
            original_write(path, record)
        request = uuid4().hex
        with patch.object(self.sources, "_write_request", fail_receipt):
            result = self.save(docx_bytes(), request_id=request)
        self.assertEqual(result["state"], "pending_reconcile")
        before = self.snapshot()
        confirmed = self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=request)
        self.assertEqual(confirmed["state"], "complete")
        self.assertEqual(confirmed["receipt"]["confirmation"], "intent_manifest_catalog")
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
