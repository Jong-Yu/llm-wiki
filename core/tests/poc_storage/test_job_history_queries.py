"""History sources preserve canonical job checks without validating artifacts."""

from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.read_index import CanonicalIndexUnavailable
from core.modules.analysis_jobs import queries, records, contracts
from core.modules.documents.listing import InvalidCursorError, CatalogChangedError
from core.tests.poc_storage import test_job_read_tracking as fixtures


ACTOR = fixtures.ACTOR


class JobHistoryQueriesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.JobReadTrackingTests(
            "test_warm_new_request_skips_directory_and_all_fingerprints_but_reads_selected_bodies")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.jobs = self.fixture.jobs

    def ids(self, **arguments):
        return self.jobs.list_history_ids(tenant=ACTOR["tenant"], user_id=ACTOR["user_id"],
                                          scope_key="history", **arguments)

    def full(self, **arguments):
        return self.jobs.list_jobs(tenant=ACTOR["tenant"], user_id=ACTOR["user_id"],
                                  scope_key="history", **arguments)

    def event(self, job_id):
        return self.jobs.history(job_id, tenant=ACTOR["tenant"], user_id=ACTOR["user_id"])

    def assert_failure_equal(self, left, right):
        outcomes = []
        for operation in (left, right):
            try:
                operation()
            except Exception as error:
                outcomes.append((type(error), str(error)))
            else:
                self.fail("Canonical corruption was accepted")
        self.assertEqual(outcomes[0], outcomes[1])

    def test_id_pages_have_identical_scope_cursor_catalog_and_only_owned_ids(self):
        jobs = self.fixture.create_jobs(4)
        before = self.fixture.snapshot()
        full = self.full(limit=2)
        with patch.object(queries, "project", side_effect=AssertionError("history projection")):
            actual = self.ids(limit=2)
            event = self.event(jobs[0]["job_id"])
        expected = {**full, "items": [{"job_id": value["job_id"]} for value in full["items"]]}
        self.assertEqual(actual, expected)
        second = self.ids(limit=2, cursor=full["next_cursor"])
        self.assertEqual([value["job_id"] for value in second["items"]], [value["job_id"] for value in jobs[2:]])
        self.assertTrue(second["complete"])
        detail = self.jobs.query(jobs[0]["job_id"], tenant=ACTOR["tenant"], user_id=ACTOR["user_id"])
        self.assertEqual(event, {key: detail[key] for key in ("job_id", "tenant", "user_id", "state", "events", "job_revision")})
        self.assertEqual(self.fixture.snapshot(), before)

    def test_events_are_fresh_objects_and_owner_is_checked_before_state(self):
        job = self.fixture.create_job()
        first = self.event(job["job_id"])
        first["events"].clear()
        self.assertEqual(len(self.event(job["job_id"])["events"]), 1)
        root = self.jobs.job_root(job["job_id"])
        self.fixture.write_record(root / "owner.json", {"job_id": job["job_id"], "tenant": "tenant", "user_id": "bob"})
        (root / "job.json").rename(self.fixture.root / "held-state.json")
        before = self.fixture.snapshot()
        self.assert_failure_equal(lambda: self.jobs.query(job["job_id"], tenant="tenant", user_id="alice"),
                                  lambda: self.event(job["job_id"]))
        self.assertEqual(self.fixture.snapshot(), before)

    def test_off_page_state_event_corruption_and_metadata_limit_remain_errors(self):
        jobs = self.fixture.create_jobs(3)
        self.ids(limit=1)
        with self.fixture.sources._coordination_lock():
            value = deepcopy(records.owned_state(self.jobs, jobs[-1]["job_id"], "tenant", "alice"))
        value["events"][0]["timestamp"] = "invalid"
        path = self.jobs.job_root(jobs[-1]["job_id"]) / "job.json"
        self.fixture.write_record(path, value)
        before = self.fixture.snapshot()
        self.assert_failure_equal(lambda: self.full(limit=1), lambda: self.ids(limit=1))
        self.assertEqual(self.fixture.snapshot(), before)

    def test_lease_before_source_error_and_canonical_byte_limit_keep_priority(self):
        job = self.fixture.create_job()
        claimed = self.fixture.claim(job)
        self.ids()
        lease = self.jobs.job_root(job["job_id"]) / "leases" / (claimed["run_id"] + ".json")
        self.fixture.write_record(lease, {"invalid": True})
        self.fixture.write_record(self.fixture.sources._catalog_path(self.fixture.source["source_id"]), {"invalid": True})
        self.assert_failure_equal(self.full, self.ids)
        self.assert_failure_equal(lambda: self.jobs.query(job["job_id"], tenant="tenant", user_id="alice"),
                                  lambda: self.event(job["job_id"]))
        with patch.object(contracts, "MAX_TOTAL_METADATA_BYTES", 1):
            self.assert_failure_equal(self.full, self.ids)

    def test_result_damage_is_separate_and_public_details_still_reject_it(self):
        job = self.fixture.create_job()
        expected_ids, expected_event = self.ids(), self.event(job["job_id"])
        path = self.jobs.job_root(job["job_id"]) / "results" / uuid4().hex / "manifest.json"
        self.fixture.write_record(path, {"invalid": True})
        before = self.fixture.snapshot()
        self.assertEqual(self.ids(), expected_ids)
        self.assertEqual(self.event(job["job_id"]), expected_event)
        self.assert_failure_equal(self.full,
            lambda: self.jobs.query(job["job_id"], tenant="tenant", user_id="alice"))
        self.assertEqual(self.fixture.snapshot(), before)

    def test_registration_descriptor_is_required_but_conversion_file_is_not(self):
        source = {key: self.fixture.source[key] for key in
                  ("source_id", "source_version", "source_sha256", "registration_revision")}
        created = self.jobs.create_registration(tenant="tenant", user_id="alice", request_id=uuid4().hex,
            source_ref=source, document="registered.md", title="Original", authorize=lambda: dict(ACTOR))
        job_id = created["job_id"]
        expected = self.event(job_id)
        root = self.jobs.job_root(job_id)
        (root / "conversion.json").rename(self.fixture.root / "held-conversion.json")
        before = self.fixture.snapshot()
        self.assertEqual(self.event(job_id), expected)
        self.assertEqual(self.ids()["items"], [{"job_id": job_id}])
        with self.assertRaises(FileNotFoundError):
            self.jobs.query(job_id, tenant="tenant", user_id="alice")
        self.assertEqual(self.fixture.snapshot(), before)
        (self.fixture.root / "held-conversion.json").rename(root / "conversion.json")
        with self.fixture.sources._coordination_lock():
            value = deepcopy(records.owned_state(self.jobs, job_id, "tenant", "alice"))
        value["events"][0]["details"]["registration"] = {"mode": "invalid"}
        self.fixture.write_record(root / "job.json", value)
        self.assert_failure_equal(self.full, self.ids)
        self.assert_failure_equal(lambda: self.jobs.query(job_id, tenant="tenant", user_id="alice"),
                                  lambda: self.event(job_id))

    def test_cursor_validation_precedes_cache_and_cancel_invalidates_old_page(self):
        jobs = self.fixture.create_jobs(2)
        first = self.ids(limit=1)
        with patch.object(queries, "read_index", side_effect=AssertionError("cache before cursor validation")):
            for cursor in ("invalid", {}, "x" * 4097):
                with self.subTest(cursor=type(cursor)), self.assertRaises(InvalidCursorError):
                    self.ids(cursor=cursor)
            with self.assertRaises(contracts.JobValidationError):
                self.ids(limit=True)
            with self.assertRaises(InvalidCursorError):
                self.jobs.list_history_ids(tenant="tenant", user_id="bob", scope_key="history", cursor=first["next_cursor"])
        self.fixture.cancel(jobs[0])
        with self.assertRaises(CatalogChangedError):
            self.ids(limit=1, cursor=first["next_cursor"])
        self.assertEqual(self.event(jobs[0]["job_id"])["state"], "cancelled")

    def test_cache_unavailable_uses_the_same_canonical_id_pages(self):
        self.fixture.create_jobs(3)
        expected = self.ids(limit=2)
        before = self.fixture.snapshot()
        with patch.object(queries, "read_index", side_effect=CanonicalIndexUnavailable("isolated cache I/O")):
            self.assertEqual(self.ids(limit=2), expected)
        self.assertEqual(self.fixture.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
