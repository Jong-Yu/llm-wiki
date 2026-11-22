"""임시 워크스페이스에서 템플릿의 바이트·판본·CAS·실패 보존을 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.documents.store import WikiStore
from core.modules.sources import files
from core.modules.templates.store import TemplateError, TemplateStore


class TemplateStorage(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.wiki = WikiStore(self.root)
        self.scope = SimpleNamespace(store=self.wiki, tenant="project", user_id="alice")
        self.templates = TemplateStore(self.scope)

    def create(self, **changes):
        data = {"request_id": uuid4().hex, "name": "화면 설계서", "instructions": "근거가 없으면 질문하세요.",
                "filename": "회사양식.pptx", "content": b"binary\x00preserved\xff"}
        return self.templates.save(**{**data, **changes})

    def update(self, original, **changes):
        return self.templates.save(**{"template_id": original["id"], "expected_revision": original["revision"],
            "request_id": uuid4().hex, "name": "편집된 양식", "instructions": "새 지침", **changes})

    def test_register_update_old_versions_and_archive_preserve_bytes(self):
        original = self.create()["template"]
        self.assertEqual(self.templates.read(original["id"]), (original, b"binary\x00preserved\xff"))
        self.assertNotIn("instructions", self.templates.list()["items"][0])
        second = self.update(original)["template"]
        third = self.update(second, filename="new.hwpx", content=b"another binary")["template"]
        self.assertEqual(self.templates.read(original["id"], original["revision"])[1], b"binary\x00preserved\xff")
        self.assertEqual(self.templates.read(original["id"], second["revision"])[0]["instructions"], "새 지침")
        self.assertEqual(len(list((self.root / "_templates" / original["id"] / "files").iterdir())), 2)
        archived = self.templates.archive(original["id"], request_id=uuid4().hex, expected_revision=third["revision"])["template"]
        self.assertTrue(archived["archived"])
        self.assertEqual(self.templates.list()["items"], [])
        self.assertEqual(self.templates.read(original["id"], original["revision"])[0], original)
        with self.assertRaises(TemplateError) as failure:
            self.update(archived)
        self.assertEqual(failure.exception.code, "template_archived")
        self.assertEqual(list(self.wiki.wiki_dir.iterdir()), [])

    def test_replayed_create_after_update_returns_original_and_rejects_changed_payload(self):
        request = uuid4().hex
        result = self.create(request_id=request)
        self.update(result["template"])
        replay = self.create(request_id=request)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["template"], result["template"])
        with self.assertRaises(TemplateError) as failure:
            self.create(request_id=request, instructions="different")
        self.assertEqual(failure.exception.code, "request_conflict")

    def test_concurrent_cas_has_one_winner_and_preserves_original(self):
        original = self.create()["template"]
        def attempt(_):
            try:
                return self.update(original)["template"]
            except TemplateError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(results.count("conflict"), 1)
        self.assertEqual(self.templates.read(original["id"], original["revision"])[0], original)

    def test_publish_failure_and_authorization_revocation_preserve_current(self):
        original = self.create()["template"]
        write = files.write_json
        def fail_catalog(store, path, value):
            if path.name == "catalog.json":
                raise OSError("disk unavailable")
            return write(store, path, value)
        with patch.object(files, "write_json", side_effect=fail_catalog):
            with self.assertRaises(OSError):
                self.update(original, filename="updated.docx", content=b"new")
        self.assertEqual(self.templates.read(original["id"])[0], original)
        self.assertGreater(self.templates._usage(), len(b"binary\x00preserved\xff"))
        calls = []
        def denied():
            calls.append(True)
            if len(calls) == 2:
                raise PermissionError("revoked")
        with self.assertRaises(PermissionError):
            self.update(original, before_commit=denied)
        self.assertEqual(self.templates.read(original["id"])[0], original)

    def test_corruption_missing_lock_symlink_and_nonregular_are_rejected(self):
        original = self.create()["template"]
        file = self.root / "_templates" / original["id"] / "files" / (original["sha256"] + ".bin")
        file.write_bytes(b"changed")
        with self.assertRaises(TemplateError):
            self.templates.read(original["id"])
        file.unlink()
        file.symlink_to(self.root / "elsewhere")
        with self.assertRaises(TemplateError):
            self.templates.read(original["id"])
        file.unlink()
        file.write_bytes(b"binary\x00preserved\xff")
        (self.root / ".registration.lock").unlink()
        with self.assertRaises(TemplateError):
            self.templates.list()
        with self.assertRaises(TemplateError):
            self.update(original)

    def test_file_limits_quota_and_input_validation_do_not_publish(self):
        for changes in ({"content": b""}, {"filename": "../../secret"}, {"instructions": "x" * 12001}, {"name": "\n"}):
            with self.subTest(changes=changes):
                with self.assertRaises(TemplateError):
                    self.create(**changes)
        with patch("core.modules.templates.store.MAX_FILE_BYTES", 5):
            with self.assertRaises(TemplateError) as failure:
                self.create(content=b"123456")
            self.assertEqual(failure.exception.code, "template_file_limit")
        with patch("core.modules.templates.store.MAX_TOTAL_BYTES", 1):
            with self.assertRaises(TemplateError) as failure:
                self.create()
            self.assertEqual(failure.exception.code, "template_limit")
        self.assertEqual(self.templates.list()["items"], [])

    def test_tenant_and_actor_identity_are_not_client_fields(self):
        request = uuid4().hex
        first = self.create(request_id=request)["template"]
        bob = TemplateStore(SimpleNamespace(store=self.wiki, tenant="project", user_id="bob"))
        other = bob.save(request_id=request, name="Bob", instructions="", filename="x.pdf", content=b"x")["template"]
        self.assertNotEqual(first["id"], other["id"])
        changed_tenant = TemplateStore(SimpleNamespace(store=self.wiki, tenant="other", user_id="alice"))
        with self.assertRaises(TemplateError):
            changed_tenant.read(first["id"])


if __name__ == "__main__":
    unittest.main()
