"""불변 추출물 읽기와 파일 업로드/다운로드의 핵심 보존 경로만 확인한다."""

from hashlib import sha256
import unittest
from unittest.mock import patch
from uuid import uuid4
from core.api.dependencies import access_value
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_inputs import artifacts
from core.modules.analysis_jobs import records
from core.common.json_codec import canonical_json_hash
from core.tests.api import test_analysis_inputs_protocol as fixture


class ExtractionApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.AnalysisInputsProtocolTests.save_policy
    snapshot = fixture.AnalysisInputsProtocolTests.snapshot
    headers = fixture.AnalysisInputsProtocolTests.headers
    client = fixture.AnalysisInputsProtocolTests.client
    nothing = fixture.AnalysisInputsProtocolTests.nothing
    value = fixture.AnalysisInputsProtocolTests.value
    create = fixture.AnalysisInputsProtocolTests.create

    def setUp(self):
        fixture.AnalysisInputsProtocolTests.setUp(self)

    def authorize(self, permission="source_write"):
        """시험에서도 사용자·작성자는 실제 임시 정책이 결정한다."""
        return access_value(self.policy.authorize(self.tokens["alice"], "alpha", permission))

    async def extracted(self, http):
        """기존 작업/입력/문자 제출 모듈로만 불변 추출물을 준비한다."""
        created, _, _ = await self.create(http)
        self.jobs = JobStore(self.stores["alpha"], rulesets=self.rulesets)
        self.inputs = InputStore(self.stores["alpha"], self.rulesets, jobs=self.jobs)
        claimed = self.jobs.claim(created["job_id"], tenant="alpha", user_id="alice",
            expected_job_revision=created["job_revision"], authorize=self.authorize)
        common = {"tenant": "alpha", "user_id": "alice", "run_id": claimed["run_id"], "authorize": self.authorize}
        prepared = self.inputs.prepare(created["job_id"], **common,
            expected_job_revision=claimed["job_revision"], stage="read_source")
        extracted = self.inputs.submit_extraction(created["job_id"], **common,
            expected_job_revision=prepared["job_revision"], bundle_id=prepared["bundle_id"],
            bundle_revision=prepared["bundle_revision"], request_id=uuid4().hex,
            content="원본\r\n🌱", method="verbatim")
        self.job_id, self.run_id = created["job_id"], claimed["run_id"]
        self.metadata = {"request_id": uuid4().hex, "run_id": self.run_id,
            "expected_job_revision": extracted["job_revision"], "bundle_id": prepared["bundle_id"],
            "bundle_revision": prepared["bundle_revision"], "extraction_id": extracted["extraction_id"],
            "extraction_revision": extracted["extraction_revision"], "content_sha256": sha256(b"binary\x00file").hexdigest()}
        return extracted

    async def test_paged_text_artifact_bytes_hash_and_cancelled_job_read_preserve_original(self):
        """정상 공개·재조회는 같은 바이트를 돌려주며 취소 뒤에도 이미 저장한 자료를 읽는다."""
        async with self.client() as http:
            extracted = await self.extracted(http)
            url = self.base + "/extractions/" + extracted["extraction_id"]
            params = {"job_id": self.job_id}
            manifest = self.value(await http.get(url, params=params))
            self.assertEqual(manifest["manifest"]["extraction_revision"], extracted["extraction_revision"])
            content, offset = "", 0
            while True:
                page = self.value(await http.get(url + "/content", params={**params,
                    "extraction_revision": extracted["extraction_revision"], "offset": offset, "limit": 2}))
                content += page["content"]
                if page["next_offset"] is None:
                    self.assertTrue(page["complete"])
                    break
                self.assertFalse(page["complete"])
                offset = page["next_offset"]
            self.assertEqual(content, "원본\r\n🌱")
            posted = self.value(await http.post(self.base + f"/analysis-jobs/{self.job_id}/artifacts",
                data=self.metadata, files={"file": ("page.bin", b"binary\x00file", "application/octet-stream")}), 201)
            before_replay = self.snapshot()
            replayed = self.value(await http.post(self.base + f"/analysis-jobs/{self.job_id}/artifacts",
                data=self.metadata, files={"file": ("page.bin", b"binary\x00file", "application/octet-stream")}), 200)
            self.assertTrue(replayed["replayed"])
            self.assertEqual(replayed["artifact_id"], posted["artifact_id"])
            self.assertEqual(before_replay, self.snapshot())
            file_url = url + "/artifacts/" + posted["artifact_id"]
            response = await http.get(file_url, params=params)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, b"binary\x00file")
            self.assertEqual(response.headers["x-artifact-sha256"], self.metadata["content_sha256"])
            self.jobs.cancel(self.job_id, tenant="alpha", user_id="alice",
                expected_job_revision=posted["job_revision"], authorize=self.authorize)
            self.assertEqual((await http.get(file_url, params=params)).content, b"binary\x00file")
            self.assertEqual(self.value(await http.get(url, params=params))["manifest"], manifest["manifest"])

    async def test_wrong_hash_owner_scope_and_cancelled_upload_are_rejected(self):
        """다른 소유 작업·변조 바이트·오래된 판본이 공개 파일로 승격되지 않는다."""
        async with self.client() as http:
            extracted = await self.extracted(http)
            upload = self.base + f"/analysis-jobs/{self.job_id}/artifacts"
            url = self.base + "/extractions/" + extracted["extraction_id"]
            original = self.snapshot()
            self.value(await http.post(upload, data=self.metadata, files={"file": ("a.bin", b"tampered")}), 422)
            self.value(await http.get(url, params={"job_id": self.job_id, "profile": "unknown"}), 403)
            self.value(await http.get(url, params={"job_id": self.job_id}, headers=self.headers("reader")), 404)
            self.value(await http.get(url, params={"job_id": self.job_id}, headers=self.headers("bob")), 403)
            self.value(await http.get(url + "/content", params={"job_id": self.job_id,
                "extraction_revision": "0" * 64}), 409)
            self.assertEqual(original, self.snapshot())
            self.jobs.cancel(self.job_id, tenant="alpha", user_id="alice",
                expected_job_revision=extracted["job_revision"], authorize=self.authorize)
            cancelled = self.snapshot()
            self.value(await http.post(upload, data=self.metadata, files={"file": ("a.bin", b"binary\x00file")}), 409)
            self.assertEqual(cancelled, self.snapshot())

    async def test_pending_upload_reserves_quota_and_read_receipt_survives_cancel_and_write_revocation(self):
        """파일 공개 뒤 연결 실패도 용량에 남고, 읽기만으로 정확한 미확인 요청을 찾는다."""
        async with self.client() as http:
            extracted = await self.extracted(http)
            endpoint = self.base + f"/analysis-jobs/{self.job_id}/artifacts"
            original_write = records.write
            def fail_job_link(jobs, path, value):
                if path == records.state_path(jobs, self.job_id) and any(
                        event["details"].get("operation") == "artifact_uploaded" for event in value["events"]):
                    raise OSError("isolated job-link failure")
                return original_write(jobs, path, value)
            # 작은 시험 한도만 주입해 큰 파일을 만들지 않고 예약 누락을 확인한다.
            with patch.object(artifacts, "MAX_ARTIFACT_TOTAL", 15), patch.object(records, "write", fail_job_link):
                pending = self.value(await http.post(endpoint, data=self.metadata,
                    files={"file": ("page.bin", b"binary\x00file", "application/octet-stream")}), 202)
                self.assertEqual(pending["state"], "pending_reconcile")
                reserved = self.snapshot()
                self.value(await http.post(endpoint, data={**self.metadata, "request_id": uuid4().hex},
                    files={"file": ("page.bin", b"binary\x00file", "application/octet-stream")}), 413)
                self.assertEqual(reserved, self.snapshot())
                own = self.stores["alpha"].data_dir / "_artifacts" / self.job_id
                self.assertEqual(len(list(own.iterdir())), 1)
            self.jobs.cancel(self.job_id, tenant="alpha", user_id="alice",
                expected_job_revision=extracted["job_revision"], authorize=self.authorize)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            before_read = self.snapshot()
            receipt_url = endpoint + "/requests/" + self.metadata["request_id"]
            receipt = self.value(await http.get(receipt_url))
            self.assertEqual(receipt["state"], "pending_reconcile")
            self.assertFalse(receipt["published"])
            self.assertEqual(receipt["request_id"], self.metadata["request_id"])
            self.assertEqual(receipt["extraction_id"], extracted["extraction_id"])
            self.assertEqual(receipt["payload_hash"], canonical_json_hash(receipt["request"]))
            self.value(await http.get(receipt_url, headers=self.headers("reader")), 404)
            self.assertEqual(before_read, self.snapshot())
