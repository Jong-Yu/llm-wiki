"""개인 AI를 호출하지 않고 실제 CLI의 작업 접수·원본 수신 한 흐름을 확인한다."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import socket
import sys
import time
import unittest
from uuid import uuid4

import httpx2

from core.client.analysis import AnalysisClientError, _same_job, read_token, server_url
from core.paths import PROJECT_DIR
from core.tests.api import test_sources_api as source_fixture


class AnalysisCliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        source_fixture.SourceApiTests.setUp(self)

    save_policy = source_fixture.SourceApiTests.save_policy

    async def test_actual_cli_claims_fixed_original_and_preserves_existing_knowledge(self):
        token_path = self.root / "client.token"
        token_path.write_text(self.tokens["alice"], encoding="ascii")
        token_path.chmod(0o600)
        original = "# 분석 입력\r\n조건과 예외 🌱\r\n".encode()
        before = {p.relative_to(self.tenant_root).as_posix(): p.read_bytes()
                  for p in self.tenant_root.rglob("*") if p.is_file()}
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        server = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config_path), "--tenant-root", str(self.tenant_root), "--port", str(port),
            *getattr(self, "server_arguments", []),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        url = f"http://127.0.0.1:{port}"
        try:
            async with httpx2.AsyncClient(base_url=url, headers={"Authorization": "Bearer " + self.tokens["alice"]},
                    trust_env=False, follow_redirects=False, timeout=10) as http:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        if (await http.get("/api/v1/access-context")).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() > deadline or server.returncode is not None:
                        self.fail("Isolated API/MCP process did not start.")
                    await asyncio.sleep(0.05)
                source_response = await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
                    "title": "분석 원본", "format": "md", "content": original.decode()})
                self.assertEqual(source_response.status_code, 201)
                source = source_response.json()["data"]
                request_id = uuid4().hex
                response = await http.post(self.base + "/analysis-jobs", json={"request_id": request_id,
                    "source_id": source["source_id"], "source_version": source["source_version"],
                    "source_sha256": source["source_sha256"], "expected_registration_revision": source["registration_revision"],
                    "targets": ["분석/결과.md"], "outputs": ["wiki", "ontology"]})
                self.assertEqual(response.status_code, 201, response.text)
                created = response.json()["data"]
                # macOS의 /var→/private/var 별칭을 제거한 실제 private 경로를 전달한다.
                work = self.root.resolve() / "client-work"
                cli = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "tools.analysis_cli",
                    "--server", url, "--tenant", "alpha", "--job-id", created["job_id"],
                    "--token-file", str(token_path), "--work-dir", str(work), cwd=PROJECT_DIR,
                    *getattr(self, "client_arguments", []),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                stdout, stderr = await asyncio.wait_for(cli.communicate(), timeout=15)
                self.assertEqual(cli.returncode, 0, stderr.decode())
                self.assertNotIn(self.tokens["alice"].encode(), stdout + stderr)
                value = json.loads(stdout)
                self.assertTrue(value["ok"])
                self.assertEqual(Path(value["local_file"]).read_bytes(), original)
                self.assertEqual(value["source_ref"]["source_sha256"], sha256(original).hexdigest())
                self.assertFalse(value["execution_ready"])
                if "--prepare-input" in getattr(self, "client_arguments", []):
                    fixed = value["fixed_input"]
                    self.assertTrue(fixed["input_ready"])
                    manifest = Path(value["local_file"]).parent / fixed["manifest_file"]
                    self.assertEqual(sha256(manifest.read_bytes()).hexdigest(), fixed["bundle_revision"])
                    self.assertTrue(fixed["components"])
                    self.assertNotIn(self.tokens["alice"], manifest.read_text())
                self.assertEqual(value["backend_identity"], "not_available")
                current = (await http.get(self.base + "/analysis-jobs/" + created["job_id"])).json()["data"]
                self.assertEqual(current["reported_status"], "input_ready")
                self.assertEqual(current["state"], "claimed")
                receipt = (await http.get(self.base + "/requests/" + request_id)).json()["data"]
                self.assertEqual(receipt["job_id"], created["job_id"])
                self.assertEqual(receipt["state"], "complete")
                heartbeat = await http.post(self.base + f"/analysis-jobs/{created['job_id']}/heartbeat", json={
                    "run_id": value["run_id"], "expected_lease_revision": value["lease_revision"]})
                self.assertEqual(heartbeat.status_code, 200)
                self.assertEqual(heartbeat.json()["data"]["job_revision"], current["job_revision"])
                cancel = await http.post(self.base + f"/analysis-jobs/{created['job_id']}/cancel", json={
                    "expected_job_revision": current["job_revision"], "reason": "연결 확인 종료"})
                self.assertEqual(cancel.status_code, 200)
                self.assertEqual(cancel.json()["data"]["state"], "cancelled")
                original_response = await http.get(self.base + f"/sources/{source['source_id']}/versions/{source['source_version']}/file")
                self.assertEqual(original_response.content, original)
                self.assertEqual(list(self.stores["alpha"].wiki_dir.iterdir()), [])
                for relative, raw in before.items():
                    self.assertEqual((self.tenant_root / relative).read_bytes(), raw)
        finally:
            if server.returncode is None:
                server.terminate()
            stdout, stderr = await asyncio.wait_for(server.communicate(), timeout=10)
            self.assertEqual(stdout, b"")
            self.assertNotIn(self.tokens["alice"].encode(), stderr)

    async def test_connection_and_token_guards_reject_mismatched_or_unsafe_inputs(self):
        for url in ("http://remote.invalid", "https://user:secret@example.com", "https://example.com/?token=value"):
            with self.subTest(url=url), self.assertRaises(AnalysisClientError):
                server_url(url)
        token = self.root / "token"
        token.write_text(self.tokens["alice"])
        token.chmod(0o644)
        with self.assertRaises(AnalysisClientError):
            read_token(token)
        token.chmod(0o600)
        self.assertEqual(read_token(token), self.tokens["alice"])
        api = {"job_id": "a" * 32, "tenant": "alpha", "user_id": "alice", "job_revision": "b" * 64}
        with self.assertRaises(AnalysisClientError):
            _same_job(api, {**api, "job_revision": "c" * 64}, job_id="a" * 32, tenant="alpha", user="alice")


if __name__ == "__main__":
    unittest.main()
