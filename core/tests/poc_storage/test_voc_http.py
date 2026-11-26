"""격리 서버에서 단방향 오류 보고의 인증·보존·실패 경계를 확인한다."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.modules.access.policy import AccessDenied, AccessPolicy
from core.modules.voc.store import save_report
from core.runtime.application import create_application
from tools.initialize_server import initialize_new_server


class VocHTTP(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        paths = initialize_new_server(Path(temporary.name).resolve() / "server")
        self.policy = AccessPolicy(paths["access_config"], paths["tenant_root"])
        self.root = self.policy.tenant_root
        self.directory = self.root / "voc"
        self.client = self.enterContext(TestClient(create_application(self.policy),
            base_url="http://127.0.0.1:8766", raise_server_exceptions=False))
        response = self.client.post("/api/v1/auth/signup", json={"name": "오류 보고 사용자"})
        self.assertEqual(response.status_code, 200, response.text)
        self.user = response.json()["data"]
        self.headers = {"Authorization": "Bearer " + self.user["token"]}

    def submit(self, content="문서 등록 중 오류가 발생했습니다."):
        return self.client.post("/api/v1/voc", headers=self.headers, json={"content": content})

    def test_authenticated_unassigned_user_can_report_text_without_changing_existing_files(self):
        self.assertEqual(self.user["memberships"], {})
        previous = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        content = "  한글 오류\n다음 줄과 공백을 보존합니다.  "
        response = self.submit(content)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        receipt = response.json()["data"]
        self.assertEqual(set(receipt), {"report_id", "created_at"})
        self.assertRegex(receipt["report_id"], r"^[0-9a-f]{32}$")
        self.assertIsNotNone(datetime.fromisoformat(receipt["created_at"]).tzinfo)
        path = self.directory / (receipt["report_id"] + ".json")
        stored = json.loads(path.read_text())
        self.assertEqual(stored, {"version": 1, **receipt,
            "user_id": self.user["user_id"], "content": content})
        self.assertNotIn(self.user["token"], path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.directory.glob(".pending-*")), [])
        for original, raw in previous.items():
            self.assertEqual(original.read_bytes(), raw)

    def test_unauthenticated_and_invalid_credentials_do_not_store(self):
        self.assertEqual(self.client.post("/api/v1/voc", json={"content": "오류"}).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/voc", json={"content": "오류"},
            headers={"Authorization": "Bearer " + "x" * 64}).status_code, 401)
        self.assertFalse(self.directory.exists())

    def test_blank_wrong_types_extra_fields_duplicate_keys_and_query_are_rejected(self):
        for value in ({}, {"content": ""}, {"content": " \n\t"}, {"content": 123},
                      {"content": "오류", "user_id": "other"}, {"content": "오류", "path": "../outside"}):
            with self.subTest(value=value):
                response = self.client.post("/api/v1/voc", headers=self.headers, json=value)
                self.assertEqual(response.status_code, 422, response.text)
        duplicate = self.client.post("/api/v1/voc", headers={**self.headers,
            "Content-Type": "application/json"}, content='{"content":"one","content":"two"}')
        self.assertEqual(duplicate.status_code, 422)
        self.assertEqual(self.client.post("/api/v1/voc?tenant=other", headers=self.headers,
            json={"content": "오류"}).status_code, 422)
        self.assertFalse(self.directory.exists())

    def test_media_type_and_actual_request_size_limit(self):
        response = self.client.post("/api/v1/voc", headers=self.headers, content="plain text")
        self.assertEqual(response.status_code, 415)
        self.assertEqual(self.submit("x" * (8 * 1024 * 1024)).status_code, 413)
        self.assertFalse(self.directory.exists())

    def test_no_report_read_list_update_or_delete_api(self):
        receipt = self.submit().json()["data"]
        for method in ("GET", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                result = self.client.request(method, "/api/v1/voc", headers=self.headers)
                self.assertEqual(result.status_code, 405, result.text)
        result = self.client.get("/api/v1/voc/" + receipt["report_id"], headers=self.headers)
        self.assertEqual(result.status_code, 404)

    def test_authentication_is_rechecked_immediately_before_publication(self):
        authenticate = self.policy.authenticate
        calls = 0

        def revoked(token):
            nonlocal calls
            calls += 1
            if calls >= 3:
                raise AccessDenied()
            return authenticate(token)

        with patch.object(self.policy, "authenticate", side_effect=revoked):
            response = self.submit()
        self.assertEqual(response.status_code, 403, response.text)
        self.assertGreaterEqual(calls, 3)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_symlink_storage_directory_is_rejected_without_writing_elsewhere(self):
        outside = self.root.parent / "outside"
        outside.mkdir()
        self.directory.symlink_to(outside, target_is_directory=True)
        response = self.submit()
        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertNotIn(str(outside), response.text)

    def test_write_failure_does_not_publish_partial_report(self):
        with patch("core.modules.voc.store.os.fsync", side_effect=OSError("private storage details")):
            response = self.submit()
        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertNotIn("private storage details", response.text)

    def test_concurrent_reports_are_independent_and_complete(self):
        def report(index):
            return save_report(self.root, user_id=self.user["user_id"],
                content=f"오류 {index}", before_commit=lambda: None)

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(report, range(24)))
        self.assertEqual(len({row["report_id"] for row in results}), 24)
        files = list(self.directory.iterdir())
        self.assertEqual(len(files), 24)
        self.assertEqual({json.loads(path.read_text())["content"] for path in files},
            {f"오류 {index}" for index in range(24)})

    def test_id_collision_preserves_existing_report(self):
        self.directory.mkdir()
        existing = self.directory / (("a" * 32) + ".json")
        existing.write_bytes(b"preserved existing file")
        with patch("core.modules.voc.store.uuid4", return_value=SimpleNamespace(hex="a" * 32)):
            with self.assertRaises(FileExistsError):
                save_report(self.root, user_id=self.user["user_id"], content="new",
                    before_commit=lambda: None)
        self.assertEqual(existing.read_bytes(), b"preserved existing file")
        self.assertEqual(list(self.directory.iterdir()), [existing])

    def test_cleanup_failure_keeps_success_and_published_file(self):
        with patch("core.modules.voc.store.os.unlink", side_effect=OSError("cleanup")):
            with self.assertLogs("core.modules.voc.store", level="WARNING") as logs:
                response = self.submit()
        self.assertEqual(response.status_code, 201, response.text)
        self.assertTrue(any("cleanup is pending" in message for message in logs.output))
        receipt = response.json()["data"]
        self.assertTrue((self.directory / (receipt["report_id"] + ".json")).is_file())

    def test_openapi_exposes_only_submission_and_exact_input(self):
        result = self.client.get("/openapi.json", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        schema = result.json()
        self.assertEqual(set(schema["paths"]["/api/v1/voc"]), {"post"})
        reference = schema["paths"]["/api/v1/voc"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        request = schema["components"]["schemas"][reference.rsplit("/", 1)[1]]
        self.assertEqual(set(request["properties"]), {"content"})
        self.assertFalse(request["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
