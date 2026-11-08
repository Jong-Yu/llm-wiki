"""Managed writes, bounded observations and interruption recovery in isolation."""

from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest
from unittest.mock import patch

from core.common import read_changes, read_snapshots
from core.common.read_metrics import collect
from core.modules.documents import changes, history, listing
from core.modules.documents.store import WikiStore, RevisionConflictError
from core.tests.poc_mcp.test_server_integration import ServerFixture


class DocumentReadTrackingTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = WikiStore(self.root, tracked_reads=True)
        self.strict = WikiStore(self.root)
        for number in range(5):
            self.strict.save(f"folder/{number}.md", f"Body {number}", expected_revision=None)

    def page(self, store=None, **options):
        return listing.list_documents(store or self.store, tenant="tenant", scope_key="scope",
                                      limit=2, **options)

    def original_files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for folder in (self.store.wiki_dir, self.store.history_dir)
                for path in folder.rglob("*") if path.is_file()}

    def test_warm_avoids_scan_but_reads_selected_current_documents(self):
        expected = self.page(self.strict)
        self.assertEqual(self.page(), expected)
        before = self.original_files()
        with patch.object(listing, "_scan_files", side_effect=AssertionError("warm full scan")), \
                patch.object(self.store, "read", wraps=self.store.read) as read, collect() as metrics:
            self.assertEqual(self.page(), expected)
        self.assertEqual(read.call_count, 2)
        counters = metrics.finish()["counters"]
        self.assertEqual(counters["snapshot_hits"], 1)
        self.assertEqual(counters["canonical_reads"], 4)
        self.assertEqual(counters.get("scanned", 0), 0)
        self.assertEqual(self.original_files(), before)

    def test_strict_writer_invalidates_only_changed_existing_document(self):
        previous = self.page()
        original = self.strict.read("folder/4.md")
        self.strict.save("folder/4.md", "Changed", expected_revision=original.revision)
        with patch.object(listing, "_scan_files", side_effect=AssertionError("delta full scan")):
            current = self.page()
        self.assertEqual(current, self.page(self.strict))
        self.assertNotEqual(current["catalog_revision"], previous["catalog_revision"])
        with self.assertRaises(listing.CatalogChangedError):
            self.page(cursor=previous["next_cursor"])

    def test_new_document_reconciles_exact_scan_count(self):
        self.page()
        self.strict.save("new/path/a.md", "new", expected_revision=None)
        with patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            actual = self.page()
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(actual, self.page(self.strict))

    def test_strict_mode_always_scans_and_validates_option(self):
        with patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            self.page(self.strict)
            self.page(self.strict)
        self.assertEqual(scan.call_count, 2)
        with self.assertRaises(TypeError):
            WikiStore(self.root, tracked_reads="true")

    def test_journal_damage_is_preserved_on_read_and_recovered_before_next_write(self):
        expected = self.page()
        lock = self.root / ".storage.lock"
        lock.write_bytes(b'{"partial":')
        with patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            self.assertEqual(self.page(), expected)
            self.assertEqual(self.page(), expected)
        self.assertEqual(scan.call_count, 2)
        self.assertEqual(lock.read_bytes(), b'{"partial":')
        old = self.strict.read("folder/4.md")
        self.strict.save("folder/4.md", "Recovered", expected_revision=old.revision)
        self.assertEqual(self.page(), self.page(self.strict))

    def test_empty_legacy_baseline_cannot_hide_a_lost_change_chain(self):
        with TemporaryDirectory() as directory:
            store = WikiStore(Path(directory).resolve(), tracked_reads=True)
            self.assertEqual(self.page(store)["items"], [])
            store.save("a.md", "published", expected_revision=None)
            with store._write_lock():
                (store.data_dir / ".storage.lock").write_bytes(b"")
            current = self.page(store)
            self.assertEqual([item["document"] for item in current["items"]], ["a.md"])
            self.assertEqual((store.data_dir / ".storage.lock").read_bytes(), b"")

    def test_retention_gap_and_periodic_reconciliation(self):
        self.page()
        with patch.object(read_changes, "MAX_CHANGE_RECORDS", 2), self.store._write_lock():
            for number in range(3):
                read_changes.before_change(self.store, "wiki", f"wiki/intent-{number}.md")
        with patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            self.page()
        self.assertEqual(scan.call_count, 1)
        with patch.object(read_snapshots, "RECONCILE_SECONDS", 0), \
                patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            self.page()
        self.assertEqual(scan.call_count, 1)

    def test_failed_invalidation_preserves_all_originals_and_cas_priority(self):
        old = self.strict.read("folder/4.md")
        before = self.original_files()
        with patch.object(read_changes.os, "fsync", side_effect=OSError("journal fsync failed")):
            with self.assertRaises(RevisionConflictError):
                self.strict.save("folder/4.md", "wrong basis", expected_revision=None)
            with self.assertRaisesRegex(OSError, "journal fsync failed"):
                self.strict.save("folder/4.md", "new", expected_revision=old.revision)
        self.assertEqual(self.original_files(), before)
        self.assertEqual(self.page(), self.page(self.strict))

    def test_published_archive_survives_failed_document_write_and_invalidates_history(self):
        def versions():
            return history.list_versions(self.store, "folder/4.md", tenant="tenant", scope_key="scope")
        before = versions()
        old = self.strict.read("folder/4.md")
        archive = self.strict._archive
        def archive_then_fail(*args, **kwargs):
            archive(*args, **kwargs)
            raise OSError("after archive")
        with patch.object(self.strict, "_archive", side_effect=archive_then_fail):
            with self.assertRaisesRegex(OSError, "after archive"):
                self.strict.save("folder/4.md", "unpublished", expected_revision=old.revision)
        self.assertEqual(self.strict.read("folder/4.md"), old)
        self.assertEqual(len(versions()["items"]), len(before["items"]) + 1)
        self.assertEqual(versions(), history.list_versions(self.strict, "folder/4.md", tenant="tenant", scope_key="scope"))

    def test_failed_save_with_abandoned_temporary_reconciles_scan_limits(self):
        self.page()
        old = self.strict.read("folder/4.md")
        before = self.original_files()
        unlink = Path.unlink
        def fail_staged_cleanup(path, *args, **kwargs):
            if path.parent == self.store.wiki_dir / "folder" and path.name.startswith(".wiki-"):
                raise OSError("staged cleanup")
            return unlink(path, *args, **kwargs)
        with patch.object(self.strict, "_archive", side_effect=OSError("archive failure")), \
                patch.object(Path, "unlink", fail_staged_cleanup):
            with self.assertRaisesRegex(OSError, "archive failure") as caught:
                self.strict.save("folder/4.md", "unpublished", expected_revision=old.revision)
        self.assertEqual(len(caught.exception.cleanup_failures), 1)
        for path, content in before.items():
            self.assertEqual((self.root / path).read_bytes(), content)
        with patch.object(listing, "MAX_LIST_ENTRIES", 6):
            actual = self.page()
            self.assertTrue(actual["truncated"])
            self.assertEqual(actual, self.page(self.strict))

    def test_warm_history_and_pending_audit_success_remain_current(self):
        old = self.strict.read("folder/4.md")
        self.strict.save("folder/4.md", "Version 2", expected_revision=old.revision)
        expected = history.list_versions(self.store, "folder/4.md", tenant="tenant", scope_key="scope")
        with patch.object(history, "_scan_versions", side_effect=AssertionError("warm history scan")):
            self.assertEqual(history.list_versions(self.store, "folder/4.md", tenant="tenant", scope_key="scope"), expected)
        old = self.strict.read("folder/4.md")
        with patch.object(changes, "finish", side_effect=OSError("audit finish")):
            result = self.strict.save("folder/4.md", "Version 3", expected_revision=old.revision)
        self.assertEqual(result.audit_status, "pending_reconcile")
        self.assertEqual(self.page(), self.page(self.strict))
        self.assertEqual(self.strict.read("folder/4.md").revision, result.revision)

    def test_legacy_public_lock_remains_readable_without_tracking(self):
        expected = self.page()
        lock = self.root / ".storage.lock"
        lock.chmod(0o644)
        with patch.object(listing, "_scan_files", wraps=listing._scan_files) as scan:
            self.assertEqual(self.page(self.strict), expected)
            self.assertEqual(self.page(), expected)
        self.assertEqual(scan.call_count, 2)
        old = self.strict.read("folder/4.md")
        before = self.original_files()
        with self.assertRaisesRegex(ValueError, "private lock"):
            self.strict.save("folder/4.md", "new", expected_revision=old.revision)
        self.assertEqual(self.original_files(), before)


