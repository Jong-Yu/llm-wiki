"""위키 편집·전체 이력·복원과 실패 보존을 임시 자료에서만 확인한다."""

import unittest
from unittest.mock import patch

from core.modules.documents.store import WikiStore
from core.tests.api import test_read_api as fixture


class DocumentMutationApiTests(unittest.IsolatedAsyncioTestCase):
    # 준비 함수만 공유해 기존 읽기 검사 전체가 중복 실행되지 않게 한다.
    setUp = fixture.ReadApiTests.setUp
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing
    data = fixture.ReadApiTests.data
    snapshot = fixture.ReadApiTests.snapshot

    def allow_write(self):
        """시험 사용자 한 명에게만 새 API에 필요한 권한을 부여한다."""
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "write"]
        self.save_policy()

    async def test_write_versions_restore_and_stale_cursor_preserve_whole_history(self):
        self.allow_write()
        base = "/api/v1/tenants/alpha/documents"
        async with self.client(lifespan=False) as http:
            created = self.data(await http.put(base + "/content", json={"document": "guide.md",
                "content": "처음\r\n  본문\n", "expected_revision": None}))
            changed = self.data(await http.put(base + "/content", json={"document": "guide.md",
                "content": "두 번째\n", "expected_revision": created["revision"]}))
            self.assertIsNone(changed["mutation_receipt"])
            listing = self.data(await http.get(base + "/versions", params={"document": "guide.md", "limit": 1}))
            old = listing["items"][0]
            history = self.data(await http.get(base + "/versions/" + old["history_id"], params={"document": "guide.md"}))
            self.assertEqual(history["content"], "처음\r\n  본문\n")
            self.assertEqual(history["revision"], created["revision"])
            self.assertIsNone(history["author"])
            before = self.snapshot()
            self.data(await http.put(base + "/content", json={"document": "guide.md", "content": "충돌",
                "expected_revision": created["revision"]}), 409)
            self.assertEqual(self.snapshot(), before)
            restored = self.data(await http.post(base + "/restorations", json={"document": "guide.md",
                "history_id": old["history_id"], "expected_revision": changed["revision"]}))
            self.assertEqual(restored["revision"], created["revision"])
            page = self.data(await http.get(base + "/versions", params={"document": "guide.md", "limit": 1}))
            self.assertFalse(page["complete"])
            remaining = self.data(await http.get(base + "/versions", params={"document": "guide.md", "limit": 1,
                "cursor": page["next_cursor"]}))
            self.assertTrue(remaining["complete"])
            self.stores["alpha"].save("guide.md", "새 변경", expected_revision=restored["revision"])
            self.data(await http.get(base + "/versions", params={"document": "guide.md", "limit": 1,
                "cursor": page["next_cursor"]}), 409)
            self.assertEqual(len(list((self.stores["alpha"].history_dir / "guide.md").glob("*.md"))), 3)

    async def test_permissions_unknown_fields_history_escape_and_archive_failure(self):
        original = self.stores["alpha"].save("guide.md", "보존할 전체 본문", expected_revision=None)
        base = "/api/v1/tenants/alpha/documents"
        async with self.client(lifespan=False) as http:
            body = {"document": "guide.md", "content": "수정", "expected_revision": original.revision}
            self.data(await http.put(base + "/content", json=body), 403)
            self.allow_write()
            self.data(await http.put(base + "/content", json={**body, "actor": "forged"}), 422)
            self.data(await http.put("/api/v1/tenants/beta/documents/content", json=body), 403)
            self.data(await http.get(base + "/versions/%2E%2E%2Fsecret.md", params={"document": "guide.md"}), 404)
            self.data(await http.post(base + "/restorations", json={"document": "guide.md", "history_id": "../secret.md",
                "expected_revision": original.revision}), 422)
            # 이력 폴더 안의 링크도 따라가지 않는다. 시험용 외부 파일은 응답에 노출되면 안 된다.
            outside = self.root / "outside.md"
            outside.write_text("시험용 외부 파일 비공개 본문", encoding="utf-8")
            history_dir = self.stores["alpha"].history_dir / "guide.md"
            history_dir.mkdir()
            (history_dir / "linked.md").symlink_to(outside)
            response = await http.get(base + "/versions/linked.md", params={"document": "guide.md"})
            self.data(response, 500)
            self.assertNotIn("시험용 외부 파일 비공개 본문", response.text)
            listing = self.data(await http.get(base + "/versions", params={"document": "guide.md"}))
            self.assertFalse(listing["complete"])
            self.assertEqual(listing["skipped"][0]["code"], "invalid_history")
            before = self.snapshot()
            with patch.object(WikiStore, "_archive", side_effect=OSError("isolated archive failure")):
                self.data(await http.put(base + "/content", json=body), 500)
            self.assertEqual(self.snapshot(), before)
