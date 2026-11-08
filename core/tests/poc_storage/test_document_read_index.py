"""문서·통합 목록과 보관 이력의 파생 인덱스를 격리 자료에서 검사한다."""

from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.read_index import CanonicalIndexUnavailable, CanonicalReadIndex, read_index
from core.modules.documents import history
from core.modules.documents.listing import list_documents, CatalogChangedError, InvalidCursorError
from core.modules.documents.store import WikiStore
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.sources.store import SourceStore


ACTOR = {"user_id": "alice", "tenant": "tenant", "profile_id": "default",
         "domain": None, "viewpoint": None, "policy_revision": "a" * 64}


class DocumentReadIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = WikiStore(self.root)

    def canonical_files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()
                and path.relative_to(self.root).parts[0] != "_index"}

    def documents(self, count=32):
        for number in range(count):
            self.store.save(f"document-{number:03}.md", f"Body {number}\n", expected_revision=None)

    def versions(self, count=15):
        revision = None
        for number in range(count):
            revision = self.store.save("a.md", f"Version {number}\n", expected_revision=revision,
                actor=ACTOR, origin="human", reason=f"Version {number}").revision

    def test_document_pages_use_sql_and_read_only_selected_bodies(self):
        self.documents()
        before = self.canonical_files()
        first = list_documents(self.store, tenant="tenant", scope_key="scope", limit=5)
        with patch.object(self.store, "read", wraps=self.store.read) as read:
            warm = list_documents(self.store, tenant="tenant", scope_key="scope", limit=5)
            self.assertEqual(read.call_count, 5)
        self.assertEqual(first, warm)
        self.assertTrue((self.root / "_index").is_dir())
        second = list_documents(self.store, tenant="tenant", scope_key="scope", limit=5,
                                cursor=first["next_cursor"])
        self.assertEqual(second["items"][0]["document"], "document-005.md")
        self.assertEqual(before, self.canonical_files())

    def test_catalogue_sql_page_matches_canonical_order_and_scope(self):
        self.documents(5)
        sources = SourceStore(self.store)
        for number in range(7):
            staged = sources.stage(BytesIO(f"Source {number}\n".encode()),
                kind="text", title=f"Source {number}", format="txt")
            sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
                           authorize=lambda: dict(ACTOR))
        before = self.canonical_files()
        first = list_catalogue(self.store, tenant="tenant", scope_key="scope", limit=5)
        with patch("core.modules.knowledge.catalogue._indexed_keys", return_value=None):
            expected = list_catalogue(self.store, tenant="tenant", scope_key="scope", limit=5,
                                      cursor=first["next_cursor"])
        actual = list_catalogue(self.store, tenant="tenant", scope_key="scope", limit=5,
                                cursor=first["next_cursor"])
        self.assertEqual(actual, expected)
        with self.assertRaises(InvalidCursorError):
            list_catalogue(self.store, tenant="tenant", scope_key="other", limit=5,
                           cursor=first["next_cursor"])
        self.assertEqual(before, self.canonical_files())

    def test_history_warm_page_reads_no_archived_bodies(self):
        self.versions()
        before = self.canonical_files()
        first = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        with patch.object(history, "_read", wraps=history._read) as read, \
                patch.object(CanonicalReadIndex, "get", side_effect=AssertionError("warm per-row lookup")):
            warm = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
            self.assertEqual(read.call_count, 0)
        self.assertEqual(first, warm)
        self.assertEqual(before, self.canonical_files())

    def test_changed_history_is_revalidated_and_new_save_rejects_old_cursor(self):
        self.versions()
        first = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        selected = first["items"][0]["history_id"]
        (self.store.history_dir / "a.md" / selected).write_bytes(b"\xff")
        before = self.canonical_files()
        changed = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        self.assertIn({"history_id": selected, "code": "read_failed"}, changed["skipped"])
        self.assertEqual(before, self.canonical_files())
        current = self.store.read("a.md")
        self.store.save("a.md", current.content + "New version\n", expected_revision=current.revision)
        with self.assertRaises(CatalogChangedError):
            history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5,
                                  cursor=first["next_cursor"])

    def test_index_failure_keeps_document_and_history_results(self):
        self.documents(9)
        self.versions()
        expected = list_documents(self.store, tenant="tenant", scope_key="scope", limit=5)
        expected_history = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        before = self.canonical_files()
        unavailable = CanonicalIndexUnavailable("isolated index failure")
        with patch("core.modules.documents.listing.read_index", side_effect=unavailable), \
                patch("core.modules.documents.history.read_index", side_effect=unavailable):
            self.assertEqual(list_documents(self.store, tenant="tenant", scope_key="scope", limit=5), expected)
            self.assertEqual(history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5),
                             expected_history)
        self.assertEqual(before, self.canonical_files())

    def test_symlinked_index_does_not_write_outside_store(self):
        self.documents(5)
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        outside = Path(temporary.name)
        (self.root / "_index").symlink_to(outside, target_is_directory=True)
        before = self.canonical_files()
        page = list_documents(self.store, tenant="tenant", scope_key="scope", limit=5)
        self.assertEqual(len(page["items"]), 5)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(before, self.canonical_files())

    def test_history_index_close_failure_falls_back_once(self):
        self.versions()
        expected = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        before = self.canonical_files()

        @contextmanager
        def close_failure(store):
            with read_index(store) as index:
                yield index
            raise CanonicalIndexUnavailable("isolated close failure")

        with patch("core.modules.documents.history.read_index", side_effect=close_failure) as opened:
            actual = history.list_versions(self.store, "a.md", tenant="tenant", scope_key="scope", limit=5)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(actual, expected)
        self.assertEqual(before, self.canonical_files())
