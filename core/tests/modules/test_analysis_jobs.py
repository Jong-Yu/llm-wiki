"""임시 원본의 작업 접수와 권한·CAS·실패 보존 핵심 다섯 흐름만 검사한다."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.access.policy import AccessDenied
from core.modules.analysis_jobs import contracts, records
from core.modules.analysis_jobs.contracts import JobConflictError, JobCorruptError, JobLimitError, JobValidationError
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import WikiStore
from core.modules.sources.contracts import SourceCorruptError
from core.modules.sources import contracts as source_limits
from core.modules.sources.store import SourceStore


class AnalysisJobTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-analysis-jobs-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = WikiStore(self.root, lock_timeout_seconds=1)
        self.sources = SourceStore(self.store)
        self.actor = {"user_id": "alice", "tenant": "alpha", "profile_id": "all", "domain": None,
                      "viewpoint": None, "policy_revision": "a" * 64}
        self.now = datetime(2026, 10, 25, tzinfo=timezone.utc)
        self.jobs = JobStore(self.store, clock=lambda: self.now)
        staged = self.sources.stage(io.BytesIO("원본\r\n🌱".encode()), kind="text", title="원본", format="txt")
        self.original = self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                             authorize=lambda: dict(self.actor))

    def create(self, request_id=None, **changes):
        values = {"tenant": "alpha", "user_id": "alice", "request_id": request_id or uuid4().hex,
            "source_id": self.original["source_id"], "source_version": self.original["source_version"],
            "source_sha256": self.original["source_sha256"], "expected_registration_revision": self.original["registration_revision"],
            "targets": ["Guide.md"], "outputs": ["wiki", "ontology"], "authorize": lambda: dict(self.actor)}
        return self.jobs.create(**{**values, **changes})

    def read(self, job_id):
        return self.jobs.query(job_id, tenant="alpha", user_id="alice")

    def mutate(self, method, job_id, **kwargs):
        return getattr(self.jobs, method)(job_id, tenant="alpha", user_id="alice",
                                          authorize=lambda: dict(self.actor), **kwargs)

    def protected(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for directory in ("wiki", "_history", "_sources", "_registrations")
                for path in (self.root / directory).rglob("*") if path.is_file()}

    def test_creation_replay_claim_heartbeat_progress_and_cancel_keep_originals(self):
        before = self.protected()
        created = self.create()
        replay = self.create(created["request_id"])
        self.assertEqual(created["job_id"], replay["job_id"])
        self.assertTrue(replay["replayed"])
        with self.assertRaises(JobConflictError):
            self.create(created["request_id"], outputs=["wiki"])
        current = self.read(created["job_id"])
        claimed = self.mutate("claim", current["job_id"], expected_job_revision=current["job_revision"])
        duplicate = self.mutate("claim", current["job_id"], expected_job_revision=current["job_revision"])
        self.assertEqual(claimed["run_id"], duplicate["run_id"])
        self.now += timedelta(seconds=30)
        alive = self.mutate("heartbeat", current["job_id"], run_id=claimed["run_id"], expected_lease_revision=claimed["lease_revision"])
        self.assertEqual(alive["job_revision"], claimed["job_revision"])
        self.assertNotEqual(alive["lease_revision"], claimed["lease_revision"])
        reported = self.mutate("update", current["job_id"], run_id=alive["run_id"], expected_job_revision=alive["job_revision"],
                               reported_status="input_ready", message="모의 CLI의 파일 준비 보고")
        with self.assertRaises(JobValidationError):
            self.mutate("update", current["job_id"], run_id=alive["run_id"], expected_job_revision=reported["job_revision"], reported_status="complete")
        source = self.mutate("source_input", current["job_id"], run_id=alive["run_id"])
        self.assertEqual(source["source_ref"], current["source_ref"])
        self.assertFalse(source["execution_ready"])
        cancelled = self.mutate("cancel", current["job_id"], expected_job_revision=reported["job_revision"])
        self.assertEqual(cancelled["state"], "cancelled")
        with self.assertRaises(JobConflictError):
            self.mutate("source_input", current["job_id"], run_id=alive["run_id"])
        self.assertEqual(self.protected(), before)

    def test_ownership_current_permission_expiry_and_changed_source_reject_progress(self):
        created = self.create(); job = self.read(created["job_id"])
        actual = records.read
        with patch("core.modules.analysis_jobs.records.read", side_effect=lambda store, path: self.fail("other state read")
                   if path.name == "state.json" else actual(store, path)):
            with self.assertRaises(FileNotFoundError):
                self.jobs.query(job["job_id"], tenant="alpha", user_id="bob")
        def denied():
            raise AccessDenied()
        with self.assertRaises(AccessDenied):
            self.jobs.claim(job["job_id"], tenant="alpha", user_id="alice", expected_job_revision=job["job_revision"], authorize=denied)
        claimed = self.mutate("claim", job["job_id"], expected_job_revision=job["job_revision"])
        self.now += timedelta(seconds=301)
        self.assertEqual(self.read(job["job_id"])["lease_status"], "expired")
        with self.assertRaises(JobConflictError):
            self.mutate("heartbeat", job["job_id"], run_id=claimed["run_id"], expected_lease_revision=claimed["lease_revision"])
        with self.assertRaises(JobConflictError):
            self.mutate("claim", job["job_id"], expected_job_revision=claimed["job_revision"])
        resumed = self.mutate("claim", job["job_id"], expected_job_revision=claimed["job_revision"], reclaim=True)
        self.assertNotEqual(resumed["run_id"], claimed["run_id"])
        staged = self.sources.stage(io.BytesIO(b"new"), kind="text", title="원본", format="txt")
        self.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
            source_id=self.original["source_id"], expected_registration_revision=self.original["registration_revision"], authorize=lambda: dict(self.actor))
        with self.assertRaises(JobConflictError):
            self.mutate("source_input", job["job_id"], run_id=resumed["run_id"])
        self.assertEqual(self.read(job["job_id"])["basis_status"], "changed")
        self.assertEqual(self.mutate("cancel", job["job_id"], expected_job_revision=resumed["job_revision"])["state"], "cancelled")

    def test_intent_and_receipt_failures_preserve_reserved_job_without_recreation(self):
        before = self.protected(); original_write = self.jobs._write_request; calls = 0
        def fail_receipt(path, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated receipt failure")
            return original_write(path, value)
        with patch.object(self.jobs, "_write_request", side_effect=fail_receipt):
            pending = self.create()
        self.assertEqual(pending["state"], "pending_reconcile")
        state_bytes = {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.jobs.jobs_dir.rglob("*") if p.is_file()}
        receipt = self.jobs.request_receipt(tenant="alpha", user_id="alice", request_id=pending["request_id"])
        self.assertEqual(receipt["state"], "complete")
        self.assertEqual(receipt["receipt"]["confirmation"], "intent_owner_state")
        replay = self.create(pending["request_id"])
        self.assertEqual(replay["job_id"], pending["job_id"])
        self.assertEqual({p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.jobs.jobs_dir.rglob("*") if p.is_file()}, state_bytes)
        with patch.object(self.jobs, "_write_request", side_effect=OSError("intent failure")), self.assertRaises(OSError):
            self.create()
        self.assertEqual(self.protected(), before)

    def test_concurrent_idempotent_creation_and_paged_owner_scope(self):
        request_id = uuid4().hex
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.create(request_id), range(2)))
        self.assertEqual(len({result["job_id"] for result in results}), 1)
        self.create()
        first = self.jobs.list_jobs(tenant="alpha", user_id="alice", scope_key="policy", limit=1)
        last = self.jobs.list_jobs(tenant="alpha", user_id="alice", scope_key="policy", limit=1, cursor=first["next_cursor"])
        self.assertEqual(len(first["items"]) + len(last["items"]), 2)
        self.assertTrue(last["complete"])
        with self.assertRaises(InvalidCursorError):
            self.jobs.list_jobs(tenant="alpha", user_id="alice", scope_key="changed-policy", cursor=first["next_cursor"])
        item = first["items"][0]
        self.mutate("claim", item["job_id"], expected_job_revision=item["job_revision"])
        with self.assertRaises(CatalogChangedError):
            self.jobs.list_jobs(tenant="alpha", user_id="alice", scope_key="policy", cursor=first["next_cursor"])

    def test_empty_reads_corruption_paths_and_limits_fail_without_reset(self):
        protected = self.protected()
        created = self.create(); job = self.read(created["job_id"])
        state = records.state_path(self.jobs, job["job_id"]); original = state.read_bytes()
        state.write_bytes(b"invalid")
        with self.assertRaises(JobCorruptError):
            self.read(job["job_id"])
        self.assertEqual(state.read_bytes(), b"invalid")
        state.write_bytes(original)
        with patch.object(contracts, "MAX_EVENTS", 1), self.assertRaises(JobLimitError):
            self.mutate("claim", job["job_id"], expected_job_revision=job["job_revision"])
        self.assertEqual(state.read_bytes(), original)
        with patch.object(source_limits, "MAX_JSON_BYTES", len(original) + 10):
            for _ in range(3):
                with self.assertRaises(JobLimitError):
                    self.mutate("claim", job["job_id"], expected_job_revision=job["job_revision"])
        self.assertEqual(list((state.parent / "leases").glob("*.json")), [])
        self.assertEqual(state.read_bytes(), original)
        self.assertEqual(self.protected(), protected)
        with self.assertRaises((ValueError, JobValidationError)):
            self.create(targets=["../outside.md"])
        with tempfile.TemporaryDirectory() as directory:
            empty = JobStore(WikiStore(directory))
            self.assertEqual(empty.list_jobs(tenant="alpha", user_id="alice", scope_key="policy")["items"], [])
            self.assertFalse((Path(directory) / "_jobs").exists())


if __name__ == "__main__":
    unittest.main()
