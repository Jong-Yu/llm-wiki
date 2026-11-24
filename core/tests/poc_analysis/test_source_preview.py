"""격리 원본의 페이지 표시·고정 근거·권한·렌더러 실패를 확인한다."""

from io import BytesIO
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2
from PIL import Image
from pypdf import PdfWriter

from core.api.v1.source_previews import render
from core.api.dependencies import access_value
from core.modules.access.auth import initialize_auth
from core.modules.access.policy import AccessPolicy, AccessDenied
from core.modules.sources.store import SourceStore
from core.runtime.application import create_application
from core.tests.poc_access.fixtures import grant_test_membership


class SourcePreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        (root / "data").mkdir()
        (root / "tenancy").mkdir()
        config = root / "tenancy/policy.json"
        config.write_text(json.dumps(dict(version=1, tenants={}, users={})))
        self.policy = AccessPolicy(config, root / "data")
        auth = initialize_auth(self.policy)
        self.user = grant_test_membership(self.policy, auth.signup("미리보기 검사"))
        self.tenant = self.user["default_tenant"]
        scope = self.policy.authorize(self.user["token"], self.tenant, "source_write")
        self.sources = SourceStore(scope.store)
        original = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=1200, height=900)
        writer.add_blank_page(width=300, height=200).rotate(90)
        writer.write(original)
        original.seek(0)
        staged = self.sources.stage(original, kind="file", title="검사 PDF", format="pdf", filename="test.pdf")
        receipt = self.sources.commit(staged, tenant=self.tenant, user_id=self.user["user_id"],
                                      request_id=uuid4().hex, authorize=lambda: access_value(scope))["receipt"]
        catalog = self.sources.get_source(receipt["source_id"])
        self.source = catalog["versions"][-1]
        self.query = dict(source_sha256=self.source["source_sha256"],
                          registration_revision=catalog["registration_revision"])
        self.endpoint = (f'/api/v1/tenants/{self.tenant}/sources/{self.source["source_id"]}'
                         f'/versions/{self.source["source_version"]}/pages/')
        self.app = create_application(self.policy, auth=auth)
        self.http = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app), base_url="http://127.0.0.1:8766",
            headers={"Authorization": "Bearer " + self.user["token"]})
        self.addAsyncCleanup(self.http.aclose)

    async def test_real_page_bounded_rotated_and_original_unchanged(self):
        before, _ = self.sources.open_original(self.source["source_id"], self.source["source_version"])
        with before:
            original = before.read()
        for page, size in ((1, (1600, 1200)), (2, (400, 600))):
            response = await self.http.get(self.endpoint + str(page), params=self.query)
            self.assertEqual(response.status_code, 200, response.text[:200] if response.status_code != 200 else "")
            self.assertEqual(response.headers["x-source-sha256"], self.source["source_sha256"])
            self.assertEqual(response.headers["x-source-page"], str(page))
            self.assertEqual(response.headers["cache-control"], "no-store")
            with Image.open(BytesIO(response.content)) as image:
                self.assertEqual(image.size, size)
        after, _ = self.sources.open_original(self.source["source_id"], self.source["source_version"])
        with after:
            self.assertEqual(after.read(), original)

    async def test_wrong_fixed_basis_and_invalid_page(self):
        for field in ("source_sha256", "registration_revision"):
            response = await self.http.get(self.endpoint + "1", params={**self.query, field: "0" * 64})
            self.assertEqual(response.status_code, 409)
        response = await self.http.get(self.endpoint + "3", params=self.query)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "source_page_not_found")

    async def test_auth_denied_before_and_after_render(self):
        response = await self.http.get(self.endpoint + "1", params=self.query, headers={"Authorization": "Bearer " + "a" * 64})
        self.assertIn(response.status_code, (401, 403))
        with patch("core.api.v1.source_previews.router.reauthorize", side_effect=AccessDenied()), \
             patch("core.api.v1.source_previews.router.render_page", return_value=b"hidden"):
            response = await self.http.get(self.endpoint + "1", params=self.query)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(b"hidden", response.content)

    async def test_busy_and_timeout_release_capacity(self):
        render._capacity.acquire()
        try:
            response = await self.http.get(self.endpoint + "1", params=self.query)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["error"]["code"], "source_preview_busy")
        finally:
            render._capacity.release()
        with patch.object(render.subprocess, "run", side_effect=subprocess.TimeoutExpired("preview", 20)):
            response = await self.http.get(self.endpoint + "1", params=self.query)
        self.assertEqual(response.json()["error"]["code"], "source_preview_timeout")
        self.assertTrue(render._capacity.acquire(blocking=False))
        render._capacity.release()
