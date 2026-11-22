"""인증 API에서 실제 파일 업로드·판본·권한·렌더 경계를 검증한다."""

from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from core.modules.access.policy import AccessPolicy
from core.runtime.application import create_application
from core.tests.poc_access.fixtures import grant_test_membership
from tools.initialize_server import initialize_new_server


class TemplateHTTP(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        paths = initialize_new_server(Path(tmp.name).resolve() / "server")
        self.config = Path(paths["access_config"])
        self.policy = AccessPolicy(self.config, Path(paths["tenant_root"]))
        self.client = self.enterContext(TestClient(create_application(self.policy), base_url="http://127.0.0.1:8766"))
        response = self.client.post("/api/v1/auth/signup", json={"name": "템플릿 사용자"})
        self.assertEqual(response.status_code, 200, response.text)
        self.user = response.json()["data"]
        self.user = grant_test_membership(self.policy, self.user)
        self.headers = {"Authorization": "Bearer " + self.user["token"]}
        self.prefix = "/api/v1/tenants/" + self.user["default_tenant"] + "/templates"

    def create(self, *, filename="양식.txt", content=b"Title: {{title}}", request_id=None, instructions="정확히 작성하세요."):
        return self.client.post(self.prefix, headers=self.headers,
            data={"request_id": request_id or uuid4().hex, "name": "회사 양식", "instructions": instructions},
            files={"file": (filename, content, "application/octet-stream")})

    def update(self, original, **changes):
        values = {"request_id": uuid4().hex, "expected_revision": original["revision"],
                  "name": "새 양식", "instructions": "새 지침", **changes}
        # 파일 교체 없는 multipart도 경계가 유지되도록 모든 항목을 일반 form part로 만든다.
        return self.client.put(self.prefix + "/" + original["id"], headers=self.headers,
            files={key: (None, value) for key, value in values.items()})

    def test_upload_read_replay_edit_archive_and_previous_file(self):
        request_id = uuid4().hex
        response = self.create(request_id=request_id)
        self.assertEqual(response.status_code, 201, response.text)
        first = response.json()["data"]["template"]
        self.assertTrue(response.json()["data"]["generation"]["supported"])
        self.assertEqual(response.json()["data"]["access"]["user_id"], self.user["user_id"])
        replay = self.create(request_id=request_id)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["data"]["replayed"])
        changed_request = self.create(request_id=request_id, instructions="다른 입력")
        self.assertEqual(changed_request.status_code, 409, changed_request.text)
        listed = self.client.get(self.prefix, headers=self.headers).json()["data"]
        self.assertEqual(len(listed["items"]), 1)
        self.assertNotIn("instructions", listed["items"][0])
        updated = self.update(first)
        self.assertEqual(updated.status_code, 200, updated.text)
        second = updated.json()["data"]["template"]
        stale = self.update(first)
        self.assertEqual(stale.status_code, 409, stale.text)
        previous_path = self.prefix + "/" + first["id"] + "/versions/" + first["revision"]
        old = self.client.get(previous_path, headers=self.headers)
        self.assertEqual(old.json()["data"]["template"], first)
        file = self.client.get(previous_path + "/file", headers=self.headers)
        self.assertEqual(file.content, b"Title: {{title}}")
        self.assertEqual(file.headers["X-Content-SHA256"], sha256(file.content).hexdigest())
        self.assertEqual(file.headers["X-Template-Revision"], first["revision"])
        self.assertEqual(file.headers["Cache-Control"], "no-store")
        archived = self.client.post(self.prefix + "/" + first["id"] + "/archive", headers=self.headers,
            json={"request_id": uuid4().hex, "expected_revision": second["revision"]})
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertTrue(archived.json()["data"]["template"]["archived"])
        self.assertIn("generation", archived.json()["data"])
        self.assertEqual(self.client.get(self.prefix, headers=self.headers).json()["data"]["items"], [])
        self.assertEqual(self.client.get(previous_path + "/file", headers=self.headers).content, file.content)

    def test_unknown_format_can_be_registered_but_does_not_fake_generation(self):
        result = self.create(filename="양식.hwpx", content=b"opaque preserved file")
        self.assertEqual(result.status_code, 201, result.text)
        self.assertFalse(result.json()["data"]["generation"]["supported"])
        template = result.json()["data"]["template"]
        response = self.client.post(self.prefix + "/" + template["id"] + "/versions/" + template["revision"] + "/render",
            headers=self.headers, json={"content": "생성했다고 주장하는 텍스트"})
        self.assertEqual(response.status_code, 422, response.text)

    def test_render_applies_frozen_version_and_returns_actual_file(self):
        created = self.create().json()["data"]
        first = created["template"]
        field = created["generation"]["fields"][0]["id"]
        self.update(first)
        content = "작성했습니다.\n\n```wiki-template-result\n" + json.dumps({
            "version": 1, "replacements": [{"id": field, "text": "Title: 완성"}]}, ensure_ascii=False) + "\n```"
        path = self.prefix + "/" + first["id"] + "/versions/" + first["revision"] + "/render"
        response = self.client.post(path, headers=self.headers, json={"content": content})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, "Title: 완성".encode())
        self.assertEqual(response.headers["X-Template-Revision"], first["revision"])
        self.assertEqual(response.headers["X-Content-SHA256"], sha256(response.content).hexdigest())
        self.assertIn("filename*=UTF-8''", response.headers["Content-Disposition"])
        invalid = self.client.post(path, headers=self.headers, json={"content": content.replace(field, "unknown")})
        self.assertEqual(invalid.status_code, 422, invalid.text)

    def test_original_above_json_limit_is_streamed_without_truncation(self):
        original = b"original\x00" * (2 * 1024 * 1024)
        created = self.create(filename="large.bin", content=original)
        self.assertEqual(created.status_code, 201, created.text)
        first = created.json()["data"]["template"]
        response = self.client.get(self.prefix + "/" + first["id"] + "/versions/" + first["revision"] + "/file", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text[:100])
        self.assertEqual(response.content, original)
        self.assertEqual(int(response.headers["Content-Length"]), len(original))

    def test_read_only_permission_can_read_but_cannot_modify(self):
        first = self.create().json()["data"]["template"]
        config = json.loads(self.config.read_text())
        config["users"][self.user["user_id"]]["memberships"][self.user["default_tenant"]]["permissions"] = ["read"]
        self.config.write_text(json.dumps(config))
        self.assertEqual(self.client.get(self.prefix, headers=self.headers).status_code, 200)
        self.assertEqual(self.create().status_code, 403)
        self.assertEqual(self.update(first).status_code, 403)
        self.assertEqual(self.client.post(self.prefix + "/" + first["id"] + "/archive", headers=self.headers,
            json={"request_id": uuid4().hex, "expected_revision": first["revision"]}).status_code, 403)

    def test_duplicate_extra_incomplete_and_invalid_file_fields_are_rejected(self):
        normal = {"request_id": uuid4().hex, "name": "name", "instructions": ""}
        response = self.client.post(self.prefix, headers=self.headers, data={**normal, "actor": "other"},
            files={"file": ("x.txt", b"x")})
        self.assertEqual(response.status_code, 422, response.text)
        duplicate = [("request_id", (None, normal["request_id"])), ("name", (None, "one")),
            ("name", (None, "two")), ("instructions", (None, "")), ("file", ("x.txt", b"x"))]
        response = self.client.post(self.prefix, headers=self.headers, files=duplicate)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.create(filename="../x.txt").status_code, 422)
        self.assertEqual(self.create(content=b"").status_code, 413)
        boundary = b"--unfinished\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" + uuid4().hex.encode()
        response = self.client.post(self.prefix, headers={**self.headers, "Content-Type": "multipart/form-data; boundary=unfinished"}, content=boundary)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get(self.prefix, headers=self.headers).json()["data"]["items"], [])

    def test_oversized_stream_and_other_tenant_are_not_exposed(self):
        with patch("core.api.v1.templates.router.MAX_FILE_BYTES", 3):
            with patch("core.modules.templates.store.MAX_FILE_BYTES", 3):
                response = self.create(content=b"1234")
        self.assertEqual(response.status_code, 413, response.text)
        path = self.prefix.replace(self.user["default_tenant"], "not_allowed")
        self.assertEqual(self.client.get(path, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.get(self.prefix).status_code, 401)


if __name__ == "__main__":
    unittest.main()
