"""Tenant history reads owned events without computing job detail projections."""

from contextlib import contextmanager
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_jobs import queries, records
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import StorageBusyError
from core.modules.knowledge import aggregation, tenant_aggregation
from core.tests.poc_storage import test_job_read_tracking as job_fixtures


ACTOR = job_fixtures.ACTOR


class TenantHistoryObservationsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = job_fixtures.JobReadTrackingTests(
            "test_warm_new_request_skips_directory_and_all_fingerprints_but_reads_selected_bodies")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = self.fixture.store

    def history(self, *, actor=None, limit=20, cursor=None):
        return aggregation.history_query(self.store, actor or ACTOR, documents=[],
            correspondence_ids=[], job_ids=[], limit=limit, cursor=cursor, coverage="tenant")

    @contextmanager
    def detail_sources(self):
        with patch.object(JobStore, "list_history_ids", JobStore.list_jobs), patch.object(JobStore, "history", JobStore.query):
            yield

    def reference(self, **kwargs):
        with self.detail_sources():
            return self.history(**kwargs)

    def assert_same(self, actual, expected):
        self.assertEqual(canonical_json_bytes(actual), canonical_json_bytes(expected))

    def test_twelve_jobs_need_no_details_and_keep_entire_dto_cursor_and_files(self):
        self.fixture.create_jobs(12)
        before = self.fixture.snapshot()
        with patch.object(queries, "project", wraps=queries.project) as projected:
            expected = self.reference(limit=1)
        self.assertEqual(projected.call_count, 24)
        with patch.object(queries, "project", side_effect=AssertionError("history detail projection")):
            actual = self.history(limit=1)
        self.assert_same(actual, expected)
        self.assertEqual((actual["total_items"], len(actual["items"])), (12, 1))
        self.assert_same(self.history(limit=3, cursor=actual["next_cursor"]),
                         self.reference(limit=3, cursor=expected["next_cursor"]))
        self.assertEqual(self.fixture.snapshot(), before)

    def test_partial_discovery_keeps_successful_pages_and_same_skipped_fields(self):
        self.fixture.create_jobs(3)
        full, ids = JobStore.list_jobs, JobStore.list_history_ids

        def partial(method):
            def page(service, *, tenant, user_id, scope_key, limit=20, cursor=None):
                if cursor is not None:
                    raise OSError("isolated later discovery failure")
                return method(service, tenant=tenant, user_id=user_id, scope_key=scope_key, limit=2)
            return page

        with patch.object(JobStore, "list_jobs", partial(full)), patch.object(JobStore, "list_history_ids", partial(ids)):
            expected = self.reference(limit=1)
            with patch.object(queries, "project", side_effect=AssertionError("partial history detail")):
                actual = self.history(limit=1)
        self.assert_same(actual, expected)
        self.assertEqual(actual["total_items"], 2)
        self.assertIn({"kind": "job", "reference": "tenant", "code": "resource_scan_failed"}, actual["skipped"])

    def test_compound_discovery_corruption_and_busy_keep_existing_behavior(self):
        jobs = self.fixture.create_jobs(2)
        self.fixture.write_record(self.fixture.jobs.job_root(jobs[-1]["job_id"]) / "job.json", {"invalid": True})
        self.fixture.write_record(self.fixture.sources._catalog_path(self.fixture.source["source_id"]), {"invalid": True})
        before = self.fixture.snapshot()
        actual = self.history()
        self.assert_same(actual, self.reference())
        self.assertEqual(actual["items"], [])
        self.assertIn({"kind": "job", "reference": "tenant", "code": "resource_scan_failed"}, actual["skipped"])
        failure = StorageBusyError(0.01)
        with patch.object(JobStore, "list_history_ids", side_effect=failure), self.assertRaises(StorageBusyError) as busy:
            self.history()
        self.assertIs(busy.exception, failure)
        self.assertEqual(self.fixture.snapshot(), before)

    def test_item_byte_and_discovery_limits_keep_snapshot_and_skipped_order(self):
        self.fixture.create_jobs(3)
        for name, value in (("MAX_TENANT_ITEMS", 2), ("MAX_AGGREGATE_BYTES", 1000), ("MAX_TENANT_RESOURCES", 2)):
            with self.subTest(limit=name), patch.object(tenant_aggregation, name, value):
                expected = self.reference(limit=1)
                actual = self.history(limit=1)
            self.assert_same(actual, expected)
            self.assertTrue(actual["truncated"])
            self.assertFalse(actual["complete"])

    def test_next_request_cancellation_access_revision_and_owner_are_fresh(self):
        jobs = self.fixture.create_jobs(2)
        first = self.history(limit=1)
        self.fixture.cancel(jobs[0])
        current = self.history(limit=1)
        self.assertEqual(current["total_items"], 3)
        self.assertNotEqual(current["snapshot_revision"], first["snapshot_revision"])
        with self.assertRaises(CatalogChangedError):
            self.history(limit=1, cursor=first["next_cursor"])
        with self.assertRaises(InvalidCursorError):
            self.history(actor={**ACTOR, "access_revision": "c" * 64}, limit=1, cursor=current["next_cursor"])
        before = self.fixture.snapshot()
        with patch.object(records, "owned_state", side_effect=AssertionError("other user's job read")):
            other = self.history(actor={**ACTOR, "user_id": "bob"})
        self.assertEqual(other["items"], [])
        self.assertEqual(self.fixture.snapshot(), before)

    def test_job_changes_after_discovery_are_read_before_history_collection(self):
        job = self.fixture.create_job()
        original = JobStore.list_history_ids
        changed = False

        def cancel_after_discovery(service, **arguments):
            nonlocal changed
            page = original(service, **arguments)
            if not changed:
                self.fixture.cancel(job)
                changed = True
            return page

        with patch.object(JobStore, "list_history_ids", cancel_after_discovery):
            actual = self.history()
        self.assertEqual(actual["total_items"], 2)
        self.assert_same(actual, self.history())

    def test_selected_coverage_keeps_dto_without_discovering_or_rendering_details(self):
        self.store.save("selected.md", "Selected source.\n", expected_revision=None)
        job = self.fixture.create_job()
        arguments = dict(documents=["selected.md"], correspondence_ids=[], job_ids=[job["job_id"]], limit=20)
        with self.detail_sources():
            expected = aggregation.history_query(self.store, ACTOR, **arguments)
        with patch.object(JobStore, "list_history_ids", side_effect=AssertionError("selected discovery")), patch.object(JobStore, "query", side_effect=AssertionError("selected details")):
            actual = aggregation.history_query(self.store, ACTOR, **arguments)
        self.assert_same(actual, expected)

    def test_unrelated_result_damage_does_not_hide_canonical_job_events(self):
        job = self.fixture.create_job()
        expected = self.history()
        path = self.fixture.jobs.job_root(job["job_id"]) / "results" / uuid4().hex / "manifest.json"
        self.fixture.write_record(path, {"invalid": True})
        before = self.fixture.snapshot()
        details = self.reference()
        self.assertIn({"kind": "job", "reference": "tenant", "code": "resource_scan_failed"}, details["skipped"])
        self.assert_same(self.history(), expected)
        self.assertEqual(self.fixture.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
