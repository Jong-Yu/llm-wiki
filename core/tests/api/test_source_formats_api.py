"""DOCX/이미지 API와 개인 변환 보고 연결. 격리 ASGI/실제 저장소 검사."""

import asyncio
from hashlib import sha256
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.sources.store import SourceStore
from core.modules.sources.contracts import SOURCE_MEDIA_TYPES
from core.tests.api import test_sources_api as fixture
from core.tests.modules.test_source_formats import docx_bytes, png_bytes, signature_samples


class SourceFormatApiTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.SourceApiTests.setUp
    save_policy = fixture.SourceApiTests.save_policy
    snapshot = fixture.SourceApiTests.snapshot
    headers = fixture.SourceApiTests.headers
    client = fixture.SourceApiTests.client
    nothing = fixture.SourceApiTests.nothing
    value = fixture.SourceApiTests.value
    file_url = fixture.SourceApiTests.file_url

    async def upload(self, http, raw, filename, *, request_id=None, url=None, expected=None):
        data = {"request_id": request_id or uuid4().hex, "title": "보존 원본"}
        if expected:
            data["expected_registration_revision"] = expected
        return await http.post(url or self.base + "/sources", data=data, files={"file": (filename, raw, "text/plain")})

    async def test_supported_upload_download_mime_hash_catalog_and_own_receipt(self):
        async with self.client() as http:
            for format, raw in signature_samples().items():
                with self.subTest(format=format):
                    request = uuid4().hex
                    result = self.value(await self.upload(http, raw, "한글 원본." + format.upper(), request_id=request), 201)
                    downloaded = await http.get(self.file_url(result))
                    self.assertEqual(downloaded.content, raw)
                    self.assertEqual(downloaded.headers["content-type"], SOURCE_MEDIA_TYPES[format])
                    self.assertEqual(downloaded.headers["x-source-sha256"], sha256(raw).hexdigest())
                    self.assertEqual(downloaded.headers["content-length"], str(len(raw)))
                    self.assertEqual(downloaded.headers["x-content-type-options"], "nosniff")
                    self.assertIn("attachment;", downloaded.headers["content-disposition"])
                    receipt = self.value(await http.get(self.base + "/requests/" + request))
                    self.assertEqual(receipt["receipt"], result["receipt"])
                    self.value(await http.get(self.base + "/requests/" + request, headers=self.headers("reader")), 404)
                    detail = self.value(await http.get(self.base + "/sources/" + result["source_id"]))
                    self.assertEqual(detail["versions"][0]["format"], format)
            listing = self.value(await http.get(self.base + "/documents"))
            self.assertEqual(len(listing["items"]), len(signature_samples()))

    async def test_invalid_signatures_names_direct_binary_and_replay(self):
        async with self.client() as http:
            for name, raw, status in (("a.docx", b"PK\x03\x04fake", 415), ("a.png", docx_bytes(), 415),
                    ("a.doc", b"unsupported", 415), ("a.svg", b"<svg/>", 415), ("../a.docx", docx_bytes(), 422)):
                self.value(await self.upload(http, raw, name), status)
            self.value(await http.post(self.base + "/sources", json={"request_id": uuid4().hex, "title": "binary", "format": "png", "content": "binary"}), 422)
            request = uuid4().hex
            created = self.value(await self.upload(http, docx_bytes(), "a.docx", request_id=request), 201)
            before = self.snapshot()
            replay = self.value(await self.upload(http, docx_bytes(), "a.docx", request_id=request))
            self.assertEqual(replay["receipt"], created["receipt"])
            self.assertTrue(replay["replayed"])
            self.value(await self.upload(http, docx_bytes("changed"), "a.docx", request_id=request), 409)
            self.assertEqual(self.snapshot(), before)

    async def test_new_binary_version_and_current_profile_permission_checks(self):
        async with self.client() as http:
            first = self.value(await self.upload(http, png_bytes(), "a.png"), 201)
            url = self.base + "/sources/" + first["source_id"] + "/versions"
            second = self.value(await self.upload(http, docx_bytes(), "a.docx", url=url, expected=first["registration_revision"]), 201)
            self.value(await self.upload(http, png_bytes(), "a.png", url=url, expected=first["registration_revision"]), 409)
            self.assertEqual((await http.get(self.file_url(first))).content, png_bytes())
            self.assertEqual((await http.get(self.file_url(second))).content, docx_bytes())
            with patch.object(SourceStore, "__init__", side_effect=AssertionError("denied storage")):
                self.value(await http.get(self.file_url(second), params={"profile": "business"}, headers=self.headers("reader")), 403)
            actual = SourceStore.stage
            def revoke(store, *args, **kwargs):
                staged = actual(store, *args, **kwargs)
                self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                self.save_policy()
                return staged
            with patch.object(SourceStore, "stage", revoke):
                self.value(await self.upload(http, docx_bytes(), "a.docx"), 403)
            self.assertEqual(len(list(self.stores["alpha"].data_dir.glob("_sources/*/*/original"))), 2)
            self.assertEqual(list((self.stores["alpha"].data_dir / "_incoming").iterdir()), [])
            self.config["users"]["alice"]["memberships"] = {}
            self.save_policy()
            self.value(await http.get(self.file_url(second)), 403)

    async def test_lost_upload_response_confirms_docx_with_own_receipt(self):
        committed, release = threading.Event(), threading.Event()
        actual = SourceStore.commit
        def delay(store, *args, **kwargs):
            result = actual(store, *args, **kwargs)
            committed.set()
            release.wait(5)
            return result
        request = uuid4().hex
        async with self.client() as http:
            with patch.object(SourceStore, "commit", delay):
                task = asyncio.create_task(self.upload(http, docx_bytes(), "a.docx", request_id=request))
                try:
                    for _ in range(200):
                        if committed.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(committed.is_set())
                    task.cancel()
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            result = self.value(await http.get(self.base + "/requests/" + request))
            self.assertEqual(result["state"], "complete")
            self.assertEqual((await http.get(self.file_url(result))).content, docx_bytes())
            self.assertEqual(len(list(self.stores["alpha"].data_dir.glob("_sources/*/*/original"))), 1)

    async def test_docx_paragraph_table_and_image_frame_reports_preserve_positions(self):
        async with self.client() as http:
            for format, raw, method, location in (("docx", docx_bytes(), "docx_text", {"kind": "paragraphs", "start": 1, "end": 1}),
                    ("docx", docx_bytes(), "docx_text", {"kind": "table_cells", "table": 1, "row": 2, "column": 3}),
                    ("png", png_bytes(), "ocr", {"kind": "pages", "start": 1, "end": 1})):
                source = self.value(await self.upload(http, raw, "original." + format), 201)
                reference = {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")}
                self.value(await http.post(self.base + "/analysis-jobs", json={"request_id": uuid4().hex,
                    **{key: source[key] for key in ("source_id", "source_version", "source_sha256")},
                    "expected_registration_revision": source["registration_revision"], "targets": ["binary.md"], "outputs": ["wiki"]}), 422)
                body = {"request_id": uuid4().hex, "source_ref": reference, "method": method,
                    "units": [{"unit_id": "unit1", "location": location, "content": "보고된 문자\r\n"}], "complete": True}
                report = self.value(await http.post(self.base + "/analysis-conversions", json=body), 201)
                manifest = report["manifest"]
                self.assertEqual(manifest["origin"], "client_reported")
                self.assertEqual(manifest["original_coverage"], "not_verified")
                self.assertEqual(manifest["semantic_validation"], "not_run")
                for key, value in location.items():
                    self.assertEqual(manifest["units"][0]["location"][key], value)
                plan = self.value(await http.post(self.base + "/analysis-plans", json={"request_id": uuid4().hex,
                    "source_ref": reference, "conversion_ref": {"conversion_id": manifest["id"], "conversion_revision": report["revision"]},
                    "outputs": [{"document": "result.md", "title": "결과", "purpose": "보고 범위", "outputs": ["wiki"], "locations": [location]}]}), 201)
                self.assertEqual(plan["components"]["output-0.txt"], "보고된 문자\r\n")
                before = self.snapshot()
                for changes in ({"method": "xlsx_values"}, {"units": [{"unit_id": "x", "location": {"kind": "cells", "sheet": "x", "cells": "A1"}, "content": "x"}]},
                        {"unread_ranges": ["not read"]}):
                    self.value(await http.post(self.base + "/analysis-conversions", json={**body, **changes, "request_id": uuid4().hex}), 422)
                self.assertEqual(self.snapshot(), before)
                partial = self.value(await http.post(self.base + "/analysis-conversions", json={**body, "request_id": uuid4().hex,
                    "complete": False, "unread_ranges": ["unread part"]}), 201)
                self.assertFalse(partial["manifest"]["complete"])
                self.assertEqual((await http.get(self.file_url(source))).content, raw)


if __name__ == "__main__":
    unittest.main()
