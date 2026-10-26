"""원본-only와 기존 위키를 함께 발견하되 계보·완료를 추측하지 않는지 검사한다."""

import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.documents.listing import CatalogChangedError, InvalidCursorError, list_documents
from core.modules.documents.store import WikiStore
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.sources.store import SourceStore


class SourceCatalogueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-source-catalogue-")
        self.addCleanup(self.temporary.cleanup)
        self.store = WikiStore(self.temporary.name, lock_timeout_seconds=0)
        self.sources = SourceStore(self.store)
        self.actor = {"user_id": "alice", "tenant": "alpha", "profile_id": "all",
                      "domain": None, "viewpoint": None, "policy_revision": "a" * 64}

    def register(self, content="등록 원본", **kwargs):
        staged = self.sources.stage(io.BytesIO(content.encode()), kind="text", title="자료", format="txt")
        return self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                   authorize=lambda: dict(self.actor), **kwargs)

    def listing(self, **kwargs):
        return list_catalogue(self.store, tenant="alpha", scope_key="alice:policy:all", **kwargs)

    def snapshot(self):
        return {p.relative_to(self.store.data_dir).as_posix(): p.read_bytes()
                for p in self.store.data_dir.rglob("*") if p.is_file()}

    def test_no_sources_keeps_original_wiki_listing_and_does_not_create_source_files(self):
        self.store.save("기존.md", "기존 본문", expected_revision=None)
        original = list_documents(self.store, tenant="alpha", scope_key="alice:policy:all")
        before = self.snapshot()
        self.assertEqual(self.listing(), original)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.store.data_dir / "_registrations").exists())
        self.assertFalse((self.store.data_dir / "_sources").exists())

    def test_registered_original_and_unlinked_wiki_are_found_without_inferred_derivation(self):
        saved = self.store.save("기존.md", "등록 원본", expected_revision=None)
        registered = self.register()
        before = self.snapshot()
        page = self.listing()
        self.assertTrue(page["complete"])
        self.assertEqual(len(page["items"]), 2)
        source, wiki = page["items"]
        self.assertEqual(source["kind"], "source")
        self.assertEqual(source["source_id"], registered["source_id"])
        self.assertEqual(source["documents"], [])
        self.assertEqual(source["analysis_status"], "not_started")
        self.assertEqual(wiki, {"document": "기존.md", "revision": saved.revision, "source_status": "unlinked"})
        self.assertEqual(self.snapshot(), before)

    def test_more_than_fifty_items_page_stably_without_skipping_wiki(self):
        for i in range(52):
            self.store.save(f"{i:03}.md", "본문", expected_revision=None)
        self.register()
        first = self.listing(limit=50)
        last = self.listing(limit=50, cursor=first["next_cursor"])
        self.assertEqual(len(first["items"]) + len(last["items"]), 53)
        self.assertFalse(first["complete"])
        self.assertTrue(last["complete"])
        self.assertEqual(first["catalog_revision"], last["catalog_revision"])

    def test_new_source_invalidates_pre_registration_wiki_cursor(self):
        for name in ("a.md", "b.md"):
            self.store.save(name, "본문", expected_revision=None)
        original = self.listing(limit=1)
        self.register()
        with self.assertRaises(CatalogChangedError):
            self.listing(cursor=original["next_cursor"])

    def test_source_version_and_wiki_mutation_each_invalidate_combined_cursor(self):
        self.store.save("본문.md", "본문", expected_revision=None)
        registered = self.register()
        first = self.listing(limit=1)
        changed = self.register("새 판본", source_id=registered["source_id"],
                                expected_registration_revision=registered["registration_revision"])
        self.assertEqual(changed["state"], "complete")
        with self.assertRaises(CatalogChangedError):
            self.listing(cursor=first["next_cursor"])
        first = self.listing(limit=1)
        self.store.save("추가.md", "새 위키", expected_revision=None)
        with self.assertRaises(CatalogChangedError):
            self.listing(cursor=first["next_cursor"])

    def test_wrong_scope_or_malformed_cursor_is_not_accepted(self):
        self.store.save("본문.md", "본문", expected_revision=None)
        self.register()
        first = self.listing(limit=1)
        with self.assertRaises(InvalidCursorError):
            list_catalogue(self.store, tenant="alpha", scope_key="another-user", cursor=first["next_cursor"])
        for cursor in ("bad", "sc1_!", "sc1_" + "a" * 17000):
            with self.subTest(cursor=cursor[:20]), self.assertRaises(InvalidCursorError):
                self.listing(cursor=cursor)

    def test_incomplete_wiki_scan_keeps_registered_original_but_never_claims_complete(self):
        for i in range(3):
            self.store.save(f"{i}.md", "본문", expected_revision=None)
        self.register()
        with patch("core.modules.documents.listing.MAX_LIST_FILES", 1):
            page = self.listing()
        self.assertTrue(page["truncated"])
        self.assertFalse(page["complete"])
        self.assertIsNone(page["next_cursor"])
        self.assertTrue(any(item.get("kind") == "source" for item in page["items"]))


if __name__ == "__main__":
    unittest.main()
