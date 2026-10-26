"""원본 등록·판본·영수증·읽기 검사는 임시 tenant 자료로만 수행한다."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.documents.store import WikiStore, StorageBusyError
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.sources import contracts, files
from core.modules.sources.store import SourceStore
from core.modules.sources.contracts import (
    SourceConflictError, SourceCorruptError, SourceLimitError, SourceTooLargeError,
    SourceValidationError, UnsupportedSourceError,
)


class SourceStorageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-sources-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.wiki = WikiStore(self.root, lock_timeout_seconds=2)
        self.sources = SourceStore(self.wiki)
        self.actor = {"user_id": "alice", "tenant": "alpha", "profile_id": "all",
                      "domain": None, "viewpoint": None, "policy_revision": "a" * 64}

    def snapshot(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def staged(self, content=b"text\r\n", **kwargs):
        return self.sources.stage(BytesIO(content), **{"kind": "text", "title": "제목", "format": "txt", **kwargs})

    def save(self, content=b"text\r\n", *, request_id=None, **kwargs):
        return self.sources.commit(self.staged(content), tenant="alpha", user_id="alice",
            request_id=request_id or uuid4().hex, authorize=lambda: self.actor, **kwargs)

    def test_empty_reads_create_no_source_directories_or_coordination_lock(self):
        before = self.snapshot()
        result = self.sources.list_sources(tenant="alpha", scope_key="scope")
        self.assertEqual(result["items"], [])
        self.assertTrue(result["complete"])
        with self.assertRaises(FileNotFoundError):
            self.sources.get_source(uuid4().hex)
        with self.assertRaises(FileNotFoundError):
            self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=uuid4().hex)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.root / "_incoming").exists())
        self.assertFalse((self.root / "_registrations").exists())
        self.assertFalse((self.root / ".registration.lock").exists())

    def test_create_preserves_exact_bytes_and_only_registers_original(self):
        content = "원본\r\n🌱\n".encode()
        saved = self.save(content)
        self.assertEqual(saved["state"], "complete")
        catalog = self.sources.get_source(saved["source_id"])
        self.assertEqual(catalog["registration_revision"], saved["registration_revision"])
        self.assertEqual(catalog["current_version"], saved["source_version"])
        self.assertEqual(catalog["documents"], [])
        with self.sources.open_original(saved["source_id"], saved["source_version"])[0] as source:
            self.assertEqual(source.read(), content)
        self.assertEqual(saved["receipt"]["analysis_status"], "not_started")
        self.assertEqual(list(self.wiki.wiki_dir.iterdir()), [])
        self.assertEqual(list(self.wiki.history_dir.iterdir()), [])
        self.assertFalse((self.root / "_jobs").exists())
        self.assertFalse((self.root / "_ontology").exists())

    def test_file_metadata_and_direct_text_are_distinct_without_client_paths(self):
        staged = self.staged(b"# heading", kind="file", filename="설명.md", format="md")
        result = self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                     authorize=lambda: self.actor)
        manifest = self.sources.get_source(result["source_id"])["versions"][0]
        self.assertEqual((manifest["kind"], manifest["filename"], manifest["format"]), ("file", "설명.md", "md"))
        self.assertEqual(manifest["actor"], self.actor)
        self.assertNotIn(str(self.root), json.dumps(result))
        for filename in ("../../escape.txt", "C:\\secret.txt", "a/b.txt", "image.pdf", "nul\x00.txt"):
            with self.subTest(filename=filename), self.assertRaises(UnsupportedSourceError):
                self.staged(kind="file", filename=filename)

    def test_new_version_cas_preserves_old_original_manifest_and_other_wiki_data(self):
        self.wiki.save("Guide.md", "before", expected_revision=None)
        self.wiki.save("Guide.md", "after", expected_revision=self.wiki.read("Guide.md").revision)
        old = self.save(b"first")
        first_version = self.root / "_sources" / old["source_id"] / old["source_version"]
        old_bytes = {p.name: p.read_bytes() for p in first_version.iterdir()}
        protected = {name: raw for name, raw in self.snapshot().items() if name.startswith(("wiki/", "_history/"))}
        latest = self.save(b"second", source_id=old["source_id"], expected_registration_revision=old["registration_revision"])
        self.assertNotEqual(old["source_version"], latest["source_version"])
        self.assertEqual(old_bytes, {p.name: p.read_bytes() for p in first_version.iterdir()})
        self.assertEqual(len(self.sources.get_source(old["source_id"])["versions"]), 2)
        with self.assertRaises(SourceConflictError):
            self.save(b"outdated", source_id=old["source_id"], expected_registration_revision=old["registration_revision"])
        self.assertEqual(protected, {name: raw for name, raw in self.snapshot().items() if name.startswith(("wiki/", "_history/"))})

    def test_same_request_same_payload_replays_and_changed_payload_is_conflict(self):
        request_id = uuid4().hex
        first = self.save(b"original", request_id=request_id)
        before = self.snapshot()
        replay = self.save(b"original", request_id=request_id)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt"], first["receipt"])
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(SourceConflictError) as raised:
            self.save(b"changed", request_id=request_id)
        self.assertEqual(raised.exception.code, "request_conflict")
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(FileNotFoundError):
            self.sources.request_receipt(tenant="alpha", user_id="bob", request_id=request_id)

    def test_same_filename_is_new_registration_unless_source_id_is_explicit(self):
        first, second = self.save(), self.save()
        self.assertNotEqual(first["source_id"], second["source_id"])
        self.assertEqual(len(self.sources.list_sources(tenant="alpha", scope_key="scope")["items"]), 2)

    def test_stream_utf8_boundaries_size_and_quota_never_truncate(self):
        class TinyStream(BytesIO):
            def read(self, count):
                return super().read(1)
        staged = self.sources.stage(TinyStream("🌱".encode()), kind="text", title="UTF8", format="txt")
        self.assertEqual(staged.size_bytes, 4)
        self.sources.discard(staged)
        for raw in (b"\xff", b"\xf0\x9f", b"ok\xffbad"):
            with self.assertRaises(UnicodeError):
                self.staged(raw)
        with patch.object(contracts, "MAX_SOURCE_BYTES", 4):
            staged = self.staged(b"1234")
            self.sources.discard(staged)
            with self.assertRaises(SourceTooLargeError):
                self.staged(b"12345")
        self.save(b"1234")
        with patch.object(contracts, "MAX_STAGING_BYTES", 4):
            staged = self.staged(b"1234")
            with self.assertRaises(SourceLimitError):
                self.staged(b"1")
            self.sources.discard(staged)
        self.assertEqual(list((self.root / "_incoming").iterdir()), [])

    def test_catalog_failure_keeps_orphan_and_intent_pending_without_republishing(self):
        request_id = uuid4().hex
        with patch.object(self.sources, "_write_catalog", side_effect=OSError("injected")):
            pending = self.save(b"published", request_id=request_id)
        self.assertEqual(pending["state"], "pending_reconcile")
        original = self.root / "_sources" / pending["source_id"] / pending["source_version"] / "original"
        self.assertEqual(original.read_bytes(), b"published")
        before = self.snapshot()
        fetched = self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=request_id)
        self.assertEqual(fetched["state"], "pending_reconcile")
        replay = self.save(b"published", request_id=request_id)
        self.assertEqual(replay["source_id"], pending["source_id"])
        self.assertEqual(self.snapshot(), before)
        with patch.object(contracts, "MAX_TENANT_SOURCE_BYTES", len(b"published")):
            with self.assertRaises(SourceLimitError):
                self.save(b"x")

    def test_full_permanent_quota_allows_same_request_replay_but_not_new_original(self):
        request_id = uuid4().hex
        with patch.object(contracts, "MAX_TENANT_SOURCE_BYTES", 3):
            saved = self.save(b"abc", request_id=request_id)
            before = self.snapshot()
            replay = self.save(b"abc", request_id=request_id)
            self.assertEqual(replay["receipt"], saved["receipt"])
            self.assertTrue(replay["replayed"])
            with self.assertRaises(SourceLimitError):
                self.save(b"a")
            self.assertEqual(self.snapshot(), before)

    def test_receipt_write_failure_is_confirmed_by_read_only_durable_evidence(self):
        request_id = uuid4().hex
        actual = self.sources._write_request
        def fail_complete(path, record):
            if record["state"] == "complete":
                raise OSError("injected")
            actual(path, record)
        with patch.object(self.sources, "_write_request", fail_complete):
            pending = self.save(b"stored", request_id=request_id)
        self.assertEqual(pending["state"], "pending_reconcile")
        before = self.snapshot()
        confirmed = self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=request_id)
        self.assertEqual(confirmed["state"], "complete")
        self.assertEqual(confirmed["receipt"]["confirmation"], "intent_manifest_catalog")
        self.assertEqual(self.snapshot(), before)
        replay = self.save(b"stored", request_id=request_id)
        self.assertEqual(replay["state"], "pending_reconcile")
        self.assertEqual(self.snapshot(), before)

    def test_intent_failure_does_not_publish_an_original(self):
        with patch.object(self.sources, "_write_request", side_effect=OSError("intent failure")):
            with self.assertRaises(OSError):
                self.save()
        self.assertFalse((self.root / "_sources").exists())
        self.assertEqual(list((self.root / "_incoming").iterdir()), [])

    def test_no_receipt_means_same_hash_does_not_claim_another_request(self):
        saved = self.save(b"same bytes")
        other_request = uuid4().hex
        with self.assertRaises(FileNotFoundError):
            self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=other_request)
        other = self.save(b"same bytes", request_id=other_request)
        self.assertNotEqual(saved["source_id"], other["source_id"])

    def test_current_authorization_runs_inside_coordination_before_intent(self):
        staged = self.staged()
        with self.assertRaises(PermissionError):
            self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                authorize=lambda: (_ for _ in ()).throw(PermissionError("revoked")))
        self.assertFalse((self.root / "_registrations").exists())
        self.assertFalse((self.root / "_sources").exists())
        self.assertEqual(list((self.root / "_incoming").iterdir()), [])

    def test_concurrent_same_request_publishes_one_original_and_receipt(self):
        request_id = uuid4().hex
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda ignored: self.save(b"same", request_id=request_id), range(2)))
        self.assertEqual(results[0]["source_id"], results[1]["source_id"])
        self.assertEqual(sorted(item["replayed"] for item in results), [False, True])
        self.assertEqual(len(self.sources._capture_catalog_locked()), 1)

    def test_sources_versions_receipts_and_catalog_metadata_limits_preserve_existing(self):
        first = self.save()
        for constant, limit, action in (
            ("MAX_SOURCES", 1, lambda: self.save()),
            ("MAX_VERSIONS", 1, lambda: self.save(source_id=first["source_id"], expected_registration_revision=first["registration_revision"])),
            ("MAX_REQUESTS", 1, lambda: self.save()),
        ):
            before = self.snapshot()
            with patch.object(contracts, constant, limit), self.assertRaises(SourceLimitError):
                action()
            self.assertEqual(self.snapshot(), before)
        with patch.object(contracts, "MAX_CATALOG_BYTES", 1), self.assertRaises(SourceLimitError):
            self.sources.list_sources(tenant="alpha", scope_key="s")

    def test_paged_list_is_scope_bound_and_changed_catalog_requires_refresh(self):
        for _ in range(4):
            self.save()
        first = self.sources.list_sources(tenant="alpha", scope_key="one", limit=2)
        last = self.sources.list_sources(tenant="alpha", scope_key="one", limit=2, cursor=first["next_cursor"])
        self.assertEqual(len(first["items"]) + len(last["items"]), 4)
        self.assertFalse(first["complete"])
        self.assertTrue(last["complete"])
        self.assertEqual([x["source_id"] for x in first["items"] + last["items"]], sorted(x["source_id"] for x in first["items"] + last["items"]))
        with self.assertRaises(InvalidCursorError):
            self.sources.list_sources(tenant="alpha", scope_key="two", cursor=first["next_cursor"])
        self.save()
        with self.assertRaises(CatalogChangedError):
            self.sources.list_sources(tenant="alpha", scope_key="one", cursor=first["next_cursor"])

    def test_symlink_fifo_corrupt_manifest_original_and_receipt_are_not_followed(self):
        saved = self.save()
        directory = self.root / "_sources" / saved["source_id"] / saved["source_version"]
        original = directory / "original"
        raw = original.read_bytes()
        original.write_bytes(b"tampered")
        with self.assertRaises(SourceCorruptError):
            self.sources.open_original(saved["source_id"], saved["source_version"])
        original.unlink()
        original.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            self.sources.open_original(saved["source_id"], saved["source_version"])
        original.unlink()
        os.mkfifo(original)
        with self.assertRaises(SourceCorruptError):
            self.sources.open_original(saved["source_id"], saved["source_version"])
        original.unlink()
        original.write_bytes(raw)
        catalog = self.root / "_registrations" / (saved["source_id"] + ".json")
        catalog.write_bytes(b"invalid")
        before = self.snapshot()
        with self.assertRaises(SourceCorruptError):
            self.sources.get_source(saved["source_id"])
        self.assertEqual(self.snapshot(), before)

    def test_storage_busy_is_separate_from_conflict_and_preserves_staging(self):
        staged = self.staged()
        self.wiki.lock_timeout_seconds = 0
        with self.sources._coordination_lock():
            with self.assertRaises(StorageBusyError):
                self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                     authorize=lambda: self.actor)
        self.assertFalse(staged.directory.exists())

    def test_actual_twenty_mib_boundary_is_preserved_and_one_extra_byte_is_rejected(self):
        class RepeatedStream:
            def __init__(self, remaining):
                self.remaining = remaining
            def read(self, count):
                size = min(count, self.remaining)
                self.remaining -= size
                return b"x" * size
        staged = self.sources.stage(RepeatedStream(20 * 1024 * 1024), kind="text", title="경계", format="txt")
        self.assertEqual(staged.size_bytes, 20 * 1024 * 1024)
        self.assertEqual((staged.directory / "original").stat().st_size, staged.size_bytes)
        self.sources.discard(staged)
        with self.assertRaises(SourceTooLargeError):
            self.sources.stage(RepeatedStream(20 * 1024 * 1024 + 1), kind="text", title="초과", format="txt")
        self.assertEqual(list((self.root / "_incoming").iterdir()), [])

    def test_successful_replay_cleanup_failure_is_a_warning_without_new_publication(self):
        request_id = uuid4().hex
        first = self.save(b"saved", request_id=request_id)
        staged = self.staged(b"saved")
        actual_unlink = Path.unlink
        def fail_own_original(path, *args, **kwargs):
            if path == staged.directory / "original":
                raise PermissionError(13, "cleanup injected")
            return actual_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_own_original):
            result = self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=request_id,
                                         authorize=lambda: self.actor)
        self.assertEqual(result["state"], "complete")
        self.assertTrue(result["replayed"])
        self.assertTrue(result["cleanup_failures"])
        self.assertEqual(result["receipt"], first["receipt"])
        self.assertEqual(len(self.sources._capture_catalog_locked()), 1)
        self.sources.discard(staged)

    def test_primary_write_failure_and_cleanup_failure_are_reported_separately(self):
        destination = self.root / "scratch" / "value.json"
        actual_unlink = Path.unlink
        def fail_temporary(path, *args, **kwargs):
            if path.parent == destination.parent and path.name.startswith(".source-"):
                raise PermissionError(13, "cleanup injected")
            return actual_unlink(path, *args, **kwargs)
        with patch("core.modules.sources.files.os.replace", side_effect=OSError(5, "publish injected")), \
             patch.object(Path, "unlink", fail_temporary):
            with self.assertRaises(OSError) as raised:
                files.write_json(self.wiki, destination, {"data": "preserve"})
        self.assertEqual(raised.exception.errno, 5)
        self.assertEqual(raised.exception.cleanup_failures[0]["errno"], 13)
        self.assertFalse(destination.exists())
        for path in destination.parent.iterdir():
            path.unlink()
        destination.parent.rmdir()

    def test_directory_symlink_or_scan_budget_does_not_change_existing_storage(self):
        self.save()
        before = self.snapshot()
        with patch.object(contracts, "MAX_SCAN_ENTRIES", 1), self.assertRaises(SourceLimitError):
            self.save()
        self.assertEqual(self.snapshot(), before)
        incoming = self.root / "_incoming"
        incoming.rmdir()
        external = self.root / "other"
        external.mkdir()
        incoming.symlink_to(external, target_is_directory=True)
        with self.assertRaises(SourceCorruptError):
            self.staged()
        self.assertEqual(list(external.iterdir()), [])
        incoming.unlink()

    def test_complete_receipt_corruption_and_oversized_json_fail_closed(self):
        saved = self.save()
        path = self.sources._request_path("alpha", "alice", saved["request_id"])
        raw = path.read_bytes()
        record = json.loads(raw)
        record["receipt"]["source_sha256"] = "0" * 64
        path.write_text(json.dumps(record))
        with self.assertRaises(SourceCorruptError):
            self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=saved["request_id"])
        path.write_bytes(raw)
        with patch.object(contracts, "MAX_JSON_BYTES", 10), self.assertRaises(SourceCorruptError):
            self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=saved["request_id"])

    def test_stored_cleanup_warnings_require_relative_paths_and_exact_types(self):
        saved = self.save()
        path = self.sources._request_path("alpha", "alice", saved["request_id"])
        original = json.loads(path.read_bytes())
        safe = {"path": "_incoming/temporary/original", "error_type": "PermissionError", "errno": 13}
        for change in ({"path": "/private/server/secret"}, {"path": "../secret"}, {"path": "C:\\secret"},
                       {"path": "a//b"}, {"path": "a/./b"}, {"errno": True}, {"errno": "13"},
                       {"error_type": {"unsafe": "value"}}, {"additional": "field"}):
            record = {**original, "cleanup_failures": [{**safe, **change}]}
            path.write_text(json.dumps(record))
            with self.subTest(change=change), self.assertRaises(SourceCorruptError):
                self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=saved["request_id"])
        path.write_text(json.dumps({**original, "cleanup_failures": [safe]}))
        self.assertEqual(self.sources.request_receipt(tenant="alpha", user_id="alice", request_id=saved["request_id"])["cleanup_failures"], [safe])


if __name__ == "__main__":
    unittest.main()
