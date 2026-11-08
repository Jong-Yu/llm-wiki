"""Incremental job listings retain canonical ownership, cursors and all files."""

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from time import monotonic
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.common.read_index import CanonicalIndexUnavailable, CanonicalReadIndex
from core.modules.analysis_jobs import contracts, queries, records
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import WikiStore
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError
from core.modules.sources.store import SourceStore


class JobReadIndexTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = WikiStore(self.root)
        self.sources = SourceStore(self.store)
        self.now = datetime(2026, 11, 6, tzinfo=timezone.utc)
        self.jobs = JobStore(self.store, clock=lambda: self.now)
        self.source = self.register_source()

    @staticmethod
    def actor(user="alice"):
        return {"user_id": user, "tenant": "tenant", "profile_id": "general", "domain": "general",
                "viewpoint": "general", "policy_revision": "a" * 64, "access_revision": "b" * 64}

    def register_source(self, *, previous=None):
        staged = self.sources.stage(io.BytesIO(b"Complete source text.\r\n"), kind="text", title="Source", format="txt")
        arguments = {} if previous is None else {"source_id": previous["source_id"],
            "expected_registration_revision": previous["registration_revision"]}
        return self.sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
                                   authorize=self.actor, **arguments)

    def create_job(self):
        return self.jobs.create(tenant="tenant", user_id="alice", request_id=uuid4().hex,
            **{key: self.source[key] for key in ("source_id", "source_version", "source_sha256")},
            expected_registration_revision=self.source["registration_revision"],
            targets=["example.md"], outputs=["wiki"], authorize=self.actor)

    def list_jobs(self, **arguments):
        return self.jobs.list_jobs(tenant="tenant", user_id="alice", scope_key="access-alice", **arguments)

    def snapshot(self):
        # Only this new derived cache is exempt. Wiki, complete history and all
        # original source/job/owner/lease/request bytes remain in the comparison.
        return {path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob("*")
                if path.is_file() and path.relative_to(self.root).parts[0] != "_index"}

    @staticmethod
    def state_reads(calls):
        return [call.args[1] for call in calls if call.args[1].name in {"job.json", "state.json"}]

    def assert_failure_matches_canonical(self, expected):
        before = self.snapshot()
        failures = []
        for fallback in (True, False):
            context = (patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("canonical comparison"))
                       if fallback else nullcontext())
            with context, patch.object(CanonicalReadIndex, "page", side_effect=AssertionError("page before validation")), \
                    self.assertRaises(expected) as failure:
                self.list_jobs(limit=1)
            failures.append(failure.exception)
        self.assertEqual(type(failures[0]), type(failures[1]))
        self.assertEqual(str(failures[0]), str(failures[1]))
        self.assertEqual(self.snapshot(), before)

    def test_cold_and_warm_sql_pages_read_only_selected_job_bodies_and_preserve_history(self):
        first = self.store.save("preserved.md", "Entire first version.\r\n", expected_revision=None)
        self.store.save("preserved.md", "Entire second version.\r\n", expected_revision=first.revision)
        jobs = sorted([self.create_job()["job_id"] for _ in range(30)])
        before = self.snapshot()
        with patch.object(files, "read_json", wraps=files.read_json) as reads:
            cold = self.list_jobs(limit=5)
        self.assertGreaterEqual(len(self.state_reads(reads.call_args_list)), 30)
        self.assertEqual([job["job_id"] for job in cold["items"]], jobs[:5])
        self.assertEqual(cold["scanned"], 30)
        self.assertEqual(self.snapshot(), before)
        # A new request-local JobStore also uses the persisted summaries.
        self.jobs = JobStore(self.store, clock=lambda: self.now)
        original_page = CanonicalReadIndex.page
        original_lookup = CanonicalReadIndex.lookup
        with patch.object(files, "read_json", wraps=files.read_json) as reads, \
                patch.object(CanonicalReadIndex, "page", autospec=True, side_effect=original_page) as sql_page, \
                patch.object(CanonicalReadIndex, "lookup", autospec=True, side_effect=original_lookup) as lookups, \
                patch.object(CanonicalReadIndex, "get", side_effect=AssertionError("warm job cache hit called get")) as gets, \
                patch.object(self.jobs.sources, "_catalog_path", wraps=self.jobs.sources._catalog_path) as catalogs:
            warm = self.list_jobs(limit=5, cursor=cold["next_cursor"])
        self.assertEqual(len(self.state_reads(reads.call_args_list)), 5)
        self.assertEqual(gets.call_count, 0)
        self.assertEqual(lookups.call_count, 4)
        self.assertEqual(catalogs.call_count, 1)
        self.assertEqual({call.args[1] for call in lookups.call_args_list}, {
            "analysis_job_owners", "analysis_jobs", "analysis_job_leases", "analysis_job_sources"})
        self.assertEqual([job["job_id"] for job in warm["items"]], jobs[5:10])
        self.assertEqual(sql_page.call_args.kwargs["after"], jobs[4])
        self.assertEqual(sql_page.call_args.kwargs["limit"], 6)
        self.assertEqual(self.snapshot(), before)
        database = sqlite3.connect(self.root / "_index/read.sqlite3")
        self.addCleanup(database.close)
        payloads = [json.loads(row[0]) for row in database.execute(
            "SELECT payload FROM read_index_rows WHERE namespace='analysis_jobs'")]
        self.assertEqual(len(payloads), 30)
        self.assertTrue(all("events" not in value and "actor" not in value for value in payloads))

    def test_off_page_changes_and_corruption_are_not_hidden_by_cached_metadata(self):
        jobs = sorted([self.create_job() for _ in range(4)], key=lambda job: job["job_id"])
        page = self.list_jobs(limit=1)
        changed = jobs[-1]
        self.jobs.cancel(changed["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                         expected_job_revision=changed["job_revision"])
        before = self.snapshot()
        with self.assertRaises(CatalogChangedError):
            self.list_jobs(limit=1, cursor=page["next_cursor"])
        self.assertEqual(self.snapshot(), before)
        self.list_jobs(limit=1)
        path = self.jobs.job_root(changed["job_id"]) / "job.json"
        path.write_text('{"broken":true}')
        before = self.snapshot()
        with self.assertRaises(contracts.JobCorruptError):
            self.list_jobs(limit=1)
        self.assertEqual(self.snapshot(), before)

    def test_raw_cursor_scope_and_limit_checks_precede_cache_open(self):
        self.create_job(); self.create_job()
        page = self.list_jobs(limit=1)
        with patch.object(queries, "read_index", side_effect=AssertionError("cache opened before validation")):
            for limit in (True, 0, 51):
                with self.subTest(limit=limit), self.assertRaises(contracts.JobValidationError):
                    self.list_jobs(limit=limit)
            for cursor in ("not-json", json.dumps(page["next_cursor"]), {}, "x" * 4097):
                with self.subTest(cursor=type(cursor)), self.assertRaises(InvalidCursorError):
                    self.list_jobs(cursor=cursor)
            with self.assertRaises(contracts.JobValidationError):
                self.jobs.list_jobs(tenant="tenant", user_id="alice", scope_key="")
            with self.assertRaises(InvalidCursorError):
                self.jobs.list_jobs(tenant="tenant", user_id="alice", scope_key="new-access",
                                    cursor=page["next_cursor"])
            with self.assertRaises(InvalidCursorError):
                self.jobs.list_jobs(tenant="tenant", user_id="bob", scope_key="access-bob",
                                    cursor=page["next_cursor"])

    def test_other_owner_state_is_never_read_and_changed_marker_precedes_body(self):
        job = self.create_job()
        self.list_jobs()
        with patch.object(records, "owned_state", side_effect=AssertionError("other owner's state read")):
            other = self.jobs.list_jobs(tenant="tenant", user_id="bob", scope_key="access-bob")
        self.assertEqual(other["items"], [])
        marker = self.jobs.job_root(job["job_id"]) / "owner.json"
        marker.write_text(json.dumps({"job_id": job["job_id"], "tenant": "tenant", "user_id": "bob"}))
        before = self.snapshot()
        with patch.object(files, "read_json", wraps=files.read_json) as reads, self.assertRaises(contracts.JobCorruptError):
            self.list_jobs()
        self.assertEqual(self.state_reads(reads.call_args_list), [])
        self.assertEqual(self.snapshot(), before)

    def test_related_source_changes_invalidate_cursor_but_unrelated_sources_do_not(self):
        self.create_job(); self.create_job()
        page = self.list_jobs(limit=1)
        self.register_source()
        self.assertTrue(self.list_jobs(limit=1, cursor=page["next_cursor"])["complete"])
        self.register_source(previous=self.source)
        before = self.snapshot()
        with self.assertRaises(CatalogChangedError):
            self.list_jobs(limit=1, cursor=page["next_cursor"])
        self.assertTrue(all(job["basis_status"] == "changed" for job in self.list_jobs()["items"]))
        self.assertEqual(self.snapshot(), before)

    def test_missing_source_and_off_page_source_or_lease_corruption_remain_visible(self):
        jobs = sorted([self.create_job() for _ in range(3)], key=lambda job: job["job_id"])
        claimed = self.jobs.claim(jobs[-1]["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                                  expected_job_revision=jobs[-1]["job_revision"])
        self.list_jobs(limit=1)
        lease = self.jobs.job_root(jobs[-1]["job_id"]) / "leases" / (claimed["run_id"] + ".json")
        original_lease = lease.read_bytes()
        lease.write_text('{"invalid":true}')
        before = self.snapshot()
        with self.assertRaises(contracts.JobCorruptError):
            self.list_jobs(limit=1)
        self.assertEqual(self.snapshot(), before)
        lease.write_bytes(original_lease)
        catalog = self.sources._catalog_path(self.source["source_id"])
        original_catalog = catalog.read_bytes()
        catalog.write_text('{"invalid":true}')
        before = self.snapshot()
        with self.assertRaises(SourceCorruptError):
            self.list_jobs(limit=1)
        self.assertEqual(self.snapshot(), before)
        catalog.write_bytes(original_catalog)
        catalog.rename(self.root / "held-catalog.json")
        before = self.snapshot()
        self.assertTrue(all(job["basis_status"] == "missing" for job in self.list_jobs()["items"]))
        self.assertEqual(self.snapshot(), before)

    def test_lease_corruption_precedes_same_job_source_and_later_job_state_errors(self):
        jobs = sorted([self.create_job() for _ in range(2)], key=lambda job: job["job_id"])
        claimed = self.jobs.claim(jobs[0]["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                                  expected_job_revision=jobs[0]["job_revision"])
        self.list_jobs(limit=1)
        lease = self.jobs.job_root(jobs[0]["job_id"]) / "leases" / (claimed["run_id"] + ".json")
        lease.write_text('{"invalid":true}')
        self.sources._catalog_path(self.source["source_id"]).write_text('{"invalid":true}')
        self.assert_failure_matches_canonical(contracts.JobCorruptError)
        (self.jobs.job_root(jobs[1]["job_id"]) / "job.json").write_text('{"invalid":true}')
        self.assert_failure_matches_canonical(contracts.JobCorruptError)

    def test_earlier_source_error_precedes_later_state_unsafe_path_and_legacy_name(self):
        jobs = sorted([self.create_job() for _ in range(2)], key=lambda job: job["job_id"])
        self.list_jobs(limit=1)
        self.sources._catalog_path(self.source["source_id"]).write_text('{"invalid":true}')
        late_state = self.jobs.job_root(jobs[1]["job_id"]) / "job.json"
        late_state.write_text('{"invalid":true}')
        self.assert_failure_matches_canonical(SourceCorruptError)
        held_state = self.root / "held-late-state.json"
        late_state.rename(held_state)
        late_state.symlink_to(held_state)
        self.assert_failure_matches_canonical(SourceCorruptError)
        late_state.unlink()
        held_state.rename(late_state)
        late_owner = records.legacy_owner_path(self.jobs, "tenant", "alice", jobs[1]["job_id"]).parent / "zz-invalid.json"
        late_owner.parent.mkdir(parents=True, exist_ok=True)
        late_owner.write_text('{}')
        self.assert_failure_matches_canonical(SourceCorruptError)

    def test_owner_error_precedes_missing_state_and_metadata_limit_precedes_lease(self):
        job = self.create_job()
        self.list_jobs()
        root = self.jobs.job_root(job["job_id"])
        original_owner = (root / "owner.json").read_bytes()
        (root / "owner.json").write_text(json.dumps({"job_id": job["job_id"], "tenant": "tenant", "user_id": "bob"}))
        (root / "job.json").rename(self.root / "held-state.json")
        self.assert_failure_matches_canonical(contracts.JobCorruptError)
        (root / "owner.json").write_bytes(original_owner)
        (self.root / "held-state.json").rename(root / "job.json")
        claimed = self.jobs.claim(job["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                                  expected_job_revision=job["job_revision"])
        self.list_jobs()
        (root / "leases" / (claimed["run_id"] + ".json")).write_text('{"invalid":true}')
        with patch.object(contracts, "MAX_TOTAL_METADATA_BYTES", 1):
            self.assert_failure_matches_canonical(contracts.JobLimitError)

    def test_heartbeat_and_time_only_expiry_change_off_page_cursor_basis(self):
        jobs = sorted([self.create_job() for _ in range(3)], key=lambda job: job["job_id"])
        job = jobs[-1]
        claimed = self.jobs.claim(job["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                                  expected_job_revision=job["job_revision"])
        page = self.list_jobs(limit=1)
        self.now += timedelta(seconds=10)
        renewed = self.jobs.heartbeat(job["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
            run_id=claimed["run_id"], expected_lease_revision=claimed["lease_revision"])
        self.assertEqual(renewed["job_revision"], claimed["job_revision"])
        with self.assertRaises(CatalogChangedError):
            self.list_jobs(limit=1, cursor=page["next_cursor"])
        page = self.list_jobs(limit=1)
        before = self.snapshot()
        self.now += timedelta(seconds=301)
        with patch.object(files, "read_json", wraps=files.read_json) as reads, self.assertRaises(CatalogChangedError):
            self.list_jobs(limit=1, cursor=page["next_cursor"])
        self.assertEqual(self.state_reads(reads.call_args_list), [])
        expired = self.list_jobs()["items"][-1]
        self.assertEqual(expired["lease_status"], "expired")
        self.assertEqual(expired["lease_revision"], renewed["lease_revision"])
        self.assertEqual(self.snapshot(), before)

    def test_warm_metadata_and_owner_count_limits_use_all_canonical_jobs(self):
        jobs = [self.create_job() for _ in range(3)]
        self.list_jobs(limit=1)
        total = sum(len(canonical_json_bytes(records.owned_state(self.jobs, job["job_id"], "tenant", "alice")))
                    for job in jobs)
        before = self.snapshot()
        with patch.object(contracts, "MAX_TOTAL_METADATA_BYTES", total - 1), self.assertRaises(contracts.JobLimitError):
            self.list_jobs(limit=1)
        with patch.object(contracts, "MAX_JOBS", 2), self.assertRaises(contracts.JobLimitError):
            self.list_jobs(limit=1)
        self.assertEqual(self.snapshot(), before)
        # The budget counts canonical JSON bytes, rather than whitespace on disk.
        path = self.jobs.job_root(jobs[-1]["job_id"]) / "job.json"
        path.write_text(json.dumps(json.loads(path.read_text()), indent=4))
        before = self.snapshot()
        with patch.object(contracts, "MAX_TOTAL_METADATA_BYTES", total):
            self.assertEqual(self.list_jobs(limit=1)["scanned"], 3)
        self.assertEqual(self.snapshot(), before)

    def test_failed_creation_and_orphan_lease_are_preserved_without_auto_repair(self):
        original_write = self.jobs._write
        def fail_state(path, value):
            if path.name == "job.json":
                raise OSError("simulated state publish failure")
            return original_write(path, value)
        with patch.object(self.jobs, "_write", side_effect=fail_state):
            partial = self.create_job()
        self.assertEqual(partial["state"], "pending_reconcile")
        before = self.snapshot()
        with self.assertRaises(FileNotFoundError):
            self.list_jobs()
        self.assertEqual(self.snapshot(), before)

    def test_failed_claim_orphan_lease_does_not_invent_current_run(self):
        job = self.create_job()
        page = self.list_jobs()
        original_write = self.jobs._write
        def fail_state(path, value):
            if path.name == "job.json":
                raise OSError("simulated state publish failure")
            return original_write(path, value)
        with patch.object(self.jobs, "_write", side_effect=fail_state), self.assertRaises(OSError):
            self.jobs.claim(job["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                            expected_job_revision=job["job_revision"])
        before = self.snapshot()
        current = self.list_jobs()
        self.assertEqual(current, page)
        self.assertEqual(current["items"][0]["lease_status"], "none")
        self.assertEqual(len(list(self.jobs.job_root(job["job_id"]).glob("leases/*.json"))), 1)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_layout_and_duplicate_locations_keep_original_bytes(self):
        job = self.create_job()
        personal = self.jobs.job_root(job["job_id"])
        legacy = self.jobs.jobs_dir / job["job_id"]
        legacy.parent.mkdir(exist_ok=True)
        shutil.move(str(personal), legacy)
        (legacy / "job.json").rename(legacy / "state.json")
        owner = records.legacy_owner_path(self.jobs, "tenant", "alice", job["job_id"])
        owner.parent.mkdir(parents=True)
        (legacy / "owner.json").rename(owner)
        before = self.snapshot()
        self.assertEqual(self.list_jobs()["items"][0]["job_id"], job["job_id"])
        self.assertEqual(self.list_jobs()["items"][0]["job_id"], job["job_id"])
        self.assertEqual(self.snapshot(), before)
        personal.mkdir()
        before = self.snapshot()
        with self.assertRaises(contracts.JobCorruptError):
            self.list_jobs()
        self.assertEqual(self.snapshot(), before)

    def test_cache_unavailable_corrupt_and_busy_fall_back_without_canonical_changes(self):
        jobs = sorted([self.create_job() for _ in range(5)], key=lambda job: job["job_id"])
        expected = self.list_jobs(limit=2)
        before = self.snapshot()
        with patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("simulated cache I/O")):
            self.assertEqual(self.list_jobs(limit=2), expected)
        with patch.object(CanonicalReadIndex, "page", side_effect=CanonicalIndexUnavailable("late cache failure")):
            self.assertEqual(self.list_jobs(limit=2), expected)
        database_path = self.root / "_index/read.sqlite3"
        with sqlite3.connect(database_path, isolation_level=None) as database:
            database.execute("BEGIN IMMEDIATE")
            try:
                # WAL readers need no write transaction when every signature matches.
                with patch.object(files, "read_json", wraps=files.read_json) as reads, \
                        patch.object(queries, "_uncached_list", side_effect=AssertionError("warm read fell back")):
                    self.assertEqual(self.list_jobs(limit=2), expected)
                self.assertEqual(len(self.state_reads(reads.call_args_list)), 2)
            finally:
                database.execute("ROLLBACK")
        self.assertEqual(self.snapshot(), before)
        # A normal off-page mutation requires a cache update. Hold a real writer
        # while reading that new basis, so bounded SQL busy must use canonical data.
        changed = jobs[-1]
        self.jobs.cancel(changed["job_id"], tenant="tenant", user_id="alice", authorize=self.actor,
                         expected_job_revision=changed["job_revision"])
        previous_revision = expected["catalog_revision"]
        with patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("canonical expected DTO")):
            expected = self.list_jobs(limit=2)
        self.assertNotEqual(expected["catalog_revision"], previous_revision)
        before = self.snapshot()
        with sqlite3.connect(database_path, isolation_level=None) as database:
            database.execute("BEGIN IMMEDIATE")
            try:
                started = monotonic()
                with patch.object(files, "read_json", wraps=files.read_json) as reads, \
                        patch.object(queries, "_uncached_list", wraps=queries._uncached_list) as fallback:
                    self.assertEqual(self.list_jobs(limit=2), expected)
                self.assertLess(monotonic() - started, 1.0)
                fallback.assert_called_once()
                self.assertEqual(len(self.state_reads(reads.call_args_list)), 5)
            finally:
                database.execute("ROLLBACK")
        self.assertEqual(self.snapshot(), before)
        database_path.write_bytes(b"Corrupt derived database; preserve this file.")
        broken = database_path.read_bytes()
        self.assertEqual(self.list_jobs(limit=2), expected)
        self.assertEqual(database_path.read_bytes(), broken)
        self.assertEqual(self.snapshot(), before)

    def test_canonical_loader_sql_errors_are_not_mistaken_for_cache_failures(self):
        self.create_job()
        before = self.snapshot()
        with patch.object(records, "owned_state", side_effect=sqlite3.OperationalError("canonical loader failure")), \
                patch.object(queries, "_uncached_list", side_effect=AssertionError("incorrect fallback")), \
                self.assertRaises(sqlite3.OperationalError):
            self.list_jobs()
        self.assertEqual(self.snapshot(), before)

    def test_incompatible_thin_cache_shapes_fall_back_to_canonical_jobs(self):
        self.create_job()
        expected = self.list_jobs()
        before = self.snapshot()
        original_lookup = CanonicalReadIndex.lookup
        for namespace in ("analysis_job_owners", "analysis_jobs", "analysis_job_sources", "analysis_job_leases"):
            def incompatible(index, name, scope, keys=None):
                values = original_lookup(index, name, scope, keys=keys)
                return ({key: (signature, {"invalid": True}) for key, (signature, _) in values.items()}
                        if name == namespace else values)
            with self.subTest(namespace=namespace), patch.object(CanonicalReadIndex, "lookup", autospec=True,
                    side_effect=incompatible):
                self.assertEqual(self.list_jobs(), expected)
        self.assertEqual(self.snapshot(), before)

    def test_stat_failure_and_unsafe_canonical_paths_do_not_trigger_cache_fallback(self):
        job = self.create_job()
        self.list_jobs()
        with patch.object(queries, "_fingerprint", side_effect=PermissionError("canonical stat denied")), \
                patch.object(queries, "_uncached_list", side_effect=AssertionError("incorrect fallback")), \
                self.assertRaises(PermissionError):
            self.list_jobs()
        path = self.jobs.job_root(job["job_id"]) / "job.json"
        original = path.read_bytes()
        target = self.root / "held-job.json"
        path.rename(target)
        path.symlink_to(target)
        with patch.object(queries, "_uncached_list", side_effect=AssertionError("incorrect fallback")), \
                self.assertRaises(contracts.JobCorruptError):
            self.list_jobs()
        self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
