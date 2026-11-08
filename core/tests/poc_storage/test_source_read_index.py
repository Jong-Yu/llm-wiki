"""Source 목록의 파생 인덱스와 원본 보존을 격리 자료에서 대조한다."""

import base64
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.common.read_index import CanonicalIndexUnavailable
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import WikiStore
from core.modules.sources import contracts, queries
from core.modules.sources.contracts import SourceCorruptError, SourceLimitError
from core.modules.sources.store import SourceStore


class SourceReadIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = WikiStore(self.root)
        self.sources = SourceStore(self.store)

    def source(self, content=b"original\r\n", *, title="Title", **kwargs):
        staged = self.sources.stage(io.BytesIO(content), kind="text", title=title, format="txt")
        return self.sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
            authorize=lambda: {"user_id": "alice", "tenant": "tenant", "profile_id": "general",
                "domain": None, "viewpoint": None, "policy_revision": "a" * 64}, **kwargs)

    def snapshot(self):
        # 캐시 생성만 허용한다. 원본·판본·영수증·위키·전체 이력은 바이트까지 대조한다.
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file() and path.relative_to(self.root).parts[0] != "_index"}

    def summaries(self):
        with self.sources._coordination_lock():
            return self.sources._capture_summaries_locked()

    def list_sources(self, **kwargs):
        return self.sources.list_sources(tenant="tenant", scope_key="scope", **kwargs)

    def test_list_pages_keep_exact_catalog_hash_and_warm_reads_no_catalogs(self):
        for number in range(7):
            self.source(title=f"Source {number}")
        first = self.store.save("a.md", "old\r\n", expected_revision=None)
        self.store.save("a.md", "new\n", expected_revision=first.revision)
        with self.sources._coordination_lock():
            catalogs = self.sources._capture_catalog_locked()
        before = self.snapshot()
        with patch.object(self.sources, "_get_source_locked", wraps=self.sources._get_source_locked) as loaded:
            initial = self.list_sources(limit=3)
        self.assertEqual(loaded.call_count, len(catalogs))
        self.assertEqual(initial["catalog_revision"], canonical_json_hash(catalogs))
        self.assertEqual(initial["items"], [queries.summary(c) for c in catalogs[:3]])
        self.assertEqual(initial["scanned"], len(catalogs))
        with patch.object(self.sources, "_get_source_locked", side_effect=AssertionError("warm JSON read")):
            self.assertEqual(self.list_sources(limit=3), initial)
            second = self.list_sources(limit=3, cursor=initial["next_cursor"])
            third = self.list_sources(limit=3, cursor=second["next_cursor"])
        self.assertEqual(second["items"], [queries.summary(c) for c in catalogs[3:6]])
        self.assertEqual(third["items"], [queries.summary(c) for c in catalogs[6:]])
        self.assertTrue(third["complete"])
        self.assertIsNone(third["next_cursor"])
        self.assertEqual(self.snapshot(), before)

    def test_list_uses_sql_page_and_binds_each_current_scope(self):
        for _ in range(4):
            self.source()
        first = self.list_sources(limit=2)
        original = queries.read_index
        pages = []
        scopes = []

        @contextmanager
        def observed(store):
            with original(store) as index:
                page = Mock(wraps=index.page)
                pages.append(page)

                def sync(namespace, scope, entries, loader):
                    scopes.append(scope)
                    return index.sync(namespace, scope, entries, loader)

                yield SimpleNamespace(sync=sync, get=index.get, page=page,
                                      values=Mock(side_effect=AssertionError("unpaged summaries")))

        with patch.object(queries, "read_index", observed):
            self.list_sources(limit=2, cursor=first["next_cursor"])
            self.sources.list_sources(tenant="tenant", scope_key="other", limit=2)
        self.assertNotEqual(scopes[0], scopes[1])
        self.assertEqual(pages[0].call_args.kwargs["after"], first["items"][-1]["source_id"])
        self.assertEqual(pages[0].call_args.kwargs["limit"], 3)
        with self.assertRaises(InvalidCursorError):
            self.sources.list_sources(tenant="tenant", scope_key="other", cursor=first["next_cursor"])

    def test_summaries_read_only_changed_source_and_keep_small_projection(self):
        receipts = [self.source(title=f"Source {number}") for number in range(5)]
        before = self.snapshot()
        with patch.object(self.sources, "_get_source_locked", wraps=self.sources._get_source_locked) as loaded:
            initial = self.summaries()
        self.assertEqual(loaded.call_count, 5)
        self.assertEqual(self.snapshot(), before)
        with patch.object(self.sources, "_get_source_locked", side_effect=AssertionError("warm JSON read")):
            self.assertEqual(self.summaries(), initial)
        changed = receipts[2]
        self.source(b"second version", title="Updated", source_id=changed["source_id"],
                    expected_registration_revision=changed["registration_revision"])
        before = self.snapshot()
        with patch.object(self.sources, "_get_source_locked", wraps=self.sources._get_source_locked) as loaded:
            actual = self.summaries()
        self.assertEqual([call.args[0] for call in loaded.call_args_list], [changed["source_id"]])
        with self.sources._coordination_lock():
            catalogs = self.sources._capture_catalog_locked()
        self.assertEqual(actual, [queries._summary_record(catalog) for catalog in catalogs])
        self.assertTrue(all("versions" not in item and "versions" not in item["summary"] for item in actual))
        self.assertEqual(self.snapshot(), before)

    def test_list_changed_catalog_keeps_exact_hash_and_rejects_old_cursor(self):
        receipts = [self.source() for _ in range(4)]
        first = self.list_sources(limit=1)
        changed = receipts[-1]
        self.source(b"new", source_id=changed["source_id"],
                    expected_registration_revision=changed["registration_revision"])
        with self.sources._coordination_lock():
            catalogs = self.sources._capture_catalog_locked()
        before = self.snapshot()
        with self.assertRaises(CatalogChangedError):
            self.list_sources(limit=1, cursor=first["next_cursor"])
        actual = self.list_sources(limit=1)
        self.assertEqual(actual["catalog_revision"], canonical_json_hash(catalogs))
        with patch.object(self.sources, "_get_source_locked", side_effect=AssertionError("warm JSON read")):
            self.assertEqual(self.list_sources(limit=1), actual)
        self.assertEqual(self.snapshot(), before)

    def test_changed_off_page_corruption_is_not_hidden_by_index_or_stale_cursor(self):
        for _ in range(3):
            self.source()
        first = self.list_sources(limit=1)
        self.summaries()
        last = max(path.parent.name for path in (self.root / "_sources").glob("*/catalog.json"))
        self.sources._catalog_path(last).write_bytes(b"{broken")
        before = self.snapshot()
        for action in (lambda: self.list_sources(limit=1),
                       lambda: self.list_sources(limit=1, cursor=first["next_cursor"]), self.summaries):
            with self.assertRaises(SourceCorruptError):
                action()
        self.assertEqual(self.snapshot(), before)

    def test_warm_metadata_limits_and_unexpected_entries_still_fail(self):
        self.source()
        self.source()
        self.list_sources(limit=1)
        self.summaries()
        before = self.snapshot()
        total = sum(path.stat().st_size for path in (self.root / "_sources").glob("*/catalog.json"))
        with patch.object(contracts, "MAX_CATALOG_BYTES", total - 1):
            for action in (self.list_sources, self.summaries):
                with self.assertRaises(SourceLimitError):
                    action()
        with patch.object(contracts, "MAX_SOURCES", 1):
            for action in (self.list_sources, self.summaries):
                with self.assertRaises(SourceLimitError):
                    action()
        self.assertEqual(self.snapshot(), before)
        (self.root / "_sources" / "unexpected").mkdir()
        with self.assertRaises(SourceCorruptError):
            self.list_sources()

    def test_earlier_catalog_error_keeps_priority_over_later_metadata_limit(self):
        self.source()
        self.source()
        paths = sorted((self.root / "_sources").glob("*/catalog.json"))
        paths[0].write_bytes(b"{bad")
        with patch.object(contracts, "MAX_CATALOG_BYTES", paths[0].stat().st_size + 1):
            with self.assertRaises(SourceCorruptError):
                self.list_sources()

    def test_legacy_catalog_is_cached_without_migration_and_duplicate_is_rejected(self):
        source = self.source()
        sid = source["source_id"]
        current = self.sources._catalog_path(sid)
        legacy = self.root / "_registrations" / (sid + ".json")
        legacy.parent.mkdir()
        current.rename(legacy)
        before = self.snapshot()
        first = self.list_sources()
        self.summaries()
        with patch.object(self.sources, "_get_source_locked", side_effect=AssertionError("warm legacy read")):
            self.assertEqual(self.list_sources(), first)
            self.summaries()
        self.assertFalse(current.exists())
        self.assertEqual(self.snapshot(), before)
        current.write_bytes(legacy.read_bytes())
        before = self.snapshot()
        for action in (self.list_sources, self.summaries):
            with self.assertRaises(SourceCorruptError):
                action()
        self.assertEqual(self.snapshot(), before)

    def test_warm_symlink_and_nonregular_catalog_are_rejected(self):
        source = self.source()
        self.list_sources()
        catalog = self.sources._catalog_path(source["source_id"])
        saved = catalog.with_name("saved.json")
        catalog.rename(saved)
        catalog.symlink_to(saved)
        before = self.snapshot()
        with self.assertRaises(SourceCorruptError):
            self.list_sources()
        self.assertEqual(self.snapshot(), before)
        catalog.unlink()
        catalog.mkdir()
        with self.assertRaises(SourceCorruptError):
            self.list_sources()
        self.assertEqual(saved.read_bytes(), before[saved.relative_to(self.root).as_posix()])

    def test_unavailable_cache_falls_back_to_same_dto_and_preserves_canonical_files(self):
        for _ in range(3):
            self.source()
        expected = self.list_sources(limit=1)
        expected_summaries = self.summaries()
        before = self.snapshot()
        with patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("test cache failure")):
            self.assertEqual(self.list_sources(limit=1), expected)
            self.assertEqual(self.summaries(), expected_summaries)
            following = self.list_sources(limit=1, cursor=expected["next_cursor"])
        self.assertEqual(following["catalog_revision"], expected["catalog_revision"])
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_sqlite_falls_back_without_overwriting_cache_or_canonical_files(self):
        self.source()
        self.source()
        expected = self.list_sources(limit=1)
        expected_summaries = self.summaries()
        database = self.root / "_index" / "read.sqlite3"
        database.write_bytes(b"invalid SQLite database")
        before = self.snapshot()
        self.assertEqual(self.list_sources(limit=1), expected)
        self.assertEqual(self.summaries(), expected_summaries)
        self.assertEqual(database.read_bytes(), b"invalid SQLite database")
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_registration_edit_and_index_reads_keep_both_original_versions(self):
        initial = self.source(b"first\r\n")
        self.list_sources()
        self.summaries()
        first_original = self.sources._version_path(initial["source_id"], initial["source_version"]) / "original"
        original_bytes = first_original.read_bytes()

        def update():
            return self.source(b"second", source_id=initial["source_id"],
                               expected_registration_revision=initial["registration_revision"])

        with ThreadPoolExecutor(max_workers=4) as pool:
            created = pool.submit(self.source, b"created")
            edited = pool.submit(update)
            listing = pool.submit(self.list_sources)
            summaries = pool.submit(self.summaries)
            new_source, new_version = created.result(), edited.result()
            self.assertGreaterEqual(len(listing.result()["items"]), 1)
            self.assertGreaterEqual(len(summaries.result()), 1)
        actual = self.list_sources()
        self.assertEqual({item["source_id"] for item in actual["items"]},
                         {initial["source_id"], new_source["source_id"]})
        current = next(item for item in actual["items"] if item["source_id"] == initial["source_id"])
        self.assertEqual(current["version_count"], 2)
        self.assertEqual(current["current_version"], new_version["source_version"])
        self.assertEqual(first_original.read_bytes(), original_bytes)
        self.assertEqual((self.sources._version_path(initial["source_id"], new_version["source_version"])
                          / "original").read_bytes(), b"second")
        with self.sources._coordination_lock():
            catalogs = self.sources._capture_catalog_locked()
        self.assertEqual(actual["catalog_revision"], canonical_json_hash(catalogs))

    def test_position_error_and_validation_order_remain_unchanged(self):
        for _ in range(2):
            self.source()
        first = self.list_sources(limit=1)
        payload = json.loads(base64.urlsafe_b64decode(first["next_cursor"] + "=" * (-len(first["next_cursor"]) % 4)))
        payload["after"] = "0" * 32
        cursor = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=").decode()
        with self.assertRaises(InvalidCursorError):
            self.list_sources(cursor=cursor)
        with patch.object(self.sources, "_coordination_lock", side_effect=AssertionError("invalid cursor opened store")):
            with self.assertRaises(InvalidCursorError):
                self.list_sources(cursor="not a cursor")
        paths = sorted((self.root / "_sources").glob("*/catalog.json"))
        raw = json.loads(paths[-1].read_bytes())
        raw["versions"] = []
        paths[-1].write_bytes(canonical_json_bytes(raw))
        with self.assertRaises(SourceCorruptError):
            self.list_sources(cursor=cursor)

    def test_empty_source_queries_do_not_create_directories_or_lock(self):
        before = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*"))
        response = self.list_sources()
        self.assertEqual(response["items"], [])
        self.assertEqual(response["catalog_revision"], canonical_json_hash([]))
        self.assertEqual(self.summaries(), [])
        self.assertEqual(sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*")), before)


if __name__ == "__main__":
    unittest.main()
