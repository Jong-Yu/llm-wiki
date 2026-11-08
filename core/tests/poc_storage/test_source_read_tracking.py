"""Managed source observations retain strict reads, original hashes and files."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common import read_changes, read_snapshots
from core.common.read_index import CanonicalIndexUnavailable
from core.common.read_metrics import collect
from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import CatalogChangedError
from core.modules.documents.store import WikiStore
from core.modules.sources import files, queries, contracts
from core.modules.sources.contracts import SourceCorruptError, SourceLimitError
from core.modules.sources.store import SourceStore


ACTOR = {"user_id": "alice", "tenant": "tenant", "profile_id": "general",
         "domain": None, "viewpoint": None, "policy_revision": "a" * 64}


class SourceReadTrackingTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = WikiStore(self.root, tracked_reads=True)
        self.sources = SourceStore(self.store)

    def source(self, content=b"Complete original.\r\n", *, previous=None):
        staged = self.sources.stage(BytesIO(content), kind="text", title="Title", format="txt")
        extra = {} if previous is None else {"source_id": previous["source_id"],
            "expected_registration_revision": previous["registration_revision"]}
        return self.sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
                                   authorize=lambda: dict(ACTOR), **extra)

    def list_sources(self, **kwargs):
        return self.sources.list_sources(tenant="tenant", scope_key="scope", **kwargs)

    def summaries(self):
        with self.sources._coordination_lock():
            return self.sources._capture_summaries_locked()

    def snapshot(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()
                and path.relative_to(self.root).parts[0] != "_index"}

    def write_catalog(self, source, value):
        with self.sources._coordination_lock():
            files.write_json(self.store, self.sources._catalog_path(source["source_id"]), value)

    def test_warm_list_and_summaries_share_metadata_without_directory_or_file_opens(self):
        for _ in range(6):
            self.source()
        first = self.list_sources(limit=2)
        expected = self.summaries()
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", side_effect=AssertionError("warm directory scan")), \
                patch.object(queries, "_catalog_entry_locked", side_effect=AssertionError("warm catalog open")):
            self.assertEqual(self.list_sources(limit=2), first)
            self.assertEqual(self.summaries(), expected)
            self.assertEqual(self.sources.list_sources(tenant="tenant", scope_key="different", limit=2)["items"], first["items"])
        self.assertEqual(self.snapshot(), before)
        with read_snapshots._guard:
            values = [snapshot[2] for key, snapshot in read_snapshots._snapshots.items()
                      if key[0] == str(self.root) and key[-1] == "source_catalog_entries"]
        self.assertEqual(len(values), 1)
        self.assertEqual(set(values[0]), {"entries", "sizes", "failure"})
        self.assertIsNone(values[0]["failure"])
        self.assertEqual(len(values[0]["sizes"]), 6)

    def test_existing_version_updates_one_metadata_entry_and_keeps_catalog_cursor_contract(self):
        receipts = [self.source() for _ in range(5)]
        first = self.list_sources(limit=2)
        self.summaries()
        updated = self.source(b"Full next version.\n", previous=receipts[2])
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", side_effect=AssertionError("existing source rescan")), \
                patch.object(queries, "_catalog_entry_locked", wraps=queries._catalog_entry_locked) as observed, \
                patch.object(self.sources, "_get_source_locked", wraps=self.sources._get_source_locked) as loaded:
            actual = self.summaries()
        self.assertEqual([call.args[1] for call in observed.call_args_list], [updated["source_id"]])
        self.assertEqual([call.args[0] for call in loaded.call_args_list], [updated["source_id"]])
        with self.assertRaises(CatalogChangedError):
            self.list_sources(limit=2, cursor=first["next_cursor"])
        with self.sources._coordination_lock():
            catalogs = self.sources._capture_catalog_locked()
        self.assertEqual(actual, [queries._summary_record(value) for value in catalogs])
        self.assertEqual(self.list_sources(limit=2)["catalog_revision"], canonical_json_hash(catalogs))
        self.assertEqual(self.snapshot(), before)

    def test_new_source_reconciles_membership_before_paging(self):
        self.source()
        self.list_sources(limit=1)
        self.source()
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned:
            actual = self.list_sources(limit=1)
        self.assertEqual(scanned.call_count, 1)
        self.assertEqual(actual["scanned"], 2)
        self.assertIsNotNone(actual["next_cursor"])
        self.assertEqual(self.snapshot(), before)

    def test_journal_overflow_and_periodic_deadline_force_full_reconciliation(self):
        self.source()
        expected = self.list_sources()
        with patch.object(read_changes, "MAX_CHANGE_RECORDS", 2), self.sources._coordination_lock():
            for index in range(4):
                read_changes.before_change(self.store, "registration", f"_jobs/unrelated-{index}.json")
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned:
            self.assertEqual(self.list_sources(), expected)
        self.assertEqual(scanned.call_count, 1)
        with patch.object(read_snapshots, "RECONCILE_SECONDS", 0), \
                patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned:
            self.assertEqual(self.list_sources(), expected)
        self.assertEqual(scanned.call_count, 1)
        self.assertEqual(self.snapshot(), before)

    def test_unrelated_managed_changes_do_not_scan_source_storage(self):
        self.source()
        expected = self.list_sources()
        with self.sources._coordination_lock():
            read_changes.before_change(self.store, "registration", "_personal/alice/analysis/job/job.json")
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", side_effect=AssertionError("unrelated source scan")), \
                patch.object(queries, "_catalog_entry_locked", side_effect=AssertionError("unrelated source open")):
            self.assertEqual(self.list_sources(), expected)
        self.assertEqual(self.snapshot(), before)

    def test_changed_off_page_corruption_precedes_cursor_error_and_can_recover(self):
        receipts = [self.source() for _ in range(3)]
        first = self.list_sources(limit=1)
        changed = max(receipts, key=lambda value: value["source_id"])
        original = self.sources.get_source(changed["source_id"])
        original.pop("registration_revision")
        self.write_catalog(changed, {"invalid": True})
        before = self.snapshot()
        for cursor in (None, first["next_cursor"]):
            with self.subTest(cursor=cursor is not None), self.assertRaises(SourceCorruptError):
                self.list_sources(limit=1, cursor=cursor)
        self.assertEqual(self.snapshot(), before)
        self.write_catalog(changed, original)
        before = self.snapshot()
        self.assertEqual(self.list_sources(limit=1), first)
        self.assertEqual(self.snapshot(), before)

    def test_changed_size_limit_uses_full_validation_and_recovers(self):
        receipts = [self.source() for _ in range(3)]
        self.list_sources(limit=1)
        self.source(b"Full new original.", previous=receipts[0])
        before = self.snapshot()
        with patch.object(contracts, "MAX_CATALOG_BYTES", 1), \
                patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned, \
                self.assertRaises(SourceLimitError):
            self.list_sources(limit=1)
        self.assertEqual(scanned.call_count, 1)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.list_sources()["scanned"], 3)

    def test_failed_catalog_publish_keeps_original_and_later_write_is_observed(self):
        source = self.source()
        first = self.list_sources()
        path = self.sources._catalog_path(source["source_id"])
        raw = path.read_bytes()
        catalog = self.sources.get_source(source["source_id"])
        catalog.pop("registration_revision")
        with patch.object(files.os, "replace", side_effect=OSError("isolated publish failure")), self.assertRaises(OSError):
            self.write_catalog(source, catalog)
        self.assertEqual(path.read_bytes(), raw)
        before = self.snapshot()
        self.assertEqual(self.list_sources(), first)
        self.assertEqual(self.snapshot(), before)
        self.source(b"Successful later version.", previous=source)
        self.assertNotEqual(self.list_sources()["catalog_revision"], first["catalog_revision"])

    def test_changed_unsafe_catalog_path_fails_full_scan_and_recovers(self):
        source = self.source()
        expected = self.list_sources()
        path = self.sources._catalog_path(source["source_id"])
        held = self.root / "held-catalog.json"
        with self.sources._coordination_lock():
            read_changes.before_change(self.store, "registration", path.relative_to(self.root).as_posix())
            path.rename(held)
            path.symlink_to(held)
        before = self.snapshot()
        with patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned, \
                self.assertRaises(SourceCorruptError):
            self.list_sources()
        self.assertEqual(scanned.call_count, 1)
        self.assertEqual(self.snapshot(), before)
        with self.sources._coordination_lock():
            read_changes.before_change(self.store, "registration", path.relative_to(self.root).as_posix())
            path.unlink()
            held.rename(path)
        before = self.snapshot()
        self.assertEqual(self.list_sources(), expected)
        self.assertEqual(self.snapshot(), before)

    def test_source_cache_failures_record_fixed_reasons_and_keep_original_results(self):
        self.source()
        expected = self.list_sources()
        expected_summaries = self.summaries()
        before = self.snapshot()
        with collect() as metrics, patch.object(queries, "read_index",
                side_effect=CanonicalIndexUnavailable("isolated cache busy", reason="busy")):
            self.assertEqual(self.list_sources(), expected)
            self.assertEqual(self.summaries(), expected_summaries)
        report = metrics.finish()
        self.assertEqual(report["cache_fallbacks"], {"busy": 2})
        self.assertEqual(self.snapshot(), before)

    def test_legacy_failed_publish_cleanup_keeps_unexpected_entry_visible(self):
        source = self.source()
        catalog = self.sources.get_source(source["source_id"])
        catalog.pop("registration_revision")
        modern = self.sources._catalog_path(source["source_id"])
        legacy = self.sources.registrations_dir / (source["source_id"] + ".json")
        with self.sources._coordination_lock():
            read_changes.before_change(self.store, "registration", legacy.relative_to(self.root).as_posix())
            files.mkdir(self.store, legacy.parent)
            modern.rename(legacy)
        self.list_sources()
        original = legacy.read_bytes()
        unlink = Path.unlink

        def cleanup_failure(path, *args, **kwargs):
            if path.parent == legacy.parent and path.name.startswith(".source-"):
                raise OSError("isolated legacy temporary cleanup failure")
            return unlink(path, *args, **kwargs)

        with patch.object(files.os, "replace", side_effect=OSError("isolated legacy publish failure")), \
                patch.object(Path, "unlink", cleanup_failure), self.assertRaises(OSError):
            self.write_catalog(source, catalog)
        self.assertEqual(legacy.read_bytes(), original)
        self.assertEqual(len(list(legacy.parent.glob(".source-*.tmp"))), 1)
        before = self.snapshot()
        errors = []
        for sources in (self.sources, SourceStore(WikiStore(self.root))):
            with self.assertRaises(SourceCorruptError) as failure:
                sources.list_sources(tenant="tenant", scope_key="scope")
            errors.append(str(failure.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(self.snapshot(), before)

    def test_default_strict_mode_checks_each_request_and_sees_unjournaled_changes(self):
        source = self.source()
        strict = WikiStore(self.root)
        self.assertFalse(strict.tracked_reads)
        sources = SourceStore(strict)
        with patch.object(queries, "_catalog_ids_locked", wraps=queries._catalog_ids_locked) as scanned:
            for _ in range(2):
                sources.list_sources(tenant="tenant", scope_key="strict")
        self.assertEqual(scanned.call_count, 2)
        sources._catalog_path(source["source_id"]).write_bytes(b"{broken")
        before = self.snapshot()
        with self.assertRaises(SourceCorruptError):
            sources.list_sources(tenant="tenant", scope_key="strict")
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