class TrackedHttpTests(ServerFixture):
    def test_http_and_mcp_writes_invalidate_warm_observation_and_revocation_still_applies(self):
        self.policy.tracked_reads = True
        written = self.write("First body")
        self.assertTrue(written["ok"], written)
        prefix = f"/api/v1/tenants/{self.tenant}/documents"
        first = self.client.get(prefix, headers=self.headers()).json()["data"]
        with patch.object(listing, "_scan_files", side_effect=AssertionError("warm HTTP full scan")):
            warm = self.client.get(prefix, headers=self.headers())
        self.assertEqual(warm.status_code, 200)
        self.assertEqual(warm.json()["data"], first)
        original = self.read()
        updated = self.write(original["content"] + "Second body", revision=original["revision"])
        self.assertTrue(updated["ok"], updated)
        with patch.object(listing, "_scan_files", side_effect=AssertionError("HTTP delta full scan")):
            current = self.client.get(prefix, headers=self.headers())
        self.assertEqual(current.status_code, 200)
        self.assertEqual(current.json()["data"]["items"][0]["revision"], updated["revision"])
        policy = json.loads(self.config.read_text())
        policy["users"][self.user["user_id"]]["memberships"][self.tenant]["permissions"] = []
        self.config.write_text(json.dumps(policy))
        with patch.object(listing, "_scan_files", side_effect=AssertionError("denied scan")):
            denied = self.client.get(prefix, headers=self.headers())
        self.assertEqual(denied.status_code, 403)


if __name__ == "__main__":
    unittest.main()
