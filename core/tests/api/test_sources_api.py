"""임시 tenant에서 원본 수신·불변 판본·영수증·다운로드를 실제 HTTP로 검사한다."""

import asyncio
from contextlib import asynccontextmanager
from hashlib import sha256
import json
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2
from anyio import CapacityLimiter

from core.modules.sources.store import SourceStore
from core.modules.sources.contracts import SOURCE_MEDIA_TYPES
from core.paths import PROJECT_DIR
from core.tests.api import test_read_api as read_api_fixture


class SourceApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = read_api_fixture.ReadApiTests.save_policy
    snapshot = read_api_fixture.ReadApiTests.snapshot
    headers = read_api_fixture.ReadApiTests.headers
    client = read_api_fixture.ReadApiTests.client
    nothing = read_api_fixture.ReadApiTests.nothing

    def setUp(self):
        read_api_fixture.ReadApiTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "source_write"]
        self.tokens["reader"] = secrets.token_urlsafe(32)
        self.config["users"]["reader"] = {
            "token_sha256": sha256(self.tokens["reader"].encode()).hexdigest(),
            "memberships": {"alpha": {"permissions": ["read"], "profiles": ["all"], "default_profile": "all"}}}
        self.save_policy()
        self.base = "/api/v1/tenants/alpha"

    def payload(self, **kwargs):
        return {"request_id": uuid4().hex, "title": "원본 제목", "format": "txt", "content": "원문\r\n🌱", **kwargs}

    def value(self, response, status=200):
        self.assertEqual(response.status_code, status, response.text[:1000])
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        result = response.json()
        self.assertEqual(len(result["meta"]["trace_id"]), 32)
        self.assertNotIn(str(self.root), response.text)
        for token in self.tokens.values():
            self.assertNotIn(token, response.text)
        return result["data"] if status in {200, 201, 202} else result["error"]

    def file_url(self, value):
        return f"{self.base}/sources/{value['source_id']}/versions/{value['source_version']}/file"

    async def test_preview_profile_authorizes_before_storage_and_preserves_original(self):
        # 상세와 파일은 같은 허용 관점을 사용하고 금지 관점은 저장소를 열지 않는다.
        async with self.client() as http:
            created = self.value(await http.post(self.base + "/sources", json=self.payload()), 201)
            before = self.snapshot()
            detail_url = f"{self.base}/sources/{created['source_id']}"
            for profile in ("all", "business"):
                detail = self.value(await http.get(detail_url, params={"profile": profile}))
                self.assertEqual(detail["access"]["profile_id"], profile)
                original = await http.get(self.file_url(created), params={"profile": profile})
                self.assertEqual(original.status_code, 200)
                self.assertEqual(original.content, "원문\r\n🌱".encode())
            with patch.object(SourceStore, "__init__", side_effect=AssertionError("denied storage")):
                for url in (detail_url, self.file_url(created)):
                    self.value(await http.get(url, params={"profile": "business"}, headers=self.headers("reader")), 403)
                    self.value(await http.get(url, params={"profile": "unknown"}), 403)
            for url in (detail_url, self.file_url(created)):
                self.value(await http.get(url, params={"profile": "../bad"}), 403)
                self.value(await http.get(url, params={"path": "/etc/passwd"}), 422)
            self.assertEqual(self.snapshot(), before)

    async def test_json_registration_download_catalog_and_own_receipt_preserve_exact_utf8(self):
        body = self.payload()
        async with self.client() as http:
            created = self.value(await http.post(self.base + "/sources", json=body), 201)
            expected = body["content"].encode("utf-8")
            self.assertEqual(created["source_sha256"], sha256(expected).hexdigest())
            self.assertEqual(created["size_bytes"], len(expected))
            self.assertEqual(created["state"], "complete")
            self.assertFalse(created["replayed"])
            self.assertFalse(list(self.stores["alpha"].wiki_dir.iterdir()))
            downloaded = await http.get(self.file_url(created), headers=self.headers("reader"))
            self.assertEqual(downloaded.content, expected)
            self.assertEqual(downloaded.headers["x-source-sha256"], created["source_sha256"])
            self.assertEqual(downloaded.headers["x-content-type-options"], "nosniff")
            self.assertEqual(downloaded.headers["cache-control"], "no-store")
            listing = self.value(await http.get(self.base + "/sources"))
            self.assertEqual(len(listing["items"]), 1)
            self.assertTrue(listing["complete"])
            detail = self.value(await http.get(f"{self.base}/sources/{created['source_id']}"))
            self.assertEqual(detail["current_version"], created["source_version"])
            self.assertEqual(detail["documents"], [])
            receipt = self.value(await http.get(f"{self.base}/requests/{body['request_id']}"))
            self.assertEqual(receipt["source_id"], created["source_id"])
            self.assertEqual(receipt["receipt"], created["receipt"])
            self.value(await http.get(f"{self.base}/requests/{body['request_id']}", headers=self.headers("reader")), 404)

    async def test_multipart_exact_bytes_unicode_filename_and_registered_old_versions(self):
        async with self.client() as http:
            old_bytes = "# 원문\r\n항목 🌱\r\n".encode()
            created = self.value(await http.post(self.base + "/sources", data={
                "request_id": uuid4().hex, "title": "파일 원본"}, files={"file": ("원본 문서.md", old_bytes, "text/markdown")}), 201)
            source_id = created["source_id"]
            changed = self.value(await http.post(f"{self.base}/sources/{source_id}/versions", data={
                "request_id": uuid4().hex, "title": "새 판본", "expected_registration_revision": created["registration_revision"]},
                files={"file": ("원본 문서.md", b"new bytes\n", "text/markdown")}), 201)
            self.assertNotEqual(changed["source_version"], created["source_version"])
            self.assertEqual(changed["source_id"], source_id)
            old = await http.get(self.file_url(created))
            self.assertEqual(old.content, old_bytes)
            self.assertIn("filename*=UTF-8''", old.headers["content-disposition"])
            self.assertEqual((await http.get(self.file_url(changed))).content, b"new bytes\n")
            self.value(await http.post(f"{self.base}/sources/{source_id}/versions", json=self.payload(
                expected_registration_revision=created["registration_revision"])), 409)
            detail = self.value(await http.get(f"{self.base}/sources/{source_id}"))
            self.assertEqual(len(detail["versions"]), 2)

    async def test_same_request_replay_conflicting_payload_and_revoked_source_write(self):
        body = self.payload()
        async with self.client() as http:
            created = self.value(await http.post(self.base + "/sources", json=body), 201)
            before = self.snapshot()
            replayed = self.value(await http.post(self.base + "/sources", json=body))
            self.assertTrue(replayed["replayed"])
            self.assertEqual(replayed["source_id"], created["source_id"])
            self.assertEqual(self.snapshot(), before)
            self.value(await http.post(self.base + "/sources", json={**body, "content": "different"}), 409)
            self.assertEqual(self.snapshot(), before)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.value(await http.post(self.base + "/sources", json=body), 403)
            self.value(await http.get(f"{self.base}/requests/{body['request_id']}"))

    async def test_tenant_and_permission_denial_precedes_storage_and_staging(self):
        async with self.client() as http:
            with patch.object(SourceStore, "__init__", side_effect=AssertionError("denied storage")):
                self.value(await http.post(self.base + "/sources", json=self.payload(), headers=self.headers("reader")), 403)
                self.value(await http.post("/api/v1/tenants/beta/sources", json=self.payload()), 403)
            with patch.object(SourceStore, "stage", side_effect=AssertionError("must not receive bytes")):
                self.value(await http.post(self.base + "/sources", json=self.payload(), headers={"Authorization": "Bearer invalid"}), 401)

    async def test_source_write_is_rechecked_after_receiving_upload_before_publish(self):
        actual_stage = SourceStore.stage
        def stage_and_revoke(store, *args, **kwargs):
            staged = actual_stage(store, *args, **kwargs)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            return staged
        async with self.client() as http, self.patch_stage(stage_and_revoke):
            self.value(await http.post(self.base + "/sources", json=self.payload()), 403)
        root = self.stores["alpha"].data_dir
        self.assertFalse(any((root / "_sources").rglob("original")))
        self.assertFalse(any((root / "_incoming").iterdir()))

    @asynccontextmanager
    async def patch_stage(self, function):
        with patch.object(SourceStore, "stage", function):
            yield

    async def test_media_fields_json_duplicates_paths_and_actual_raw_byte_limit(self):
        async with self.client() as http:
            self.value(await http.post(self.base + "/sources", content=b"abc", headers={"Content-Type": "text/plain"}), 415)
            self.value(await http.post(self.base + "/sources", json={**self.payload(), "actor": "fake"}), 422)
            self.value(await http.post(self.base + "/sources", json=self.payload(content=12)), 422)
            duplicate = json.dumps(self.payload())[:-1] + ', "title": "duplicate"}'
            self.value(await http.post(self.base + "/sources", content=duplicate, headers={"Content-Type": "application/json"}), 422)
            self.value(await http.post(self.base + "/sources", content=json.dumps(self.payload(content="\ud800")),
                headers={"Content-Type": "application/json"}), 422)
            for filename, expected in (("../path.txt", 422), ("C:\\folder\\path.txt", 422), ("source.pdf", 415)):
                self.value(await http.post(self.base + "/sources", data={"request_id": uuid4().hex, "title": "file"},
                    files={"file": (filename, b"text", "application/octet-stream")}), expected)
            self.value(await http.post(self.base + "/sources", data={"request_id": uuid4().hex, "title": "file"},
                files={"file": ("source.txt", b"\xff\xfe", "text/plain")}), 422)
            self.value(await http.post(self.base + "/sources?user_id=reader", json=self.payload()), 422)
            self.value(await http.get(self.base + "/sources?limit=1.0"), 422)
            schema = (await http.get("/openapi.json")).json()
            endpoint = schema["paths"]["/api/v1/tenants/{tenant}/sources"]
            self.assertEqual(set(endpoint["post"]["requestBody"]["content"]), {"application/json", "multipart/form-data"})
            download = schema["paths"]["/api/v1/tenants/{tenant}/sources/{source_id}/versions/{source_version}/file"]["get"]
            self.assertEqual(set(download["responses"]["200"]["content"]), set(SOURCE_MEDIA_TYPES.values()))
            with patch("core.api.v1.sources.ingress.MAX_UPLOAD_REQUEST_BYTES", 32):
                self.value(await http.post(self.base + "/sources", json=self.payload(content="x" * 40)), 413)

    async def test_truncated_duplicate_or_excess_multipart_fields_are_rejected(self):
        async with self.client() as http:
            content = (b"--BOUND\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" + uuid4().hex.encode() +
                b"\r\n--BOUND\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\ntitle\r\n--BOUND\r\n"
                b"Content-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\n\r\nsource\r\n--BOUND\r\n")
            self.value(await http.post(self.base + "/sources", content=content,
                headers={"Content-Type": "multipart/form-data; boundary=BOUND"}), 422)
            self.value(await http.post(self.base + "/sources", files=[
                ("request_id", (None, uuid4().hex)), ("title", (None, "one")),
                ("title", (None, "two")), ("file", ("test.txt", b"text", "text/plain"))]), 422)

    async def test_download_stream_is_not_subject_to_json_response_budget(self):
        async with self.client() as http:
            created = self.value(await http.post(self.base + "/sources", json=self.payload(content="a" * 8192)), 201)
            with patch("core.api.limits.MAX_RESPONSE_BYTES", 1024):
                response = await http.get(self.file_url(created))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, b"a" * 8192)
            self.value(await http.get(self.file_url(created) + "?path=/etc/passwd"), 422)
            self.value(await http.get(self.file_url(created).replace("alpha", "beta")), 403)

    async def test_real_twenty_mib_original_and_twenty_four_mib_transport_boundaries(self):
        boundary = 20 * 1024 * 1024
        raw = b"a" * boundary
        async with self.client() as http:
            created = self.value(await http.post(self.base + "/sources", data={
                "request_id": uuid4().hex, "title": "20MiB boundary"}, files={"file": ("full.txt", raw, "text/plain")}), 201)
            self.assertEqual(created["size_bytes"], boundary)
            downloaded = await http.get(self.file_url(created))
            self.assertEqual(downloaded.status_code, 200)
            self.assertEqual(len(downloaded.content), boundary)
            self.assertEqual(sha256(downloaded.content).hexdigest(), created["source_sha256"])
            self.value(await http.post(self.base + "/sources", data={
                "request_id": uuid4().hex, "title": "oversized original"},
                files={"file": ("large.txt", raw + b"x", "text/plain")}), 413)
            async def too_many_bytes():
                for _ in range(384):
                    yield b"x" * 65536
                yield b"x"
            self.value(await http.post(self.base + "/sources", content=too_many_bytes(),
                headers={"Content-Type": "application/json"}), 413)
            listing = self.value(await http.get(self.base + "/sources"))
            self.assertEqual(len(listing["items"]), 1)

    async def test_upload_capacity_is_bounded_and_released_after_input_failure(self):
        self.app.state.upload_limiter = limiter = CapacityLimiter(1)
        borrower = object()
        await limiter.acquire_on_behalf_of(borrower)
        async with self.client() as http:
            with patch("core.api.v1.sources.router.UPLOAD_WAIT_SECONDS", 0.01), \
                    patch.object(SourceStore, "stage", side_effect=AssertionError("busy upload cannot stage")):
                error = self.value(await http.post(self.base + "/sources", json=self.payload()), 503)
                self.assertEqual((error["code"], error["retry"]), ("upload_busy", "same_basis"))
            limiter.release_on_behalf_of(borrower)
            self.value(await http.post(self.base + "/sources", content=b"invalid", headers={"Content-Type": "application/json"}), 422)
            self.assertEqual(limiter.borrowed_tokens, 0)
            self.value(await http.post(self.base + "/sources", json=self.payload()), 201)
            self.assertEqual(limiter.borrowed_tokens, 0)

    async def test_invalid_input_preserves_separate_staging_cleanup_warning(self):
        error = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid source input")
        error.cleanup_failures = [{"path": "_incoming/own-temp", "error_type": "PermissionError", "errno": 13}]
        async with self.client() as http, self.patch_stage(lambda *args, **kwargs: (_ for _ in ()).throw(error)):
            value = self.value(await http.post(self.base + "/sources", json=self.payload()), 422)
            self.assertEqual(value["details"]["cleanup_failures"], error.cleanup_failures)

    async def test_direct_task_cancel_waits_for_stage_and_cleans_before_releasing_capacity(self):
        actual_stage = SourceStore.stage
        created, release = threading.Event(), threading.Event()
        def delayed_stage(store, *args, **kwargs):
            staged = actual_stage(store, *args, **kwargs)
            created.set()
            release.wait(5)
            return staged
        async with self.client() as http:
            with patch.object(SourceStore, "stage", delayed_stage):
                task = asyncio.create_task(http.post(self.base + "/sources", json=self.payload()))
                try:
                    for _ in range(200):
                        if created.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(created.is_set())
                    task.cancel()
                    await asyncio.sleep(0.01)
                    task.cancel()
                    self.assertFalse(task.done())
                    self.assertEqual(self.app.state.upload_limiter.borrowed_tokens, 1)
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(self.app.state.upload_limiter.borrowed_tokens, 0)
            root = self.stores["alpha"].data_dir
            self.assertEqual(list((root / "_incoming").iterdir()), [])
            self.assertFalse(any((root / "_sources").rglob("original")))

    async def test_direct_task_cancel_after_commit_preserves_original_and_receipt(self):
        actual_commit = SourceStore.commit
        committed, release = threading.Event(), threading.Event()
        body = self.payload()
        def delayed_commit(store, *args, **kwargs):
            result = actual_commit(store, *args, **kwargs)
            committed.set()
            release.wait(5)
            return result
        async with self.client() as http:
            with patch.object(SourceStore, "commit", delayed_commit):
                task = asyncio.create_task(http.post(self.base + "/sources", json=body))
                try:
                    for _ in range(200):
                        if committed.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(committed.is_set())
                    task.cancel()
                    await asyncio.sleep(0.01)
                    self.assertFalse(task.done())
                    self.assertEqual(self.app.state.upload_limiter.borrowed_tokens, 1)
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(self.app.state.upload_limiter.borrowed_tokens, 0)
            receipt = self.value(await http.get(f"{self.base}/requests/{body['request_id']}"))
            self.assertEqual(receipt["state"], "complete")
            self.assertEqual((await http.get(self.file_url(receipt))).content, body["content"].encode())
            self.assertEqual(list((self.stores["alpha"].data_dir / "_incoming").iterdir()), [])

    async def test_actual_loopback_chunked_multipart_and_download(self):
        from core.tests.modules.test_source_formats import docx_bytes, png_bytes
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config_path), "--tenant-root", str(self.tenant_root), "--port", str(port),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            async with httpx2.AsyncClient(base_url=f"http://127.0.0.1:{port}", headers=self.headers(), trust_env=False, timeout=10) as http:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        if (await http.get("/api/v1/access-context")).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if process.returncode is not None or time.monotonic() > deadline:
                        self.fail("The isolated source HTTP process did not start.")
                    await asyncio.sleep(0.05)
                for extension, raw in (("txt", "chunked 원문\r\n🌱".encode()), ("docx", docx_bytes()), ("png", png_bytes())):
                    request = uuid4().hex
                    data = (b"--BOUND\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" + request.encode() +
                        b"\r\n--BOUND\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nchunked\r\n--BOUND\r\n"
                        b"Content-Disposition: form-data; name=\"file\"; filename=\"test." + extension.encode() +
                        b"\"\r\nContent-Type: application/octet-stream\r\n\r\n" + raw + b"\r\n--BOUND--\r\n")
                    async def chunks():
                        for position in range(0, len(data), 13):
                            yield data[position:position + 13]
                    created = self.value(await http.post(self.base + "/sources", content=chunks(),
                        headers={"Content-Type": "multipart/form-data; boundary=BOUND"}), 201)
                    downloaded = await http.get(self.file_url(created))
                    self.assertEqual(downloaded.content, raw)
                    self.assertTrue(downloaded.headers["content-type"].startswith(SOURCE_MEDIA_TYPES[extension]))
                    self.assertEqual(created["source_sha256"], sha256(raw).hexdigest())
                    receipt = self.value(await http.get(self.base + "/requests/" + request))
                    self.assertEqual(receipt["receipt"], created["receipt"])
        finally:
            if process.returncode is None:
                process.terminate()
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            self.assertEqual(stdout, b"")
            for token in self.tokens.values():
                self.assertNotIn(token.encode(), stderr)


if __name__ == "__main__":
    unittest.main()
