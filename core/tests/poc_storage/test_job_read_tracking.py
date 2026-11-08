"""Tracked job reads use real temporary writers and preserve strict contracts."""

from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common import read_metrics, read_snapshots
from core.common.json_codec import canonical_json_bytes
from core.common.read_index import CanonicalIndexUnavailable
from core.modules.analysis_jobs import contracts, queries, records
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.listing import CatalogChangedError
from core.modules.documents.store import WikiStore
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError
from core.modules.sources.store import SourceStore


ACTOR = {"user_id": "alice", "tenant": "tenant", "profile_id": "general", "domain": None,
         "viewpoint": None, "policy_revision": "a" * 64, "access_revision": "b" * 64}


class JobReadTrackingTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = WikiStore(self.root, tracked_reads=True, lock_timeout_seconds=0.02)
        self.sources = SourceStore(self.store)
        self.now = datetime(2026, 11, 6, tzinfo=timezone.utc)
        self.jobs = JobStore(self.store, clock=lambda: self.now)
        self.source = self.register_source()

    def register_source(self, *, previous=None):
        staged = self.sources.stage(BytesIO(b"Whole original source.\r\n"), kind="text", title="Title", format="txt")
        extra = {} if previous is None else {"source_id": previous["source_id"],
            "expected_registration_revision": previous["registration_revision"]}
        return self.sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
                                   authorize=lambda: dict(ACTOR), **extra)

    def create_job(self):
        return self.jobs.create(tenant="tenant", user_id="alice", request_id=uuid4().hex,
            **{key: self.source[key] for key in ("source_id", "source_version", "source_sha256")},
            expected_registration_revision=self.source["registration_revision"], targets=["example.md"],
            outputs=["wiki"], authorize=lambda: dict(ACTOR))

    def create_jobs(self, count=4):
        return sorted([self.create_job() for _ in range(count)], key=lambda value: value["job_id"])

    def listing(self, **arguments):
        return self.jobs.list_jobs(tenant="tenant", user_id="alice", scope_key="alice-scope", **arguments)

    def strict(self, **arguments):
        strict = JobStore(WikiStore(self.root), clock=lambda: self.now)
        return strict.list_jobs(tenant="tenant", user_id="alice", scope_key="alice-scope", **arguments)

    def snapshot(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob("*")
                if path.is_file() and path.relative_to(self.root).parts[0] != "_index"}

    def cancel(self, job):
        return self.jobs.cancel(job["job_id"], tenant="tenant", user_id="alice", authorize=lambda: dict(ACTOR),
                                expected_job_revision=job["job_revision"])

    def claim(self, job):
        return self.jobs.claim(job["job_id"], tenant="tenant", user_id="alice", authorize=lambda: dict(ACTOR),
                               expected_job_revision=job["job_revision"])

    def write_record(self, path, value):
        with self.sources._coordination_lock():
            files.write_json(self.store, path, value)

    def test_warm_new_request_skips_directory_and_all_fingerprints_but_reads_selected_bodies(self):
        self.create_jobs(8)
        first = self.listing(limit=2)
        before = self.snapshot()
        self.jobs = JobStore(WikiStore(self.root, tracked_reads=True), clock=lambda: self.now)
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("warm directory scan")), \
                patch.object(queries, "_fingerprint", side_effect=AssertionError("warm canonical stat")), \
                patch.object(self.jobs.sources, "_catalog_path", side_effect=AssertionError("warm source path scan")), \
                patch.object(files, "read_json", wraps=files.read_json) as read:
            self.assertEqual(self.listing(limit=2), first)
        state_reads = [call.args[1] for call in read.call_args_list if call.args[1].name in {"job.json", "state.json"}]
        self.assertEqual(len(state_reads), 2)
        self.assertEqual(self.snapshot(), before)
        with read_snapshots._guard:
            snapshots = [item[2] for key, item in read_snapshots._snapshots.items()
                         if key[0] == str(self.root) and key[-1].startswith("analysis_job_entries:")]
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(set(snapshots[0]), {"jobs", "states", "fingerprints", "source_paths"})
        self.assertEqual(len(snapshots[0]["states"]), 8)
        self.assertTrue(all("events" not in value and "actor" not in value for value in snapshots[0]["states"].values()))

    def test_existing_off_page_change_checks_one_fingerprint_and_invalidates_cursor(self):
        jobs = self.create_jobs()
        first = self.listing(limit=1)
        self.cancel(jobs[-1])
        before = self.snapshot()
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("existing job rescan")), \
                patch.object(queries, "_fingerprint", wraps=queries._fingerprint) as fingerprints:
            with self.assertRaises(CatalogChangedError):
                self.listing(limit=1, cursor=first["next_cursor"])
        self.assertEqual([call.args[1] for call in fingerprints.call_args_list],
                         [self.jobs.job_root(jobs[-1]["job_id"]) / "job.json"])
        self.assertEqual(self.listing(limit=1), self.strict(limit=1))
        self.assertEqual(self.snapshot(), before)

    def test_new_owner_reconciles_membership_and_partial_creation_never_uses_old_snapshot(self):
        self.create_jobs(2)
        first = self.listing(limit=1)
        self.create_job()
        with patch.object(queries, "_owner_jobs", wraps=queries._owner_jobs) as scan:
            with self.assertRaises(CatalogChangedError):
                self.listing(limit=1, cursor=first["next_cursor"])
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(self.listing()["scanned"], 3)
        original = self.jobs._write

        def fail_state(path, value):
            if path.name == "job.json":
                raise OSError("temporary publish failure")
            return original(path, value)

        with patch.object(self.jobs, "_write", side_effect=fail_state):
            self.assertEqual(self.create_job()["state"], "pending_reconcile")
        before = self.snapshot()
        with self.assertRaises(FileNotFoundError):
            self.listing()
        self.assertEqual(self.snapshot(), before)

    def test_new_run_and_heartbeat_only_recheck_the_changed_job_and_lease(self):
        jobs = self.create_jobs(3)
        self.listing(limit=1)
        claimed = self.claim(jobs[-1])
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("claim rescan")), \
                patch.object(queries, "_fingerprint", wraps=queries._fingerprint) as fingerprints:
            page = self.listing(limit=1)
        root = self.jobs.job_root(jobs[-1]["job_id"])
        lease = root / "leases" / (claimed["run_id"] + ".json")
        self.assertEqual([call.args[1] for call in fingerprints.call_args_list], [root / "job.json", lease])
        self.now += timedelta(seconds=10)
        renewed = self.jobs.heartbeat(jobs[-1]["job_id"], tenant="tenant", user_id="alice", authorize=lambda: dict(ACTOR),
            run_id=claimed["run_id"], expected_lease_revision=claimed["lease_revision"])
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("heartbeat rescan")), \
                patch.object(queries, "_fingerprint", wraps=queries._fingerprint) as fingerprints:
            with self.assertRaises(CatalogChangedError):
                self.listing(limit=1, cursor=page["next_cursor"])
        self.assertEqual([call.args[1] for call in fingerprints.call_args_list], [lease])
        self.assertEqual(renewed["job_revision"], claimed["job_revision"])
        self.assertEqual(self.listing(), self.strict())

    def test_time_only_lease_expiry_is_recomputed_without_file_scans(self):
        jobs = self.create_jobs(3)
        self.claim(jobs[-1])
        first = self.listing(limit=1)
        before = self.snapshot()
        self.now += timedelta(seconds=301)
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("clock rescan")), \
                patch.object(queries, "_fingerprint", side_effect=AssertionError("clock stat")), \
                patch.object(records, "owned_state", side_effect=AssertionError("projection before cursor check")):
            with self.assertRaises(CatalogChangedError):
                self.listing(limit=1, cursor=first["next_cursor"])
        self.assertEqual(self.listing()["items"][-1]["lease_status"], "expired")
        self.assertEqual(self.listing(), self.strict())
        self.assertEqual(self.snapshot(), before)

    def test_related_source_checks_one_catalog_but_unrelated_sources_do_not_invalidate(self):
        self.create_jobs(3)
        first = self.listing(limit=1)
        self.register_source()
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("unrelated source scan")), \
                patch.object(queries, "_fingerprint", side_effect=AssertionError("unrelated source stat")):
            self.listing(limit=1, cursor=first["next_cursor"])
        self.register_source(previous=self.source)
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("source version rescan")), \
                patch.object(queries, "_fingerprint", wraps=queries._fingerprint) as fingerprints:
            with self.assertRaises(CatalogChangedError):
                self.listing(limit=1, cursor=first["next_cursor"])
        self.assertEqual([call.args[1] for call in fingerprints.call_args_list],
                         [self.sources._catalog_path(self.source["source_id"])])
        self.assertTrue(all(item["basis_status"] == "changed" for item in self.listing()["items"]))
        self.assertEqual(self.listing(), self.strict())

    def test_owner_scope_and_authorization_scope_do_not_share_discovered_membership(self):
        self.create_jobs(2)
        self.listing()
        with patch.object(records, "owned_state", side_effect=AssertionError("other owner state read")):
            self.assertEqual(self.jobs.list_jobs(tenant="tenant", user_id="bob", scope_key="bob-scope")["items"], [])
        with patch.object(queries, "_owner_jobs", wraps=queries._owner_jobs) as scan:
            self.jobs.list_jobs(tenant="tenant", user_id="alice", scope_key="new-authorization")
        self.assertEqual(scan.call_count, 1)

    def test_strict_external_change_detection_and_periodic_deadline_survive_intermediate_delta(self):
        jobs = self.create_jobs(3)
        with patch.object(read_snapshots.time, "monotonic", return_value=100):
            self.listing(limit=1)
        self.cancel(jobs[1])
        with patch.object(read_snapshots.time, "monotonic", return_value=120):
            self.listing(limit=1)
        path = self.jobs.job_root(jobs[-1]["job_id"]) / "job.json"
        path.write_text('{"externally_corrupt":true}')
        with self.assertRaises(contracts.JobCorruptError):
            self.strict(limit=1)
        with patch.object(read_snapshots.time, "monotonic", return_value=129), \
                patch.object(queries, "_owner_jobs", side_effect=AssertionError("early periodic scan")):
            self.listing(limit=1)
        before = self.snapshot()
        with patch.object(read_snapshots.time, "monotonic", return_value=131), self.assertRaises(contracts.JobCorruptError):
            self.listing(limit=1)
        self.assertEqual(self.snapshot(), before)

    def test_sql_busy_and_corrupt_cache_fall_back_to_fresh_canonical_membership(self):
        jobs = self.create_jobs()
        self.listing(limit=2)
        self.cancel(jobs[-1])
        with patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("expected canonical result")):
            expected = self.strict(limit=2)
        database = self.root / "_index/read.sqlite3"
        with sqlite3.connect(database, isolation_level=None) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                with read_metrics.collect() as metrics, patch.object(queries, "_owner_jobs", wraps=queries._owner_jobs) as scan:
                    self.assertEqual(self.listing(limit=2), expected)
                self.assertEqual(scan.call_count, 1)
                self.assertEqual(metrics.finish()["cache_fallbacks"].get("busy"), 1)
            finally:
                connection.rollback()
        database.write_bytes(b"Preserve corrupt derived cache.")
        before = self.snapshot()
        self.assertEqual(self.listing(limit=2), expected)
        self.assertEqual(database.read_bytes(), b"Preserve corrupt derived cache.")
        self.assertEqual(self.snapshot(), before)

    def test_recreated_sql_database_repopulates_membership_with_warm_metadata(self):
        self.create_jobs(4)
        expected = self.listing(limit=2)
        database = self.root / "_index/read.sqlite3"
        preserved = self.root / "_index/preserved.sqlite3"
        database.rename(preserved)
        before = self.snapshot()
        with patch.object(queries, "_owner_jobs", side_effect=AssertionError("replacement directory scan")), \
                patch.object(queries, "_fingerprint", side_effect=AssertionError("replacement canonical stat")):
            self.assertEqual(self.listing(limit=2), expected)
        self.assertTrue(preserved.is_file())
        self.assertEqual(self.snapshot(), before)

    def test_warm_owner_and_total_metadata_limits_are_still_enforced(self):
        jobs = self.create_jobs(3)
        self.listing(limit=1)
        total = sum(len(canonical_json_bytes(records.owned_state(self.jobs, job["job_id"], "tenant", "alice")))
                    for job in jobs)
        with patch.object(contracts, "MAX_JOBS", 2), self.assertRaises(contracts.JobLimitError):
            self.listing(limit=1)
        with patch.object(contracts, "MAX_TOTAL_METADATA_BYTES", total - 1), self.assertRaises(contracts.JobLimitError):
            self.listing(limit=1)

    def test_changed_owner_and_source_errors_keep_original_validation_order(self):
        jobs = self.create_jobs(2)
        self.listing(limit=1)
        path = self.jobs.job_root(jobs[0]["job_id"]) / "owner.json"
        self.write_record(path, {"job_id": jobs[0]["job_id"], "tenant": "tenant", "user_id": "bob"})
        with patch.object(records, "owned_state", side_effect=AssertionError("state read before changed owner")), \
                self.assertRaises(contracts.JobCorruptError):
            self.listing(limit=1)
        self.write_record(path, {"job_id": jobs[0]["job_id"], "tenant": "tenant", "user_id": "alice"})
        self.listing(limit=1)
        self.write_record(self.sources._catalog_path(self.source["source_id"]), {"invalid": True})
        self.write_record(self.jobs.job_root(jobs[-1]["job_id"]) / "job.json", {"invalid": True})
        before = self.snapshot()
        for listing in (self.listing, self.strict):
            with self.assertRaises(SourceCorruptError):
                listing(limit=1)
        self.assertEqual(self.snapshot(), before)

    def test_failed_publish_intent_does_not_change_result_or_hide_a_later_success(self):
        jobs = self.create_jobs(2)
        first = self.listing(limit=1)
        path = self.jobs.job_root(jobs[-1]["job_id"]) / "job.json"
        original = path.read_bytes()
        with patch.object(files.os, "replace", side_effect=OSError("temporary publish failure")), self.assertRaises(OSError):
            self.cancel(jobs[-1])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(self.listing(limit=1), first)
        self.cancel(jobs[-1])
        with self.assertRaises(CatalogChangedError):
            self.listing(limit=1, cursor=first["next_cursor"])


if __name__ == "__main__":
    unittest.main()
