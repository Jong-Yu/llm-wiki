"""HTTP/MCP job operations share ownership, cursor and CAS contracts on temporary data."""

from datetime import datetime, timedelta, timezone
import json
from unittest.mock import patch
from uuid import uuid4

from core.modules.analysis_jobs.store import JobStore
from core.tests.poc_mcp.test_server_integration import ServerFixture


class JobOperationsTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.prefix = f"/api/v1/tenants/{self.tenant}/analysis-jobs"
        response = self.client.post(f"/api/v1/tenants/{self.tenant}/sources", headers=self.headers(), json={
            "request_id": uuid4().hex, "title": "Pump", "format": "txt", "content": "A pump moves water.\n"})
        self.assertEqual(response.status_code, 201, response.text)
        self.source = response.json()["data"]
        scope = self.policy.authorize(self.token, self.tenant, "source_write")
        self.store = scope.store

    def new_job(self):
        response = self.client.post(self.prefix, headers=self.headers(), json={
            "request_id": uuid4().hex,
            **{key: self.source[key] for key in ("source_id", "source_version", "source_sha256")},
            "expected_registration_revision": self.source["registration_revision"],
            "targets": ["example.md"], "outputs": ["wiki"]})
        self.assertEqual(response.status_code, 201, response.text)
        return self.call("analysis_job_query", job_id=response.json()["data"]["job_id"])

    def call(self, name, **arguments):
        return self.mcp(name, {"tenant": self.tenant, **arguments})

    def claimed(self):
        job = self.new_job()
        claimed = self.call("analysis_job_claim", job_id=job["job_id"], expected_job_revision=job["job_revision"])
        self.assertTrue(claimed["ok"], claimed)
        return claimed

    def http_job(self, job_id):
        response = self.client.get(f"{self.prefix}/{job_id}", headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    def assert_equivalent(self, http, mcp):
        self.assertTrue(mcp["ok"], mcp)
        self.assertEqual(http, {key: value for key, value in mcp.items() if key != "ok"})

    def snapshot(self):
        # SQLite의 파생 파일과 원본·소유 원장·전체 이력을 구분한다.
        return {str(path.relative_to(self.store.data_dir)): path.read_bytes()
                for path in self.store.data_dir.rglob("*") if path.is_file()
                and path.relative_to(self.store.data_dir).parts[0] != "_index"}

    def test_list_http_mcp_equivalence_cross_transport_cursor_and_catalog_change(self):
        jobs = [self.new_job(), self.new_job()]
        before = self.snapshot()
        response = self.client.get(self.prefix, headers=self.headers(), params={"limit": 1})
        self.assertEqual(response.status_code, 200, response.text)
        page = response.json()["data"]
        self.assert_equivalent(page, self.call("analysis_job_list", limit=1))
        next_page = self.call("analysis_job_list", limit=1, cursor=page["next_cursor"])
        self.assertTrue(next_page["complete"])
        http_next = self.client.get(self.prefix, headers=self.headers(), params={"cursor": page["next_cursor"], "limit": 1})
        self.assert_equivalent(http_next.json()["data"], next_page)
        self.assertEqual({job["job_id"] for job in jobs},
            {item["job_id"] for item in page["items"] + next_page["items"]})
        self.assertFalse(self.call("analysis_job_list", cursor=json.dumps(page["next_cursor"]))["ok"])
        self.assertEqual(before, self.snapshot())
        self.signup("Unrelated user")
        # Another membership changes the policy file but not this user's cursor basis.
        self.assertTrue(self.call("analysis_job_list", cursor=page["next_cursor"])["ok"])
        self.call("analysis_job_cancel", job_id=jobs[0]["job_id"], expected_job_revision=jobs[0]["job_revision"])
        self.assertEqual(self.call("analysis_job_list", cursor=page["next_cursor"])["error"]["code"], "catalog_changed")
        self.assertEqual(self.client.get(self.prefix, headers=self.headers(), params={"cursor": page["next_cursor"]}).status_code, 409)
        self.change_policy(lambda policy: policy["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.assertTrue(self.call("analysis_job_list")["ok"])
        self.assertEqual(self.call("analysis_job_list", cursor=page["next_cursor"])["error"]["code"], "invalid_cursor")
        self.assertEqual(self.client.get(self.prefix, headers=self.headers(), params={"cursor": page["next_cursor"]}).status_code, 422)

    def test_listing_projects_only_the_page_but_detects_off_page_changes(self):
        """반환하지 않는 작업의 고정 입력·규약 검사로 다른 조회를 지연시키지 않는다."""
        from core.modules.analysis_inputs import readiness
        from core.modules.analysis_results import repository
        jobs = sorted([self.new_job() for _ in range(3)], key=lambda job: job["job_id"])
        before = self.snapshot()
        with patch.object(readiness, "project", wraps=readiness.project) as inputs, \
                patch.object(repository, "summary", wraps=repository.summary) as results:
            response = self.client.get(self.prefix, headers=self.headers(), params={"limit": 1})
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()["data"]
            self.assertEqual(page["scanned"], 3)
            self.assertEqual(inputs.call_count, 1)
            self.assertEqual(results.call_count, 1)
        self.assertEqual(page["items"], [JobStore(self.store).query(jobs[0]["job_id"],
            tenant=self.tenant, user_id=self.user["user_id"])])
        self.assertEqual(before, self.snapshot())
        self.call("analysis_job_cancel", job_id=jobs[-1]["job_id"],
                  expected_job_revision=jobs[-1]["job_revision"])
        response = self.client.get(self.prefix, headers=self.headers(),
                                   params={"limit": 1, "cursor": page["next_cursor"]})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "catalog_changed")

    def test_heartbeat_lease_cas_is_separate_from_job_revision_and_progress(self):
        job = self.claimed()
        body = {key: job[key] for key in ("run_id",)}
        body["expected_lease_revision"] = job["lease_revision"]
        response = self.client.post(f"{self.prefix}/{job['job_id']}/heartbeat", headers=self.headers(), json=body)
        self.assertEqual(response.status_code, 200, response.text)
        renewed = response.json()["data"]
        self.assert_equivalent(renewed, self.call("analysis_job_query", job_id=job["job_id"]))
        self.assertEqual(renewed["job_revision"], job["job_revision"])
        self.assertNotEqual(renewed["lease_revision"], job["lease_revision"])
        updated = self.call("analysis_job_update", job_id=job["job_id"], run_id=job["run_id"],
            expected_job_revision=job["job_revision"], reported_status="analyzing")
        self.assertTrue(updated["ok"], updated)
        second = self.call("analysis_job_heartbeat", job_id=job["job_id"], run_id=job["run_id"],
            expected_lease_revision=renewed["lease_revision"])
        self.assert_equivalent(self.http_job(job["job_id"]), second)
        self.assertEqual(second["job_revision"], updated["job_revision"])
        self.assertEqual(self.call("analysis_job_heartbeat", job_id=job["job_id"], **body)["error"]["code"], "lease_conflict")
        self.assertEqual(self.client.post(f"{self.prefix}/{job['job_id']}/heartbeat", headers=self.headers(), json=body).status_code, 409)
        self.assertEqual(self.call("analysis_job_heartbeat", job_id=job["job_id"], run_id=uuid4().hex,
            expected_lease_revision=second["lease_revision"])["error"]["code"], "run_conflict")
        before = self.snapshot()
        future = datetime.now(timezone.utc) + timedelta(seconds=301)
        with patch.object(JobStore, "_now", return_value=future):
            self.assertEqual(self.call("analysis_job_heartbeat", job_id=job["job_id"], run_id=job["run_id"],
                expected_lease_revision=second["lease_revision"])["error"]["code"], "lease_expired")
            self.assertEqual(self.client.post(f"{self.prefix}/{job['job_id']}/heartbeat", headers=self.headers(),
                json={**body, "expected_lease_revision": second["lease_revision"]}).status_code, 409)
        self.assertEqual(before, self.snapshot())

    def test_cancel_cas_repeated_request_and_preservation_for_both_transports(self):
        self.assertTrue(self.write("Preserve the entire first version.\n")["ok"])
        first = self.read()
        self.assertTrue(self.write(first["content"].replace("entire first", "revised"), first["revision"])["ok"])
        for transport in ("http", "mcp"):
            with self.subTest(transport=transport):
                initial = self.new_job()
                job = self.call("analysis_job_claim", job_id=initial["job_id"], expected_job_revision=initial["job_revision"])
                body = {"expected_job_revision": initial["job_revision"], "reason": "User requested stop"}
                self.assertEqual(self.call("analysis_job_cancel", job_id=job["job_id"], **body)["error"]["code"], "conflict")
                self.assertEqual(self.client.post(f"{self.prefix}/{job['job_id']}/cancel", headers=self.headers(), json=body).status_code, 409)
                body["expected_job_revision"] = job["job_revision"]
                before = self.snapshot()
                if transport == "http":
                    response = self.client.post(f"{self.prefix}/{job['job_id']}/cancel", headers=self.headers(), json=body)
                    self.assertEqual(response.status_code, 200, response.text)
                    cancelled = self.call("analysis_job_query", job_id=job["job_id"])
                    self.assert_equivalent(response.json()["data"], cancelled)
                else:
                    cancelled = self.call("analysis_job_cancel", job_id=job["job_id"], **body)
                    self.assert_equivalent(self.http_job(job["job_id"]), cancelled)
                self.assertEqual(cancelled["state"], "cancelled")
                self.assertEqual(cancelled["message"], body["reason"])
                after = self.snapshot()
                self.assertEqual(set(before), set(after))
                changed = [path for path in before if before[path] != after[path]]
                self.assertIn(".registration.lock", changed)
                changed.remove(".registration.lock")
                self.assertEqual(len(changed), 1)
                self.assertTrue(changed[0].endswith(f"/{job['job_id']}/job.json"), changed)
                self.assertEqual(self.call("analysis_job_cancel", job_id=job["job_id"], **body)["error"]["code"], "conflict")
                body["expected_job_revision"] = cancelled["job_revision"]
                self.assertEqual(self.call("analysis_job_cancel", job_id=job["job_id"], **body)["error"]["code"], "job_cancelled")
                self.assertEqual(self.client.post(f"{self.prefix}/{job['job_id']}/cancel", headers=self.headers(), json=body).status_code, 409)
                self.assertEqual(self.call("analysis_job_heartbeat", job_id=job["job_id"], run_id=job["run_id"],
                    expected_lease_revision=job["lease_revision"])["error"]["code"], "job_cancelled")
                self.assertEqual(after, self.snapshot())

    def test_other_owner_tenant_and_cursor_scope_are_rejected(self):
        job = self.claimed()
        self.new_job()
        page = self.call("analysis_job_list", limit=1)
        stranger = self.signup("Another owner")
        listed = self.mcp("analysis_job_list", {"tenant": self.tenant}, stranger["token"])
        self.assertEqual(listed["items"], [])
        self.assertEqual(self.mcp("analysis_job_list", {"tenant": self.tenant, "cursor": page["next_cursor"]},
            stranger["token"])["error"]["code"], "invalid_cursor")
        self.assertEqual(self.client.get(self.prefix, headers=self.headers(stranger["token"]),
            params={"cursor": page["next_cursor"]}).status_code, 422)
        before = self.snapshot()
        operations = {"cancel": {"expected_job_revision": job["job_revision"]},
            "heartbeat": {"run_id": job["run_id"], "expected_lease_revision": job["lease_revision"]}}
        for operation, body in operations.items():
            self.assertEqual(self.mcp("analysis_job_" + operation,
                {"tenant": self.tenant, "job_id": job["job_id"], **body}, stranger["token"])["error"]["code"], "not_found")
            self.assertEqual(self.client.post(f"{self.prefix}/{job['job_id']}/{operation}",
                headers=self.headers(stranger["token"]), json=body).status_code, 404)
            self.assertEqual(self.mcp("analysis_job_" + operation,
                {"tenant": "forbidden", "job_id": job["job_id"], **body})["error"]["code"], "access_denied")
            self.assertEqual(self.client.post(f"/api/v1/tenants/forbidden/analysis-jobs/{job['job_id']}/{operation}",
                headers=self.headers(), json=body).status_code, 403)
        self.assertEqual(self.call("analysis_job_list", profile="forbidden")["error"]["code"], "access_denied")
        self.assertEqual(self.mcp("analysis_job_list", {"tenant": "forbidden"})["error"]["code"], "access_denied")
        self.assertEqual(before, self.snapshot())

    def test_current_source_write_permission_is_rechecked_inside_mutations(self):
        job = self.claimed()
        operations = {"cancel": {"expected_job_revision": job["job_revision"]},
            "heartbeat": {"run_id": job["run_id"], "expected_lease_revision": job["lease_revision"]}}
        original_permissions = json.loads(self.config.read_text())["users"][self.user["user_id"]]["memberships"][self.tenant]["permissions"]
        def permissions(value):
            self.change_policy(lambda policy: policy["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=value))
        for operation, body in operations.items():
            original = getattr(JobStore, operation)
            def revoke(owner, *args, **kwargs):
                permissions(["read"])
                return original(owner, *args, **kwargs)
            for transport in ("http", "mcp"):
                with self.subTest(operation=operation, transport=transport):
                    permissions(original_permissions)
                    before = self.snapshot()
                    with patch.object(JobStore, operation, revoke):
                        if transport == "http":
                            response = self.client.post(f"{self.prefix}/{job['job_id']}/{operation}", headers=self.headers(), json=body)
                            self.assertEqual(response.status_code, 403)
                        else:
                            self.assertEqual(self.call("analysis_job_" + operation, job_id=job["job_id"], **body)["error"]["code"], "access_denied")
                    self.assertEqual(before, self.snapshot())
                    self.assertTrue(self.call("analysis_job_query", job_id=job["job_id"])["ok"])
                    self.assertTrue(self.call("analysis_job_list")["ok"])

    def test_lost_mutation_response_is_reconciled_by_read_without_repeating_write(self):
        for operation in ("heartbeat", "cancel"):
            with self.subTest(operation=operation):
                job = self.claimed()
                body = ({"run_id": job["run_id"], "expected_lease_revision": job["lease_revision"]}
                        if operation == "heartbeat" else {"expected_job_revision": job["job_revision"]})
                original = JobStore._write
                writes = []
                def lose_response(owner, path, value):
                    original(owner, path, value)
                    writes.append(path)
                    raise OSError("simulated lost completion")
                with patch.object(JobStore, "_write", lose_response), self.assertLogs("core.mcp.results", level="ERROR"):
                    self.assertEqual(self.call("analysis_job_" + operation, job_id=job["job_id"], **body)["error"]["code"], "storage_error")
                self.assertEqual(len(writes), 1)
                before_query = self.snapshot()
                current = self.call("analysis_job_query", job_id=job["job_id"])
                self.assert_equivalent(self.http_job(job["job_id"]), current)
                if operation == "heartbeat":
                    self.assertEqual(current["job_revision"], job["job_revision"])
                    self.assertNotEqual(current["lease_revision"], job["lease_revision"])
                    error = "lease_conflict"
                else:
                    self.assertEqual(current["state"], "cancelled")
                    error = "conflict"
                self.assertEqual(self.call("analysis_job_" + operation, job_id=job["job_id"], **body)["error"]["code"], error)
                self.assertEqual(before_query, self.snapshot())

    def test_raw_json_types_missing_fields_and_spoofed_actor_are_rejected(self):
        job = self.claimed()
        before = self.snapshot()
        invalid_lists = [{"limit": value} for value in (True, "20", 0, 51, None)]
        invalid_lists += [{"cursor": value} for value in (True, 1, [], {}, "null", " null ", '"null"', "", "x" * 16385)]
        invalid_lists += [{"actor": job["actor"]}, {"user_id": self.user["user_id"]}]
        for arguments in invalid_lists:
            with self.subTest(tool="list", arguments=str(arguments)[:100]):
                self.assertFalse(self.call("analysis_job_list", **arguments)["ok"])
        self.assertTrue(self.call("analysis_job_list", cursor=None)["ok"])
        valid = {"analysis_job_cancel": {"job_id": job["job_id"], "expected_job_revision": job["job_revision"]},
            "analysis_job_heartbeat": {"job_id": job["job_id"], "run_id": job["run_id"], "expected_lease_revision": job["lease_revision"]}}
        for tool, arguments in valid.items():
            invalid = [{key: value for key, value in arguments.items() if key != omitted} for omitted in arguments]
            invalid += [{**arguments, key: value} for key in arguments for value in (True, None, 1, [], {})]
            invalid += [{**arguments, "actor": job["actor"]}, {**arguments, "user_id": self.user["user_id"]}]
            if tool == "analysis_job_cancel":
                invalid += [{**arguments, "reason": value} for value in (None, True, 1, [], {}, "x" * 1001)]
            for bad in invalid:
                with self.subTest(tool=tool, arguments=str(bad)[:100]):
                    self.assertFalse(self.call(tool, **bad)["ok"])
        self.assertEqual(before, self.snapshot())
